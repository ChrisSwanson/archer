import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { contrastRatio, measureContrast } from "../harness/contrast.mjs";
import { readFileSync } from "node:fs";

test("WCAG uses unrounded ratios", () => {
  assert.equal(contrastRatio([0, 0, 0, 1], [255, 255, 255, 1]), 21);
});

test("focus ring is measured against the outside adjacent surface", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(
      "<style>body{background:white}button{background:black;color:white;outline:2px solid white;border:0}</style><button id=ring>Focused</button>",
    );
    const r = await measureContrast(page, { tokens: false });
    assert.ok(r.pairs.some((p) => p.selector === "#ring" && p.kind === "focus-ring" && !p.pass));
  } finally {
    await browser.close();
  }
});

test("visible aria-hidden glyphs count; fully transparent ancestor text does not", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<style>body{background:white}</style><svg aria-hidden="true" width=100 height=50><path id=icon d="M0 20H100" stroke="#ddd"/></svg><div style="opacity:0"><p id=invisible>Invisible text</p></div>',
    );
    const r = await measureContrast(page, { tokens: false });
    assert.ok(r.pairs.some((p) => p.selector === "#icon" && p.kind === "stroke" && !p.pass));
    assert.ok(!r.pairs.some((p) => p.selector === "#invisible"));
  } finally {
    await browser.close();
  }
});

test("uses SVG label plate behind text and ancestor group opacity", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<style>body{background:white}</style><svg width=200 height=100><g opacity=".8"><rect width=200 height=100 fill="black"/><text id="plate-label" x=10 y=30 fill="white">Plate label</text></g></svg>',
    );
    const r = await measureContrast(page, { tokens: false });
    const p = r.pairs.find((p) => p.selector === "#plate-label" && p.kind === "text");
    assert.equal(p.pass, true);
    assert.ok(p.background[0] < 52 && p.background[0] > 50);
  } finally {
    await browser.close();
  }
});

test("known pass: actual Archer text token on surface", async (t) => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const css = readFileSync(new URL("../../../ui/src/styles.css", import.meta.url), "utf8");
    await page.setContent(
      `<style>${css}</style><p id="actual-token" style="color:var(--text);background:var(--surface)">Text token on surface</p>`,
    );
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((el, theme) => (el.dataset.theme = theme), theme);
      const r = await measureContrast(page, { tokens: false });
      const p = r.pairs.find((p) => p.selector === "#actual-token");
      assert.equal(p.pass, true);
      t.diagnostic(JSON.stringify({ theme, ratio: p.ratio, pass: p.pass }));
    }
  } finally {
    await browser.close();
  }
});

test("browser planted pass/fail, opacity, large text and SVG cues", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // A 2.9:1 grey on white; keep its fractional channel rather than round a ratio.
    const grey = 255 * (1.055 * (1.05 / 2.9 - 0.05) ** (1 / 2.4) - 0.055);
    const near = 1.055 * (1.05 / 2.99999 - 0.05) ** (1 / 2.4) - 0.055;
    await page.setContent(`<style>:root{--surface:white;--node-text:black}body{background:var(--surface)}
      #pass{color:var(--node-text)} #fail{border:2px solid color(srgb ${grey / 255} ${grey / 255} ${grey / 255});width:30px;height:30px}
      #near{width:30px;height:30px;border:2px solid color(srgb ${near} ${near} ${near})}
      #dim{opacity:.25} #big{color:#888;font-size:24px} #bold{color:#888;font-size:18.6666666667px;font-weight:700}
      #small{color:#888;font-size:18px;font-weight:700}</style>
      <div id=pass>Known passing text token</div><div id=fail data-contrast-cue=border></div>
      <div id=near data-contrast-cue=border></div>
      <div id=dim><span id=dimtext>Dimmed off-path text</span></div>
      <div id=big>Large</div><div id=bold>Bold large</div><div id=small>Small</div>
      <svg width=100 height=50><path id=svgcue data-contrast-cue=stroke d="M0 20H100" stroke="black" stroke-opacity=".2"/></svg>`);
    const r = await measureContrast(page, { tokens: false });
    const row = (id, kind) => r.pairs.find((p) => p.selector === `#${id}` && (!kind || p.kind === kind));
    assert.equal(row("pass", "text").pass, true);
    assert.equal(row("fail", "border").pass, false);
    assert.ok(Math.abs(row("fail", "border").ratio - 2.9) < 1e-5);
    assert.equal(row("near", "border").ratio.toFixed(2), "3.00");
    assert.equal(row("near", "border").pass, false);
    assert.equal(row("dimtext", "text").pass, false);
    assert.equal(row("big", "text").threshold, 3);
    assert.equal(row("bold", "text").threshold, 3);
    assert.equal(row("small", "text").threshold, 4.5);
    assert.equal(row("svgcue", "stroke").pass, false);
  } finally {
    await browser.close();
  }
});
