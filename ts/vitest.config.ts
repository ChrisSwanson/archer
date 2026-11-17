import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { runWritersDir } from "../tools/test-writers-dir.mjs";

// macOS's TMPDIR (/var/folders/…/T) is reached through a link (/var → /private/var) and is long.
// Archer refuses a link on the way to a confined root (ADR 0018 D7), and a Unix socket path holds
// at most 103 bytes there, so tests that build projects and state under tmpdir() fail on macOS for
// reasons a person's real project never meets. Give the suite, and every process it forks, a short
// real temporary directory instead. Linux's /tmp is already real and short.
if (process.platform === "darwin") {
  const dir = `/private/tmp/archer-test-${process.getuid?.() ?? "user"}`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  process.env.TMPDIR = dir;
}

export default defineConfig({
  resolve: {
    alias: {
      "@archer/export-painter": fileURLToPath(new URL("../ui/src/export/painter.ts", import.meta.url)),
      "@archer/layout-analysis": fileURLToPath(new URL("../ui/src/layout/analysis.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    // The editor fuzz (test/stress) runs for minutes; it is opt-in:
    // `npm run test:stress` (STRESS=1). Ordinary runs and CI skip it.
    exclude: ["**/node_modules/**", ...(process.env.STRESS === "1" ? [] : ["test/stress/**"])],
    environment: "node",
    // ARCHER_TEST_PATH_ANCHORS=1 runs the suite on the macOS confinement (the D7 path anchor).
    setupFiles: process.env.ARCHER_TEST_PATH_ANCHORS === "1" ? ["test/support/path-anchors.ts"] : [],
    // Writer claims are private per-user runtime state (src/comments/lock.ts).
    // Tests and the processes they fork share the run's own scratch root
    // (tools/test-writers-dir.mjs), removed when the run ends, never the
    // person's own state directory.
    // The instance registry and preferences (ADR 0031) likewise: a test service started on the
    // process environment never lists itself in, or reads, the person's ~/.archer.
    env: {
      ARCHER_WRITERS_DIR: runWritersDir(),
      ARCHER_HOME: join(tmpdir(), `archer-test-home-${process.getuid?.() ?? "user"}`),
    },
    // Match CI's bounded pool for ordinary local runs too. Each worker loads
    // its own compiler/runtime; host CPU count is not a memory budget.
    // A caller can still select another measured limit with --maxWorkers.
    // Hold off macOS idle sleep for the run (tools/keep-awake.mjs).
    globalSetup: [fileURLToPath(new URL("../tools/keep-awake.mjs", import.meta.url))],
    maxWorkers: 3,
    // The first compile or export in a worker loads and transforms the whole
    // Mermaid compiler or painter (~0.7–1.7 s idle). On the shared, loaded CI
    // host that cold start has exceeded vitest's 5 s default in tests that
    // check behaviour, not speed (store.test.ts, notes/tools.test.ts), so the
    // default bound is 15 s. A test that measures time asserts it explicitly.
    testTimeout: 15_000,
  },
});
