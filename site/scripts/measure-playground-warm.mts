/**
 * How quickly the full Playground draws after a docs visit, and what that visit downloads.
 *
 *   npm run docs:build && node --import tsx site/scripts/measure-playground-warm.mts [runs]
 *
 * Each run is a fresh browser profile (a cold HTTP cache), served with GitHub Pages' caching headers
 * (`max-age=600`). It opens a docs page, waits until the page is idle and its warm-up (if any) has finished,
 * then follows a link into the Playground's heartbeat walk and times the click to the first drawn node.
 * Bytes are gzip-9 sizes of the files read from disk, as Pages sends them compressed.
 * The network is throttled (ARCHER_MEASURE_RTT ms, default 40; ARCHER_MEASURE_MBPS, default 20; 0 turns it off):
 * on localhost an uncached Playground draws in about 260 ms, which hides what a reader on Pages waits for.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { chromium } from "@playwright/test";
import { serveStatic } from "../tests/serve-static.ts";

const root = resolve(process.env.ARCHER_DOCS_DIST ?? "site/.vitepress/dist");
const base = process.env.ARCHER_DOCS_BASE ?? "/archer/";
const runs = Number(process.argv[2] ?? 5);
const rtt = Number(process.env.ARCHER_MEASURE_RTT ?? 40);
const mbps = Number(process.env.ARCHER_MEASURE_MBPS ?? 20);
const target = `${base}playground/app/index.html?route=%2Fprojects%2Farcher-tour%2Fdiagrams%2Fheartbeat.mmd&walkthrough=one-turn&step=5`;

const server = await serveStatic(root, base, { pagesCache: true });
const browser = await chromium.launch();
const gzipOf = new Map<string, number>();
async function gzipped(url: string): Promise<number> {
  const path = decodeURIComponent(new URL(url).pathname);
  if (!gzipOf.has(path)) {
    let file = join(root, path.slice(base.length));
    if (path.endsWith("/")) file = join(file, "index.html");
    const bytes = (await readFile(file).catch(() => null)) ?? (await readFile(`${file}.html`).catch(() => null));
    gzipOf.set(path, bytes ? gzipSync(bytes, { level: 9 }).length : 0);
  }
  return gzipOf.get(path)!;
}

async function visit(path: string) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  if (mbps > 0) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    // Applies to the page's navigations and its subresources; workers created by the page inherit it in Chromium.
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: rtt,
      downloadThroughput: (mbps * 1_000_000) / 8,
      uploadThroughput: (mbps * 1_000_000) / 8,
    });
  }
  const seen: { url: string; prefetch: boolean }[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith(server.origin))
      seen.push({ url: request.url(), prefetch: request.headers()["sec-purpose"]?.includes("prefetch") ?? false });
  });
  await page.goto(server.origin + path, { waitUntil: "load" });
  await page.waitForLoadState("networkidle");
  // The warm-up starts once the page is idle after load: give it a moment, then let its downloads finish.
  await page.waitForTimeout(1500);
  await page.waitForLoadState("networkidle");
  const docs = [...seen];
  let gzip = 0;
  let prefetchGzip = 0;
  for (const entry of docs) {
    const size = await gzipped(entry.url);
    gzip += size;
    if (entry.prefetch) prefetchGzip += size;
  }
  // Into the Playground the way a reader goes: a click on a link, in the same tab.
  // What the click still fetches over the wire: not from the disk, memory or prefetch cache.
  const wire = await context.newCDPSession(page);
  await wire.send("Network.enable");
  const cached = new Set<string>();
  const responses: { id: string; url: string; status: number }[] = [];
  wire.on("Network.requestServedFromCache", (event) => cached.add(event.requestId));
  wire.on("Network.responseReceived", (event) => {
    const response = event.response as {
      url: string;
      fromDiskCache?: boolean;
      fromPrefetchCache?: boolean;
      status: number;
    };
    if (response.url.startsWith(server.origin) && !response.fromDiskCache && !response.fromPrefetchCache)
      responses.push({ id: event.requestId, url: response.url.slice(server.origin.length), status: response.status });
  });
  await page.evaluate((href) => {
    const link = document.createElement("a");
    link.href = href;
    link.textContent = "measure";
    link.id = "measure-link";
    link.style.cssText = "position:fixed;top:0;left:0;z-index:99999;background:#fff";
    document.body.append(link);
  }, target);
  const start = Date.now();
  await page.click("#measure-link");
  await page.locator(".react-flow__node").first().waitFor({ state: "visible", timeout: 30_000 });
  const clickToNode = Date.now() - start;
  const overWire = responses.filter((response) => !cached.has(response.id));
  if (process.env.ARCHER_MEASURE_VERBOSE)
    for (const response of overWire) console.error("wire", response.status, response.url);
  const network = overWire.length;
  await context.close();
  return {
    clickToNode,
    requests: docs.length,
    gzip,
    prefetched: docs.filter((e) => e.prefetch).length,
    prefetchGzip,
    network,
  };
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const report: Record<string, unknown> = {
  root,
  runs,
  network: mbps > 0 ? `${rtt} ms RTT, ${mbps} Mbit/s` : "unthrottled",
};
for (const path of [base, `${base}install`]) {
  const results = [];
  for (let run = 0; run < runs; run += 1) results.push(await visit(path));
  const last = results.at(-1)!;
  report[path] = {
    clickToNodeMs: { median: median(results.map((r) => r.clickToNode)), all: results.map((r) => r.clickToNode) },
    docsVisit: {
      requests: last.requests,
      gzipBytes: last.gzip,
      prefetched: last.prefetched,
      prefetchGzipBytes: last.prefetchGzip,
    },
    overTheWireAfterClick: last.network,
  };
}
console.log(JSON.stringify(report, null, 2));
await browser.close();
await server.close();
