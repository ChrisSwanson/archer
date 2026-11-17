// Gallery thumbnails: per (view, model revision, theme) one drawing, kept on
// disk under the service's state directory so a reload or a restart serves it
// without painting again. A drawing is one file holding the SVG, its brotli and
// gzip copies (compressed once, when kept) and a PNG of the same SVG, so every
// variant a page asks for is a file read. A revision names exactly one model,
// so a cached file never goes stale; it only ages out of the byte bound, least
// recently used first.
//
// Work is bounded: at most `concurrency` renders run at once, `queue` more may
// wait, and anything beyond is refused as busy. A render that outlives its
// deadline answers its callers with a timeout but keeps its slot until it
// actually settles (the painter cannot be interrupted), and its late result is
// still kept.
//
// A refusal that depends only on the drawing (too large, cannot be drawn) is
// remembered per key, so a page asking again does not pay the layout again. A
// PNG that could not be drawn is remembered in the file, beside its SVG.
// `prefetch` draws in the background, one at a time and only while no request
// is drawing, so the first visit to a gallery finds its thumbnails ready.
//
// `ThumbnailPainters` is the service's renderer: each drawing runs in a worker
// thread (thumbnail-worker.ts), so a large layout does not hold the event loop.
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { assertSafeThumbnail, ExportRefusal, THUMBNAIL_PNG_BOX } from "../export/index.ts";
import type { DiagramEnvelope } from "../model/envelope.ts";
import { ensurePrivateDir } from "./paths.ts";
import {
  compressThumbnail,
  drawThumbnail,
  type ThumbnailDrawing,
  type ThumbnailRasterResources,
} from "./thumbnail-draw.ts";
import { activeTelemetry, phaseEnd, phaseStart } from "../telemetry/index.ts";

export type { ThumbnailDrawing, ThumbnailRasterResources } from "./thumbnail-draw.ts";
export type ThumbnailTheme = "light" | "dark";
/** What pages ask for (`format=` on a thumbnail address); `svg` when absent. */
export type ThumbnailFormat = "svg" | "png";
/** A painter: the whole drawing, or (older or test painters) the SVG alone, which the store compresses itself. */
export type ThumbnailRender = (
  envelope: DiagramEnvelope,
  theme: ThumbnailTheme,
) => Promise<Uint8Array | ThumbnailDrawing>;
export interface ThumbnailRequest {
  readonly viewId: string;
  readonly revision: string;
  readonly theme: ThumbnailTheme;
}
/** Which variant to answer with: a format, and the content codings the reader accepts (`br`, `gzip`). */
export interface ThumbnailVariant {
  readonly format?: ThumbnailFormat;
  readonly codings?: ReadonlySet<string>;
}
export interface Thumbnail {
  readonly bytes: Uint8Array;
  /** The format's validator: the cache key, which names the drawing exactly; one for every encoding of the SVG. */
  readonly etag: string;
  readonly contentType: "image/svg+xml" | "image/png";
  /** The content coding of `bytes`; undefined for the bytes as drawn. */
  readonly encoding?: "br" | "gzip";
}

/**
 * Bumped when the drawing of a thumbnail changes (its painter, the PNG box, the file's
 * layout), so older files are neither served nor kept and pages ask afresh (`v=`).
 */
export const THUMBNAIL_DRAWING_VERSION = 3;
export const THUMBNAIL_LIMITS = {
  maxBytes: 64 * 1024 * 1024,
  /** Per part: the SVG, and separately the PNG. */
  maxThumbnailBytes: 512 * 1024,
  concurrency: 2,
  queue: 32,
  timeoutMs: 10_000,
  /** Remembered refusals, most recent kept. */
  refusals: 1024,
  /** Background drawings waiting, newest kept. */
  background: 4096,
  /** Quiet time before background drawing starts or resumes after a busy moment. */
  backgroundDelayMs: 2_000,
  /** Pause between two background drawings, so requests that arrived meanwhile go first. */
  backgroundGapMs: 20,
} as const;

export class ThumbnailRefusal extends Error {
  constructor(
    readonly code: "thumbnail_busy" | "thumbnail_timeout" | "thumbnail_too_large" | "thumbnail_failed",
    message: string,
  ) {
    super(message);
    this.name = "ThumbnailRefusal";
  }
}

