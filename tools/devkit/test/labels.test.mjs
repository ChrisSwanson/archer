import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { up, down } from "../sandbox.mjs";
import { measureLabels, measureLabelFixtures, waitForDiagramLabels, FAMILY_FIXTURES } from "../harness/labels.mjs";

const planted = (overlap) =>
  `<style>.react-flow {position:relative;height:300px}.archer-node-label-row {position:absolute;left:30px;font:20px sans-serif} .a {top:30px}.b {top:${overlap ? 30 : 90}px}</style><div class="react-flow"><div class="react-flow__node"><span class="archer-node-label-row a">First label</span></div><div class="react-flow__node"><span class="archer-node-label-row b">Second label</span></div></div>`;

test("planted labels: two labels forced to overlap are refused", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(readFileSync(new URL("../fixtures/labels/overlap.html", import.meta.url), "utf8"));
    const result = await measureLabels(page, { fit: false });
    assert.equal(result.ok, false);
    assert.equal(result.overlaps.length, 1);
    assert.deepEqual(
      result.overlaps[0].labels.map((i) => result.labels[i].text),
      ["First label", "Second label"],
    );
  } finally {
    await browser.close();
  }
});

test("separate labels pass; hidden duplicate text is ignored; rendered size includes CSS scale", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(planted(false));
    await page.addStyleTag({ content: ".react-flow { transform:scale(.5);transform-origin:top left }" });
    await page
      .locator(".react-flow")
      .evaluate((root) =>
        root.insertAdjacentHTML(
          "beforeend",
          '<div class="react-flow__node" style="display:none"><span>First label</span></div>',
        ),
      );
    const result = await measureLabels(page, { fit: false });
    assert.equal(result.complete, true);
    assert.equal(result.ok, true);
    assert.equal(result.labels.length, 2);
    assert.equal(result.minRenderedFontPx, 10);
    assert.equal(result.maxRenderedFontPx, 10);
  } finally {
    await browser.close();
  }
});

test("SVG tspan text is counted once and screen CTM determines px after fit", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<svg width="400" height="200"><g class="archer-seq-viewport" transform="scale(.5)"><text x="10" y="40" font-size="20"><tspan>One</tspan></text><text x="10" y="100" font-size="20" aria-hidden="true"><tspan>Two</tspan></text></g></svg>',
    );
    const result = await measureLabels(page, { fit: false });
    assert.equal(result.ok, true);
    assert.equal(result.labels.length, 2);
    assert.equal(result.minRenderedFontPx, 10);
    assert.equal(result.overlaps.length, 0);
  } finally {
    await browser.close();
  }
});

test("a blank or failed-to-load diagram cannot pass", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent("<main>Diagram unavailable</main>");
    const result = await measureLabels(page, { fit: false, timeout: 150 });
    assert.equal(result.complete, false);
    assert.equal(result.ok, false);
    assert.match(result.incompleteReason, /No rendered diagram labels/);
  } finally {
    await browser.close();
  }
});

test("F20: addressed title wins over a recovered diagram flash and bare Loading...", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("http://labels.test/**", (route) => {
      if (route.request().url().endsWith("/api/diagrams"))
        return route.fulfill({
          json: { views: [{ id: "x", sourcePath: "diagrams/x.mmd", title: "Addressed diagram" }] },
        });
      return route.fulfill({
        contentType: "text/html",
        body: `<h1>Checkout</h1><main><svg><g class="archer-seq-viewport"><text x="10" y="30">Wrong</text></g></svg></main><script>
        setTimeout(() => { document.querySelector('h1').textContent = 'Addressed diagram'; document.querySelector('main').innerHTML = '<p>Loading...</p>'; }, 120);
        setTimeout(() => { document.querySelector('main').innerHTML = ${JSON.stringify(planted(false))}; }, 450);
      </script>`,
      });
    });
    const result = await measureLabelFixtures(page, {
      projectUrl: "http://labels.test/projects/p/",
      fixtures: [{ family: "state", fixture: "x.mmd" }],
    });
    assert.equal(result.complete, true, JSON.stringify(result));
    assert.deepEqual(
      result.results[0].labels.map((l) => l.text),
      ["First label", "Second label"],
    );
    assert.equal(await page.locator("h1").textContent(), "Addressed diagram");
  } finally {
    await browser.close();
  }
});

for (const loading of ["<p>Loading...</p>", '<p role="status" aria-busy="true">Loading...</p>']) {
  test(`F20: loading blocks visible labels until ready (${loading})`, async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(`${loading}${planted(false)}`);
      const pending = waitForDiagramLabels(page, { timeout: 1000 });
      await page.evaluate(() => setTimeout(() => document.querySelector("p").remove(), 250));
      await pending;
      assert.equal(await page.locator("p").count(), 0, "readiness accepted labels while loading");
    } finally {
      await browser.close();
    }
  });
}

