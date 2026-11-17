// Keep a Mac awake while a test run is alive.
//
// On a Mac set to idle-sleep (pmset `sleep 1`), a long Vitest or Playwright run that nobody is watching is
// suspended mid-test: on 2026-11-13 the ts suite took 36 min, 30 of them asleep, and every test that was running
// when the machine slept "took" 350–970 s and failed its 15 s timeout. `caffeinate -i -w <pid>` holds an idle-sleep
// assertion only until the runner exits. No-op off macOS, in CI, or when ARCHER_KEEP_AWAKE=0; the env mark stops
// workers and nested runners (which load the same config) from starting a second one.
import { spawn } from "node:child_process";

export function keepAwake() {
  if (process.platform !== "darwin" || process.env.CI || process.env.ARCHER_KEEP_AWAKE) return;
  process.env.ARCHER_KEEP_AWAKE = String(process.pid);
  try {
    const child = spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

/** Vitest/Playwright globalSetup form. */
export default function setup() {
  keepAwake();
}
