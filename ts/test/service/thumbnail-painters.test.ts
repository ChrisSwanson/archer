import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import { revisionOf } from "../../src/project/index.ts";
import { exportThumbnail, THUMBNAIL_PNG_BOX } from "../../src/export/index.ts";
import { drawThumbnail } from "../../src/service/thumbnail-draw.ts";
import { testFontFaces } from "../export/resources.ts";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import {
  ThumbnailPainters,
  ThumbnailRefusal,
  ThumbnailStore,
  thumbnailWorkerLocation,
} from "../../src/service/thumbnails.ts";
import type { DiagramEnvelope } from "../../src/model/envelope.ts";

const themeCss = readFileSync(resolve("../ui/src/styles.css"), "utf8");
const raster = {
  fontFaces: testFontFaces(),
  wasmBytes: readFileSync(resolve("../node_modules/@resvg/resvg-wasm/index_bg.wasm")),
};
const pools: ThumbnailPainters[] = [],
  dirs: string[] = [];
afterEach(() => {
  for (const pool of pools.splice(0)) pool.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const painters = (options: Partial<ConstructorParameters<typeof ThumbnailPainters>[0]> = {}): ThumbnailPainters => {
  const pool = new ThumbnailPainters({ themeCss: () => themeCss, raster: () => raster, ...options });
  pools.push(pool);
  return pool;
};

async function envelopeOf(source: string, id = "drawing"): Promise<DiagramEnvelope> {
  const compiled = await compile(source);
  expect(compiled.model).not.toBeNull();
  return {
    schemaVersion: 2,
    revision: revisionOf(new TextEncoder().encode(source)),
    view: { id, kind: "freeform", title: "Drawing" },
    model: compiled.model!,
  } as DiagramEnvelope;
}
const SMALL = "flowchart LR\n a[A]\n b[B]\n a ab@--> b\n";
const large = (): string => {
  const lines = ["flowchart TD"];
  for (let i = 0; i <= 120; i++) lines.push(`  n${i}["Step ${i}"]`);
  for (let i = 0; i < 120; i++) lines.push(`  n${i} e${i}@--> n${i + 1}`);
  for (let i = 0; i < 120; i += 3) lines.push(`  n${i} x${i}@--> n${(i * 7) % 121}`);
  return `${lines.join("\n")}\n`;
};

test("the worker is found beside the module and draws the same SVG and PNG as drawing in process", async () => {
  expect(thumbnailWorkerLocation()?.pathname.endsWith("/ts/src/service/thumbnail-worker.ts")).toBe(true);
  const pool = painters();
  const envelope = await envelopeOf('flowchart LR\n a["Request & response"]\n b[API]\n a calls@--> b\n');
  for (const theme of ["light", "dark"] as const) {
    const threaded = await pool.render(envelope, theme);
    const direct = await drawThumbnail(envelope, theme, themeCss, raster);
    expect(
      Buffer.from(threaded.svg).equals(Buffer.from((await exportThumbnail(envelope, { theme, themeCss })).bytes)),
    ).toBe(true);
    for (const part of ["svg", "png"] as const)
      expect(Buffer.from(threaded[part]!).equals(Buffer.from(direct[part]!)), part).toBe(true);
    // The compressed copies are the store's (see "no zlib in the painter" below).
    expect([threaded.br, threaded.gzip, direct.br, direct.gzip]).toEqual([undefined, undefined, undefined, undefined]);
    const png = Buffer.from(threaded.png!);
    expect(png.readUInt32BE(16)).toBeLessThanOrEqual(THUMBNAIL_PNG_BOX.width);
    expect(png.readUInt32BE(20)).toBeLessThanOrEqual(THUMBNAIL_PNG_BOX.height);
    expect(threaded.ms!.png).toBeGreaterThan(0);
  }
  expect(pool.threaded).toBe(true);
});

test("without raster resources the painter draws the SVG and names why there is no PNG", async () => {
  const pool = new ThumbnailPainters({ themeCss: () => themeCss });
  pools.push(pool);
  const drawn = await pool.render(await envelopeOf(SMALL), "light");
  expect(drawn.svg.length).toBeGreaterThan(0);
  expect(drawn.png).toBeNull();
  expect(drawn.pngError).toMatch(/raster/);
});

test("a drawing the painter refuses rejects with the painter's message, and the store remembers it as thumbnail_failed", async () => {
  const bad = {
    schemaVersion: 2,
    revision: `sha256:${"c".repeat(64)}`,
    view: { id: "x", kind: "freeform", title: "X" },
    model: { nonsense: true },
  } as unknown as DiagramEnvelope;
  const direct = await exportThumbnail(bad, { theme: "light", themeCss }).then(
    () => null,
    (failure: Error) => failure.message,
  );
  expect(direct).not.toBeNull();
  const pool = painters();
  await expect(pool.render(bad, "light")).rejects.toThrow(direct!);
  const dir = mkdtempSync(join(tmpdir(), "archer-thumbs-"));
  dirs.push(dir);
  const store = new ThumbnailStore({ dir, render: pool.render });
  const request = { viewId: "x", revision: bad.revision, theme: "light" } as const;
  const first = await store.get(request, bad).catch((failure: unknown) => failure);
  expect(first).toBeInstanceOf(ThumbnailRefusal);
  expect((first as ThumbnailRefusal).code).toBe("thumbnail_failed");
  expect((first as ThumbnailRefusal).message).toBe(direct);
  expect(store.ready(request)).toBe(true);
});

test("a large drawing in the worker leaves the event loop free", async () => {
  const pool = painters();
  const envelope = await envelopeOf(large());
  await pool.render(await envelopeOf(SMALL), "light"); // the worker has loaded the painter
  let worst = 0,
    last = performance.now(),
    ticking = true;
  const tick = (): void => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
    if (ticking) setTimeout(tick, 5);
  };
  setTimeout(tick, 5);
  const started = performance.now();
  await pool.render(envelope, "dark");
  const drawing = performance.now() - started;
  ticking = false;
  expect(drawing).toBeGreaterThan(150); // a drawing that would have held the loop
  expect(worst).toBeLessThan(100);
});

test("without a worker it draws in process, and a worker that cannot start falls back the same way", async () => {
  const envelope = await envelopeOf(SMALL);
  const direct = (await exportThumbnail(envelope, { theme: "light", themeCss })).bytes;
  const inline = painters({ worker: null });
  const drawn = await inline.render(envelope, "light");
  expect(Buffer.from(drawn.svg).equals(Buffer.from(direct))).toBe(true);
  expect(drawn.png).not.toBeNull();
  expect(inline.threaded).toBe(false);
  const missing = painters({ worker: new URL("./no-such-worker.mjs", import.meta.url) });
  expect(Buffer.from((await missing.render(envelope, "light")).svg).equals(Buffer.from(direct))).toBe(true);
  expect(missing.threaded).toBe(false);
});

// O32: a painter is terminated mid-drawing (close on service stop, the hard deadline), and a
// termination that lands between a zlib handle's creation and its init aborts the whole process
// (node_zlib.cc "close before init", at the worker's cleanup). So no zlib handle is ever made in a
// painter: here the real worker runs under an async hook that fails it on the first ZLIB handle
// (gzip and brotli alike), and the store still keeps both compressed copies.
test("no zlib in the painter: the worker makes no zlib handle, and the store compresses what it keeps", async () => {
  const dir = mkdtempSync(join(tmpdir(), "archer-thumbs-"));
  dirs.push(dir);
  const watched = join(dir, "zlib-watched-worker.ts");
  writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n'); // tsx then loads it as ESM (top-level await)
  // A throw inside an async hook is fatal to the whole process, so the hook only counts, and the
  // painter's answer becomes a failure naming the handles.
  writeFileSync(
    watched,
    [
      'import { createHook } from "node:async_hooks";',
      'import { parentPort } from "node:worker_threads";',
      "let made = 0;",
      'createHook({ init(_id: number, type: string) { if (type === "ZLIB") made++; } }).enable();',
      "const post = parentPort!.postMessage.bind(parentPort!);",
      "parentPort!.postMessage = (message: { id?: number }, transfer?: never) => made === 0 || message.id === undefined ? post(message, transfer) : post({ id: message.id, error: `the painter made ${made} zlib handle(s)` });",
      `await import(${JSON.stringify(thumbnailWorkerLocation()!.href)});`,
    ].join("\n"),
  );
  const pool = painters({ worker: pathToFileURL(watched) });
  const envelope = await envelopeOf(SMALL);
  const store = new ThumbnailStore({ dir: join(dir, "cache"), render: pool.render });
  const request = { viewId: "drawing", revision: envelope.revision, theme: "light" } as const;
  for (const encoding of ["br", "gzip"] as const) {
    const answer = await store.get(request, envelope, { codings: new Set([encoding]) });
    expect(answer.encoding).toBe(encoding);
    const svg = encoding === "br" ? brotliDecompressSync(answer.bytes) : gunzipSync(answer.bytes);
    expect(svg.equals(Buffer.from((await exportThumbnail(envelope, { theme: "light", themeCss })).bytes))).toBe(true);
  }
  expect(pool.threaded).toBe(true);
});

test("a drawing past the hard deadline stops its worker and fails", async () => {
  const pool = painters({ hardTimeoutMs: 1 });
  await expect(pool.render(await envelopeOf(large()), "light")).rejects.toThrow(/longer than 1 ms/);
  expect(pool.threaded).toBe(true);
});

test("close fails what is queued and starts no fresh worker for it (a stopped service then exits)", async () => {
  const pool = painters({ workers: 1 });
  const envelope = await envelopeOf(large());
  pool.warm();
  const drawings = [pool.render(envelope, "light"), pool.render(envelope, "dark"), pool.render(envelope, "light")];
  // Retiring the busy worker used to pump the queue into a fresh worker that nothing stopped: the
  // queued drawings then finished on it, and its port kept a stopped service's process alive.
  pool.close();
  const settled = await Promise.allSettled(drawings);
  expect(settled.map((outcome) => outcome.status)).toEqual(["rejected", "rejected", "rejected"]);
}, 40_000);
