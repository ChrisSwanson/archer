import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readGlobalConfig, type GlobalConfig } from "../../src/config/index.ts";
import {
  loadServiceConfiguration,
  loadServiceConfigurationWithReader,
  type GlobalConfigReader,
} from "../../src/config/load.ts";
import { ProjectError } from "../../src/project/index.ts";

const temporary: string[] = [];
const tempDir = (): string => {
  const path = mkdtempSync(join(tmpdir(), "archer-config-load-"));
  temporary.push(path);
  return path;
};
const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
};

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

const failure = (run: () => unknown): ProjectError => {
  try {
    run();
  } catch (error) {
    if (error instanceof ProjectError) return error;
    throw error;
  }
  throw new Error("expected a ProjectError");
};

test("composes canonical project discovery, trusted user configuration, and service resolution", () => {
  const root = tempDir();
  const home = tempDir();
  write(join(root, "archer.toml"), 'version = 1\n[service]\nname = "project-choice"\n');
  mkdirSync(join(root, "nested"));
  const linkedCwd = join(tempDir(), "linked-cwd");
  symlinkSync(join(root, "nested"), linkedCwd);
  write(
    join(home, ".config", "archer", "archer.toml"),
    [
      "version = 1",
      "[service]",
      'name = "user-default"',
      'host = "user.example"',
      "[[services]]",
      'name = "named"',
      'host = "named.example"',
      "port = 4567",
      "[[projects]]",
      `path = ${JSON.stringify(root)}`,
      'service = "named"',
      "",
    ].join("\n"),
  );

  const missingSystem = join(tempDir(), "missing-system.toml");
  const loaded = loadServiceConfiguration(linkedCwd, { env: { HOME: home }, systemConfigPath: missingSystem });

  expect(loaded.project.root).toBe(root);
  expect(loaded.paths).toEqual({ system: missingSystem, user: join(home, ".config", "archer", "archer.toml") });
  expect(loaded.resolution).toMatchObject({
    serviceName: "named",
    serviceNameSource: "user-project",
    settings: { host: "named.example", port: 4567 },
    settingSources: { host: "user", port: "user" },
    dirs: { socketPath: join(home, ".local", "state", "archer", "services", "named", "archer.sock") },
    projectRule: { path: root, service: "named" },
    projectRuleSource: "user",
  });
});

test("an explicit ARCHER_CONFIG replaces both discovered layers and is required as the user principal", () => {
  const root = tempDir();
  const home = tempDir();
  const explicit = join(tempDir(), "explicit.toml");
  write(join(root, "archer.toml"), "version = 1\n");
  write(join(home, ".config", "archer", "archer.toml"), 'version = 1\n[service]\nname = "ignored-user"\n');
  write(explicit, 'version = 1\n[service]\nname = "explicit"\n');

  const calls: Array<[string, string, boolean | undefined]> = [];
  const readConfig: GlobalConfigReader = (path, options) => {
    calls.push([path, options.principal, options.required]);
    return readGlobalConfig(path, options);
  };
  const loaded = loadServiceConfigurationWithReader(root, { env: { HOME: home, ARCHER_CONFIG: explicit } }, readConfig);
  expect(calls).toEqual([[explicit, "user", true]]);
  expect(loaded.paths).toEqual({ user: explicit });
  expect(loaded.system).toBeUndefined();
  expect(loaded.resolution).toMatchObject({ serviceName: "explicit", serviceNameSource: "user" });

  const missing = join(tempDir(), "missing.toml");
  const error = failure(() => loadServiceConfiguration(root, { env: { HOME: home, ARCHER_CONFIG: missing } }));
  expect(error.code).toBe("manifest_error");
  expect(error.message).toContain(missing);
});

test("refuses a relative explicit path with a named manifest error", () => {
  const error = failure(() =>
    loadServiceConfiguration(tempDir(), { env: { HOME: tempDir(), ARCHER_CONFIG: "config/archer.toml" } }),
  );
  expect(error.code).toBe("manifest_error");
  expect(error.message).toMatch(/ARCHER_CONFIG.*absolute/);
});

