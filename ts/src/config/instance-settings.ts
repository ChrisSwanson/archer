// The account's service settings as the page shows them: read-only (ADR 0028). Browser credentials
// never write configuration; the person changes these in the global archer.toml or the environment.
import { homedir } from "node:os";
import { revisionOf } from "../project/index.ts";
import { displayLocation } from "./project-settings.ts";
import { loadGlobalConfiguration } from "./load.ts";
import {
  CONFIG_FILE_SYSTEM,
  readGlobalConfigSnapshotWithFileSystem,
  type CommentSubmission,
  type ConfigFileSystem,
  type GlobalConfig,
  type ServiceConfig,
} from "./index.ts";
import {
  resolveServiceConfiguration,
  serviceSettingsForIdentity,
  type ResolvedServiceSettings,
  type ServiceFlags,
  type SettingSource,
} from "./resolve.ts";

/** Every resolved service setting, in the order the page lists them. */
export const SHOWN_SETTINGS = [
  "edit",
  "host",
  "port",
  "publicUrl",
  "admission",
  "openBrowser",
  "autoStart",
  "restore",
  "commentSubmission",
  "pairingCodeMinutes",
  "tlsCert",
  "tlsKey",
  "forceHttp",
] as const;
export type ShownSetting = (typeof SHOWN_SETTINGS)[number];
/** Values the page never receives: only whether one is set. */
const REDACTED: ReadonlySet<ShownSetting> = new Set(["tlsKey"]);
/** Paths the page receives home-relative (displayLocation): any grant holder reads these settings. */
const PATHS: ReadonlySet<ShownSetting> = new Set(["tlsCert"]);
const BUILT_IN: Readonly<Record<ShownSetting, string | number | boolean | null>> = {
  edit: true,
  host: "127.0.0.1",
  port: null,
  publicUrl: null,
  admission: "any",
  openBrowser: "auto",
  autoStart: true,
  restore: true,
  commentSubmission: "immediate",
  pairingCodeMinutes: 5,
  tlsCert: null,
  tlsKey: null,
  forceHttp: false,
};

export interface ShownSettingValue {
  readonly key: ShownSetting;
  /** `null` when unset (the built-in behaviour applies); `"set"` for a redacted value. */
  readonly value: string | number | boolean | null;
  readonly default: string | number | boolean | null;
  readonly source: SettingSource;
}

export interface InstanceSettings {
  readonly serviceName: string;
  readonly commentSubmission: CommentSubmission;
  readonly configRevision: string;
  readonly configPath: string;
  /** Always false: no browser credential writes account configuration (ADR 0028). */
  readonly writable: false;
  readonly settings: readonly ShownSettingValue[];
}

export class InstanceSettingsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class InstanceSettingsStore {
  constructor(
    readonly serviceName: string,
    readonly env: Readonly<Record<string, string | undefined>>,
    readonly systemConfigPath = "/etc/archer/archer.toml",
    /** @internal */ readonly fileSystem: ConfigFileSystem = CONFIG_FILE_SYSTEM,
    /** The running service's startup overrides, so the page shows what the service actually uses. */
    readonly flags: Omit<ServiceFlags, "serviceName"> = {},
  ) {}

  read(): InstanceSettings {
    const loaded = loadGlobalConfiguration(this.env, this.systemConfigPath);
    const required = this.env["ARCHER_CONFIG"] !== undefined && this.env["ARCHER_CONFIG"] !== "";
    const snapshot = readGlobalConfigSnapshotWithFileSystem(
      loaded.paths.user,
      { principal: "user", required },
      this.fileSystem,
    );
    const setting = selected(loaded.system, this.serviceName)?.commentSubmission ?? "immediate";
    const userSetting = selected(snapshot.config, this.serviceName)?.commentSubmission;
    const resolved = resolveServiceConfiguration({
      projectRoot: "/",
      ...(loaded.system === undefined ? {} : { system: loaded.system }),
      user: snapshot.config,
      env: this.env,
      flags: { ...this.flags, serviceName: this.serviceName },
    });
    const home = this.env["HOME"] ?? homedir();
    const settings = SHOWN_SETTINGS.map((key): ShownSettingValue => {
      // `edit` is top-level, not a service setting: creating and editing in the page; a project's own `edit` wins.
      if (key === "edit") {
        const user = snapshot.config?.edit,
          system = loaded.system?.edit;
        return {
          key,
          value: user ?? system ?? BUILT_IN.edit,
          default: BUILT_IN.edit,
          source: user !== undefined ? "user" : system !== undefined ? "system" : "builtin",
        };
      }
      const raw = (resolved.settings as ResolvedServiceSettings & Record<string, unknown>)[key];
      const value =
        raw === undefined
          ? null
          : REDACTED.has(key)
            ? "set"
            : PATHS.has(key) && typeof raw === "string"
              ? displayLocation(raw, home)
              : (raw as string | number | boolean);
      return { key, value, default: BUILT_IN[key], source: resolved.settingSources[key] };
    });
    return {
      serviceName: this.serviceName,
      commentSubmission: userSetting ?? setting,
      configRevision: revisionOf(Buffer.from(snapshot.source, "utf8")),
      configPath: displayLocation(loaded.paths.user, home),
      writable: false,
      settings,
    };
  }
}

function selected(config: GlobalConfig | undefined, name: string): ServiceConfig | undefined {
  return config === undefined ? undefined : serviceSettingsForIdentity(config, name);
}
