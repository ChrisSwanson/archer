import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { build } from "esbuild";
import { afterEach, expect, test } from "vitest";
import {
  MAX_PROJECT_LIFECYCLE_BYTES,
  MAX_PROJECT_LIFECYCLE_DEPTH,
  parseProjectLifecycle,
  ProjectLifecycleStore,
} from "../../src/state/project-lifecycle.ts";
import { cleanUp, tempDir } from "../service/support.ts";

afterEach(cleanUp);

test("a lifecycle mutation rechecks the private runtime directory before writing", () => {
  const state = tempDir("archer-lifecycle-");
  const store = new ProjectLifecycleStore(state, () => Date.parse("2026-10-15T12:00:00.000Z"));
  chmodSync(`${state}/runtime`, 0o777);
  try {
    expect(() => store.observe("/project", "empty", true)).toThrow(expect.objectContaining({ code: "saved_state_io" }));
    expect(existsSync(store.path)).toBe(false);
  } finally {
    chmodSync(`${state}/runtime`, 0o700);
  }
});

test("a directory-sync failure is reported after rename without losing the visible committed choice", () => {
  const state = tempDir("archer-lifecycle-");
  const store = new ProjectLifecycleStore(state, () => Date.parse("2026-10-15T12:00:00.000Z"));
  chmodSync(`${state}/runtime`, 0o300);
  try {
    expect(() => store.observe("/project", "empty", true)).toThrow(expect.objectContaining({ code: "saved_state_io" }));
  } finally {
    chmodSync(`${state}/runtime`, 0o700);
  }
  expect(store.setVisibility("/project", "hidden", "empty")).toMatchObject({ state: "inactive", visibility: "hidden" });
  expect(new ProjectLifecycleStore(state).setVisibility("/project", "hidden", "empty")).toMatchObject({
    state: "inactive",
    visibility: "hidden",
  });
});

test("a non-regular lifecycle file is refused without blocking startup", async () => {
  const state = tempDir("archer-lifecycle-");
  const runtime = join(state, "runtime");
  mkdirSync(runtime, { mode: 0o700 });
  execFileSync("mkfifo", [join(runtime, "project-lifecycle.json")]);
  const module = join(state, "lifecycle.mjs");
  const runner = join(state, "runner.mjs");
  await build({
    entryPoints: [new URL("../../src/state/project-lifecycle.ts", import.meta.url).pathname],
    outfile: module,
    bundle: true,
    format: "esm",
    platform: "node",
  });
  writeFileSync(
    runner,
    `import {ProjectLifecycleStore} from './lifecycle.mjs';\ntry { new ProjectLifecycleStore(${JSON.stringify(state)}); } catch { process.exit(7); }`,
  );
  const result = spawnSync(process.execPath, [runner], { timeout: 1_000, encoding: "utf8" });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(7);
});

test("empty grace, content history, manual visibility, restart, and idempotence share one persisted state machine", () => {
  let now = Date.parse("2026-10-15T12:00:00.000Z");
  const state = tempDir("archer-lifecycle-");
  const root = "/project";
  let store = new ProjectLifecycleStore(state, () => now);
  expect(store.observe(root, "empty", true)).toEqual({
    state: "grace",
    visibility: "auto",
    reason: "empty",
    emptySince: "2026-10-15T12:00:00.000Z",
  });
  const inode = statSync(store.path, { bigint: true }).ino;
  expect(store.observe(root, "unknown", true)).toMatchObject({
    state: "unknown",
    emptySince: "2026-10-15T12:00:00.000Z",
  });
  expect(statSync(store.path, { bigint: true }).ino).toBe(inode);

  now += 10 * 60 * 1_000;
  store = new ProjectLifecycleStore(state, () => now);
  expect(store.observe(root, "empty", false)).toMatchObject({ state: "inactive", reason: "empty" });
  expect(store.observe(root, "content", false)).toEqual({ state: "active", visibility: "auto" });
  expect(store.observe(root, "empty", false)).toEqual({ state: "active", visibility: "auto" });
  expect(store.setVisibility(root, "hidden", "content")).toEqual({
    state: "inactive",
    visibility: "hidden",
    reason: "manual",
  });
  store = new ProjectLifecycleStore(state, () => now);
  expect(store.observe(root, "content", false)).toEqual({ state: "inactive", visibility: "hidden", reason: "manual" });
  expect(store.setVisibility(root, "visible", "content")).toEqual({
    state: "active",
    visibility: "visible",
    reason: "manual",
  });
  store = new ProjectLifecycleStore(state, () => now);
  expect(store.setVisibility(root, "visible", "content")).toEqual({
    state: "active",
    visibility: "visible",
    reason: "manual",
  });
  expect(store.setVisibility(root, "auto", "empty")).toEqual({ state: "active", visibility: "auto" });
});

test("a legacy attachment never becomes automatically eligible through manual overrides", () => {
  const store = new ProjectLifecycleStore(tempDir("archer-lifecycle-"), () => Date.parse("2026-10-15T12:00:00.000Z"));
  expect(store.observe("/legacy", "empty", false)).toMatchObject({ state: "unknown", visibility: "auto" });
  expect(store.setVisibility("/legacy", "hidden", "empty")).toMatchObject({ state: "inactive", visibility: "hidden" });
  expect(store.setVisibility("/legacy", "auto", "empty")).toMatchObject({ state: "unknown", visibility: "auto" });
});

test("the lifecycle file accepts its exact byte and depth limits and refuses one past either", () => {
  const valid = JSON.stringify({ version: 1, projects: [] });
  const exact = valid + " ".repeat(MAX_PROJECT_LIFECYCLE_BYTES - Buffer.byteLength(valid));
  expect(() => parseProjectLifecycle(exact)).not.toThrow();
  expect(() => parseProjectLifecycle(`${exact} `)).toThrow(expect.objectContaining({ code: "saved_state_capacity" }));
  const exactDepth = JSON.stringify({
    version: 1,
    projects: [
      {
        root: "/project",
        firstObservedAt: "2026-10-15T12:00:00.000Z",
        everHadContent: false,
        automaticEligible: true,
        visibility: "auto",
      },
    ],
  });
  expect(() => parseProjectLifecycle(exactDepth)).not.toThrow();
  const onePast = `{"version":1,"projects":[],"extra":${"[".repeat(MAX_PROJECT_LIFECYCLE_DEPTH)}0${"]".repeat(MAX_PROJECT_LIFECYCLE_DEPTH)}}`;
  expect(() => parseProjectLifecycle(onePast)).toThrow(expect.objectContaining({ code: "saved_state_depth" }));
});
