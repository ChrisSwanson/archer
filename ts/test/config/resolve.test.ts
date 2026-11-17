import { expect, test } from "vitest";
import type { GlobalConfig } from "../../src/config/index.ts";
import { resolveServiceConfiguration } from "../../src/config/resolve.ts";
import { ProjectError } from "../../src/project/errors.ts";

const config = (value: Omit<GlobalConfig, "version">): GlobalConfig => ({ version: 1, ...value });

test("selects identity and settings through every precedence layer with provenance", () => {
  const system = config({
    service: { name: "system-fallback", host: "system-default", port: 4400 },
    services: [{ name: "chosen", host: "system-named", port: 4401 }],
    projects: [{ path: "/work/**", service: "system-rule" }],
  });
  const user = config({
    service: { name: "user-fallback", host: "user-default" },
    services: [{ name: "chosen", host: "user-named", admission: "listed" }],
    projects: [{ path: "/work/project", service: "chosen" }],
  });
  const resolved = resolveServiceConfiguration({
    projectRoot: "/work/project",
    projectServiceName: "manifest-choice",
    system,
    user,
    env: { HOME: "/home/me", ARCHER_SERVICE: "chosen", ARCHER_PORT: "4500", ARCHER_OPEN_BROWSER: "always" },
    flags: { serviceName: "chosen", host: "flag-host", autoStart: false },
  });
  expect(resolved).toMatchObject({
    serviceName: "chosen",
    serviceNameSource: "flag",
    settings: {
      host: "flag-host",
      port: 4500,
      admission: "listed",
      openBrowser: "always",
      autoStart: false,
      restore: true,
    },
    settingSources: {
      host: "flag",
      port: "env",
      admission: "user",
      openBrowser: "env",
      autoStart: "flag",
      restore: "builtin",
    },
    dirs: {
      stateDir: "/home/me/.local/state/archer/services/chosen",
      socketPath: "/home/me/.local/state/archer/services/chosen/archer.sock",
    },
    projectRule: { path: "/work/project", service: "chosen" },
    projectRuleSource: "user",
  });
});

test.each([
  ["env", { env: { ARCHER_SERVICE: "env-choice" } }, "env-choice"],
  ["user-project", { user: config({ projects: [{ path: "/work/project", service: "user-rule" }] }) }, "user-rule"],
  ["system-project", { system: config({ projects: [{ path: "/work/**", service: "system-rule" }] }) }, "system-rule"],
  ["project", { projectServiceName: "manifest-choice" }, "manifest-choice"],
  ["user", { user: config({ service: { name: "user-fallback" } }) }, "user-fallback"],
  ["system", { system: config({ service: { name: "system-fallback" } }) }, "system-fallback"],
  ["builtin", {}, "default"],
] as const)("selects the %s identity source", (source, extra, name) => {
  expect(
    resolveServiceConfiguration({ projectRoot: "/work/project", env: { HOME: "/home/me" }, ...extra }),
  ).toMatchObject({ serviceName: name, serviceNameSource: source });
});

test("named services do not inherit default settings, while default named records overlay [service]", () => {
  const system = config({
    service: { host: "system-default", port: 4400 },
    services: [
      { name: "named", admission: "listed" },
      { name: "default", host: "system-explicit" },
    ],
  });
  const user = config({
    service: { host: "user-default", port: 4500 },
    services: [
      { name: "named", openBrowser: "never" },
      { name: "default", port: 4501 },
    ],
  });
  expect(
    resolveServiceConfiguration({
      projectRoot: "/p",
      system,
      user,
      flags: { serviceName: "named" },
      env: { HOME: "/h" },
    }),
  ).toMatchObject({
    settings: { host: "127.0.0.1", admission: "listed", openBrowser: "never" },
    settingSources: { host: "builtin", port: "builtin", admission: "system", openBrowser: "user" },
  });
  expect(resolveServiceConfiguration({ projectRoot: "/p", system, user, env: { HOME: "/h" } })).toMatchObject({
    settings: { host: "user-default", port: 4501 },
    settingSources: { host: "user", port: "user" },
  });
});

