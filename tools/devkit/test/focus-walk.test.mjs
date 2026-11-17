// node --test tools/devkit/test/focus-walk.test.mjs
// The focus walk (harness/focus-walk.mjs) on planted pages in a real Chromium: its known pass and known fail
// (rubric ui-ux.md §8: a dialog that returns focus / one that drops focus to <body>; a field under a toolbar),
// plus the indicator heuristic, aria-activedescendant and the trap check.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { dialogCheck, focusRecorder, focusWalk } from "../harness/focus-walk.mjs";

let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

async function pageWith(html, script = "") {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await ctx.newPage();
  await page.setContent(`<style>body{margin:0;font:16px sans-serif}</style>${html}<script>${script}</script>`);
  await page.evaluate(focusRecorder); // in a real run it is an init script; setContent's document.open would drop its listener
  return { page, close: () => ctx.close() };
}

// A modal dialog in the APG shape: Tab wraps inside, Escape closes; `returnFocus` decides where focus goes after.
const dialogPage = (returnFocus) =>
  pageWith(
    `
  <button id="before">Before</button><button id="open">Filters</button><button id="after">After</button>
  <div id="dlg" role="dialog" aria-modal="true" aria-label="Project Filters" hidden>
    <button id="first">Sort</button><input aria-label="Folder"><button id="last">Close</button>
  </div>`,
    `
  const dlg = document.getElementById("dlg"), open = document.getElementById("open");
  open.addEventListener("click", () => { dlg.hidden = false; document.getElementById("first").focus(); });
  dlg.addEventListener("keydown", (e) => {
    const f = [...dlg.querySelectorAll("button, input")];
    if (e.key === "Escape") { dlg.hidden = true; ${returnFocus ? "open.focus();" : "document.activeElement.blur();"} }
    if (e.key === "Tab") { const i = f.indexOf(document.activeElement); const n = e.shiftKey ? (i - 1 + f.length) % f.length : (i + 1) % f.length; e.preventDefault(); f[n].focus(); }
  });`,
  );

test("known pass: a modal dialog keeps focus inside, closes on Escape and returns focus to its launcher", async () => {
  const { page, close } = await dialogPage(true);
  try {
    await page.click("#open");
    const d = await dialogCheck(page);
    assert.equal(d.dialog, true);
    assert.equal(d.launcher.name, "Filters");
    assert.equal(d.initialInside, true);
    assert.equal(d.trapped, true);
    assert.equal(d.closesOnEscape, true);
    assert.equal(d.returnedToLauncher, true, d.returnedTo);
    assert.equal(d.droppedToBody, false);
  } finally {
    await close();
  }
});

test("known fail: a dialog that drops focus to <body> on close", async () => {
  const { page, close } = await dialogPage(false);
  try {
    await page.click("#open");
    const d = await dialogCheck(page);
    assert.equal(d.closesOnEscape, true);
    assert.equal(d.returnedToLauncher, false);
    assert.equal(d.droppedToBody, true);
    assert.equal(d.returnedTo, "body");
  } finally {
    await close();
  }
});

test("a non-modal dialog that lets Tab out is reported as not trapped", async () => {
  const { page, close } = await pageWith(
    `<button id="open">Open</button><div role="dialog" aria-label="Loose"><button>One</button></div><button>Outside</button>`,
  );
  try {
    await page.focus("#open");
    await page.keyboard.press("Tab");
    const d = await dialogCheck(page, { presses: 4 });
    assert.equal(d.trapped, false);
  } finally {
    await close();
  }
});

test("known pass / fail (2.4.11): a visible field is not hidden; a field entirely under a fixed toolbar is", async () => {
  const { page, close } = await pageWith(`
    <div style="position:fixed;top:0;left:0;right:0;height:80px;background:#eee;z-index:2">Toolbar</div>
    <input aria-label="Covered" style="position:absolute;top:20px;left:20px;width:200px;height:30px;z-index:1">
    <input aria-label="Visible" style="position:absolute;top:200px;left:20px;width:200px;height:30px">
    <input aria-label="Half" style="position:absolute;top:60px;left:300px;width:200px;height:40px;z-index:1">`);
  try {
    const walk = await focusWalk(page, { maxStops: 8 });
    const at = (n) => walk.stops.find((s) => s.name === n);
    assert.equal(at("Covered").obscured.hidden, true);
    assert.equal(at("Covered").obscured.why, "covered");
    assert.equal(at("Visible").obscured.hidden, false);
    assert.equal(at("Half").obscured.hidden, false, "partly covered passes the minimum");
    assert.ok(at("Half").obscured.visiblePoints < at("Half").obscured.points);
    assert.equal(walk.summary.entirelyHidden, 1);
  } finally {
    await close();
  }
});

test("an overlay that ignores the pointer still covers the focused element", async () => {
  const { page, close } = await pageWith(`
    <div style="position:fixed;inset:0;background:rgba(0,0,0,.9);pointer-events:none;z-index:5"></div>
    <button style="position:absolute;top:100px;left:100px">Under</button>`);
  try {
    const walk = await focusWalk(page, { maxStops: 3 });
    assert.equal(walk.stops.find((s) => s.name === "Under").obscured.hidden, true);
  } finally {
    await close();
  }
});

