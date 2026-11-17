// The page a service started from this checkout serves when it is given none: the checkout's web build,
// never the MCP App's single file (which carries the MCP shell alone, ADR 0003).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { defaultPagePath } from "../../src/service/index.ts";
import { REPO } from "../terminal/models.ts";

test("a checkout's service serves its web build, not the tracked MCP App file", () => {
  expect(defaultPagePath()).toBe(join(REPO, "ui", "dist", "index.html"));
  expect(defaultPagePath()).not.toBe(join(REPO, "ts", "assets", "archer-mcp-app.html"));
});

test.runIf(existsSync(join(REPO, "ui", "dist", "index.html")))(
  "the web build it names loads its layout worker from beside it",
  () => {
    const page = readFileSync(defaultPagePath(), "utf8");
    expect(page).toMatch(/page-assets\/elk-layout-worker-[\w-]+\.js/);
  },
);
