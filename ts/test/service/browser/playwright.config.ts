/**
 * The service's real-browser test: Chromium against Archer's own page served
 * by the TypeScript service: this checkout's build (`npm run build` first), or
 * ARCHER_PAGE. Run from the repository root with
 *
 *   npx playwright test -c ts/test/service/browser
 *
 * Files are `*.e2e.ts`, so vitest never collects them.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.e2e.ts",
  // Outside the repository: nothing a run leaves behind lands in the worktree.
  outputDir: join(tmpdir(), "archer-ts-service-test-results"),
  fullyParallel: false,
  retries: 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  use: {
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
