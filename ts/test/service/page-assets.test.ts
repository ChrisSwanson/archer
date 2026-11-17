// The web page's own files beside it (`ui` build: `page-assets/`, the ELK layout worker): served at
// `/-/page-assets/<name>` under the page's credential, compressed, cached for good by their hashed names.
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { connectService, type ServiceClient } from "../../src/service/index.ts";
import { writePrecompressed } from "../../src/service/page-version.ts";
import { optionsFromEnv } from "../../src/service/foreground.ts";
import { handoverPageEnv, parseRestartConfiguration } from "../../src/service/restart.ts";
import { cleanUp, exactly, http, project, service, tempDir, write } from "./support.ts";

afterEach(cleanUp);
const clients: ServiceClient[] = [];
afterEach(() => clients.splice(0).forEach((c) => c.close()));

const WORKER = "elk-layout-worker-AbC123_x.js";
/** Big enough that compression shows. */
const SOURCE = `self.onmessage = (event) => self.postMessage(event.data); // ${"layout ".repeat(4000)}\n`;

/** A built page that names its worker, as the `ui` build writes it. */
function builtPage(worker: string, source: string): string {
  const dir = tempDir("archer-page-");
  write(
    dir,
    "index.html",
    `<!doctype html><html><head></head><body><script>new Worker(new URL("page-assets/${worker}",location.href))</script></body></html>`,
  );
  write(dir, `page-assets/${worker}`, source);
  return dir;
}

async function servedPage(
  options: { precompressed?: boolean; previousPage?: string; retainedPage?: string; dir?: string } = {},
) {
  const dir = options.dir ?? builtPage(WORKER, SOURCE);
  const worker = join(dir, "page-assets", WORKER);
  if (options.precompressed === true) writePrecompressed(worker, Buffer.from(SOURCE));
  write(dir, "secret.js", "not a page asset");
  write(dir, "page-assets/unnamed-AbC12345.js", "a file the page does not name");
  const { svc } = await service({
    pagePath: join(dir, "index.html"),
    ...(options.previousPage === undefined ? {} : { previousPagePath: options.previousPage }),
    ...(options.retainedPage === undefined ? {} : { retainedPagePath: options.retainedPage }),
  });
  const c = await connectService(svc.socketPath);
  clients.push(c);
  const status = await c.call("attach", { root: project() });
  const exchange = await http(status.url);
  const cookie = (exchange.headers["set-cookie"] as string[])[0]!.split(";")[0]!;
  return { svc, c, cookie, origin: `http://127.0.0.1:${svc.port}`, worker, dir };
}

