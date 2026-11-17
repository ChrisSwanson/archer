// S6 shift identity against a real Chromium (O229, codex-307): VITALS_SCRIPT records each layout-shift source's
// structural path and its rects at full precision, so two elements of one kind making the same motion stay two
// movements, the same element regrouped or the whole page translated stays one, and a sub-pixel or text motion is
// not rounded away. Skipped when Playwright's Chromium is not installed.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";
import { VITALS_SCRIPT, movementKey, shiftElements } from "../lib/vitals.mjs";
import { lateShiftChanges } from "../lib/compare.mjs";

const require = createRequire(import.meta.url);

// Two fact lines, each with a span that moves 8 px right when the text before it widens; `?which=a|b` widens one.
// `?top=N` places the whole page N px lower (a translation, not a motion of these elements).
const page = (
  which,
  top,
) => `<!doctype html><title>s</title><style>body{margin:0;font:14px/20px sans-serif}p{margin:0 0 40px}</style>
<main style="padding-top:${top}px"><p data-fact="a"><b id="ta">0</b> diagrams <span>3 notes</span></p><p data-fact="b"><b id="tb">0</b> diagrams <span>3 notes</span></p></main>
<script>setTimeout(() => { document.getElementById("t${which}").style.display = "inline-block"; document.getElementById("t${which}").style.width = "40px"; }, 300);</script>`;

const FRACTIONAL = `<!doctype html><div id="x" style="position:relative;top:0.25px;width:100px;height:100px;background:#000"></div><script>setTimeout(()=>{document.getElementById("x").style.top="30.75px"},200)</script>`;

test("shift identity: same motion on two elements is two movements; translation and regrouping are not new", {
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
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      u.searchParams.has("frac")
        ? FRACTIONAL
        : page(u.searchParams.get("which"), Number(u.searchParams.get("top") ?? 0)),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const load = async (q) => {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } }),
      p = await context.newPage();
    try {
      await p.addInitScript(VITALS_SCRIPT);
      await p.goto(`${origin}/${q}`, { waitUntil: "load" });
      await p.waitForTimeout(700);
      await p.evaluate(() => window.__perfLab.flush());
      return shiftElements(await p.evaluate(() => window.__perfLab.shifts));
    } finally {
      await context.close();
    }
  };
  try {
    const a = await load("?which=a"),
      b = await load("?which=b"),
      lower = await load("?which=a&top=7");
    // Chrome attributes the move to the span's text node, with both rects its line box (x 0, the block's width), not
    // the text's own box: equal rects on a text source are not "no motion" (O224).
    const span = (els) => els.filter((e) => / > span > #text$/.test(e.path ?? ""));
    assert.equal(span(a).length, 1, JSON.stringify(a));
    assert.equal(span(a)[0].node, span(b)[0].node, "the same description");
    assert.deepEqual(span(a)[0].from, span(a)[0].to, "the text moved, its reported rects did not");
    assert.notEqual(span(a)[0].path, span(b)[0].path, "different elements");
    assert.match(span(a)[0].path, /p\[data-fact=a\]/);
    const row = (els) => [
      {
        page: "p",
        state: "warm",
        profile: "default",
        readyAnchors: { dom: { domElements: 1, lateShiftElements: els } },
      },
    ];
    // Different elements with the same delta: new (the bare description matched them: a false PASS).
    assert.equal(lateShiftChanges(row(span(b)), row(span(a))).cells[0].status, "FAIL");
    // The whole page translated: the same movement.
    assert.equal(movementKey(span(lower)[0]), movementKey(span(a)[0]));
    assert.equal(lateShiftChanges(row(span(lower)), row(span(a))).cells[0].status, "PASS");
    // Regrouped: the same sources split over two entries are the same movements.
    const regrouped = a.map((e, i) => ({ ...e, startTime: e.startTime + i }));
    assert.equal(lateShiftChanges(row(regrouped), row(a)).cells[0].status, "PASS");
    // Rects at full precision: a fractional coordinate survives.
    const fractional = await load("?frac");
    assert.ok(
      fractional.some((e) => /Δy30\.5/.test(movementKey(e))),
      JSON.stringify(fractional),
    );
  } finally {
    await browser.close();
    server.close();
  }
});
