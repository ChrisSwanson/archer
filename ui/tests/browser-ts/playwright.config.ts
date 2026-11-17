/**
 * The page in a real browser against the TypeScript service (`ts/src/service`).
 * Run with
 *
 *   npm --workspace ui run build && npm --workspace ui run test:browser:ts
 *
 * The service is started in the test process and serves `ui/dist/index.html`,
 * the page just built, so what is tested is this checkout's page.
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import { installCpuThrottle } from "./support/cpu-throttle";
import { keepAwake } from "../../../tools/keep-awake.mjs";
import { runWritersDir } from "../../../tools/test-writers-dir.mjs";

// Loaded in every worker too, so the hook is in place where the pages are made.
installCpuThrottle();

// macOS's TMPDIR (/var/folders/…/T) is reached through a link (/var → /private/var) and is long. Archer refuses a
// link on the way to a confined root (ADR 0018 D7: a state dir made there answered authoring_store_io), and a Unix
// socket path holds at most 103 bytes there, so fixtures that build projects and state under tmpdir() fail on macOS
// for reasons a person's real project never meets. As ts/vitest.config.ts does: a short real temporary directory,
// set here so the runner, every worker and every process they start use it. Linux's /tmp is already real and short.
if (process.platform === "darwin") {
  const dir = `/private/tmp/archer-test-${process.getuid?.() ?? "user"}`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  process.env.TMPDIR = dir;
}
// Writer claims are private per-user runtime state (ts/src/comments/lock.ts): the services these tests start in
// their workers, and the processes they fork, share the run's own scratch root (tools/test-writers-dir.mjs), made
// by the runner and removed when it exits, after its workers; a worker inherits the runner's. Never the person's
// own state directory.
process.env.ARCHER_WRITERS_DIR = runWritersDir();

const CI = !!process.env.CI;

// Files dispatched before the rest, each in a project of its own. Playwright hands out work in
// project order and cuts `--shard` ranges from that same order, so these start at the head of
// shard 1 and of a local run instead of finishing it alone. xss-mcp-host runs in order on one
// worker (`mode: "default"`, one devkit sandbox) for about 3 min; sorted last, it was the run's
// tail with the other workers idle (S-1).
const FIRST = ["xss-mcp-host.e2e.ts"];
// pr-check's changed e2e files (ARCHER_E2E_FIRST, space-separated, relative to this folder) run
// next, so a likely failure shows early. Only the order changes: each file still runs once.
const CHANGED = (process.env.ARCHER_E2E_FIRST ?? "").split(/\s+/).filter((file) => file && !FIRST.includes(file));
const exact = (file: string) => `**/browser-ts/${file}`;

// Hold off macOS idle sleep while the run is alive (tools/keep-awake.mjs).
keepAwake();

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.e2e.ts",
  // The page served as an installed service serves it: with its packaged compressed copies (O33).
  globalSetup: "./support/precompress-page.ts",
  // Local agent invocations may overlap. Sharing Playwright's artifact tree
  // lets one run delete another's in-flight trace. CI containers are isolated
  // and retain the fixed path consumed by report-playwright.sh.
  outputDir: join(tmpdir(), CI ? "archer-ui-ts-browser-results" : `archer-ui-ts-browser-results-${process.pid}`),
  fullyParallel: true,
  forbidOnly: CI,
  // Never retried.
  retries: 0,
  workers: CI ? 2 : 4,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  use: {
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // The last project keeps the empty name, so the list reporter prints its tests as before.
  projects: [
    ...FIRST.map((file) => ({ name: file.replace(/\.e2e\.ts$/, ""), testMatch: exact(file) })),
    ...(CHANGED.length ? [{ name: "changed", testMatch: CHANGED.map(exact) }] : []),
    { name: "", testIgnore: [...FIRST, ...CHANGED].map(exact) },
  ],
});