describe("page assets", () => {
  test("the worker is served under the page's credential, as JavaScript cached for good, with a policy of its own", async () => {
    const { cookie, origin } = await servedPage();
    const reply = await fetch(`${origin}/-/page-assets/${WORKER}`, {
      headers: { cookie, "accept-encoding": "identity" },
    });
    expect(reply.status).toBe(200);
    expect(await reply.text()).toBe(SOURCE);
    const names = [
      "content-type",
      "cache-control",
      "x-content-type-options",
      "referrer-policy",
      "content-security-policy",
    ];
    expect(Object.fromEntries(names.map((name) => [name, reply.headers.get(name)]))).toEqual({
      "content-type": "text/javascript; charset=utf-8",
      // The name carries the content hash: a new build is a new address. `private`: a cookie admitted it.
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      // A worker from a URL runs under its own response's policy: it loads and connects to nothing.
      "content-security-policy": "default-src 'none'",
    });
  });

  test("it is sent compressed as the reader accepts: brotli, gzip or as is", async () => {
    const { cookie, origin } = await servedPage();
    const url = `${origin}/-/page-assets/${WORKER}`;
    const gzip = await fetch(url, { headers: { cookie, "accept-encoding": "gzip" } });
    expect([gzip.headers.get("content-encoding"), gzip.headers.get("vary"), await gzip.text()]).toEqual([
      "gzip",
      "accept-encoding",
      SOURCE,
    ]);
    // Brotli is made once a reader asks (it takes a while for a large file); until then that reader gets gzip.
    await expect
      .poll(async () =>
        (await fetch(url, { headers: { cookie, "accept-encoding": "br, gzip" } })).headers.get("content-encoding"),
      )
      .toBe("br");
    const br = await fetch(url, { headers: { cookie, "accept-encoding": "br" } });
    expect(await br.text()).toBe(SOURCE);
  });

  test("a packaged worker's compressed copies are used as they are", async () => {
    const { cookie, origin } = await servedPage({ precompressed: true });
    const reply = await fetch(`${origin}/-/page-assets/${WORKER}`, { headers: { cookie, "accept-encoding": "br" } });
    expect([reply.headers.get("content-encoding"), await reply.text()]).toEqual(["br", SOURCE]);
  });

  test("without a credential, or for any other name, it is the bare 404", async () => {
    const { svc, cookie, origin } = await servedPage();
    expect((await exactly(`${origin}/-/page-assets/${WORKER}`)).status).toBe(404);
    for (const name of [
      "missing-12345678.js",
      "unnamed-AbC12345.js",
      "..%2Fsecret.js",
      "%2E%2E/secret.js",
      ".hidden.js",
      `${WORKER}.br`,
      "index.html",
      "",
    ]) {
      const reply = await http(`${origin}/-/page-assets/${name}`, { headers: { cookie } });
      expect([name, reply.status, reply.body]).toEqual([name, 404, ""]);
    }
    expect((await http(`${origin}/-/page-assets/../secret.js`, { headers: { cookie } })).status).toBe(404);
    expect((await http(`${origin}/-/secret.js`, { headers: { cookie } })).status).toBe(404);
    // The retired path-token prefix is no credential.
    const legacy = await exactly(`${origin}/${svc.token}/-/page-assets/${WORKER}`);
    expect([legacy.status, legacy.body]).toEqual([404, ""]);
  });

  test("a Bearer grant admits it as it admits the page; a 304 needs the credential too", async () => {
    const { c, origin } = await servedPage();
    const grant = await c.call("issueAccess", { label: "Browser" });
    const url = `${origin}/-/page-assets/${WORKER}`;
    const first = await http(url, { headers: { authorization: `Bearer ${grant.token}` } });
    expect([first.status, first.body]).toEqual([200, SOURCE]);
    const tag = first.headers.etag as string;
    expect(
      (await http(url, { headers: { authorization: `Bearer ${grant.token}`, "if-none-match": tag } })).status,
    ).toBe(304);
    expect((await exactly(url, { headers: { "if-none-match": tag } })).status).toBe(404);
    expect((await http(url, { headers: { authorization: `Bearer ${"0".repeat(32)}` } })).status).toBe(404);
  });

  test("the assets are the ones the page names, read with it: a rebuild under the running service changes neither", async () => {
    const { cookie, origin, dir } = await servedPage();
    expect((await http(`${origin}/projects/`, { headers: { cookie } })).status).toBe(200);
    // `npm run build` empties the directory and writes the next build's worker under another name.
    rmSync(join(dir, "page-assets"), { recursive: true });
    write(dir, "page-assets/elk-layout-worker-NeXt5678.js", "the next build");
    write(dir, "index.html", '<script>new URL("page-assets/elk-layout-worker-NeXt5678.js")</script>');
    const reply = await http(`${origin}/-/page-assets/${WORKER}`, { headers: { cookie } });
    expect([reply.status, reply.body]).toEqual([200, SOURCE]);
    expect((await http(`${origin}/-/page-assets/elk-layout-worker-NeXt5678.js`, { headers: { cookie } })).status).toBe(
      404,
    );
  });

  test("after a hand-over the previous build's assets are served too, for tabs it loaded; older ones are not", async () => {
    const previous = builtPage("elk-layout-worker-PreV1234.js", "the previous build's worker");
    write(previous, "page-assets/elk-layout-worker-OlDr1234.js", "a build before that: not named by the previous page");
    const { cookie, origin } = await servedPage({ previousPage: join(previous, "index.html") });
    // The previous install is removed later (the next upgrade): what was read at the hand-over stays.
    renameSync(join(previous, "page-assets"), join(previous, "gone"));
    const old = await http(`${origin}/-/page-assets/elk-layout-worker-PreV1234.js`, { headers: { cookie } });
    expect([old.status, old.body, old.headers["cache-control"]]).toEqual([
      200,
      "the previous build's worker",
      "private, max-age=31536000, immutable",
    ]);
    expect((await http(`${origin}/-/page-assets/${WORKER}`, { headers: { cookie } })).status).toBe(200);
    expect((await http(`${origin}/-/page-assets/elk-layout-worker-OlDr1234.js`, { headers: { cookie } })).status).toBe(
      404,
    );
    expect((await http(`${origin}/-/page-assets/elk-layout-worker-PreV1234.js`)).status).toBe(404);
  });

  test("restart passes the running build's page to its replacement, which keeps that build's assets", async () => {
    const { c, dir } = await servedPage();
    const configuration = await c.call("restartConfiguration", {});
    expect(configuration.servedPage).toBe(join(dir, "index.html"));
    expect(parseRestartConfiguration(configuration).servedPage).toBe(join(dir, "index.html"));
    expect(() => parseRestartConfiguration({ ...configuration, servedPage: "relative/index.html" })).toThrow(
      /invalid restart settings/,
    );
    const ready = {
      ARCHER_HANDOVER_READY: "/state/handover.ready",
      ARCHER_HANDOVER_PREVIOUS_PAGE: "/old/assets/archer-ui.html",
    };
    expect(optionsFromEnv(ready)).toMatchObject({ previousPagePath: "/old/assets/archer-ui.html" });
    // Only for a hand-over, and only an absolute path.
    expect(optionsFromEnv({ ARCHER_HANDOVER_PREVIOUS_PAGE: "/old/assets/archer-ui.html" })).not.toHaveProperty(
      "previousPagePath",
    );
    expect(() => optionsFromEnv({ ...ready, ARCHER_HANDOVER_PREVIOUS_PAGE: "old.html" })).toThrow(/absolute/);
  });

  test("a same-build restart keeps the previous build's assets (A→B→B); a different build replaces them (B→C)", async () => {
    const a = builtPage("elk-layout-worker-BuiLdAAA.js", "build A's worker");
    const b = builtPage(WORKER, SOURCE);
    const aPage = join(a, "index.html"),
      bPage = join(b, "index.html");
    // A→B: B is served, A retained; the configuration says so, and parses back.
    const first = await servedPage({ dir: b, previousPage: aPage });
    const afterUpgrade = await first.c.call("restartConfiguration", {});
    expect([afterUpgrade.servedPage, afterUpgrade.retainedPage]).toEqual([bPage, aPage]);
    expect(parseRestartConfiguration(afterUpgrade).retainedPage).toBe(aPage);
    expect(() => parseRestartConfiguration({ ...afterUpgrade, retainedPage: "relative/index.html" })).toThrow(
      /invalid restart settings/,
    );
    // What restart hands the replacement, and how the replacement reads it.
    const env = handoverPageEnv(parseRestartConfiguration(afterUpgrade));
    expect(env).toEqual({ ARCHER_HANDOVER_PREVIOUS_PAGE: bPage, ARCHER_HANDOVER_RETAINED_PAGE: aPage });
    expect(optionsFromEnv({ ARCHER_HANDOVER_READY: "/state/handover.ready", ...env })).toMatchObject({
      previousPagePath: bPage,
      retainedPagePath: aPage,
    });
    expect(optionsFromEnv({ ARCHER_HANDOVER_RETAINED_PAGE: aPage })).not.toHaveProperty("retainedPagePath");
    expect(() =>
      optionsFromEnv({ ARCHER_HANDOVER_READY: "/state/handover.ready", ARCHER_HANDOVER_RETAINED_PAGE: "old.html" }),
    ).toThrow(/absolute/);
    // B→B: the replacement serves the same page; an A tab still gets A's worker.
    const second = await servedPage({ dir: b, previousPage: bPage, retainedPage: aPage });
    const aWorker = await http(`${second.origin}/-/page-assets/elk-layout-worker-BuiLdAAA.js`, {
      headers: { cookie: second.cookie },
    });
    expect([aWorker.status, aWorker.body]).toEqual([200, "build A's worker"]);
    expect((await second.c.call("restartConfiguration", {})).retainedPage).toBe(aPage);
    // B→C: C retains B, and A is no longer served (current plus previous only).
    const third = await servedPage({ previousPage: bPage, retainedPage: aPage });
    expect((await third.c.call("restartConfiguration", {})).retainedPage).toBe(bPage);
    expect(
      (await http(`${third.origin}/-/page-assets/elk-layout-worker-BuiLdAAA.js`, { headers: { cookie: third.cookie } }))
        .status,
    ).toBe(404);
    // A plain start retains nothing.
    expect((await (await servedPage()).c.call("restartConfiguration", {})).retainedPage).toBeUndefined();
  });

  test("the page allows a worker from its own origin (the web page's file) and a blob (the single-file page)", async () => {
    const { cookie, origin } = await servedPage();
    const page = await http(`${origin}/projects/`, { headers: { cookie } });
    expect(page.headers["content-security-policy"]).toContain("worker-src 'self' blob:;");
  });

  test("a page without page assets serves none", async () => {
    const dir = tempDir("archer-page-");
    writeFileSync(join(dir, "single.html"), "<html></html>");
    const { svc } = await service({ pagePath: join(dir, "single.html") });
    expect((await http(`http://127.0.0.1:${svc.port}/${svc.token}/-/page-assets/${WORKER}`)).status).toBe(404);
  });
});
