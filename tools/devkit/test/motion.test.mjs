// node --test tools/devkit/test/motion.test.mjs
// The motion probe (harness/motion.mjs) on planted pages in a real Chromium: its known pass and known fail
// (rubric ui-ux.md §8: the packet parked under Off / the packet left moving), and each collector on its own
// (CSS animation, SMIL, a requestAnimationFrame mover, chrome transitions).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { MOTION_CELLS, probeMotion } from "../harness/motion.mjs";

let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

const OFF = MOTION_CELLS.find((c) => c.id === "off-reduce");
const ON = MOTION_CELLS.find((c) => c.id === "on-noreduce");

async function probe(html, { cell = null, reduce = false, sampleMs = 800 } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 800, height: 600 },
    reducedMotion: reduce ? "reduce" : "no-preference",
  });
  try {
    const page = await ctx.newPage();
    await page.setContent(`<style>body{margin:0}</style>${html}`);
    await page.waitForTimeout(100);
    return await probeMotion(page, { sampleMs, cell });
  } finally {
    await ctx.close();
  }
}

// The packet as EmphasisChevrons draws it: a group per edge holding chevrons; moving ones carry <animateMotion>.
const packet = (moving) => `
  <svg width="400" height="200"><path id="route" d="M20,100 L380,100" stroke="black" fill="none"/>
    <g class="archer-emph-chevrons" data-edge="e1">
      <g class="archer-emph-chevron"${moving ? "" : ` transform="translate(200,100)"`}><path d="M-4,-4.5 L1.5,0 L-4,4.5" stroke="blue" fill="none"/>
        ${moving ? `<animateMotion dur="1.2s" repeatCount="indefinite" rotate="auto"><mpath href="#route"/></animateMotion>` : ""}</g>
    </g></svg>`;

test("known pass: the packet parked at the midpoint under Off + OS reduce", async () => {
  const r = await probe(packet(false), { cell: OFF, reduce: true });
  assert.equal(r.summary.packets, 1);
  assert.equal(r.summary.packetMoving, false);
  assert.equal(r.summary.automaticMotions, 0);
  assert.equal(r.verdict.noEmphasisMotion, true);
  assert.equal(r.verdict.packetParked, true);
  assert.equal(r.verdict.pass, true);
});

test("known fail: the packet left moving (SMIL <animateMotion>) under Off + OS reduce", async () => {
  const r = await probe(packet(true), { cell: OFF, reduce: true });
  assert.equal(r.summary.smilActive, 1);
  assert.equal(r.summary.packetMoving, true);
  assert.ok(r.summary.movers >= 1, "the chevron's box moves between samples");
  assert.equal(r.verdict.packetParked, false);
  assert.equal(r.verdict.pass, false);
});

test("under On without reduce, a moving packet is what the cell expects", async () => {
  const r = await probe(packet(true), { cell: ON });
  assert.equal(r.verdict.packetMoving, true);
  assert.equal(r.verdict.pass, true);
});

test("a CSS animation left running is collected by getAnimations()", async () => {
  const r = await probe(
    `<style>@keyframes spin{to{transform:rotate(360deg)}} .s{width:40px;height:40px;background:red;animation:spin 1s linear infinite}</style><div class="s"></div>`,
  );
  assert.equal(r.summary.runningAnimations, 1);
  assert.equal(r.running[0].type, "CSSAnimation");
  assert.equal(r.running[0].name, "spin");
  assert.equal(r.summary.automaticMotions, 1, "the rotating box is one motion, not two");
});

test("a requestAnimationFrame mover is caught by the sampled boxes", async () => {
  const r =
    await probe(`<div id="m" style="position:absolute;left:0;top:0;width:30px;height:30px;background:green"><span>x</span></div>
    <script>const m=document.getElementById("m");(function f(t){m.style.left=(t/10%300)+"px";requestAnimationFrame(f)})(0)</script>`);
  assert.equal(r.summary.runningAnimations, 0);
  assert.equal(r.summary.movers, 1, "the box and its child move together: one motion");
  assert.equal(r.summary.automaticMotions, 1);
});

test("a still page has no automatic motion; chrome transitions are counted statically", async () => {
  const r = await probe(`<button style="transition:background 200ms">Still</button>`, { cell: OFF, reduce: true });
  assert.equal(r.summary.automaticMotions, 0);
  assert.equal(r.summary.chromeTransitions, 1);
  assert.equal(r.verdict.chromeTransitions, 1);
  assert.equal(r.verdict.packetParked, null, "no packet on the page: not judged");
});