export interface ThumbnailStoreOptions {
  readonly dir: string;
  readonly render: ThumbnailRender;
  readonly maxBytes?: number;
  readonly maxThumbnailBytes?: number;
  readonly concurrency?: number;
  readonly queue?: number;
  readonly timeoutMs?: number;
  /** Names the painter (Archer's version), so an upgrade draws its thumbnails afresh. */
  readonly painter?: string;
  readonly backgroundDelayMs?: number;
  /** How long background drawing waits after finding a request drawing or the owner busy; backgroundDelayMs by default. */
  readonly busyRetryMs?: number;
  /** Whether the owner is otherwise quiet; background drawing waits until it is (a drawing takes a core, and in process the event loop). */
  readonly idle?: () => boolean;
  /** The format pages are told to ask for (the inventory's `thumbnailFormat`); svg by default. */
  readonly format?: ThumbnailFormat;
}

/** A background drawing: its address, and the model at that revision if it is still current. */
export interface ThumbnailPrefetch {
  readonly request: ThumbnailRequest;
  readonly envelope: () => DiagramEnvelope | null;
}

type PngRefusal = { readonly code: "thumbnail_too_large" | "thumbnail_failed"; readonly message: string };
/** One kept drawing, as read from or written to its file. */
interface Kept {
  readonly svg: Buffer;
  readonly br: Buffer;
  readonly gzip: Buffer;
  readonly png: Buffer | null;
  readonly pngRefusal: PngRefusal | null;
  /** Set when the SVG was over the byte limit in a PNG store: then only the PNG is kept (svg, br and gzip are empty). */
  readonly svgRefusal?: string;
}

const REMEMBERED: ReadonlySet<ThumbnailRefusal["code"]> = new Set(["thumbnail_too_large", "thumbnail_failed"]);
const FILE = /^[0-9a-f]{64}\.thumb$/;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const keyOf = (request: ThumbnailRequest, painter: string): string =>
  createHash("sha256")
    .update(JSON.stringify([THUMBNAIL_DRAWING_VERSION, painter, request.viewId, request.revision, request.theme]))
    .digest("hex");

/** The file: one JSON header line naming each part's length (and a PNG's refusal), then the parts in order. */
function encodeKept(kept: Kept): Buffer {
  const header = JSON.stringify({
    v: THUMBNAIL_DRAWING_VERSION,
    svg: kept.svg.length,
    br: kept.br.length,
    gzip: kept.gzip.length,
    png: kept.png?.length ?? 0,
    pngRefusal: kept.pngRefusal,
    ...(kept.svgRefusal === undefined ? {} : { svgRefusal: kept.svgRefusal }),
  });
  return Buffer.concat([Buffer.from(`${header}\n`), kept.svg, kept.br, kept.gzip, kept.png ?? Buffer.alloc(0)]);
}

function decodeKept(file: Buffer, maxPart: number): Kept {
  const newline = file.indexOf(0x0a);
  if (newline < 0 || newline > 1024) throw new Error("not a thumbnail");
  const header = JSON.parse(file.subarray(0, newline).toString("utf8")) as Record<string, unknown>;
  const lengths = (["svg", "br", "gzip", "png"] as const).map((part) => header[part]);
  if (
    header["v"] !== THUMBNAIL_DRAWING_VERSION ||
    !lengths.every((n) => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= maxPart)
  )
    throw new Error("not a thumbnail");
  const [svgLength, brLength, gzipLength, pngLength] = lengths as number[];
  if (newline + 1 + svgLength! + brLength! + gzipLength! + pngLength! !== file.length)
    throw new Error("not a thumbnail");
  let at = newline + 1;
  const take = (n: number): Buffer => file.subarray(at, (at += n));
  const svg = take(svgLength!),
    br = take(brLength!),
    gz = take(gzipLength!),
    png = take(pngLength!);
  const refusal = header["pngRefusal"] as PngRefusal | null | undefined;
  const pngRefusal =
    refusal !== null &&
    typeof refusal === "object" &&
    (refusal.code === "thumbnail_failed" || refusal.code === "thumbnail_too_large") &&
    typeof refusal.message === "string"
      ? { code: refusal.code, message: refusal.message.slice(0, 500) }
      : null;
  if ((pngLength === 0) !== (pngRefusal !== null)) throw new Error("not a thumbnail");
  const svgRefusal = typeof header["svgRefusal"] === "string" ? header["svgRefusal"].slice(0, 500) : undefined;
  if ((svgLength === 0) !== (svgRefusal !== undefined) || (svgRefusal !== undefined && pngLength === 0))
    throw new Error("not a thumbnail");
  return {
    svg,
    br,
    gzip: gz,
    png: pngLength === 0 ? null : png,
    pngRefusal,
    ...(svgRefusal === undefined ? {} : { svgRefusal }),
  };
}

