import { defineConfig } from "@playwright/test";
import { keepAwake } from "../../../tools/keep-awake.mjs";
// Hold off macOS idle sleep while the run is alive (tools/keep-awake.mjs).
keepAwake();

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "*.e2e.ts",
  retries: 0,
  workers: 1,
  timeout: 45000,
  use: { headless: true, viewport: { width: 1280, height: 800 } },
  outputDir: "/private/tmp/archer-playground-browser-results",
});
