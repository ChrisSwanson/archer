import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { measureContrast } from "../harness/contrast.mjs";
import { focusStop, settleFocus } from "../harness/focus-walk.mjs";
import { censusPage } from "../harness/targets.mjs";

let browser, server, origin;
before(async () => {
  browser = await chromium.launch();
  server = createServer((req, res) => {
    if (req.url === "/wrong.mmd") {
      res.writeHead(302, { location: "/other.mmd" }).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    if (req.url === "/projects/demo/notes/readme.md") {
      res.end(
        '<style>body{background:white;color:black}</style><main class="archer-stage"><article class="archer-note-body"><h2 id="heading">Note heading</h2><p>Plain note content</p></article></main>',
      );
      return;
    }
    const kind = req.url.slice(1).replace(".mmd", "");
    const content =
      kind === "sequence"
        ? '<svg class="archer-seq-viewport"><text x="10" y="30" fill="black">Sequence label</text></svg>'
        : kind === "journey"
          ? '<div class="archer-journey">Journey label</div>'
          : '<div class="react-flow__node">Graph label</div>';
    res.end(`<style>body{background:white;color:black}</style><main>Chrome${req.url === "/projects/demo/notes/design.md" ? '<div class="react-flow"></div>' : ""}</main><script>
      let frames=0; function render(){ if(++frames < 10) requestAnimationFrame(render);
      else { ${kind === "missing" ? "" : `document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(content)})`} } } requestAnimationFrame(render);
      </script>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

test("R1 #28 known pass: direct fixture contrast waits for rendered graph, sequence and journey labels", async () => {
  for (const family of ["flowchart", "state", "er", "c4", "architecture", "sequence", "journey"]) {
    const page = await browser.newPage();
    try {
      const surface = `${origin}/${family}.mmd`;
      await page.goto(surface, { waitUntil: "domcontentloaded" });
      const result = await measureContrast(page, { surface, tokens: false });
      assert.ok(result.counts.diagramLabels >= 1, `${family}: label coverage must be explicit`);
      assert.equal(result.status, "pass", JSON.stringify(result.incomplete));
      assert.ok(
        result.pairs.some((pair) => pair.kind === "text" && /label/.test(pair.element)),
        family,
      );
    } finally {
      await page.close();
    }
  }
});

test("R1 #28 a query view, embedded note and non-URL surface labels wait for the diagram", async () => {
  const cases = [
    ["/projects/demo/?follow&view=diagram", undefined],
    ["/projects/demo/?follow&view=diagram", "P4.explore.flowchart"],
    ["/projects/demo/notes/design.md#diagram", undefined],
  ];
  for (const [path, state] of cases) {
    const page = await browser.newPage();
    try {
      const surface = `${origin}${path}`;
      await page.goto(surface, { waitUntil: "domcontentloaded" });
      const result = await measureContrast(page, { surface: state ?? surface, tokens: false });
      assert.ok(result.counts.diagramLabels >= 1, `${path}: awaited the actual view`);
      assert.equal(result.status, "pass", JSON.stringify(result.incomplete));
    } finally {
      await page.close();
    }
  }
});

test("R1 #28 known pass: a plain note heading anchor does not require diagram labels", async () => {
  const page = await browser.newPage();
  try {
    const surface = `${origin}/projects/demo/notes/readme.md#heading`;
    await page.goto(surface);
    const result = await measureContrast(page, { surface, tokens: false, readinessTimeout: 200 });
    assert.equal(result.status, "pass", JSON.stringify(result.incomplete));
    assert.equal(result.counts.diagramLabels, 0);
  } finally {
    await page.close();
  }
});

test("R1 #28 a view address keeps its fixture identity across the access exchange", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}/projects/demo/?follow&view=diagram`);
    // The link as issued, before its token is exchanged: the same view.
    const result = await measureContrast(page, {
      surface: `${origin}/projects/demo/?follow&view=diagram&token=0123`,
      tokens: false,
    });
    assert.equal(result.status, "pass", JSON.stringify(result.incomplete));
    assert.ok(result.counts.diagramLabels >= 1);
  } finally {
    await page.close();
  }
});

test("R1 #28 known fail: a query view's identity cannot silently change", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}/projects/demo/?follow&view=other`);
    const result = await measureContrast(page, {
      surface: `${origin}/projects/demo/?follow&view=expected`,
      tokens: false,
    });
    assert.equal(result.status, "incomplete");
    assert.match(JSON.stringify(result.incomplete), /expected.*fixture/i);
  } finally {
    await page.close();
  }
});