/** Throws unless `png` starts as a PNG of at most the thumbnail box. */
function assertThumbnailPng(png: Uint8Array): void {
  const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("ascii", 12, 16) !== "IHDR")
    throw new Error("not a PNG");
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0 || width > THUMBNAIL_PNG_BOX.width || height > THUMBNAIL_PNG_BOX.height)
    throw new Error("not a thumbnail PNG");
}

export class ThumbnailStore {
  readonly #dir: string;
  readonly #render: ThumbnailRender;
  readonly #maxBytes: number;
  readonly #maxThumbnailBytes: number;
  readonly #concurrency: number;
  readonly #queue: number;
  readonly #timeoutMs: number;
  readonly #painter: string;
  /** Cached file name → size, least recently used first; read from disk once. */
  #index: Map<string, number> | null = null;
  #total = 0;
  #active = 0;
  readonly #waiting: { readonly resolve: () => void; readonly reject: (failure: Error) => void }[] = [];
  readonly #flights = new Map<string, Promise<Kept>>();
  readonly #refusals = new Map<string, ThumbnailRefusal>();
  readonly #background = new Map<string, ThumbnailPrefetch>();
  readonly #backgroundDelayMs: number;
  readonly #busyRetryMs: number;
  readonly #idle: () => boolean;
  #backgroundTimer: NodeJS.Timeout | undefined;
  #backgroundRunning = false;
  #closed = false;

