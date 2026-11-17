import { defineConfig } from "@playwright/test";
import { keepAwake } from "../../tools/keep-awake.mjs";

// Browser checks of the built docs site: `npm run docs:build && npm run docs:test:browser`.
// Hold off macOS idle sleep while the run is alive (tools/keep-awake.mjs).
keepAwake();

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "**/*.e2e.ts",
  retries: 0,
  workers: 2,
  timeout: 45000,
  use: { headless: true, viewport: { width: 1440, height: 900 } },
  outputDir: "/private/tmp/archer-site-browser-results",
});
