import { createRequire } from "node:module";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  ThumbnailRefusal,
  ThumbnailStore,
  type ThumbnailDrawing,
  type ThumbnailRender,
} from "../../src/service/thumbnails.ts";
import { version } from "../../src/version.ts";

const require = createRequire(import.meta.url);
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const cacheDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "archer-thumbs-"));
  dirs.push(dir);
  return join(dir, "thumbnails");
};

const REV_A = `sha256:${"a".repeat(64)}`;
const REV_B = `sha256:${"b".repeat(64)}`;
const svg = (label: string, pad = 0): Uint8Array =>
  new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg"><text>${label}${" ".repeat(pad)}</text></svg>`);
const counting = (pad = 0): ThumbnailRender & { calls: string[] } => {
  const calls: string[] = [];
  const render = Object.assign(
    async (envelope: { revision: string }, theme: string) => {
      calls.push(`${envelope.revision}|${theme}`);
      return svg(`${envelope.revision}|${theme}`, pad);
    },
    { calls },
  );
  return render as ThumbnailRender & { calls: string[] };
};
const envelope = (revision: string) => ({ revision }) as never;
const files = (dir: string): string[] => readdirSync(dir).filter((name) => name.endsWith(".thumb"));
/** A minimal PNG: signature and an IHDR of these dimensions (the store checks no more). */
const png = (width = 640, height = 360): Uint8Array => {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
};
const brotli = (s: string): Uint8Array => new Uint8Array(require("node:zlib").brotliCompressSync(Buffer.from(s)));
const gzipped = (s: string): Uint8Array => new Uint8Array(require("node:zlib").gzipSync(Buffer.from(s)));
const drawing = (label: string, withPng = true): ThumbnailDrawing => {
  const text = new TextDecoder().decode(svg(label));
  return {
    svg: svg(label),
    br: brotli(text),
    gzip: gzipped(text),
    png: withPng ? png() : null,
    ...(withPng ? {} : { pngError: "no raster here" }),
  };
};

test("a rendered thumbnail is kept on disk and served again without rendering, across store instances", async () => {
  const dir = cacheDir(),
    render = counting();
  const first = await new ThumbnailStore({ dir, render }).get(
    { viewId: "flow", revision: REV_A, theme: "dark" },
    envelope(REV_A),
  );
  const again = await new ThumbnailStore({ dir, render }).get(
    { viewId: "flow", revision: REV_A, theme: "dark" },
    envelope(REV_A),
  );
  expect(render.calls).toEqual([`${REV_A}|dark`]);
  expect(Buffer.from(again.bytes).equals(Buffer.from(first.bytes))).toBe(true);
  expect(again.etag).toBe(first.etag);
  expect(statSync(dir).mode & 0o077).toBe(0);
});

test("the store's version names its painter: stable for one, different for another", () => {
  const dir = cacheDir(),
    render = counting();
  const v1 = new ThumbnailStore({ dir, render, painter: "1.0.0" }).version;
  expect(v1).toMatch(/^[0-9a-f]{12}$/);
  expect(new ThumbnailStore({ dir, render, painter: "1.0.0" }).version).toBe(v1);
  expect(new ThumbnailStore({ dir, render, painter: "1.1.0" }).version).not.toBe(v1);
});

test("thumbnails are keyed by view, revision and theme", async () => {
  const store = new ThumbnailStore({ dir: cacheDir(), render: counting() });
  const tags = new Set<string>();
  for (const [viewId, revision, theme] of [
    ["flow", REV_A, "dark"],
    ["flow", REV_B, "dark"],
    ["flow", REV_A, "light"],
    ["note.md#flow", REV_A, "dark"],
  ] as const)
    tags.add((await store.get({ viewId, revision, theme }, envelope(revision))).etag);
  expect(tags.size).toBe(4);
});