describe("standard layer discovery", () => {
  test("reads the injected system default as root and the real user file as the current uid", () => {
    const root = tempDir();
    const home = tempDir();
    const systemPath = join(tempDir(), "system.toml");
    const userPath = join(home, ".config", "archer", "archer.toml");
    write(userPath, 'version = 1\n[service]\nhost = "user.example"\n');
    const system: GlobalConfig = { version: 1, service: { host: "system.example", port: 4321 } };
    const calls: Array<[string, string, boolean | undefined]> = [];
    const readConfig: GlobalConfigReader = (path, options) => {
      calls.push([path, options.principal, options.required]);
      return path === systemPath ? system : readGlobalConfig(path, options);
    };

    const loaded = loadServiceConfigurationWithReader(
      root,
      { env: { HOME: home }, systemConfigPath: systemPath },
      readConfig,
    );
    expect(calls).toEqual([
      [systemPath, "system", undefined],
      [userPath, "user", undefined],
    ]);
    expect(loaded.resolution).toMatchObject({
      settings: { host: "user.example", port: 4321 },
      settingSources: { host: "user", port: "system" },
    });
  });

  test("ignores relative XDG_CONFIG_HOME and falls back from relative HOME to homedir", () => {
    const root = tempDir();
    const paths: string[] = [];
    const readConfig: GlobalConfigReader = (path) => {
      paths.push(path);
      return { version: 1 };
    };
    loadServiceConfigurationWithReader(
      root,
      {
        env: { XDG_CONFIG_HOME: "relative-xdg", HOME: "relative-home" },
      },
      readConfig,
    );
    expect(paths).toEqual(["/etc/archer/archer.toml", join(homedir(), ".config", "archer", "archer.toml")]);
  });
});

test("missing ordinary layers and a project without a manifest preserve legacy defaults", () => {
  const root = tempDir();
  const home = tempDir();
  const loaded = loadServiceConfiguration(root, {
    env: { HOME: home },
    systemConfigPath: join(tempDir(), "missing-system.toml"),
  });
  expect(loaded.project).toMatchObject({ root, manifest: null, folder: join(root, ".archer") });
  expect(loaded.system).toEqual({ version: 1 });
  expect(loaded.user).toEqual({ version: 1 });
  expect(loaded.resolution).toMatchObject({
    serviceName: "default",
    serviceNameSource: "builtin",
    settings: { host: "127.0.0.1", admission: "any", openBrowser: "auto", autoStart: true, restore: true },
    dirs: {
      stateDir: join(home, ".local", "state", "archer"),
      socketPath: join(home, ".local", "state", "archer", "archer.sock"),
    },
  });
});

test("malformed and unsafe discovered user files fail closed at the production reader", () => {
  for (const [text, mode, code] of [
    ["version = [\n", 0o600, "manifest_error"],
    ["version = 1\n", 0o602, "untrusted_manifest"],
  ] as const) {
    const root = tempDir();
    const home = tempDir();
    const path = join(home, ".config", "archer", "archer.toml");
    write(path, text);
    chmodSync(path, mode);
    const error = failure(() =>
      loadServiceConfiguration(root, { env: { HOME: home }, systemConfigPath: join(tempDir(), "missing.toml") }),
    );
    expect(error.code).toBe(code);
    if (code === "untrusted_manifest") expect(error.message).toContain(path);
  }
});

test("an empty user projects list replaces system rules while absent user projects retains them", () => {
  const root = tempDir();
  const home = tempDir();
  const systemPath = join(tempDir(), "system.toml");
  const userPath = join(home, ".config", "archer", "archer.toml");
  const system: GlobalConfig = { version: 1, projects: [{ path: root, service: "system-rule" }] };
  let user: GlobalConfig = { version: 1, projects: [] };
  const readConfig: GlobalConfigReader = (path) =>
    path === systemPath ? system : path === userPath ? user : { version: 1 };

  expect(
    loadServiceConfigurationWithReader(root, { env: { HOME: home }, systemConfigPath: systemPath }, readConfig)
      .resolution,
  ).toMatchObject({ serviceName: "default", serviceNameSource: "builtin" });

  user = { version: 1 };
  expect(
    loadServiceConfigurationWithReader(root, { env: { HOME: home }, systemConfigPath: systemPath }, readConfig)
      .resolution,
  ).toMatchObject({ serviceName: "system-rule", serviceNameSource: "system-project", projectRuleSource: "system" });
});
