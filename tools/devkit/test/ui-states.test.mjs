import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { inspectState } from "../fixtures/ui-states.mjs";

test("state checker: planted empty overview passes; fabricated empty count with projects fails", async (t) => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent("<main><h1>No projects yet</h1><p>Ask your agent to attach a project.</p></main>");
    const good = await inspectState(page, { name: "zero-projects", projectCount: 0 });
    assert.equal(good.ok, true);
    t.diagnostic(JSON.stringify({ fixture: "zero-projects: planted pass", result: good.ok }));
    await page.setContent('<main><h1>Projects</h1><a href="/projects/demo/">Demo</a></main>');
    const bad = await inspectState(page, { name: "zero-projects", projectCount: 1 });
    assert.equal(bad.ok, false);
    t.diagnostic(JSON.stringify({ fixture: "zero-projects: planted fail", result: bad.ok, failures: bad.failures }));
    assert.ok(bad.failures.some((f) => f.includes("empty")));
  } finally {
    await browser.close();
  }
});

test("state checker: compile failure must be visible and announced, not just present in metadata", async (t) => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<main><p role="alert">This diagram could not compile. Fix the Mermaid source.</p></main>');
    const good = await inspectState(page, { name: "compile-error", compileInvalid: true });
    assert.equal(good.ok, true);
    t.diagnostic(JSON.stringify({ fixture: "compile-error: planted pass", result: good.ok }));
    await page.setContent('<main><p hidden role="alert">Could not compile</p><p>Current drawing</p></main>');
    const bad = await inspectState(page, { name: "compile-error", compileInvalid: true });
    assert.equal(bad.ok, false);
    t.diagnostic(JSON.stringify({ fixture: "compile-error: planted fail", result: bad.ok, failures: bad.failures }));
  } finally {
    await browser.close();
  }
});

test("state checker: real state evidence is required for each role and connection mode", async (t) => {
  const browser = await chromium.launch({ headless: true });
  const cases = [
    {
      fixture: { name: "expired-link", revoked: true, timeExpirySupported: false },
      good: "<main><h1>Open the link Archer gave you</h1><p>Ask your agent for a new one.</p></main>",
      bad: "<main><h1>Not found</h1></main>",
    },
    {
      fixture: { name: "reader-link", role: "reader", grantId: "planted" },
      good: '<main><div class="react-flow__node">Client</div><div class="react-flow__node">API</div></main>',
      bad: "<main><h1>Request flow</h1><p>Loading...</p></main>",
    },
    {
      fixture: { name: "service-stopped", stopped: true },
      good: '<main><p role="status">Reconnecting. This diagram may be out of date.</p></main>',
      bad: "<main><p>Current drawing</p></main>",
    },
  ];
  try {
    const page = await browser.newPage();
    for (const { fixture, good, bad } of cases) {
      await page.setContent(good);
      const passing = await inspectState(page, fixture);
      assert.equal(passing.ok, true, `${fixture.name} planted pass`);
      t.diagnostic(JSON.stringify({ fixture: `${fixture.name}: planted pass`, result: passing.ok }));
      await page.setContent(bad);
      const failing = await inspectState(page, fixture);
      assert.equal(failing.ok, false, `${fixture.name} planted fail`);
      t.diagnostic(
        JSON.stringify({ fixture: `${fixture.name}: planted fail`, result: failing.ok, failures: failing.failures }),
      );
    }
  } finally {
    await browser.close();
  }
});

test("harness journey exposes its result and preserves a supplied browser on setup failure", async () => {
  const states = await import("../fixtures/ui-states.mjs");
  assert.equal(typeof states.default, "function", "state fixtures must be a runnable smoke journey");
  assert.equal(states.default, states.runUiStates);
  assert.equal(states.meta.name, "ui-states");
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const out = mkdtempSync(join(tmpdir(), "archer-state-journey-test-"));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await assert.rejects(
      states.runUiStates(
        { page, step: async (_name, action) => action(), run: { dir: out } },
        { page: join(out, "missing-prebuilt-page.html") },
      ),
      /UI state fixtures/,
    );
    assert.equal(browser.isConnected(), true, "the journey must not close the harness browser");
    const report = JSON.parse(readFileSync(join(out, "ui-states", "ui-states.json"), "utf8"));
    assert.equal(report.ok, false);
    assert.match(report.error, /No built page/);
    await page.setContent("<main>Harness browser is still usable</main>");
    assert.match(await page.locator("main").innerText(), /still usable/);
  } finally {
    await browser.close();
    rmSync(out, { recursive: true, force: true });
  }
});
