// The production page must carry no dev telemetry (docs/devkit/CONTRACT.md, "Switches").
// `node scripts/check-prod-strip.mjs dist/index.html [more pages]` exits 1 naming each marker it finds.
// `npm run build` runs it after the build, and first `--refuse-debug-env`, which fails while
// `ARCHER_DEBUG_UI=1` is set: debug pages are built only by `build:debug`, into `dist/debug/`.
// `ts/scripts/bundle.ts` runs the same check on the page it packages.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Strings only the telemetry code contains: its route, its global, and its warning codes. */
export const DEBUG_MARKERS = [
  "/-/debug/",
  "__archerTelemetry",
  "ui.page-error",
  "ui.console-error",
  "ui.fetch-duplicate",
  "ui.request-count",
  "ui.web-vitals",
  "ui.render-storm",
  "ui.edit.",
  // The tag on a scheduled poll's requests (telemetry/runtime.ts, app/polls.ts).
  "x-archer-poll",
  // React's profiling renderer (`react-dom/profiling`, which a debug build aliases in): its
  // performance-track labels, which React's production renderer lacks (its development build has
  // them too, and does not belong in a production page either).
  "Cascading Update",
  "Suspended on CSS and Images",
];

export function debugMarkersIn(html) {
  return DEBUG_MARKERS.filter((marker) => html.includes(marker));
}

/** Why this environment may not run a production build, or null. */
export function debugEnvRefusal(env) {
  return env.ARCHER_DEBUG_UI === "1"
    ? "ARCHER_DEBUG_UI=1 is set: a production build never carries telemetry; build a debug page with `npm --workspace ui run build:debug` (into dist/debug/)"
    : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--refuse-debug-env") {
    const refusal = debugEnvRefusal(process.env);
    if (refusal !== null) {
      console.error(`check-prod-strip: ${refusal}`);
      process.exit(1);
    }
  } else {
    const files = process.argv.length > 2 ? process.argv.slice(2) : ["dist/index.html"];
    for (const file of files) {
      const found = debugMarkersIn(readFileSync(file, "utf8"));
      if (found.length > 0) {
        console.error(`check-prod-strip: ${file} contains dev telemetry: ${found.join(", ")}`);
        process.exit(1);
      }
      console.log(`check-prod-strip: ${file} carries no dev telemetry.`);
    }
  }
}
