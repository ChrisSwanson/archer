import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { inspectZoomLayout, probeReflow, probeTextZoom } from "../harness/zoom.mjs";

async function fixture(name, run) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 2560 } });
    await page.setContent(readFileSync(new URL(`../fixtures/zoom/${name}.html`, import.meta.url), "utf8"));
    await run(page);
  } finally {
    await browser.close();
  }
}

test("G8 known pass: 1280 at 400% becomes 320 CSS px, desktop pointer; contained drawing is exempt", async () => {
  await fixture("pass", async (page) => {
    const r = await probeReflow(page);
    assert.deepEqual(r.viewport, { width: 320, height: 640, coarse: false });
    assert.deepEqual(r.horizontalScroll, []);
    assert.deepEqual(r.clippedText, []);
    assert.deepEqual(r.overlappingText, []);
    assert.deepEqual(r.lostContent, []);
    assert.deepEqual(r.clippedControls, []);
    assert.ok(r.exemptTextCount > 0);
  });
});

test("G8 known fail: scroll, ancestor clipping, overlap, disappearing content and canvas controls are reported", async () => {
  await fixture("fail", async (page) => {
    const r = await probeReflow(page);
    assert.ok(r.horizontalScroll.some((x) => x.path === "document" && x.overflowPx >= 180));
    assert.ok(r.clippedText.some((x) => x.path.includes("#clipped")));
    assert.ok(r.clippedText.some((x) => x.text.includes("Diagram control")));
    assert.ok(r.overlappingText.some((x) => x.first.path.includes("#one") && x.second.path.includes("#two")));
    assert.ok(
      r.overlappingText.some((x) => x.first.path === "#tight" && x.second.path === "#tight"),
      "overlap within multiline text counts",
    );
    assert.ok(r.lostContent.some((x) => x.text.includes("Important instruction")));
    assert.ok(!r.clippedText.some((x) => x.text.includes("Exempt diagram label")));
  });
});

test("G12 known pass: explicit px text grows 2x; fixed non-text widths stay unchanged", async () => {
  await fixture("pass", async (page) => {
    const measure = () =>
      page.evaluate(() => ({
        text: document.querySelector("#sample").getBoundingClientRect().width,
        nontext: document.querySelector("#nontext").getBoundingClientRect().width,
        main: document.querySelector("main").getBoundingClientRect().width,
      }));
    const before = await measure();
    const r = await probeTextZoom(page);
    const after = await measure();
    assert.ok(Math.abs(after.text / before.text - 2) < 0.02);
    assert.equal(after.nontext, before.nontext);
    assert.equal(after.main, before.main);
    assert.deepEqual(r.clippedText, []);
    assert.deepEqual(r.overlappingText, []);
    assert.deepEqual(r.lostContent, []);
    assert.deepEqual(r.clippedControls, []);
  });
});

test("G12 known fail: text that fits at 100% clips at 200% and controls are included", async () => {
  await fixture("fail", async (page) => {
    const baseline = await page.evaluate(inspectZoomLayout);
    assert.ok(!baseline.clippedText.some((x) => x.path.includes("#text-clip")), "text fits before enlargement");
    const r = await probeTextZoom(page);
    assert.ok(r.clippedText.some((x) => x.path.includes("#text-clip")));
    assert.ok(r.clippedText.some((x) => x.text.includes("Diagram control")));
    assert.ok(r.overlappingText.length > 0);
    assert.equal(r.zoom.factor, 2);
    assert.equal(r.zoom.native, false);
  });
});
