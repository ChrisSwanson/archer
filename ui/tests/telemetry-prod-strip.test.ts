// The production page carries no dev telemetry; a debug build carries it (so the check is not vacuous).
// Builds the page twice in child processes (about 6 s each), into a temporary directory.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { DEBUG_MARKERS, debugEnvRefusal, debugMarkersIn } from "../scripts/check-prod-strip.mjs";
import { archerDebug, debugOutDirRefusal } from "../vite.config";

const UI = fileURLToPath(new URL("..", import.meta.url));
const VITE = fileURLToPath(new URL("../../node_modules/vite/bin/vite.js", import.meta.url));
const out = mkdtempSync(join(tmpdir(), "archer-prod-strip-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

function build(name: string, debug: boolean): string {
  // Vitest sets NODE_ENV=test, which would make Vite bundle React's development build.
  const { VITEST: _vitest, ARCHER_DEBUG_UI: _debug, NODE_ENV: _mode, ...inherited } = process.env;
  const env = debug ? { ...inherited, ARCHER_DEBUG_UI: "1" } : inherited;
  execFileSync(process.execPath, [VITE, "build", "--outDir", join(out, name), "--emptyOutDir", "--logLevel", "error"], {
    cwd: UI,
    env,
    stdio: "pipe",
  });
  return readFileSync(join(out, name, "index.html"), "utf8");
}

it("switches on for the dev server and ARCHER_DEBUG_UI=1, off for builds and tests", () => {
  expect(archerDebug("serve", {})).toBe(true);
  expect(archerDebug("build", {})).toBe(false);
  expect(archerDebug("build", { ARCHER_DEBUG_UI: "1" })).toBe(true);
  expect(archerDebug("serve", { VITEST: "true" })).toBe(false);
  expect(archerDebug("serve", { ARCHER_DEBUG_UI: "0" })).toBe(false);
});

it("strips telemetry from the production build and keeps it in a debug build", () => {
  const production = build("production", false);
  expect(debugMarkersIn(production)).toEqual([]);
  const debug = build("debug", true);
  expect(debugMarkersIn(debug)).toEqual([...DEBUG_MARKERS]);
}, 180_000);

it("a production build refuses ARCHER_DEBUG_UI=1, and a debug build refuses ui/dist", () => {
  expect(debugEnvRefusal({ ARCHER_DEBUG_UI: "1" })).toMatch(/build:debug/);
  expect([debugEnvRefusal({}), debugEnvRefusal({ ARCHER_DEBUG_UI: "0" })]).toEqual([null, null]);
  const guard = (env: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, ["scripts/check-prod-strip.mjs", "--refuse-debug-env"], {
      cwd: UI,
      env,
      encoding: "utf8",
    });
  const { ARCHER_DEBUG_UI: _debug, ...clean } = process.env;
  expect(guard({ ...clean, ARCHER_DEBUG_UI: "1" }).status).toBe(1);
  expect(guard(clean).status).toBe(0);
  // `npm run build` runs the guard first.
  expect(JSON.parse(readFileSync(join(UI, "package.json"), "utf8")).scripts.build).toMatch(
    /^node scripts\/check-prod-strip\.mjs --refuse-debug-env && .* scripts\/check-prod-strip\.mjs dist\/index\.html dist\/mcp\/index\.html$/,
  );
  expect(debugOutDirRefusal(true, "dist", UI)).toMatch(/may not write ui\/dist/);
  expect(debugOutDirRefusal(true, join(UI, "dist/"), UI)).not.toBeNull();
  expect(debugOutDirRefusal(true, "dist/mcp", UI)).toMatch(/ui\/dist\/mcp/);
  expect([
    debugOutDirRefusal(true, "dist/debug", UI),
    debugOutDirRefusal(false, "dist", UI),
    debugOutDirRefusal(true, out, UI),
  ]).toEqual([null, null, null]);
});
