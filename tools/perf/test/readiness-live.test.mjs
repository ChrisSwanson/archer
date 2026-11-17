// The note's DOM readiness anchor against a real Chromium (rubric §8: a collector is shown on known controls before
// it scores; O212). The pages copy the note reader's shape (ui/src/comments/NoteItem.tsx): the article holds the
// title and the "Loading the note…" placeholder while a hidden, empty `.archer-note-body` waits for the note; then
// the body fills, its figure hosts mount, and each figure draws. The anchor must wait for the body and its figures.
// Skipped when Playwright's Chromium is not installed.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";
import { readyScript } from "../lib/readiness.mjs";

const require = createRequire(import.meta.url);

const SHELL = `<main><article class="primary-note-reader"><h1>Auth design</h1><p>Loading highlights…</p>
<div class="archer-note-region"><p class="archer-review-quiet" id="placeholder">Loading the note…</p><div class="archer-note-body" role="document" hidden id="body"></div></div></article></main>`;
// The body arrives after `bodyMs`; with a figure, it is drawing first and drawn `drawMs` later. `never`: no body.
const page = ({
  bodyMs = 400,
  figure = true,
  drawMs = 300,
  never = false,
}) => `<!doctype html><title>n</title>${SHELL}<script>
const body = document.getElementById("body");
${
  never
    ? ""
    : `setTimeout(() => {
  document.getElementById("placeholder").remove();
  body.hidden = false;
  body.innerHTML = '<p>Sign-in goes through the gateway.</p>${figure ? `<div class="archer-note-figure-host" style="height:200px"><figure class="archer-note-figure" data-state="drawing" aria-label="auth-flow, flowchart"></figure></div>` : ""}';
  window.bodyAt = performance.now();
  ${figure ? `setTimeout(() => { const f = body.querySelector("figure"); f.innerHTML = '<svg width="10" height="10"><rect width="10" height="10"/></svg>'; f.setAttribute("data-state", "drawn"); window.drawnAt = performance.now(); }, ${drawMs});` : ""}
}, ${bodyMs});`
}
</script>`;

async function serve() {
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const html = page({ figure: u.searchParams.get("figure") !== "0", never: u.searchParams.has("never") });
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

test("note DOM anchor: waits for the real body and its drawn figures, not the title or the loading placeholder", {
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
  const load = async (query, waitFor) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }),
      p = await context.newPage();
    try {
      await p.addInitScript(readyScript("note"));
      await p.goto(`${origin}/n${query}`, { waitUntil: "load" });
      if (waitFor) await p.waitForFunction(waitFor, null, { timeout: 10_000 });
      else await p.waitForTimeout(1500);
      return await p.evaluate(() => ({
        dom: window.__perfReadyDom ?? null,
        ready: window.__perfReady ?? null,
        bodyAt: window.bodyAt ?? null,
        drawnAt: window.drawnAt ?? null,
      }));
    } finally {
      await context.close();
    }
  };
  try {
    // Delayed body with a figure: the anchor comes once the figure is drawn, never on the placeholder.
    const delayed = await load("", () => window.__perfReadyDom && window.__perfReady);
    assert.ok(delayed.bodyAt !== null && delayed.drawnAt !== null, JSON.stringify(delayed));
    assert.ok(
      delayed.dom.at >= delayed.drawnAt,
      `DOM anchor ${delayed.dom.at} ms before the figure was drawn at ${delayed.drawnAt} ms (body at ${delayed.bodyAt})`,
    );
    assert.ok(
      delayed.ready.at >= delayed.drawnAt,
      `route-ready ${delayed.ready.at} ms before the figure was drawn at ${delayed.drawnAt} ms`,
    );
    assert.ok(
      delayed.dom.figures.some((f) => f.inView && f.state === "drawn"),
      JSON.stringify(delayed.dom.figures),
    );
    // A body without figures: ready once the body is there.
    const plain = await load("?figure=0", () => window.__perfReadyDom);
    assert.ok(plain.dom.at >= plain.bodyAt, `DOM anchor ${plain.dom.at} ms before the body at ${plain.bodyAt} ms`);
    // Negative control: the body never arrives (title and placeholder only): no anchor at all.
    const never = await load("?never");
    assert.equal(never.dom, null, `anchored on the loading shell: ${JSON.stringify(never.dom)}`);
    assert.equal(never.ready, null);
  } finally {
    await browser.close();
    server.close();
  }
});
