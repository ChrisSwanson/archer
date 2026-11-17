import { resolveFeedbackConfiguration, type ResolvedFeedbackConfiguration } from "./feedback-resolution.ts";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ProjectError, findProject, type Project } from "../project/index.ts";
import { readGlobalConfig, type GlobalConfig, type ReadGlobalConfigOptions } from "./index.ts";
import { resolveServiceConfiguration, type ResolvedServiceConfiguration, type ServiceFlags } from "./resolve.ts";

export type GlobalConfigReader = (path: string, options: ReadGlobalConfigOptions) => GlobalConfig;

export interface LoadServiceConfigurationOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly flags?: ServiceFlags;
  /** Alternate default system path, used by packaged installations and tests. */
  readonly systemConfigPath?: string;
}

export interface LoadedServiceConfiguration {
  readonly project: Project;
  readonly system?: GlobalConfig;
  readonly user: GlobalConfig;
  readonly paths: { readonly system?: string; readonly user: string };
  readonly resolution: ResolvedServiceConfiguration;
  readonly feedback: ResolvedFeedbackConfiguration;
}

export interface LoadedGlobalConfiguration {
  readonly system?: GlobalConfig;
  readonly user: GlobalConfig;
  readonly paths: { readonly system?: string; readonly user: string };
}

export function loadGlobalConfiguration(
  env: Readonly<Record<string, string | undefined>> = process.env,
  systemConfigPath = "/etc/archer/archer.toml",
): LoadedGlobalConfiguration {
  return loadGlobalConfigurationWithReader(env, systemConfigPath, readGlobalConfig);
}

export function loadGlobalConfigurationWithReader(
  env: Readonly<Record<string, string | undefined>>,
  systemConfigPath: string,
  read: GlobalConfigReader,
): LoadedGlobalConfiguration {
  const explicit = env["ARCHER_CONFIG"];
  if (explicit !== undefined && explicit !== "" && !isAbsolute(explicit))
    throw new ProjectError(
      "manifest_error",
      "global archer.toml cannot be used: ARCHER_CONFIG must be an absolute path",
    );
  if (explicit !== undefined && explicit !== "")
    return { user: read(explicit, { principal: "user", required: true }), paths: { user: explicit } };
  const configHome = absolute(env["XDG_CONFIG_HOME"]) ?? join(absolute(env["HOME"]) ?? homedir(), ".config");
  const userPath = join(configHome, "archer", "archer.toml");
  return {
    system: read(systemConfigPath, { principal: "system" }),
    user: read(userPath, { principal: "user" }),
    paths: { system: systemConfigPath, user: userPath },
  };
}

export function loadServiceConfiguration(
  cwd: string,
  options: LoadServiceConfigurationOptions = {},
): LoadedServiceConfiguration {
  return loadServiceConfigurationWithReader(cwd, options, readGlobalConfig);
}

/** @internal Contract seam; the authoritative loader always supplies the trusted production reader. */
export function loadServiceConfigurationWithReader(
  cwd: string,
  options: LoadServiceConfigurationOptions,
  read: GlobalConfigReader,
): LoadedServiceConfiguration {
  const env = options.env ?? process.env;
  const project = findProject(cwd);
  const global = loadGlobalConfigurationWithReader(env, options.systemConfigPath ?? "/etc/archer/archer.toml", read);
  return result(project, global.system, global.user, global.paths, env, options.flags);
}

function result(
  project: Project,
  system: GlobalConfig | undefined,
  user: GlobalConfig,
  paths: { readonly system?: string; readonly user: string },
  env: Readonly<Record<string, string | undefined>>,
  flags: ServiceFlags | undefined,
): LoadedServiceConfiguration {
  const resolution = resolveServiceConfiguration({
    projectRoot: project.root,
    ...(project.serviceName === undefined ? {} : { projectServiceName: project.serviceName }),
    ...(system === undefined ? {} : { system }),
    user,
    env,
    ...(flags === undefined ? {} : { flags }),
  });
  return {
    project,
    ...(system === undefined ? {} : { system }),
    user,
    paths,
    resolution,
    feedback: resolveFeedbackConfiguration({
      ...(system === undefined ? {} : { system }),
      user,
      project,
      serviceName: resolution.serviceName,
    }),
  };
}

const absolute = (value: string | undefined): string | undefined =>
  value !== undefined && isAbsolute(value) ? value : undefined;
