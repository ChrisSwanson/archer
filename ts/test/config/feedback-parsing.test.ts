import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { parseGlobalConfig, readGlobalConfig } from "../../src/config/index.ts";
import { configurationSourceRevision } from "../../src/config/source-revision.ts";
import { ProjectError } from "../../src/project/errors.ts";
import { findProject } from "../../src/project/project.ts";
import { removeTempDirs, tempDir } from "../project/support.ts";

afterEach(removeTempDirs);

function failure(run: () => unknown): ProjectError {
  try {
    run();
  } catch (error) {
    if (error instanceof ProjectError) return error;
    throw error;
  }
  throw new Error("expected a ProjectError");
}

test("global feedback parses optional fields without filling absent values", () => {
  expect(parseGlobalConfig("version = 1\n")).not.toHaveProperty("feedback");
  expect(parseGlobalConfig("version = 1\n[feedback]\n").feedback).toEqual({});
  expect(
    parseGlobalConfig('version = 1\n[feedback]\nchanges = "on_save"\nallow_notifications = false\n'),
  ).toMatchObject({
    feedback: { changes: "on_save", allowNotifications: false },
  });
  expect(parseGlobalConfig('version = 1\n[feedback]\ndelivery = "next_call_and_notify"\n').feedback).toEqual({
    delivery: "next_call_and_notify",
  });
});

test("project feedback parses only changes and delivery without changing project scope", () => {
  const root = tempDir({
    "archer.toml":
      'version = 1\nfolder = ".archer"\n[service]\nname = "courierdesk"\n[feedback]\nchanges = "manual"\ndelivery = "next_call"\n',
  });
  const project = findProject(root);
  expect(project.feedback).toEqual({ changes: "manual", delivery: "next_call" });
  expect(project).toMatchObject({
    root,
    folderSetting: ".archer",
    serviceName: "courierdesk",
    views: [],
    problems: [],
  });
  expect(project).not.toHaveProperty("discovery");

  const empty = findProject(tempDir({ "archer.toml": "version = 1\n[feedback]\n" }));
  expect(empty.feedback).toEqual({});
});

test.each([
  ["global", "unknown = true"],
  ["global", 'changes = "sometimes"'],
  ["global", "changes = true"],
  ["global", 'delivery = "immediate"'],
  ["global", "delivery = 1"],
  ["global", 'allow_notifications = "false"'],
  ["project", "unknown = true"],
  ["project", 'changes = "sometimes"'],
  ["project", "changes = true"],
  ["project", 'delivery = "immediate"'],
  ["project", "delivery = 1"],
  ["project", "allow_notifications = false"],
] as const)("%s feedback refuses invalid setting: %s", (scope, setting) => {
  const run =
    scope === "global"
      ? () => parseGlobalConfig(`version = 1\n[feedback]\n${setting}\n`)
      : () => findProject(tempDir({ "archer.toml": `version = 1\n[feedback]\n${setting}\n` }));
  const error = failure(run);
  expect(error.code).toBe("manifest_error");
  expect(error.message).toMatch(/feedback/);
});

test.each(["global", "project"] as const)("%s feedback must be one table", (scope) => {
  const run =
    scope === "global"
      ? () => parseGlobalConfig('version = 1\nfeedback = "manual"\n')
      : () => findProject(tempDir({ "archer.toml": 'version = 1\nfeedback = "manual"\n' }));
  const error = failure(run);
  expect(error.code).toBe("manifest_error");
  expect(error.message).toMatch(/feedback.*table/);
});

test("configuration source revisions use exact text and stay outside public config fields", () => {
  const source = 'version = 1\n# exact source matters\n[feedback]\nchanges = "manual"\n';
  const config = parseGlobalConfig(source);
  expect(configurationSourceRevision(config)).toBe(revision(source));
  expect(Object.keys(config).sort()).toEqual(["feedback", "version"]);
});

test("trusted file revisions retain raw BOM bytes for global and project configuration", () => {
  const bytes = Buffer.from('\ufeffversion = 1\n[feedback]\ndelivery = "next_call"\n');
  const globalRoot = tempDir();
  const globalPath = join(globalRoot, "global.toml");
  writeFileSync(globalPath, bytes);
  const global = readGlobalConfig(globalPath, { principal: "user" });
  expect(configurationSourceRevision(global)).toBe(revision(bytes));
  expect(global).not.toHaveProperty("configurationRevision");

  const projectRoot = tempDir();
  writeFileSync(join(projectRoot, "archer.toml"), bytes);
  const project = findProject(projectRoot);
  expect(configurationSourceRevision(project)).toBe(revision(bytes));
  expect(project).not.toHaveProperty("configurationRevision");
});

function revision(source: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}
