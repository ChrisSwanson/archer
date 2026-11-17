import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { up, down } from "../sandbox.mjs";
import {
  STATES,
  openState,
  resolveTarget,
  sandboxTarget,
  VIEWPORTS,
  THEMES,
  cellContext,
} from "../harness/surfaces.mjs";

const state = (id) => STATES.find((s) => s.id === id);

test("F20 zero-project sandbox has no attachments and P1.zero opens it through the auxiliary target", {
  timeout: 60000,
}, async () => {
  const name = `f20-zero-${process.pid}`;
  let sandbox, browser;
  try {
    sandbox = await up({ name, zeroProjects: true, corpus: resolve("ts/test/fixtures/pageturner") });
    assert.deepEqual(sandbox.projects, []);
    browser = await chromium.launch();
    const target = resolveTarget(
      { origin: "http://unused.invalid", login: "http://unused.invalid/link", "zero-sandbox": name },
      {},
    );
    assert.equal(target.zero.origin, sandbox.origin);
    for (const viewport of Object.keys(VIEWPORTS))
      for (const theme of THEMES) {
        const context = await cellContext(browser, { viewport, theme });
        try {
          const page = await context.newPage();
          const opened = await openState(page, state("P1.zero"), target);
          assert.equal(opened.ok, true, `${viewport}/${theme}: ${JSON.stringify(opened)}`);
          const inventory = await page.request.get(`${sandbox.origin}/api/browser-projects`);
          assert.equal(inventory.status(), 200);
          assert.deepEqual((await inventory.json()).projects, []);
          assert.match(await page.locator("main").innerText(), /No diagrams or notes yet\./i);
        } finally {
          await context.close();
        }
      }
  } finally {
    await browser?.close();
    if (sandbox) await down({ name });
  }
});

test("F20 embedded sandbox serves the MCP build and P10 draws its real compiled fixture", {
  timeout: 60000,
}, async () => {
  const name = `f20-mcp-${process.pid}`;
  const writers = mkdtempSync(join(tmpdir(), "f20-mcp-writers-"));
  const previous = process.env.ARCHER_WRITERS_DIR;
  process.env.ARCHER_WRITERS_DIR = writers;
  let sandbox, browser;
  try {
    sandbox = await up({ name, embedded: true, corpus: resolve("ts/test/fixtures/pageturner") });
    assert.equal(sandbox.page, resolve("ui/dist/mcp/index.html"));
    browser = await chromium.launch();
    const target = resolveTarget(
      { origin: "http://unused.invalid", login: "http://unused.invalid/link", "embedded-sandbox": name },
      {},
    );
    assert.equal(target.embedded.origin, sandbox.origin);
    for (const viewport of Object.keys(VIEWPORTS))
      for (const theme of THEMES) {
        const context = await cellContext(browser, { viewport, theme });
        try {
          const page = await context.newPage();
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("console", (message) => {
            if (message.type() === "error") errors.push(message.text());
          });
          const opened = await openState(page, state("P10.embedded"), target);
          assert.equal(opened.ok, true, `${viewport}/${theme}: ${JSON.stringify(opened)}`);
          assert.equal(await page.locator(".archer-mcp-shell").isVisible(), true);
          assert.equal(await page.locator(".react-flow__node").first().isVisible(), true);
          assert.equal(await page.locator(".archer-project-browser").count(), 0);
          assert.match(await page.locator(".archer-mcp-shell").innerText(), /Pageturner/);
          assert.deepEqual(errors, [], `${viewport}/${theme}: unexpected embedded errors`);
        } finally {
          await context.close();
        }
      }
    assert.equal(sandboxTarget(sandbox).embeddedPage, true);
  } finally {
    await browser?.close();
    if (sandbox) await down({ name });
    if (previous === undefined) delete process.env.ARCHER_WRITERS_DIR;
    else process.env.ARCHER_WRITERS_DIR = previous;
    rmSync(writers, { recursive: true, force: true });
  }
});
