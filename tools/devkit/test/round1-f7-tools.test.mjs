import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright";
import { measureContrast } from "../harness/contrast.mjs";

const css = readFileSync(new URL("../../../ui/src/styles.css", import.meta.url), "utf8");
const flow = `<svg width="200" height="100">${[1, 2, 3, 4]
  .map(
    (i) =>
      `<g class="archer-edge archer-emph archer-emph-style-flow"><path id="flow-${i}" class="react-flow__edge-path" d="M10 ${20 * i}H190" style="stroke:var(--g${i});stroke-width:2;fill:none"/></g>`,
  )
  .join("")}</svg>`;

async function checkFlow(page, { opacity, pass }) {
  const result = await measureContrast(page);
  for (const i of [1, 2, 3, 4]) {
    const rendered = result.pairs.find((p) => p.selector === `#flow-${i}` && p.kind === "stroke");
    const token = result.pairs.find((p) => p.selector === `--g${i} on --surface (flow)`);
    assert.ok(rendered && token, `g${i}: both rendered and inventory samples required`);
    assert.equal(rendered.paintOpacity, opacity);
    assert.equal(token.paintOpacity, rendered.paintOpacity, `g${i}: inventory must use rendered flow opacity`);
    assert.equal(rendered.pass, pass, `g${i}: rendered line verdict`);
    assert.equal(token.pass, pass, `g${i}: token verdict`);
    assert.ok(Math.abs(token.ratio - rendered.ratio) < 1e-10, `g${i}: same composited ratio`);
  }
}

test("F7a known pass: flow inventory matches rendered Archer opacity in both themes", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>${css}body{background:var(--surface)}</style>${flow}`);
    for (const [theme, opacity] of [
      ["dark", 0.7],
      ["light", 0.85],
    ]) {
      await page.locator("html").evaluate((el, theme) => (el.dataset.theme = theme), theme);
      await checkFlow(page, { opacity, pass: true });
    }
  } finally {
    await browser.close();
  }
});

test("F7a known fail: low-opacity flow lines fail in the rendered and token samples", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>${css}body{background:var(--surface)}</style>${flow}`);
    for (const theme of ["dark", "light"]) {
      await page.locator("html").evaluate((el, theme) => {
        el.dataset.theme = theme;
        el.style.setProperty("--flow-line-opacity", ".2");
      }, theme);
      await checkFlow(page, { opacity: 0.2, pass: false });
    }
  } finally {
    await browser.close();
  }
});