test("concurrent requests for one thumbnail share one render", async () => {
  const render = counting(),
    store = new ThumbnailStore({ dir: cacheDir(), render });
  await Promise.all(
    Array.from({ length: 5 }, () => store.get({ viewId: "flow", revision: REV_A, theme: "dark" }, envelope(REV_A))),
  );
  expect(render.calls).toHaveLength(1);
});

test("renders run at most `concurrency` at a time, and a full queue is refused as busy", async () => {
  let active = 0,
    peak = 0;
  const gates: (() => void)[] = [];
  const render: ThumbnailRender = async (env) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => gates.push(resolve));
    active--;
    return svg(env.revision);
  };
  const store = new ThumbnailStore({ dir: cacheDir(), render, concurrency: 2, queue: 2 });
  const rev = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
  const admitted = [1, 2, 3, 4].map((n) =>
    store.get({ viewId: "v", revision: rev(n), theme: "dark" }, envelope(rev(n))),
  );
  await expect(store.get({ viewId: "v", revision: rev(5), theme: "dark" }, envelope(rev(5)))).rejects.toMatchObject({
    code: "thumbnail_busy",
  });
  while (gates.length < 2) await new Promise((r) => setTimeout(r, 1));
  expect(peak).toBe(2);
  let done = 0;
  for (const get of admitted) void get.then(() => done++);
  while (done < admitted.length) {
    gates.shift()?.();
    await new Promise((r) => setTimeout(r, 1));
  }
  expect(peak).toBe(2);
});

test("a render that outlives its deadline is refused as a timeout and keeps its slot until it settles", async () => {
  let release!: () => void;
  const render: ThumbnailRender = async (env) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return svg(env.revision);
  };
  const store = new ThumbnailStore({ dir: cacheDir(), render, concurrency: 1, queue: 0, timeoutMs: 20 });
  await expect(store.get({ viewId: "v", revision: REV_A, theme: "dark" }, envelope(REV_A))).rejects.toMatchObject({
    code: "thumbnail_timeout",
  });
  // The slow render still holds the only slot: no second render starts.
  await expect(store.get({ viewId: "v", revision: REV_B, theme: "dark" }, envelope(REV_B))).rejects.toMatchObject({
    code: "thumbnail_busy",
  });
  release();
  // Its late result was kept (written once its compression settles: polled, not a fixed 10 ms, which failed under load).
  await expect.poll(() => store.ready({ viewId: "v", revision: REV_A, theme: "dark" })).toBe(true);
  expect(
    (await store.get({ viewId: "v", revision: REV_A, theme: "dark" }, envelope(REV_A))).bytes.length,
  ).toBeGreaterThan(0);
});

test("an unsafe or oversized render is refused and never written", async () => {
  const dir = cacheDir();
  const unsafe = new ThumbnailStore({
    dir,
    render: async () => new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'),
  });
  await expect(unsafe.get({ viewId: "v", revision: REV_A, theme: "dark" }, envelope(REV_A))).rejects.toBeInstanceOf(
    ThumbnailRefusal,
  );
  const large = new ThumbnailStore({ dir, render: counting(2_000), maxThumbnailBytes: 1_000 });
  await expect(large.get({ viewId: "v", revision: REV_B, theme: "dark" }, envelope(REV_B))).rejects.toMatchObject({
    code: "thumbnail_too_large",
  });
  expect(files(dir)).toEqual([]);
});

test("the disk cache stays within its byte bound by evicting the least recently used", async () => {
  const dir = cacheDir(),
    render = counting(900);
  const store = new ThumbnailStore({ dir, render, maxBytes: 3_500 });
  const rev = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
  for (const n of [1, 2, 3]) await store.get({ viewId: "v", revision: rev(n), theme: "dark" }, envelope(rev(n)));
  await store.get({ viewId: "v", revision: rev(1), theme: "dark" }, envelope(rev(1))); // 1 is now the most recent
  await store.get({ viewId: "v", revision: rev(4), theme: "dark" }, envelope(rev(4)));
  const total = files(dir).reduce((sum, n) => sum + statSync(join(dir, n)).size, 0);
  expect(total).toBeLessThanOrEqual(3_500);
  render.calls.length = 0;
  await store.get({ viewId: "v", revision: rev(1), theme: "dark" }, envelope(rev(1)));
  expect(render.calls).toEqual([]);
  await store.get({ viewId: "v", revision: rev(2), theme: "dark" }, envelope(rev(2)));
  expect(render.calls).toEqual([`${rev(2)}|dark`]);
});