  constructor(options: ThumbnailStoreOptions) {
    this.#dir = options.dir;
    this.#render = options.render;
    this.#maxBytes = options.maxBytes ?? THUMBNAIL_LIMITS.maxBytes;
    this.#maxThumbnailBytes = options.maxThumbnailBytes ?? THUMBNAIL_LIMITS.maxThumbnailBytes;
    this.#concurrency = options.concurrency ?? THUMBNAIL_LIMITS.concurrency;
    this.#queue = options.queue ?? THUMBNAIL_LIMITS.queue;
    this.#timeoutMs = options.timeoutMs ?? THUMBNAIL_LIMITS.timeoutMs;
    this.#painter = options.painter ?? "";
    this.#backgroundDelayMs = options.backgroundDelayMs ?? THUMBNAIL_LIMITS.backgroundDelayMs;
    this.#busyRetryMs = options.busyRetryMs ?? this.#backgroundDelayMs;
    this.#idle = options.idle ?? (() => true);
    this.format = options.format ?? "svg";
    this.version = createHash("sha256")
      .update(JSON.stringify([THUMBNAIL_DRAWING_VERSION, this.#painter]))
      .digest("hex")
      .slice(0, 12);
  }

  /**
   * The painter and drawing version as one short token (`v=` in a thumbnail address): an
   * upgrade changes it, so a browser holding last version's immutable previews asks afresh.
   */
  readonly version: string;
  /** The format pages are told to ask for. */
  readonly format: ThumbnailFormat;

  /**
   * The validator `get` would answer with, known without reading or drawing anything: weak for
   * the SVG (one for each of its encodings, as the page's), strong for the PNG.
   */
  etag(request: ThumbnailRequest, format: ThumbnailFormat = "svg"): string {
    const key = keyOf(request, this.#painter);
    return format === "png" ? `"${key}-png"` : `W/"${key}"`;
  }

  /** The thumbnail of `envelope`, which the caller has checked is the view's model at `request.revision`. */
  get(request: ThumbnailRequest, envelope: DiagramEnvelope, variant: ThumbnailVariant = {}): Promise<Thumbnail> {
    return this.#get(request, envelope, true, variant);
  }

  /** `requested` false: a background drawing, which is not a request's cache hit or miss. */
  async #get(
    request: ThumbnailRequest,
    envelope: DiagramEnvelope,
    requested: boolean,
    variant: ThumbnailVariant,
  ): Promise<Thumbnail> {
    const key = keyOf(request, this.#painter);
    const read = phaseStart();
    const served = this.#readVariant(key, request, variant);
    phaseEnd("fs", read);
    if (requested) activeTelemetry()?.thumbnailCache(served !== null);
    if (served !== null) return served;
    const refused = this.#refusals.get(key);
    if (refused !== undefined) throw refused;
    let flight = this.#flights.get(key);
    if (flight === undefined) {
      flight = this.#produce(key, envelope, request.theme)
        .catch((failure: unknown) => {
          if (failure instanceof ThumbnailRefusal && REMEMBERED.has(failure.code)) this.#remember(key, failure);
          throw failure;
        })
        .finally(() => this.#flights.delete(key));
      this.#flights.set(key, flight);
    }
    return this.#variant(request, await flight, variant);
  }

  /** The asked variant of a kept drawing, or its PNG's refusal. */
  #variant(request: ThumbnailRequest, kept: Kept, variant: ThumbnailVariant): Thumbnail {
    if (variant.format === "png") {
      if (kept.png === null)
        throw new ThumbnailRefusal(
          kept.pngRefusal?.code ?? "thumbnail_failed",
          kept.pngRefusal?.message ?? "The PNG thumbnail could not be drawn.",
        );
      return { bytes: kept.png, etag: this.etag(request, "png"), contentType: "image/png" };
    }
    if (kept.svgRefusal !== undefined) throw new ThumbnailRefusal("thumbnail_too_large", kept.svgRefusal);
    const etag = this.etag(request, "svg"),
      codings = variant.codings;
    if (codings?.has("br") === true) return { bytes: kept.br, etag, contentType: "image/svg+xml", encoding: "br" };
    if (codings?.has("gzip") === true)
      return { bytes: kept.gzip, etag, contentType: "image/svg+xml", encoding: "gzip" };
    return { bytes: kept.svg, etag, contentType: "image/svg+xml" };
  }

  /** Whether `get` would answer without drawing: a kept file or a remembered refusal. */
  ready(request: ThumbnailRequest): boolean {
    const key = keyOf(request, this.#painter);
    return this.#refusals.has(key) || this.#ensureIndex().has(`${key}.thumb`);
  }

  /**
   * Draws these thumbnails in the background unless they are kept, remembered
   * or being drawn. Later requests for the same address replace waiting ones.
   */
  prefetch(jobs: Iterable<ThumbnailPrefetch>): void {
    if (this.#closed) return;
    for (const job of jobs) {
      const key = keyOf(job.request, this.#painter);
      if (this.#flights.has(key) || this.ready(job.request)) continue;
      this.#background.delete(key);
      this.#background.set(key, job);
      if (this.#background.size > THUMBNAIL_LIMITS.background)
        this.#background.delete(this.#background.keys().next().value as string);
    }
    this.#scheduleBackground();
  }

  /**
   * Stops drawing: background work is dropped, and requests waiting for a slot fail rather than
   * start a drawing later (that drawing started a fresh worker, which kept a stopped service's
   * process alive). Kept thumbnails are still answered.
   */
  close(): void {
    this.#closed = true;
    this.#background.clear();
    clearTimeout(this.#backgroundTimer);
    const stopped = new ThumbnailRefusal("thumbnail_busy", "The service is stopping.");
    for (const waiter of this.#waiting.splice(0)) waiter.reject(stopped);
  }

  #scheduleBackground(delayMs = this.#backgroundDelayMs): void {
    if (this.#closed || this.#backgroundRunning || this.#background.size === 0) return;
    clearTimeout(this.#backgroundTimer);
    this.#backgroundTimer = setTimeout(() => void this.#runBackground(), delayMs);
    this.#backgroundTimer.unref();
  }

  async #runBackground(): Promise<void> {
    this.#backgroundRunning = true;
    let wait = Math.min(this.#backgroundDelayMs, THUMBNAIL_LIMITS.backgroundGapMs);
    try {
      // Requests come first: wait while any drawing runs or waits, or the owner is busy.
      if (this.#active > 0 || this.#waiting.length > 0 || !this.#idle()) {
        wait = this.#busyRetryMs;
        return;
      }
      const next = this.#background.entries().next().value as [string, ThumbnailPrefetch] | undefined;
      if (next === undefined) return;
      const [key, job] = next;
      this.#background.delete(key);
      const envelope = job.envelope();
      if (envelope === null || envelope.revision !== job.request.revision || this.ready(job.request)) return;
      try {
        await this.#get(job.request, envelope, false, {});
      } catch {
        /* remembered, or asked again by a request */
      }
    } finally {
      this.#backgroundRunning = false;
      this.#scheduleBackground(wait);
    }
  }

  #remember(key: string, refusal: ThumbnailRefusal): void {
    this.#refusals.delete(key);
    this.#refusals.set(key, refusal);
    if (this.#refusals.size > THUMBNAIL_LIMITS.refusals)
      this.#refusals.delete(this.#refusals.keys().next().value as string);
  }

  async #produce(key: string, envelope: DiagramEnvelope, theme: ThumbnailTheme): Promise<Kept> {
    await this.#admit();
    let settled = false;
    const work = (async () => {
      try {
        const started = phaseStart();
        const drawn = await this.#render(envelope, theme);
        const ms = phaseEnd("render", started);
        activeTelemetry()?.thumbnailRendered(ms);
        const kept = await this.#accept(drawn);
        this.#write(key, kept);
        return kept;
      } catch (failure) {
        if (failure instanceof ThumbnailRefusal) throw failure;
        throw new ThumbnailRefusal(
          "thumbnail_failed",
          failure instanceof Error ? failure.message : "The thumbnail could not be drawn.",
        );
      } finally {
        settled = true;
        this.#release();
      }
    })();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (!settled)
          reject(
            new ThumbnailRefusal("thumbnail_timeout", `The thumbnail took longer than ${this.#timeoutMs} ms to draw.`),
          );
      }, this.#timeoutMs);
      timer.unref();
    });
    work.catch(() => undefined);
    try {
      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** A painter's drawing, checked and completed: the SVG is safe and within bounds, a bad PNG becomes its refusal. */
  async #accept(drawn: Uint8Array | ThumbnailDrawing): Promise<Kept> {
    const drawing: ThumbnailDrawing =
      drawn instanceof Uint8Array ? { svg: drawn, png: null, pngError: "This painter draws no PNG." } : drawn;
    const svg = Buffer.from(drawing.svg.buffer, drawing.svg.byteOffset, drawing.svg.byteLength);
    if (svg.length > this.#maxThumbnailBytes) {
      const message = `The thumbnail is ${svg.length} bytes, over the ${this.#maxThumbnailBytes}-byte limit.`;
      // The limit is the served format's (server review S8): a PNG store keeps the PNG of a large diagram.
      if (this.format !== "png") throw new ThumbnailRefusal("thumbnail_too_large", message);
      const png = this.#acceptPng(drawing);
      if (png.png === null) throw new ThumbnailRefusal(png.pngRefusal!.code, png.pngRefusal!.message);
      const empty = Buffer.alloc(0);
      return { svg: empty, br: empty, gzip: empty, ...png, svgRefusal: message };
    }
    try {
      assertSafeThumbnail(new TextDecoder("utf-8", { fatal: true }).decode(svg));
    } catch (failure) {
      throw new ThumbnailRefusal(
        "thumbnail_failed",
        failure instanceof ExportRefusal ? failure.message : "The thumbnail is not a readable SVG.",
      );
    }
    const asBuffer = (bytes: Uint8Array): Buffer => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Compressed here in the service's thread, off its event loop; never in a painter (thumbnail-draw.ts says why).
    const { br, gzip: gz } =
      drawing.br !== undefined && drawing.gzip !== undefined
        ? { br: asBuffer(drawing.br), gzip: asBuffer(drawing.gzip) }
        : await compressThumbnail(svg);
    return { svg, br, gzip: gz, ...this.#acceptPng(drawing) };
  }

  /** The drawing's PNG if it is a thumbnail PNG within bounds, else the refusal that says why not. */
  #acceptPng(drawing: ThumbnailDrawing): { png: Buffer | null; pngRefusal: PngRefusal | null } {
    if (drawing.png === undefined || drawing.png === null)
      return {
        png: null,
        pngRefusal: {
          code: "thumbnail_failed",
          message: (drawing.pngError ?? "The PNG thumbnail could not be drawn.").slice(0, 500),
        },
      };
    if (drawing.png.length > this.#maxThumbnailBytes)
      return {
        png: null,
        pngRefusal: {
          code: "thumbnail_too_large",
          message: `The PNG thumbnail is ${drawing.png.length} bytes, over the ${this.#maxThumbnailBytes}-byte limit.`,
        },
      };
    try {
      assertThumbnailPng(drawing.png);
      return { png: Buffer.from(drawing.png.buffer, drawing.png.byteOffset, drawing.png.byteLength), pngRefusal: null };
    } catch {
      return {
        png: null,
        pngRefusal: { code: "thumbnail_failed", message: "The PNG thumbnail is not a readable PNG." },
      };
    }
  }

  #admit(): Promise<void> {
    if (this.#closed) return Promise.reject(new ThumbnailRefusal("thumbnail_busy", "The service is stopping."));
    if (this.#active < this.#concurrency) {
      this.#active++;
      return Promise.resolve();
    }
    if (this.#waiting.length >= this.#queue)
      return Promise.reject(
        new ThumbnailRefusal(
          "thumbnail_busy",
          "Archer is already drawing as many thumbnails as it allows; try again shortly.",
        ),
      );
    return new Promise((resolve, reject) => this.#waiting.push({ resolve, reject }));
  }

  #release(): void {
    const next = this.#waiting.shift();
    if (next === undefined) this.#active--;
    else next.resolve();
  }

  #ensureIndex(): Map<string, number> {
    if (this.#index !== null) return this.#index;
    ensurePrivateDir(this.#dir);
    const found: [string, number, number][] = [];
    for (const name of readdirSync(this.#dir)) {
      if (!FILE.test(name)) continue;
      try {
        const stats = lstatSync(join(this.#dir, name));
        if (stats.isFile()) found.push([name, stats.size, stats.mtimeMs]);
      } catch {
        // gone meanwhile
      }
    }
    found.sort((a, b) => a[2] - b[2]);
    this.#index = new Map(found.map(([name, size]) => [name, size]));
    this.#total = found.reduce((sum, [, size]) => sum + size, 0);
    this.#evict();
    return this.#index;
  }

  /**
   * The asked variant from the kept file, checked before it is served: the SVG is safe and a
   * compressed copy decodes to it; a PNG starts as one. A file that fails is discarded (drawn again).
   */
  #readVariant(key: string, request: ThumbnailRequest, variant: ThumbnailVariant): Thumbnail | null {
    const index = this.#ensureIndex();
    const name = `${key}.thumb`;
    if (!index.has(name)) return null;
    const path = join(this.#dir, name);
    try {
      const stats = lstatSync(path);
      if (!stats.isFile() || stats.size > 4 * this.#maxThumbnailBytes + 1024) throw new Error("not a thumbnail");
      const kept = decodeKept(readFileSync(path), this.#maxThumbnailBytes);
      const answer = this.#variant(request, kept, variant);
      if (answer.contentType === "image/png") assertThumbnailPng(answer.bytes);
      else {
        assertSafeThumbnail(new TextDecoder("utf-8", { fatal: true }).decode(kept.svg));
        const decoded =
          answer.encoding === "br"
            ? brotliDecompressSync(answer.bytes)
            : answer.encoding === "gzip"
              ? gunzipSync(answer.bytes)
              : null;
        if (decoded !== null && !decoded.equals(kept.svg)) throw new Error("a copy is not its SVG");
      }
      this.#touch(index, name, path, stats.size);
      return answer;
    } catch (failure) {
      // A PNG that was refused when drawn is an answer about the drawing, not a bad file.
      if (failure instanceof ThumbnailRefusal) {
        this.#touch(index, name, path, index.get(name)!);
        throw failure;
      }
      this.#forget(name);
      return null;
    }
  }

  /** Most recently used: last in the index, and on disk for the next start. */
  #touch(index: Map<string, number>, name: string, path: string, size: number): void {
    index.delete(name);
    index.set(name, size);
    try {
      const now = new Date();
      utimesSync(path, now, now);
    } catch {
      /* recency is best-effort */
    }
  }

  #write(key: string, kept: Kept): void {
    const index = this.#ensureIndex();
    const name = `${key}.thumb`,
      path = join(this.#dir, name);
    const temporary = join(this.#dir, `.${name}.${process.pid}.tmp`);
    const bytes = encodeKept(kept);
    try {
      writeFileSync(temporary, bytes, { mode: 0o600, flag: "w" });
      renameSync(temporary, path);
    } catch {
      try {
        unlinkSync(temporary);
      } catch {
        /* none */
      }
      return; // a cache that cannot be written still serves this answer
    }
    const prior = index.get(name);
    if (prior !== undefined) {
      this.#total -= prior;
      index.delete(name);
    }
    const size = statSync(path).size;
    index.set(name, size);
    this.#total += size;
    this.#evict();
  }

  #forget(name: string): void {
    const size = this.#index?.get(name);
    if (size !== undefined) {
      this.#total -= size;
      this.#index!.delete(name);
    }
    try {
      unlinkSync(join(this.#dir, name));
    } catch {
      /* already gone */
    }
  }

  #evict(): void {
    const index = this.#index!;
    while (this.#total > this.#maxBytes) {
      const oldest = index.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#forget(oldest);
    }
  }
}

// ---------------------------------------------------------------- painters

export interface ThumbnailPaintersOptions {
  /** The theme stylesheet, read when the first worker starts. */
  readonly themeCss: () => string;
  /** The Fira Sans faces and resvg WASM for PNG thumbnails, read with the theme; without them only SVGs are drawn. */
  readonly raster?: () => ThumbnailRasterResources;
  /** Worker threads at most; the store's `concurrency` bounds the drawings anyway. */
  readonly workers?: number;
  /** A drawing still running after this long has its worker stopped and fails (the store has long answered timeout). */
  readonly hardTimeoutMs?: number;
  /** The worker module; found beside this module (source or bundle) by default. null: draw in process. */
  readonly worker?: URL | null;
}

interface PainterJob {
  readonly id: number;
  readonly envelope: DiagramEnvelope;
  readonly theme: ThumbnailTheme;
  readonly resolve: (drawing: ThumbnailDrawing) => void;
  readonly reject: (failure: Error) => void;
}

interface PainterSlot {
  readonly worker: Worker;
  ready: boolean;
  job: PainterJob | null;
  timer?: NodeJS.Timeout;
}

/**
 * What a thumbnail looks like depends on: the painter's code (the worker file; in the bundle it names
 * its chunks by content hash, so its bytes change exactly when the drawing code does), the theme
 * and fonts it is given, and the format. Their digest names the painter, so an upgrade that leaves
 * drawing alone keeps every cached thumbnail (ADR 0032), and one that changes it draws afresh.
 */
export function drawingIdentity(format: string, inputs: readonly Uint8Array[]): string {
  const hash = createHash("sha256").update(format);
  const worker = thumbnailWorkerLocation();
  try {
    hash.update(worker === null ? "in-process" : readFileSync(fileURLToPath(worker)));
  } catch {
    hash.update("unreadable");
  }
  for (const input of inputs) hash.update(createHash("sha256").update(input).digest());
  return `drawing-${hash.digest("hex").slice(0, 16)}+${format}`;
}

/** The worker beside this module: dist/thumbnail-worker.js from the bundle (this code may sit in dist/chunks/), or the source file. */
export function thumbnailWorkerLocation(): URL | null {
  for (const candidate of ["./thumbnail-worker.js", "../thumbnail-worker.js", "./thumbnail-worker.ts"]) {
    const url = new URL(candidate, import.meta.url);
    if (existsSync(fileURLToPath(url))) return url;
  }
  return null;
}

/** A source (.ts) worker needs the TypeScript loader the service itself runs under; a worker inherits the parent's flags. */
function workerExecArgv(url: URL): string[] | undefined {
  if (!url.pathname.endsWith(".ts") || process.execArgv.some((flag) => flag.includes("tsx"))) return undefined;
  try {
    return [...process.execArgv, "--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href];
  } catch {
    return undefined;
  }
}

/**
 * Draws thumbnails in worker threads, a few at a time, with the same bytes and
 * the same failures as drawing in process (`drawThumbnail`): a failed drawing
 * rejects with the painter's message, which the store turns into its
 * remembered `thumbnail_failed`. A worker that cannot start (a packaged build
 * missing its worker file, a loader failure) is not an answer about the drawing:
 * that job and every later one are drawn in process instead.
 */
export class ThumbnailPainters {
  readonly #options: ThumbnailPaintersOptions;
  readonly #size: number;
  readonly #hardTimeoutMs: number;
  readonly #slots = new Set<PainterSlot>();
  readonly #queue: PainterJob[] = [];
  #worker: URL | null;
  #themeCss: string | undefined;
  #raster: ThumbnailRasterResources | null | undefined;
  #nextId = 0;
  #closed = false;

  constructor(options: ThumbnailPaintersOptions) {
    this.#options = options;
    this.#size = Math.max(1, options.workers ?? THUMBNAIL_LIMITS.concurrency);
    this.#hardTimeoutMs = options.hardTimeoutMs ?? THUMBNAIL_LIMITS.timeoutMs * 6;
    this.#worker = options.worker === undefined ? thumbnailWorkerLocation() : options.worker;
  }

  /** Whether drawings go to worker threads (false once a worker could not start). */
  get threaded(): boolean {
    return this.#worker !== null;
  }

  readonly render = (envelope: DiagramEnvelope, theme: ThumbnailTheme): Promise<ThumbnailDrawing> => {
    if (this.#closed) return Promise.reject(new Error("The thumbnail painter stopped."));
    if (this.#worker === null) return this.#inProcess(envelope, theme);
    return new Promise<ThumbnailDrawing>((resolve, reject) => {
      this.#queue.push({ id: ++this.#nextId, envelope, theme, resolve, reject });
      this.#pump();
    });
  };

  /** Starts the first worker now, so the first drawing does not wait for its modules to load. */
  warm(): void {
    if (!this.#closed && this.#worker !== null && this.#slots.size === 0) this.#spawn(this.#worker);
  }

  /**
   * Stops every worker and fails what is queued, for good: a later drawing is refused. The queue goes
   * first: retiring a busy worker pumps the queue, which would start a fresh worker for the next
   * drawing, and that worker kept a stopped service's process alive (cli.test "serve starts…").
   */
  close(): void {
    this.#closed = true;
    const stopped = new Error("The thumbnail painter stopped.");
    for (const job of this.#queue.splice(0)) job.reject(stopped);
    for (const slot of [...this.#slots]) this.#retire(slot, stopped);
  }

  get #css(): string {
    return (this.#themeCss ??= this.#options.themeCss());
  }
  get #rasterResources(): ThumbnailRasterResources | null {
    return (this.#raster ??= this.#options.raster?.() ?? null);
  }

  #inProcess(envelope: DiagramEnvelope, theme: ThumbnailTheme): Promise<ThumbnailDrawing> {
    return drawThumbnail(envelope, theme, this.#css, this.#rasterResources);
  }

  #pump(): void {
    if (this.#closed) return;
    while (this.#queue.length > 0) {
      if (this.#worker === null) {
        for (const job of this.#queue.splice(0)) this.#inProcess(job.envelope, job.theme).then(job.resolve, job.reject);
        return;
      }
      const slot = [...this.#slots].find((candidate) => candidate.ready && candidate.job === null);
      if (slot === undefined) {
        if (this.#slots.size >= this.#size || [...this.#slots].some((candidate) => !candidate.ready)) return;
        this.#spawn(this.#worker);
        continue; // it takes work once ready
      }
      this.#assign(slot, this.#queue.shift()!);
    }
  }

  #spawn(url: URL): void {
    let worker: Worker;
    try {
      const execArgv = workerExecArgv(url);
      worker = new Worker(url, {
        workerData: { themeCss: this.#css, raster: this.#rasterResources },
        name: "archer-thumbnails",
        ...(execArgv === undefined ? {} : { execArgv }),
      });
    } catch (failure) {
      return this.#unavailable(failure);
    }
    const slot: PainterSlot = { worker, ready: false, job: null };
    this.#slots.add(slot);
    worker.on("message", (message: { ready?: true; id?: number; drawing?: ThumbnailDrawing; error?: string }) => {
      if (message.ready === true) {
        slot.ready = true;
        return this.#pump();
      }
      const job = slot.job;
      if (job === null || message.id !== job.id) return;
      clearTimeout(slot.timer);
      slot.job = null;
      if (message.drawing !== undefined) job.resolve(message.drawing);
      else job.reject(new Error(message.error ?? "The drawing could not be rendered."));
      this.#pump();
    });
    worker.on("error", (failure) => {
      if (!slot.ready) return this.#startFailed(slot, failure);
      this.#retire(slot, new Error(`The thumbnail painter failed: ${failure.message}`));
    });
    worker.on("exit", (code) => {
      if (!this.#slots.has(slot)) return;
      if (!slot.ready) return this.#startFailed(slot, new Error(`exited with code ${code}`));
      this.#retire(slot, new Error(`The thumbnail painter stopped (exit code ${code}).`));
    });
    // After the listeners: attaching a "message" listener refs the worker again (server review S3).
    worker.unref();
  }

  #assign(slot: PainterSlot, job: PainterJob): void {
    slot.job = job;
    slot.timer = setTimeout(
      () => this.#retire(slot, new Error(`The thumbnail took longer than ${this.#hardTimeoutMs} ms to draw.`)),
      this.#hardTimeoutMs,
    );
    slot.timer.unref();
    // The model is plain JSON; the structured clone is a small fraction of the drawing.
    slot.worker.postMessage({ id: job.id, envelope: job.envelope, theme: job.theme });
  }

  /** Removes a worker, failing its drawing, and lets the queue start a fresh one. */
  #retire(slot: PainterSlot, failure: Error): void {
    if (!this.#slots.delete(slot)) return;
    clearTimeout(slot.timer);
    const job = slot.job;
    slot.job = null;
    void slot.worker.terminate();
    job?.reject(failure);
    this.#pump();
  }

  #startFailed(slot: PainterSlot, failure: unknown): void {
    this.#slots.delete(slot);
    void slot.worker.terminate();
    this.#unavailable(failure);
  }

  #unavailable(failure: unknown): void {
    activeTelemetry()?.log("warn", "svc.thumbnail-worker", "thumbnail worker could not start; drawing in process", {
      data: { error: failure instanceof Error ? failure.message : String(failure) },
    });
    this.#worker = null;
    this.#pump();
  }
}