test("R1 #28 known fail: chrome alone cannot certify fixture contrast coverage", async () => {
  const page = await browser.newPage();
  try {
    const surface = `${origin}/missing.mmd`;
    await page.goto(surface);
    const result = await measureContrast(page, { surface, tokens: false, readinessTimeout: 200 });
    assert.equal(result.status, "incomplete");
    assert.equal(result.pass, false);
    assert.equal(result.counts.diagramLabels, 0);
    assert.match(JSON.stringify(result.incomplete), /diagram labels/i);
  } finally {
    await page.close();
  }
});

test("R1 #28 known fail: redirected fixture identity is reported rather than certified", async () => {
  const page = await browser.newPage();
  try {
    const surface = `${origin}/wrong.mmd`;
    await page.goto(surface);
    const result = await measureContrast(page, { surface, tokens: false });
    assert.equal(result.status, "incomplete");
    assert.match(JSON.stringify(result.incomplete), /expected.*fixture/i);
  } finally {
    await page.close();
  }
});

test("R1 #29 known pass/fail: zero-height SVG strokes remain visible unless painted over", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<style>body{margin:0} g:focus{outline:none} g:focus path{filter:drop-shadow(0 0 3px blue)}</style>
      <svg width="500" height="300"><g id="edge" tabindex="0" aria-label="Edge"><path d="M30 100H200" fill="none" stroke="black" stroke-width="4"/></g></svg>
      <div id="cover" style="display:none;position:absolute;left:0;top:80px;width:300px;height:40px;background:white"></div>`);
    await page.focus("#edge");
    const visible = await page.evaluate(focusStop);
    assert.equal(visible.obscured.hidden, false);
    assert.equal(visible.indicator.detected, true);
    await page.locator("#cover").evaluate((el) => (el.style.display = "block"));
    assert.equal((await page.evaluate(focusStop)).obscured.hidden, true);
  } finally {
    await page.close();
  }
});

test("R1 #29 known pass/fail: settle native smooth scrolling before judging focus; retain real cover failures", async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  try {
    await page.setContent(`<style>html{scroll-behavior:smooth}body{margin:0}button{position:absolute;top:3000px}</style>
      <button id="destination">Destination</button><div style="height:4000px"></div>`);
    await page.focus("#destination");
    await settleFocus(page);
    assert.equal((await page.evaluate(focusStop)).obscured.hidden, false);
    await page.evaluate(() => {
      const cover = document.createElement("div");
      cover.style.cssText = "position:fixed;inset:0;background:white;z-index:10";
      document.body.append(cover);
    });
    assert.equal((await page.evaluate(focusStop)).obscured.hidden, true);
  } finally {
    await page.close();
  }
});

test("R1 #29 target census separates scroll-only Tab stops from pointer actions", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<style>body{margin:0}#scroll{position:absolute;left:11px;top:0;width:340px;height:320px;overflow:auto}#separator{position:absolute;left:0;top:0;width:11px;height:500px}</style>
      <div id="separator" role="separator" tabindex="0" aria-label="Resize diagram panel"></div>
      <section id="scroll" tabindex="0" role="group" aria-label="Diagram symbols"><div style="height:1000px">Scrollable explanation</div></section>
      <button style="position:absolute;left:450px;top:0;width:20px;height:20px">A</button>
      <button style="position:absolute;left:472px;top:0;width:20px;height:20px">B</button>`);
    const result = await censusPage(page);
    assert.ok(!result.targets.some((target) => target.name === "Diagram symbols"));
    assert.equal(result.targets.find((target) => target.name === "Resize diagram panel").w, "spacing");
    assert.equal(result.targets.find((target) => target.name === "A").w, "fail");
    assert.equal(result.targets.find((target) => target.name === "B").w, "fail");
  } finally {
    await page.close();
  }
});

test("R1 #29 hidden transparent status text is not a painted occluder", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<button id="target" style="position:absolute;left:50px;top:50px;width:100px;height:40px">Target</button>
      <span aria-hidden="true" style="position:absolute;left:50px;top:50px;width:100px;height:40px;color:transparent;pointer-events:none">9</span>`);
    await page.focus("#target");
    assert.equal((await page.evaluate(focusStop)).obscured.hidden, false);
  } finally {
    await page.close();
  }
});