test("a cached file that is not a safe thumbnail is discarded and rendered again", async () => {
  const dir = cacheDir(),
    render = counting();
  const store = new ThumbnailStore({ dir, render });
  await store.get({ viewId: "v", revision: REV_A, theme: "dark" }, envelope(REV_A));
  const [name] = files(dir);
  // The same container, its SVG swapped for an unsafe one of the same length.
  const kept = readFileSync(join(dir, name!)),
    at = kept.indexOf("<svg ");
  Buffer.from("<svg><script>alert(1)</script>".padEnd(kept.indexOf("</svg>") - at, " ")).copy(kept, at);
  writeFileSync(join(dir, name!), kept);
  const fresh = new ThumbnailStore({ dir, render });
  const served = await fresh.get({ viewId: "v", revision: REV_A, theme: "dark" }, envelope(REV_A));
  expect(new TextDecoder().decode(served.bytes)).not.toContain("<script");
  expect(render.calls).toHaveLength(2);
});

test("a refusal that depends only on the drawing is remembered: asking again does not draw again", async () => {
  let calls = 0;
  const render: ThumbnailRender = async () => {
    calls++;
    throw new Error("Export drawing has no extent.");
  };
  const store = new ThumbnailStore({ dir: cacheDir(), render });
  const request = { viewId: "flow", revision: REV_A, theme: "dark" } as const;
  await expect(store.get(request, envelope(REV_A))).rejects.toMatchObject({ code: "thumbnail_failed" });
  await expect(store.get(request, envelope(REV_A))).rejects.toMatchObject({ code: "thumbnail_failed" });
  expect(calls).toBe(1);
  expect(store.ready(request)).toBe(true);
  // Another revision is another drawing.
  await expect(store.get({ ...request, revision: REV_B }, envelope(REV_B))).rejects.toBeInstanceOf(ThumbnailRefusal);
  expect(calls).toBe(2);
});

test("a timeout is not remembered: the next request draws again", async () => {
  let calls = 0;
  const render: ThumbnailRender = async (env) => {
    calls++;
    if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 60));
    return svg(env.revision);
  };
  const store = new ThumbnailStore({ dir: cacheDir(), render, timeoutMs: 20 });
  const request = { viewId: "flow", revision: REV_A, theme: "dark" } as const;
  await expect(store.get(request, envelope(REV_A))).rejects.toMatchObject({ code: "thumbnail_timeout" });
  await new Promise((resolve) => setTimeout(resolve, 80));
  // The late result was kept; either way nothing was remembered as refused.
  expect((await store.get(request, envelope(REV_A))).bytes.length).toBeGreaterThan(0);
});

