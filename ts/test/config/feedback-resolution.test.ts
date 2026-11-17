import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { parseGlobalConfig, readGlobalConfig, type GlobalConfig } from "../../src/config/index.ts";
import { loadServiceConfiguration, loadServiceConfigurationWithReader } from "../../src/config/load.ts";

const roots: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), "archer-feedback-resolution-"));
  roots.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  const user = join(root, "user.toml"),
    system = join(root, "system.toml");
  writeFileSync(user, "version = 1\n", { mode: 0o600 });
  return {
    root,
    project,
    user,
    system,
    options: { env: { HOME: root, ARCHER_CONFIG: user }, systemConfigPath: system },
  };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("production loader resolves feedback defaults separately from service settings", () => {
  const fixture = setup();
  const loaded = loadServiceConfiguration(fixture.project, fixture.options);
  expect(loaded).toHaveProperty("feedback");
  const feedback = loaded.feedback;
  expect(feedback).toMatchObject({
    changes: "on_save",
    delivery: "next_call",
    allowNotifications: false,
    notificationPolicy: "not_requested",
    sources: { changes: "builtin", delivery: "builtin", allowNotifications: "builtin" },
  });
  expect(feedback.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(loaded.resolution.settings).not.toHaveProperty("feedback");
});

function feedback(fixture: ReturnType<typeof setup>) {
  return loadServiceConfiguration(fixture.project, fixture.options).feedback;
}
function projectConfig(fixture: ReturnType<typeof setup>, source: string) {
  writeFileSync(join(fixture.project, "archer.toml"), source, { mode: 0o600 });
}

test("user and project fields overlay independently, explicit false closes the global gate", () => {
  const f = setup();
  // ARCHER_CONFIG intentionally selects only the user global file, excluding system config.
  writeFileSync(f.user, 'version = 1\n[feedback]\nchanges = "manual"\nallow_notifications = false\n');
  projectConfig(f, 'version = 1\n[feedback]\ndelivery = "next_call_and_notify"\n');
  expect(feedback(f)).toMatchObject({
    changes: "manual",
    delivery: "next_call_and_notify",
    allowNotifications: false,
    notificationPolicy: "blocked_by_global",
    sources: { changes: "user", delivery: "project", allowNotifications: "user" },
  });
});

test("system and user layers are field-wise and project cannot grant push", () => {
  const f = setup();
  const homeConfig = join(f.root, ".config", "archer");
  mkdirSync(homeConfig, { recursive: true });
  writeFileSync(f.system, 'version = 1\n[feedback]\nchanges = "manual"\nallow_notifications = true\n', { mode: 0o600 });
  writeFileSync(join(homeConfig, "archer.toml"), "version = 1\n[feedback]\nallow_notifications = false\n", {
    mode: 0o600,
  });
  projectConfig(f, 'version = 1\n[feedback]\ndelivery = "next_call_and_notify"\n');
  const loaded = loadServiceConfigurationWithReader(
    f.project,
    { env: { HOME: f.root }, systemConfigPath: f.system },
    (path, options) =>
      path === f.system ? parseGlobalConfig(readFileSync(path, "utf8")) : readGlobalConfig(path, options),
  );
  expect(loaded.feedback).toMatchObject({
    changes: "manual",
    notificationPolicy: "blocked_by_global",
    sources: { changes: "system", delivery: "project", allowNotifications: "user" },
  });
  expect(loaded.feedback.sourceRevisions.system).toMatch(/^sha256:/);
});

test.each([
  ["next_call", false, "not_requested"],
  ["next_call", true, "not_requested"],
  ["next_call_and_notify", false, "blocked_by_global"],
  ["next_call_and_notify", true, "requires_subscription"],
] as const)("delivery %s and global gate %s produce policy %s, never promise delivery", (delivery, allow, policy) => {
  const f = setup();
  writeFileSync(f.user, `version = 1\n[feedback]\ndelivery = "${delivery}"\nallow_notifications = ${allow}\n`);
  expect(feedback(f).notificationPolicy).toBe(policy);
});

test("effective revision covers exact global and project sources, including comments", () => {
  const f = setup();
  projectConfig(f, "version = 1\n");
  const original = feedback(f);
  expect(feedback(f).revision).toBe(original.revision);
  writeFileSync(f.user, "version = 1\n# global edit\n");
  const globalEdit = feedback(f);
  expect(globalEdit.revision).not.toBe(original.revision);
  expect(globalEdit.sourceRevisions.user).not.toBe(original.sourceRevisions.user);
  expect(globalEdit.sourceRevisions.project).toBe(original.sourceRevisions.project);
  projectConfig(f, "version = 1\n# project edit\n");
  const projectEdit = feedback(f);
  expect(projectEdit.revision).not.toBe(globalEdit.revision);
  expect(projectEdit.sourceRevisions.project).not.toBe(globalEdit.sourceRevisions.project);
  expect(projectEdit.sourceRevisions.user).toBe(globalEdit.sourceRevisions.user);
  expect(projectEdit.changes).toBe(original.changes);
});

test("absent versus present empty files have distinct source provenance", () => {
  const f = setup();
  const absent = feedback(f);
  expect(absent.sourceRevisions.project).toBeNull();
  projectConfig(f, "version = 1\n");
  const present = feedback(f);
  expect(present.sourceRevisions.project).toMatch(/^sha256:/);
  expect(present.revision).not.toBe(absent.revision);
  expect(present.sources).toEqual(absent.sources);
});

test("different projects and selected services never share an effective revision", () => {
  const f = setup();
  const first = feedback(f);
  const other = join(f.root, "other");
  mkdirSync(other);
  expect(loadServiceConfiguration(other, f.options).feedback.revision).not.toBe(first.revision);
  const named = loadServiceConfiguration(f.project, { ...f.options, flags: { serviceName: "named" } });
  expect(named.feedback.revision).not.toBe(first.revision);
});

test("resolving feedback preserves listener, authoring root and independent write rules", () => {
  const f = setup();
  projectConfig(f, 'version = 1\nfolder = "docs"\n[feedback]\nchanges = "manual"\ndelivery = "next_call_and_notify"\n');
  writeFileSync(
    f.user,
    `version = 1\n[service]\nhost = "127.0.0.1"\nport = 40400\n[[projects]]\npath = ${JSON.stringify(f.project)}\nread_only = true\n`,
  );
  const result = loadServiceConfiguration(f.project, f.options);
  expect(result.project.folder).toBe(join(f.project, "docs"));
  expect(result.resolution.settings).toMatchObject({ host: "127.0.0.1", port: 40400 });
  expect(result.resolution.projectRule).toMatchObject({ path: f.project, readOnly: true });
  expect(result.feedback).toMatchObject({ changes: "manual", allowNotifications: false });
});

test("injected configuration readers remain deterministic without claiming raw source revisions", () => {
  const f = setup();
  let user: GlobalConfig = { version: 1, feedback: { changes: "manual" } };
  const read = () => user;
  const one = loadServiceConfigurationWithReader(f.project, f.options, read).feedback;
  const two = loadServiceConfigurationWithReader(f.project, f.options, read).feedback;
  expect(one.sourceRevisions).toEqual({ system: null, user: null, project: null });
  expect(two.revision).toBe(one.revision);
  user = { version: 1, feedback: { changes: "on_save" } };
  expect(loadServiceConfigurationWithReader(f.project, f.options, read).feedback.revision).not.toBe(one.revision);
});