test("an unregistered valid name uses built-ins", () => {
  expect(
    resolveServiceConfiguration({ projectRoot: "/p", flags: { serviceName: "unregistered" }, env: { HOME: "/h" } }),
  ).toMatchObject({
    settings: { host: "127.0.0.1", admission: "any", openBrowser: "auto", autoStart: true, restore: true },
  });
});

test.each([
  ["ARCHER_SERVICE", "Bad", /ARCHER_SERVICE/],
  ["ARCHER_PORT", "80", /ARCHER_PORT/],
  ["ARCHER_PORT", "x", /ARCHER_PORT/],
  ["ARCHER_ADMISSION", "sometimes", /ARCHER_ADMISSION/],
  ["ARCHER_PUBLIC_URL", "file:///tmp/x", /ARCHER_PUBLIC_URL/],
  ["ARCHER_OPEN_BROWSER", "", /ARCHER_OPEN_BROWSER/],
  ["ARCHER_AUTO_START", "", /ARCHER_AUTO_START/],
  ["ARCHER_RESTORE_STATE", "", /ARCHER_RESTORE_STATE/],
] as const)("refuses invalid %s", (key, value, message) => {
  let caught: unknown;
  try {
    resolveServiceConfiguration({ projectRoot: "/p", env: { HOME: "/h", [key]: value } });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ProjectError);
  expect((caught as ProjectError).code).toBe("manifest_error");
  expect((caught as Error).message).toMatch(message);
});

test("preserves legacy boolean environment spellings and empty host behavior", () => {
  expect(
    resolveServiceConfiguration({
      projectRoot: "/p",
      env: { HOME: "/h", ARCHER_HOST: "", ARCHER_AUTO_START: "0", ARCHER_RESTORE_STATE: "false" },
    }),
  ).toMatchObject({
    settings: { host: "127.0.0.1", autoStart: false, restore: false },
    settingSources: { host: "builtin", autoStart: "env", restore: "env" },
  });
});

test("derives default and named directories with authoritative absolute legacy overrides", () => {
  expect(resolveServiceConfiguration({ projectRoot: "/p", env: { HOME: "/home/u" } }).dirs).toEqual({
    stateDir: "/home/u/.local/state/archer",
    socketDir: "/home/u/.local/state/archer",
    socketPath: "/home/u/.local/state/archer/archer.sock",
  });
  const named = resolveServiceConfiguration({
    projectRoot: "/p",
    flags: { serviceName: "two" },
    env: { HOME: "/home/u", ARCHER_STATE_DIR: "/state/two" },
  });
  expect(named).toMatchObject({
    dirs: { stateDir: "/state/two", socketDir: "/state/two", socketPath: "/state/two/archer.sock" },
    dirSources: { stateDir: "env", socketPath: "env" },
  });
  expect(
    resolveServiceConfiguration({
      projectRoot: "/p",
      flags: { serviceName: "two" },
      env: { HOME: "/home/u", ARCHER_STATE_DIR: "relative", ARCHER_SOCKET: "/run/two.sock" },
    }),
  ).toMatchObject({
    dirs: { stateDir: "/home/u/.local/state/archer/services/two", socketDir: "/run", socketPath: "/run/two.sock" },
    dirSources: { stateDir: "builtin", socketPath: "env" },
  });
});

test("pairing codes last 5 minutes unless the user or system configuration says otherwise", () => {
  expect(resolveServiceConfiguration({ projectRoot: "/p", env: {} }).settings.pairingCodeMinutes).toBe(5);
  const resolved = resolveServiceConfiguration({
    projectRoot: "/p",
    env: {},
    system: { version: 1, service: { pairingCodeMinutes: 10 } },
    user: { version: 1, service: { pairingCodeMinutes: 15 } },
  });
  expect(resolved.settings.pairingCodeMinutes).toBe(15);
  expect(resolved.settingSources.pairingCodeMinutes).toBe("user");
});
