// The ui test run's writers root (vite.config.ts, tools/test-writers-dir.mjs): given to every Vitest run, whatever
// its mode, and to nothing else (a build, the dev server). A Vitest run in a mode of its own (`--mode production`)
// without it would send the claims of the services its tests start to the person's own state directory.
import { isAbsolute } from "node:path";
import type { UserConfig } from "vite";
import { afterEach, expect, test } from "vitest";
import config from "../vite.config";

type Make = (env: {
  command: "serve" | "build";
  mode: string;
}) => UserConfig & { test?: { env?: Record<string, string> } };
const make = config as unknown as Make;
const vitest = process.env.VITEST;

afterEach(() => {
  process.env.VITEST = vitest;
});

for (const mode of ["test", "production", "development"])
  test(`a Vitest run in mode ${mode} gets the run's writers root`, () => {
    const root = make({ command: "serve", mode }).test?.env?.ARCHER_WRITERS_DIR;
    expect(root).toBeDefined();
    expect(isAbsolute(root!)).toBe(true);
  });

for (const [command, mode] of [
  ["build", "production"],
  ["serve", "development"],
] as const)
  test(`${command} in mode ${mode}, outside Vitest, makes no writers root`, () => {
    delete process.env.VITEST;
    expect(make({ command, mode }).test?.env?.ARCHER_WRITERS_DIR).toBeUndefined();
  });
