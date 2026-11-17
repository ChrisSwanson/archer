// S1 chain depth against a real Chromium (rubric §8: shown on known controls before it scores): serial, parallel,
// promise-chained, script-chained and worker pages served from a local server, recorded by the lab's own
// instrument() with async stacks and reduced by lib/chain.mjs. Skipped when Playwright's Chromium is not installed.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";
import { chainDepth } from "../lib/chain.mjs";
import { PROFILES } from "../lib/report.mjs";
import { instrument } from "../page-load.mjs";

const require = createRequire(import.meta.url);
const done = "<script>/*nothing*/</script>";
const PAGES = {
  "/serial.html": `<script>(async () => { await (await fetch("/a")).text(); await (await fetch("/b")).text(); window.done = true; })();</script>`,
  "/parallel.html": `<script>Promise.all([fetch("/a"), fetch("/b")]).then((rs) => Promise.all(rs.map((r) => r.text()))).then(() => { window.done = true; });</script>`,
  "/then.html": `<script>fetch("/a").then((r) => r.text()).then(() => fetch("/b")).then((r) => r.text()).then(() => fetch("/c")).then((r) => r.text()).then(() => { window.done = true; });</script>`,
  "/chained.html": `<script src="/one.js"></script>`,
  "/worker.html": `<script>const w = new Worker("/worker.js"); w.onmessage = () => { window.done = true; };</script>`,
  // claude-308: three badge reads from one call site after the catalog's answer, the 2nd and 3rd started late (as a
  // loaded host let them), each after the one before ended: siblings, depth 3 (start-after-end alone read 5).
  "/siblings.html": `<script>async function badge(p) { await (await fetch("/badge-" + p)).text(); }
fetch("/cat").then((r) => r.text()).then(() => { for (const [i, p] of ["x", "y", "z"].entries()) setTimeout(() => badge(p).then(() => { if (p === "z") window.done = true; }), i * 120); });</script>`,
  // The rule's limit: a loop awaiting each read from one call site (truth 4) reads 3, its 3rd read sharing the 2nd's stack.
  "/loop.html": `<script>(async () => { for (const p of ["a", "b", "c"]) await (await fetch("/" + p)).text(); window.done = true; })();</script>`,
};
const SCRIPTS = {
  "/one.js": `const s = document.createElement("script"); s.src = "/two.js"; document.head.append(s);`,
  "/two.js": `fetch("/data").then((r) => r.text()).then(() => { window.done = true; });`,
  "/worker.js": `fetch("/w-data").then((r) => r.text()).then(() => postMessage("ok"));`,
};

const LAST = {
  "/serial.html": "/b",
  "/parallel.html": "/b",
  "/then.html": "/c",
  "/chained.html": "/data",
  "/worker.html": "/w-data",
  "/siblings.html": "/badge-z",
  "/loop.html": "/c",
};

async function serve() {
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const send = (type, body) => {
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    if (PAGES[path]) return send("text/html", `<!doctype html><title>c</title>${PAGES[path]}${done}`);
    if (SCRIPTS[path]) return send("text/javascript", SCRIPTS[path]);
    setTimeout(() => send("application/json", JSON.stringify({ path })), 40);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

test("chain depth on live controls: serial 3, parallel 2, promise chain 4, script chain 4, worker 3, late siblings 3, loop of 3 (limit) 3", {
  timeout: 60_000,
}, async (t) => {
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    t.skip("playwright not installed");
    return;
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`no Chromium: ${String(error.message).split("\n")[0]}`);
    return;
  }
  const { server, origin } = await serve();
  try {
    const measure = async (path) => {
      const context = await browser.newContext(),
        page = await context.newPage();
      try {
        const probe = await instrument(page, PROFILES.default, false, true);
        await page.goto(`${origin}${path}`, { waitUntil: "load" });
        await page.waitForFunction(() => window.done === true, null, { timeout: 10_000 });
        // The worker's rows come over its own session and can land after the page's flag under load: wait (bounded)
        // for the last expected request to be recorded instead of a fixed pause.
        const last = LAST[path],
          deadline = Date.now() + 5_000;
        while (!probe.snapshot().some((r) => r.url.endsWith(last)) && Date.now() < deadline)
          await page.waitForTimeout(50);
        assert.ok(
          probe.snapshot().some((r) => r.url.endsWith(last)),
          `${path}: ${last} recorded`,
        );
        assert.equal(probe.asyncStacks, true);
        return chainDepth(probe.snapshot(), { asyncStacks: probe.asyncStacks });
      } finally {
        await context.close();
      }
    };
    const results = {};
    for (const path of Object.keys(PAGES)) results[path] = await measure(path);
    const depths = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.depth]));
    assert.equal(depths["/serial.html"], 3, JSON.stringify(results["/serial.html"].rows));
    assert.equal(depths["/parallel.html"], 2, JSON.stringify(results["/parallel.html"].rows));
    assert.equal(depths["/then.html"], 4, JSON.stringify(results["/then.html"].rows));
    assert.equal(depths["/chained.html"], 4, JSON.stringify(results["/chained.html"].rows));
    assert.equal(depths["/worker.html"], 3, JSON.stringify(results["/worker.html"].rows));
    assert.equal(depths["/siblings.html"], 3, JSON.stringify(results["/siblings.html"].rows));
    assert.equal(depths["/loop.html"], 3, JSON.stringify(results["/loop.html"].rows));
  } finally {
    await browser.close();
    server.close();
  }
});