test("prefetch draws in the background, one at a time, and a request then finds it kept", async () => {
  const render = counting(),
    store = new ThumbnailStore({ dir: cacheDir(), render, backgroundDelayMs: 5 });
  const jobs = (["light", "dark"] as const).map((theme) => ({
    request: { viewId: "flow", revision: REV_A, theme },
    envelope: () => envelope(REV_A),
  }));
  store.prefetch(jobs);
  store.prefetch(jobs); // asked twice, drawn once
  const deadline = Date.now() + 2_000;
  // Ready once kept: drawn, then (this painter returns the SVG alone) compressed and written.
  while (!jobs.every((job) => store.ready(job.request)) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(render.calls.sort()).toEqual([`${REV_A}|dark`, `${REV_A}|light`]);
  expect(jobs.every((job) => store.ready(job.request))).toBe(true);
  await store.get(jobs[0]!.request, envelope(REV_A));
  expect(render.calls).toHaveLength(2);
  store.close();
});

test("prefetch skips a drawing whose model moved on, and waits while a request is drawing", async () => {
  const gates: (() => void)[] = [];
  const calls: string[] = [];
  const render: ThumbnailRender = async (env, theme) => {
    calls.push(`${env.revision}|${theme}`);
    if (theme === "dark") await new Promise<void>((resolve) => gates.push(resolve));
    return svg(env.revision);
  };
  const store = new ThumbnailStore({ dir: cacheDir(), render, backgroundDelayMs: 5 });
  const foreground = store.get({ viewId: "flow", revision: REV_A, theme: "dark" }, envelope(REV_A));
  store.prefetch([
    { request: { viewId: "flow", revision: REV_A, theme: "light" }, envelope: () => envelope(REV_A) },
    // The view is at REV_B now: nothing to draw for REV_A's successor that is not current.
    { request: { viewId: "gone", revision: REV_A, theme: "light" }, envelope: () => null },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(calls).toEqual([`${REV_A}|dark`]);
  gates.splice(0).forEach((open) => open());
  await foreground;
  const deadline = Date.now() + 2_000;
  while (calls.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(calls).toEqual([`${REV_A}|dark`, `${REV_A}|light`]);
  store.close();
});

test("prefetch waits while its owner is busy", async () => {
  const render = counting();
  let idle = false;
  const store = new ThumbnailStore({ dir: cacheDir(), render, backgroundDelayMs: 5, idle: () => idle });
  store.prefetch([{ request: { viewId: "flow", revision: REV_A, theme: "light" }, envelope: () => envelope(REV_A) }]);
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(render.calls).toEqual([]);
  idle = true;
  const deadline = Date.now() + 2_000;
  while (render.calls.length < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(render.calls).toEqual([`${REV_A}|light`]);
  store.close();
});

test("after finding a request drawing, background drawing looks again after busyRetryMs", async () => {
  const gates: (() => void)[] = [];
  const calls: string[] = [];
  const render: ThumbnailRender = async (env, theme) => {
    calls.push(`${env.revision}|${theme}`);
    if (theme === "dark") await new Promise<void>((resolve) => gates.push(resolve));
    return svg(env.revision);
  };
  const request = { viewId: "flow", revision: REV_A, theme: "light" } as const;
  const run = async (busyRetryMs: number): Promise<string[]> => {
    calls.length = 0;
    const store = new ThumbnailStore({ dir: cacheDir(), render, backgroundDelayMs: 5, busyRetryMs });
    const foreground = store.get({ viewId: "flow", revision: REV_A, theme: "dark" }, envelope(REV_A));
    store.prefetch([{ request, envelope: () => envelope(REV_A) }]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    gates.splice(0).forEach((open) => open());
    await foreground;
    await new Promise((resolve) => setTimeout(resolve, 150));
    store.close();
    return [...calls];
  };
  expect(await run(10)).toEqual([`${REV_A}|dark`, `${REV_A}|light`]);
  expect(await run(10_000)).toEqual([`${REV_A}|dark`]);
});

test("one drawing keeps its SVG, its compressed copies and its PNG in one file, each served as asked", async () => {
  const dir = cacheDir();
  let calls = 0;
  const store = new ThumbnailStore({
    dir,
    render: async () => {
      calls++;
      return drawing("hello");
    },
  });
  const request = { viewId: "flow", revision: REV_A, theme: "dark" } as const;
  const plain = await store.get(request, envelope(REV_A));
  expect(plain.contentType).toBe("image/svg+xml");
  expect(plain.encoding).toBeUndefined();
  expect(new TextDecoder().decode(plain.bytes)).toContain("hello");
  const br = await store.get(request, envelope(REV_A), { codings: new Set(["gzip", "br"]) });
  expect(br.encoding).toBe("br");
  expect(brotliDecompressSync(br.bytes).equals(Buffer.from(plain.bytes))).toBe(true);
  const gz = await store.get(request, envelope(REV_A), { codings: new Set(["gzip"]) });
  expect(gz.encoding).toBe("gzip");
  expect(gunzipSync(gz.bytes).equals(Buffer.from(plain.bytes))).toBe(true);
  // One validator across the encodings of the SVG (weak, as the page's); another for the PNG.
  expect(new Set([plain.etag, br.etag, gz.etag, store.etag(request)]).size).toBe(1);
  expect(plain.etag).toMatch(/^W\/"[0-9a-f]{64}"$/);
  const raster = await store.get(request, envelope(REV_A), { format: "png", codings: new Set(["br"]) });
  expect(raster.contentType).toBe("image/png");
  expect(raster.encoding).toBeUndefined();
  expect(Buffer.from(raster.bytes).equals(Buffer.from(png()))).toBe(true);
  expect(raster.etag).toBe(store.etag(request, "png"));
  expect(raster.etag).not.toBe(plain.etag);
  expect(calls).toBe(1);
  expect(files(dir)).toHaveLength(1);
  // A restart serves every variant from the file without drawing.
  const again = new ThumbnailStore({
    dir,
    render: async () => {
      calls++;
      return drawing("other");
    },
  });
  expect(
    Buffer.from((await again.get(request, envelope(REV_A), { format: "png" })).bytes).equals(Buffer.from(png())),
  ).toBe(true);
  expect((await again.get(request, envelope(REV_A), { codings: new Set(["br"]) })).encoding).toBe("br");
  expect(calls).toBe(1);
});

test("a painter that returns only the SVG still gets compressed copies; its PNG is refused, the SVG is not", async () => {
  const store = new ThumbnailStore({ dir: cacheDir(), render: counting() });
  const request = { viewId: "flow", revision: REV_A, theme: "light" } as const;
  const br = await store.get(request, envelope(REV_A), { codings: new Set(["br"]) });
  expect(br.encoding).toBe("br");
  await expect(store.get(request, envelope(REV_A), { format: "png" })).rejects.toMatchObject({
    code: "thumbnail_failed",
  });
  expect((await store.get(request, envelope(REV_A))).contentType).toBe("image/svg+xml");
});

test("a PNG the painter could not draw is refused with its reason, also after a restart", async () => {
  const dir = cacheDir();
  const request = { viewId: "flow", revision: REV_A, theme: "light" } as const;
  const store = new ThumbnailStore({ dir, render: async () => drawing("x", false) });
  await expect(store.get(request, envelope(REV_A), { format: "png" })).rejects.toMatchObject({
    code: "thumbnail_failed",
    message: "no raster here",
  });
  expect(store.ready(request)).toBe(true);
  let calls = 0;
  const fresh = new ThumbnailStore({
    dir,
    render: async () => {
      calls++;
      return drawing("x");
    },
  });
  await expect(fresh.get(request, envelope(REV_A), { format: "png" })).rejects.toMatchObject({
    code: "thumbnail_failed",
    message: "no raster here",
  });
  expect(calls).toBe(0);
});

test("a PNG over the byte limit is refused as too large while its SVG is kept", async () => {
  const store = new ThumbnailStore({
    dir: cacheDir(),
    maxThumbnailBytes: 1_000,
    render: async () => ({
      ...drawing("x"),
      png: new Uint8Array(Buffer.concat([Buffer.from(png()), Buffer.alloc(2_000)])),
    }),
  });
  const request = { viewId: "flow", revision: REV_A, theme: "light" } as const;
  await expect(store.get(request, envelope(REV_A), { format: "png" })).rejects.toMatchObject({
    code: "thumbnail_too_large",
  });
  expect((await store.get(request, envelope(REV_A))).contentType).toBe("image/svg+xml");
});

test("a kept copy that does not match its SVG, or a PNG that is not one, is discarded and drawn again", async () => {
  const dir = cacheDir();
  let calls = 0;
  const render: ThumbnailRender = async () => {
    calls++;
    return drawing("hello");
  };
  const request = { viewId: "flow", revision: REV_A, theme: "dark" } as const;
  await new ThumbnailStore({ dir, render }).get(request, envelope(REV_A));
  const [name] = files(dir);
  const kept = readFileSync(join(dir, name!));
  // Corrupt the PNG's signature (the last 33 bytes are the PNG).
  kept.fill(0, kept.length - 33, kept.length - 25);
  writeFileSync(join(dir, name!), kept);
  const store = new ThumbnailStore({ dir, render });
  expect(
    Buffer.from((await store.get(request, envelope(REV_A), { format: "png" })).bytes).equals(Buffer.from(png())),
  ).toBe(true);
  expect(calls).toBe(2);
});

test("the store names the format pages should ask for: svg unless chosen", () => {
  expect(new ThumbnailStore({ dir: cacheDir(), render: counting() }).format).toBe("svg");
  expect(new ThumbnailStore({ dir: cacheDir(), render: counting(), format: "png" }).format).toBe("png");
});

// Server review S8: a large diagram's SVG passed the byte limit, and that refused its PNG too, so
// a PNG gallery never showed it. The limit applies to the format served.
test("a PNG store keeps a PNG whose SVG is over the byte limit, and refuses only that SVG", async () => {
  const dir = cacheDir();
  const big = (): ThumbnailDrawing => ({ svg: svg("x", 2_000), png: drawing("x").png! });
  const store = new ThumbnailStore({ dir, format: "png", maxThumbnailBytes: 1_000, render: async () => big() });
  const request = { viewId: "flow", revision: REV_A, theme: "light" } as const;
  expect((await store.get(request, envelope(REV_A), { format: "png" })).contentType).toBe("image/png");
  await expect(store.get(request, envelope(REV_A))).rejects.toMatchObject({ code: "thumbnail_too_large" });
  // Kept on disk the same way: a fresh store answers both without drawing.
  let calls = 0;
  const fresh = new ThumbnailStore({
    dir,
    format: "png",
    maxThumbnailBytes: 1_000,
    render: async () => {
      calls++;
      return big();
    },
  });
  expect((await fresh.get(request, envelope(REV_A), { format: "png" })).contentType).toBe("image/png");
  await expect(fresh.get(request, envelope(REV_A))).rejects.toMatchObject({ code: "thumbnail_too_large" });
  expect(calls).toBe(0);
});

test("an SVG store still refuses an SVG over the byte limit", async () => {
  const store = new ThumbnailStore({
    dir: cacheDir(),
    format: "svg",
    maxThumbnailBytes: 1_000,
    render: async (): Promise<ThumbnailDrawing> => ({ svg: svg("x", 2_000), png: drawing("x").png! }),
  });
  await expect(
    store.get({ viewId: "v", revision: REV_A, theme: "dark" }, envelope(REV_A), { format: "png" }),
  ).rejects.toMatchObject({ code: "thumbnail_too_large" });
});

test("the drawing identity follows what draws (worker code, theme, fonts, format), not Archer's version", async () => {
  const { drawingIdentity } = await import("../../src/service/thumbnails.ts");
  const theme = new TextEncoder().encode("theme"),
    font = new TextEncoder().encode("font");
  const id = drawingIdentity("png", [theme, font]);
  expect(drawingIdentity("png", [theme, font])).toBe(id);
  expect(drawingIdentity("svg", [theme, font])).not.toBe(id);
  expect(drawingIdentity("png", [theme, new TextEncoder().encode("other font")])).not.toBe(id);
  expect(id).not.toContain(version());
});