test("indicator heuristic: the default ring is detected; outline: none with no replacement is not", async () => {
  const { page, close } = await pageWith(
    `<button>Default</button><button style="outline:none">Bare</button><button class="r">Ringed</button><style>.r:focus-visible{outline:none;box-shadow:0 0 0 3px blue}</style>`,
  );
  try {
    const walk = await focusWalk(page, { maxStops: 5 });
    const at = (n) => walk.stops.find((s) => s.name === n);
    assert.equal(at("Default").indicator.detected, true);
    assert.equal(at("Bare").indicator.detected, false);
    assert.equal(at("Ringed").indicator.detected, true);
    assert.equal(walk.summary.noIndicatorDetected, 1);
  } finally {
    await close();
  }
});

test("aria-activedescendant is resolved at each stop; a dangling id is reported", async () => {
  const { page, close } = await pageWith(`
    <div role="listbox" tabindex="0" aria-label="Good" aria-activedescendant="o2"><div role="option" id="o1">One</div><div role="option" id="o2" aria-selected="true">Two</div></div>
    <div role="listbox" tabindex="0" aria-label="Broken" aria-activedescendant="nope"></div>`);
  try {
    const walk = await focusWalk(page, { maxStops: 4 });
    const good = walk.stops.find((s) => s.name === "Good"),
      broken = walk.stops.find((s) => s.name === "Broken");
    assert.equal(good.activedescendant.name, "Two");
    assert.equal(good.activedescendant.obscured.hidden, false);
    assert.equal(broken.activedescendant.missing, true);
    assert.equal(walk.summary.activedescendantMissing, 1);
  } finally {
    await close();
  }
});

test("known pass / fail (2.1.2): a page whose Tab cycle reaches the browser passes; a keyboard trap outside a modal is flagged", async () => {
  const open = await pageWith(`<button>A</button><button>B</button><button>C</button>`);
  try {
    const walk = await focusWalk(open.page, { maxStops: 10 });
    assert.equal(walk.cycle.completed, true);
    assert.equal(walk.cycle.passesBrowserChrome, true);
    assert.equal(walk.summary.possibleTrap, false);
  } finally {
    await open.close();
  }
  const trap = await pageWith(
    `<button id="a">A</button><button id="b">B</button><button>Never reached</button>`,
    `
    for (const id of ["a", "b"]) document.getElementById(id).addEventListener("keydown", (e) => { if (e.key === "Tab") { e.preventDefault(); document.getElementById(id === "a" ? "b" : "a").focus(); } });`,
  );
  try {
    await trap.page.focus("#a");
    const walk = await focusWalk(trap.page, { maxStops: 10 });
    assert.equal(walk.cycle.completed, true);
    assert.equal(walk.cycle.passesBrowserChrome, false);
    assert.equal(walk.summary.possibleTrap, true);
  } finally {
    await trap.close();
  }
});

test("a transparent full-size layer (an edge-label renderer) does not hide what is under it; its painted label does", async () => {
  const { page, close } = await pageWith(`
    <button style="position:absolute;top:100px;left:100px;width:120px;height:30px">Node</button>
    <button style="position:absolute;top:300px;left:100px;width:120px;height:30px">Labelled over</button>
    <div style="position:absolute;inset:0;pointer-events:none;z-index:5">
      <span style="position:absolute;top:295px;left:95px;width:140px;height:40px;background:#fff">label</span>
    </div>`);
  try {
    const walk = await focusWalk(page, { maxStops: 4 });
    assert.equal(walk.stops.find((s) => s.name === "Node").obscured.hidden, false);
    assert.equal(walk.stops.find((s) => s.name === "Labelled over").obscured.hidden, true);
  } finally {
    await close();
  }
});

test("a modal whose Tab passes through the browser chrome and comes back inside is trapped; Escape is pressed from inside", async () => {
  const { page, close } = await pageWith(
    `
    <button id="open">Cancel</button>
    <div id="dlg" role="alertdialog" aria-modal="true" aria-label="Discard your changes?" hidden><button id="keep">Keep editing</button><button>Discard</button></div>`,
    `
    const dlg = document.getElementById("dlg"), open = document.getElementById("open");
    open.addEventListener("click", () => { dlg.hidden = false; open.inert = true; document.getElementById("keep").focus(); });
    dlg.addEventListener("keydown", (e) => { if (e.key === "Escape") { dlg.hidden = true; open.inert = false; open.focus(); } });`,
  );
  try {
    await page.click("#open");
    const d = await dialogCheck(page, { presses: 5 });
    assert.equal(d.trapped, true);
    assert.equal(d.passesBrowserChrome, true);
    assert.equal(d.closesOnEscape, true);
    assert.equal(d.returnedToLauncher, true);
  } finally {
    await close();
  }
});
