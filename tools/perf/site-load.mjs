// Static docs-site load probe: cold loads of docs/playground pages in Chromium, one line per page.
//
//   node tools/perf/site-load.mjs [--base http://localhost:4173] [--paths /archer/,/archer/playground/app/index.html]
//        [--json <file>] [--fail-on-error]
//
// Prints load and network-idle times, request count, decoded bytes, and every 4xx/5xx, failed request,
// page error and console error. Serve the built site first, e.g. `npx vitepress preview site --port 4173`.
// For the Archer service page use tools/perf/page-load.mjs instead (budgets, manifests, CDP detail).
// Run from ui/ (or any folder that resolves @playwright/test): `cd ui && node ../tools/perf/site-load.mjs`.
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};
const base = option("base", "http://localhost:4173");
const paths = option(
  "paths",
  "/archer/,/archer/playground,/archer/playground/app/,/archer/playground/app/index.html?scene=hero,/archer/generated/cli",
).split(",");

const browser = await chromium.launch();
const rows = [];
for (const path of paths) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const problems = [];
  let requests = 0;
  let bytes = 0;
  page.on("response", async (response) => {
    requests++;
    if (response.status() >= 400) problems.push(`${response.status()} ${response.url()}`);
    try {
      bytes += (await response.body()).length;
    } catch {}
  });
  page.on("requestfailed", (request) => problems.push(`failed ${request.url()} ${request.failure()?.errorText ?? ""}`));
  page.on("pageerror", (error) => problems.push(`pageerror ${error.message.slice(0, 160)}`));
  page.on(
    "console",
    (message) => message.type() === "error" && problems.push(`console ${message.text().slice(0, 160)}`),
  );
  const started = Date.now();
  await page
    .goto(base + path, { waitUntil: "load", timeout: 60_000 })
    .catch((error) => problems.push(`goto ${error.message}`));
  const load = Date.now() - started;
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => problems.push("networkidle timeout"));
  const idle = Date.now() - started;
  const row = { path, load, idle, requests, kb: Math.round(bytes / 1024), problems };
  rows.push(row);
  console.log(
    `${path}  load=${load}ms idle=${idle}ms req=${requests} ${row.kb}KB${problems.length ? `\n  ${problems.join("\n  ")}` : ""}`,
  );
  await context.close();
}
await browser.close();
const json = option("json");
if (json) writeFileSync(json, `${JSON.stringify({ base, rows }, null, 2)}\n`);
if (args.includes("--fail-on-error") && rows.some((row) => row.problems.length)) process.exit(1);
