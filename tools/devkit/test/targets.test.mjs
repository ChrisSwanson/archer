// node --test tools/devkit/test/targets.test.mjs
// The target census (harness/targets.mjs) on planted pages in a real Chromium: its known pass and known fail
// (rubric ui-ux.md §8: a 36 px button / a 20 px button 2 px from its neighbour), the spacing exception, the
// exception candidates, and the coarse-pointer 44 px column.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { censusPage, judgeTargets } from "../harness/targets.mjs";

let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

async function census(html, { coarse = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 }, isMobile: coarse, hasTouch: coarse });
  try {
    const page = await ctx.newPage();
    await page.setContent(
      `<style>body{margin:0;font:16px sans-serif} button{padding:0;border:0;margin:0;position:absolute;top:100px}</style>${html}`,
    );
    return await censusPage(page);
  } finally {
    await ctx.close();
  }
}
const byName = (r, name) => r.targets.find((t) => t.name === name);

test("known pass: a lone 36 px button passes 2.5.8 by size", async () => {
  const r = await census(`<button style="left:100px;width:36px;height:36px">Go</button>`);
  assert.equal(r.summary.targets, 1);
  assert.equal(byName(r, "Go").w, "size");
  assert.equal(r.summary.w.fail, 0);
});

test("known fail: a 20 px button 2 px from its neighbour fails 2.5.8 (circle hits the neighbour's circle)", async () => {
  const r = await census(
    `<button style="left:100px;width:20px;height:20px">A</button><button style="left:122px;width:20px;height:20px">B</button>`,
  );
  assert.equal(byName(r, "A").w, "fail");
  assert.equal(byName(r, "B").w, "fail");
  assert.equal(r.summary.w.failNoCandidate, 2);
});

test("the spacing exception: two 20 px buttons 6 px apart pass by spacing", async () => {
  const r = await census(
    `<button style="left:100px;width:20px;height:20px">A</button><button style="left:126px;width:20px;height:20px">B</button>`,
  );
  assert.deepEqual([byName(r, "A").w, byName(r, "B").w], ["spacing", "spacing"]);
  assert.equal(r.summary.w.fail, 0);
});

test("a 20 px button whose circle reaches a large neighbour's box fails; the large one passes by size", async () => {
  const r = await census(
    `<button style="left:100px;width:20px;height:20px">S</button><button style="left:121px;width:60px;height:40px">Large</button>`,
  );
  assert.equal(byName(r, "S").w, "fail");
  assert.equal(byName(r, "Large").w, "size");
});

test("exception candidates are recorded, not passed: an inline link in a sentence", async () => {
  const r = await census(
    `<p style="position:absolute;top:10px;left:10px;font-size:12px">Read <a href="#a">the guide</a> and <a href="#b">more</a> now.</p>`,
  );
  const link = byName(r, "the guide");
  assert.ok(link.box.h < 24);
  assert.deepEqual(link.candidates, ["inline"]);
  assert.equal(r.summary.w.failNoCandidate, 0);
});

test("[H] 44 px column applies only under pointer: coarse", async () => {
  const fine = await census(`<button style="left:100px;width:36px;height:36px">Go</button>`);
  assert.equal(fine.summary.h44.applies, false);
  assert.equal(byName(fine, "Go").h44, null);
  const coarse = await census(
    `<button style="left:100px;width:36px;height:36px">Small</button><button style="left:200px;width:44px;height:44px">Big</button>`,
    { coarse: true },
  );
  assert.equal(coarse.summary.h44.applies, true);
  assert.equal(byName(coarse, "Small").h44, false);
  assert.equal(byName(coarse, "Big").h44, true);
  assert.equal(coarse.summary.h44.fail, 1);
});

test("judgeTargets: a target nested inside another is not its neighbour", () => {
  const r = judgeTargets({
    coarse: false,
    targets: [
      { i: 0, name: "card", box: { x: 0, y: 0, w: 200, h: 60 }, candidates: [] },
      { i: 1, name: "inner", box: { x: 10, y: 10, w: 16, h: 16 }, candidates: [] },
    ],
  });
  assert.equal(r.targets[1].w, "spacing");
});