test("F20: an empty layout is never declared stable", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent("<main></main>");
    const pending = measureLabels(page, { fit: false });
    await page.evaluate(
      (html) =>
        setTimeout(() => {
          document.body.innerHTML = html;
        }, 250),
      planted(false),
    );
    const result = await pending;
    assert.equal(result.complete, true, "measurement finished during the empty loading layout");
    assert.equal(result.counts.labels, 2);
  } finally {
    await browser.close();
  }
});

test("known pass: actual Pageturner system-context.mmd as opened, and after Fit", { timeout: 45000 }, async () => {
  const writerRoot = mkdtempSync(join(tmpdir(), "archer-labels-writers-"));
  const previous = process.env.ARCHER_WRITERS_DIR;
  process.env.ARCHER_WRITERS_DIR = writerRoot;
  const name = `labels-test-${process.pid}`;
  let sandbox, browser;
  try {
    sandbox = await up({
      name,
      corpus: resolve("ts/test/fixtures/pageturner"),
      page: process.env.ARCHER_LABELS_TEST_PAGE ?? resolve("ui/dist/index.html"),
    });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
    await page.goto(sandbox.link);
    await page.goto(sandbox.projects[0].url + "diagrams/system-context.mmd");
    await page.waitForSelector(".archer-node-label-row");
    // V6 measures the opening framing by default (AM-R1-02); an explicit Fit is still measurable on request.
    const fitted = await measureLabels(page, { fit: true, family: "flowchart", fixture: "system-context.mmd" });
    assert.equal(fitted.fit, "explicit-fit");
    assert.equal(fitted.complete, true);
    await page.reload();
    await page.waitForSelector(".archer-node-label-row");
    const result = await measureLabels(page, { family: "flowchart", fixture: "system-context.mmd" });
    assert.equal(result.fit, "as-rendered");
    assert.equal(result.complete, true);
    assert.equal(result.ok, true);
    assert.equal(result.overlaps.length, 0);
    assert.ok(result.labels.some((l) => l.text.includes("Pageturner")));
    assert.ok(result.minRenderedFontPx > 0);
    const seeded = await page.evaluate(async (projectUrl) => {
      const api = projectUrl.replace("/projects/", "/p/");
      const envelope = await (await fetch(api + "api/diagrams/checkout")).json();
      const response = await fetch(api + "api/selection", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          viewId: "checkout",
          revision: envelope.revision,
          presentationId: "reader:checkout",
          selectionRevision: 1,
          nodes: [],
          edges: [],
        }),
      });
      return response.status;
    }, sandbox.projects[0].url);
    assert.equal(seeded, 204, "reader:checkout recovery seeded before measuring fixtures");
    const families = await measureLabelFixtures(page, { projectUrl: sandbox.projects[0].url });
    assert.equal(families.results.length, 7);
    assert.deepEqual(
      families.results.map((r) => r.family),
      FAMILY_FIXTURES.map((f) => f.family),
    );
    assert.equal(families.complete, true, JSON.stringify(families.results.filter((r) => !r.complete)));
    for (const family of families.results) assert.ok(family.counts.labels > 0, family.family);
    assert.equal(families.results.find((r) => r.fixture === "system-context.mmd").pass, true);
  } finally {
    if (browser) await browser.close();
    if (sandbox) await down({ name });
    if (previous === undefined) delete process.env.ARCHER_WRITERS_DIR;
    else process.env.ARCHER_WRITERS_DIR = previous;
    rmSync(writerRoot, { recursive: true, force: true });
  }
});

test("harness step writes the same failed result as JSON and Markdown", async () => {
  const { runLabels } = await import("../harness/labels.mjs");
  const root = mkdtempSync(join(tmpdir(), "archer-labels-artifacts-"));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(planted(true));
    const steps = [];
    await assert.rejects(
      runLabels(
        {
          page,
          run: { dir: root },
          step: async (title, fn) => {
            steps.push(title);
            return fn();
          },
        },
        { fit: false },
      ),
      /Label geometry failed: 1 overlapping pair/,
    );
    assert.deepEqual(steps, ["measure diagram labels"]);
    assert.equal(JSON.parse(readFileSync(join(root, "labels.json"), "utf8")).counts.overlaps, 1);
    assert.match(readFileSync(join(root, "labels.md"), "utf8"), /FAIL/);
    await page.setContent("<main>Diagram unavailable</main>");
    await assert.rejects(
      runLabels({ page, run: { dir: root }, step: async (_title, fn) => fn() }, { fit: false, timeout: 150 }),
      /Label geometry incomplete: No rendered diagram labels/,
    );
    assert.equal(JSON.parse(readFileSync(join(root, "labels.json"), "utf8")).complete, false);
    assert.match(readFileSync(join(root, "labels.md"), "utf8"), /INCOMPLETE/);
  } finally {
    await browser.close();
    rmSync(root, { recursive: true, force: true });
  }
});
