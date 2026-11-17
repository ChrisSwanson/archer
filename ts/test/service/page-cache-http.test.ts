// The page is revalidated on every load (EX-S1-01 as extended by D8: ETag + private, no-cache, so a reload
// is a 304) and sent
// compressed when the browser accepts it; decoded, every copy is the page's bytes.
import { request } from "node:http";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterEach, expect, test } from "vitest";
import { connectService } from "../../src/service/index.ts";
import { pageBrotliRuns, pageGzipRuns } from "../../src/service/http.ts";
import { cleanUp, project, service, tempDir, write } from "./support.ts";
import { readPrecompressed, withApplicationVersion, writePrecompressedPage } from "../../src/service/page-version.ts";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { version } from "../../src/version.ts";

afterEach(cleanUp);

interface Raw {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
}
function raw(url: string, headers: Record<string, string> = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function servedPage() {
  // A small page keeps the compression quick; its bytes are what every copy must decode to.
  const dir = tempDir("archer-page-");
  const bytes = Buffer.from(`<!doctype html><html><body>${"Archer page ".repeat(4000)}</body></html>`, "utf8");
  write(dir, "page.html", bytes.toString("utf8"));
  const { svc } = await service({ pagePath: join(dir, "page.html") });
  const client = await connectService(svc.socketPath);
  const { url } = await client.call("attach", { root: project() });
  client.close();
  const exchange = await raw(url);
  expect(exchange.status).toBe(303);
  // The token exchange itself is never cached and still sets the cookie.
  expect(exchange.headers["cache-control"]).toBe("no-store");
  const cookie = (exchange.headers["set-cookie"] as string[])[0]!.split(";")[0]!;
  // Served naming the version that serves it (ADR 0032).
  return {
    bytes: withApplicationVersion(bytes, version()),
    page: new URL(exchange.headers.location as string, url).href,
    cookie,
  };
}

test("the page carries a validator, and a reload with it is a 304 without a body", async () => {
  const { bytes, page, cookie } = await servedPage();
  const first = await raw(page, { cookie });
  expect(first.status).toBe(200);
  expect(first.headers["cache-control"]).toBe("private, no-cache");
  expect(first.headers["vary"]).toBe("accept-encoding");
  expect(first.headers["content-encoding"]).toBeUndefined();
  expect(first.body.equals(bytes)).toBe(true);
  const etag = first.headers["etag"] as string;
  expect(etag).toMatch(/^W\/"[0-9a-f]{32}"$/);

  const again = await raw(page, { cookie, "if-none-match": etag });
  expect(again.status).toBe(304);
  expect(again.body.length).toBe(0);
  expect(again.headers["etag"]).toBe(etag);
  expect(again.headers["content-security-policy"]).toContain("img-src 'self' data:");
  // A stale validator gets the page.
  expect((await raw(page, { cookie, "if-none-match": 'W/"0000"' })).status).toBe(200);
  // Without the cookie the validator buys nothing: still the bare 404.
  expect((await raw(page, { "if-none-match": etag })).status).toBe(404);
});

test("a started service and a gzip-only reader never start brotli (a pending q11 job would hold up a stop)", async () => {
  const brotliBefore = pageBrotliRuns();
  const { page, cookie } = await servedPage();
  expect((await raw(page, { cookie, "accept-encoding": "gzip" })).headers["content-encoding"]).toBe("gzip");
  expect(pageBrotliRuns() - brotliBefore).toBe(0);
});

test("the very first gzip-capable request is compressed, with no warm-up and no polling", async () => {
  const { bytes, page, cookie } = await servedPage();
  const first = await raw(page, { cookie, "accept-encoding": "gzip, deflate, br" });
  expect(first.headers["content-encoding"]).toBe("gzip");
  expect(Number(first.headers["content-length"])).toBe(first.body.length);
  expect(first.body.length).toBeLessThan(bytes.length / 4);
  expect(gunzipSync(first.body).equals(bytes)).toBe(true);
});

test("five parallel first requests are all compressed, from one compression", async () => {
  const { bytes, page, cookie } = await servedPage();
  const before = pageGzipRuns();
  const answers = await Promise.all([1, 2, 3, 4, 5].map(() => raw(page, { cookie, "accept-encoding": "gzip" })));
  for (const answer of answers) {
    expect(answer.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(answer.body).equals(bytes)).toBe(true);
  }
  expect(pageGzipRuns() - before).toBe(1);
});

test("br appears after gzip with the same validator; identity stays raw; a 304 still matches", async () => {
  const { bytes, page, cookie } = await servedPage();
  const before = pageGzipRuns();
  const gz = await raw(page, { cookie, "accept-encoding": "gzip" });
  expect(gz.headers["content-encoding"]).toBe("gzip");
  const deadline = Date.now() + 10_000;
  let br: Raw;
  // Brotli starts after gzip settles; until it exists a br-capable reader gets gzip.
  do {
    br = await raw(page, { cookie, "accept-encoding": "gzip, deflate, br" });
    if (br.headers["content-encoding"] === "br") break;
    expect(br.headers["content-encoding"]).toBe("gzip");
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  expect(br.headers["content-encoding"]).toBe("br");
  expect(br.body.length).toBeLessThan(bytes.length / 4);
  expect(Number(br.headers["content-length"])).toBe(br.body.length);
  expect(brotliDecompressSync(br.body).equals(bytes)).toBe(true);
  expect(br.headers["etag"]).toBe(gz.headers["etag"]);
  const plain = await raw(page, { cookie, "accept-encoding": "identity" });
  expect(plain.headers["content-encoding"]).toBeUndefined();
  expect(plain.body.equals(bytes)).toBe(true);
  expect(pageGzipRuns() - before).toBe(1);
  expect(
    (await raw(page, { cookie, "accept-encoding": "br", "if-none-match": gz.headers["etag"] as string })).status,
  ).toBe(304);
});

test("a br-only reader gets the raw page rather than waiting for brotli", async () => {
  const { bytes, page, cookie } = await servedPage();
  const first = await raw(page, { cookie, "accept-encoding": "br" });
  expect(first.headers["content-encoding"]).toBeUndefined();
  expect(first.body.equals(bytes)).toBe(true);
});

test("packaged compressed copies are used when their hash matches the served bytes, and ignored otherwise", () => {
  const dir = tempDir("archer-page-pre-");
  const page = join(dir, "page.html");
  write(dir, "page.html", `<!doctype html><html><head></head><body>${"Archer page ".repeat(4000)}</body></html>`);
  writePrecompressedPage(page, version());
  const served = withApplicationVersion(readFileSync(page), version());
  const found = readPrecompressed(page, served);
  expect(found).not.toBeNull();
  expect(gunzipSync(found!.gzip).equals(served)).toBe(true);
  expect(brotliDecompressSync(found!.br).equals(served)).toBe(true);
  // A page edited after packaging, or served under another version, falls back to run-time compression.
  expect(readPrecompressed(page, withApplicationVersion(readFileSync(page), "9.9.9"))).toBeNull();
  writeFileSync(`${page}.gz`, Buffer.from("not gzip"));
  expect(readPrecompressed(page, served)).toBeNull();
  rmSync(`${page}.sha256`);
  expect(readPrecompressed(page, served)).toBeNull();
});

test("a service started on a packaged page serves its copies with no run-time compression", async () => {
  const dir = tempDir("archer-page-pre-");
  const pagePath = join(dir, "page.html");
  write(dir, "page.html", `<!doctype html><html><head></head><body>${"Archer page ".repeat(4000)}</body></html>`);
  writePrecompressedPage(pagePath, version());
  const { svc } = await service({ pagePath });
  const client = await connectService(svc.socketPath);
  const { url } = await client.call("attach", { root: project() });
  client.close();
  const exchange = await raw(url);
  const cookie = (exchange.headers["set-cookie"] as string[])[0]!.split(";")[0]!;
  const page = new URL(exchange.headers.location as string, url).href;
  const before = pageGzipRuns();
  const answer = await raw(page, { cookie, "accept-encoding": "br, gzip" });
  expect(answer.headers["content-encoding"]).toBe("br");
  expect(brotliDecompressSync(answer.body).equals(withApplicationVersion(readFileSync(pagePath), version()))).toBe(
    true,
  );
  expect(pageGzipRuns()).toBe(before);
});

test("an unreadable page is a 500 naming it, not a throw out of the request listener (the service stays up)", async () => {
  // A checkout that was never built has no ui/dist/index.html: reading it threw inside dispatch, so the
  // request hung and the throw escaped as an uncaught exception (the ui unit suite before a build).
  const dir = tempDir("archer-page-");
  const { svc } = await service({ pagePath: join(dir, "missing.html") });
  const client = await connectService(svc.socketPath);
  const { url } = await client.call("attach", { root: project() });
  client.close();
  const exchange = await raw(url);
  const cookie = (exchange.headers["set-cookie"] as string[])[0]!.split(";")[0]!;
  const page = new URL(exchange.headers.location as string, url).href;
  const first = await raw(page, { cookie });
  expect(first.status).toBe(500);
  expect(JSON.parse(first.body.toString("utf8")).error.code).toBe("page_unavailable");
  // Built afterwards, the next request serves it.
  write(dir, "missing.html", "<!doctype html><html><body>built</body></html>");
  expect((await raw(page, { cookie })).status).toBe(200);
});
