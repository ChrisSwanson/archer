// Local environment management uses the same private socket and lifecycle
// ownership as project operations. It creates no additional authorization scope.
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ProjectStatus } from "../service/protocol.ts";
import type { OperationResult } from "./index.ts";
import { openProject } from "./diagrams.ts";
import { accessStartFailure, OperationError, serviceError, toolError } from "./errors.ts";
import { PROTOCOL_VERSION } from "../service/protocol.ts";
import { readPreferences } from "../config/preferences.ts";
import {
  InstanceChoiceError,
  ServiceCallError,
  ServiceStartError,
  ServiceUnavailableError,
  type ServiceClient,
} from "../service/service-client.ts";
import { linkText, pairingText } from "./link-text.ts";
import { projectPageUrl } from "./page-urls.ts";

export type EnvironmentOperation =
  | "start_service"
  | "stop_service"
  | "list_projects"
  | "attach_project"
  | "detach_project"
  | "issue_access_link"
  | "list_access_links"
  | "revoke_access_link"
  | "issue_pairing_code";

export interface EnvironmentAccess {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Acquisition and connection ownership belong to the application. */
  readonly acquire: (startIfNeeded: boolean, explicit?: boolean) => Promise<ServiceClient | null>;
  readonly disconnect: () => void;
}

export async function runEnvironmentOperation(
  name: EnvironmentOperation,
  args: Readonly<Record<string, unknown>>,
  access: EnvironmentAccess,
): Promise<OperationResult> {
  // Validate project discovery before starting a daemon. Detach must also work
  // after files have disappeared, and retains the service's idempotent behavior.
  const root =
    name === "attach_project"
      ? openProject(resolve(access.cwd, String(args["root"]))).root
      : name === "detach_project"
        ? resolve(access.cwd, String(args["root"]))
        : undefined;
  // A pairing code is for opening Archer: there has to be one running to open.
  const starts = name === "start_service" || name === "attach_project" || name === "issue_pairing_code";
  for (let attempt = 0; ; attempt += 1) {
    try {
      const client = await access.acquire(starts, name === "start_service");
      if (client === null) {
        switch (name) {
          case "stop_service":
            return { text: "Archer is not running.", structured: { running: false, stopped: false } };
          case "list_projects":
            return {
              text: "Archer is not running. No projects are attached.",
              structured: { running: false, projects: [] },
            };
          case "detach_project":
            return {
              text: "Archer is not running. No project was detached.",
              structured: { running: false, root, detached: false },
            };
          default:
            throw toolError("io_failure", `${name} could not start the Archer service.`);
        }
      }
      switch (name) {
        case "issue_access_link": {
          const result = await client.call("issueAccess", { label: String(args["label"]) });
          return {
            text: `${linkText("Browser access link (returned once; share it privately)", result.url)}\nGrant: ${result.id}`,
            structured: { ...result },
          };
        }
        case "issue_pairing_code": {
          const result = await client.call("issuePairingCode", {});
          const warning = result.localOnly
            ? "\nThis Archer listens only on this computer: give the address and code anyway. For another device, ask the person once whether Archer may serve their network; after their yes, run setup_network_access with personConfirmed: true (it returns the new address and a fresh code)."
            : result.plainHttpOnNetwork
              ? "\nThis Archer serves plain HTTP on the network: the code and the browser's cookie cross it unencrypted."
              : "";
          return { text: `${pairingText(result)}${warning}`, structured: { ...result } };
        }
        case "list_access_links": {
          const result = await client.call("listAccess", {});
          return {
            text: `${result.grants.length} browser grant(s).\n${result.grants.map((grant) => `${grant.id} · ${grant.label} · ${grant.revokedAt === null ? "active" : "revoked"}`).join("\n")}`,
            structured: { ...result },
          };
        }
        case "revoke_access_link": {
          const result = await client.call("revokeAccess", { grantId: String(args["grantId"]) });
          return {
            text: result.revoked ? "Browser grant revoked." : "No active browser grant with that ID.",
            structured: { ...result },
          };
        }
        case "start_service": {
          const status = await client.call("hello", { protocolVersion: PROTOCOL_VERSION });
          // ADR 0031: one short line, only when the person has written preferences or they need fixing.
          const preferences = readPreferences(access.env ?? process.env);
          const note = preferences.exists
            ? `\nFollow the person's preferences in ${preferences.path} (instances: ${preferences.instances}).`
            : "";
          const warnings = preferences.warnings
            .map((warning) => `\nWarning (${preferences.path}): ${warning}`)
            .join("");
          return {
            text: `${linkText("Archer is running", status.homeUrl)}${note}${warnings}`,
            structured: {
              running: true,
              ...status,
              preferences: { path: preferences.path, instances: preferences.instances, warnings: preferences.warnings },
            },
          };
        }
        case "stop_service": {
          await client.call("stop", {});
          access.disconnect();
          return { text: "Archer stopped.", structured: { running: false, stopped: true } };
        }
        case "list_projects": {
          const status = await client.call("listProjects", {});
          // Each project's own page, not what the agent presents next (claude-08); `url` in the result is that.
          const lines = status.projects.map(
            (project) => `${described(project)}\n  ${project.root}\n  ${projectPageUrl(project.url) ?? project.url}`,
          );
          return {
            text: `${status.projects.length} attached project(s).${lines.length ? `\n${lines.join("\n")}` : ""}`,
            structured: { running: true, ...status },
          };
        }
        case "attach_project": {
          const project = await client.call("attach", { root: root! });
          const notices = attachNotices(
            project,
            project.repository === undefined ? [] : (await client.call("listProjects", {})).projects,
          );
          return {
            text: [
              linkText(`Archer is serving ${described(project, "'")}`, projectPageUrl(project.url) ?? project.url),
              ...notices,
            ].join("\n"),
            structured: { running: true, project, ...(notices.length === 0 ? {} : { notices }) },
          };
        }
        case "detach_project": {
          const status = await client.call("detach", { root: root! });
          return {
            text: status.detached ? `Detached project at ${root}.` : `No project is attached at ${root}.`,
            structured: { running: true, root, ...status },
          };
        }
      }
    } catch (error) {
      if (error instanceof OperationError) throw error;
      // A service handing over (ADR 0032) refuses with service_stopping: the next connection reaches its replacement.
      if (
        error instanceof ServiceCallError &&
        error.error.code === "service_stopping" &&
        attempt === 0 &&
        name !== "stop_service"
      ) {
        access.disconnect();
        continue;
      }
      if (error instanceof ServiceCallError)
        throw serviceError(error.error.code, error.error.message, error.error.details ?? {});
      if (error instanceof InstanceChoiceError)
        throw toolError("instance_choice_needed", error.message, { ...error.details });
      access.disconnect();
      // A reconnect is retried once; a service that failed to start would only fail again.
      const refused = accessStartFailure(name, error);
      if (refused !== null) throw refused;
      if (error instanceof ServiceStartError)
        throw toolError("io_failure", `${name} could not start the Archer service: ${error.message}`);
      if (
        attempt === 0 &&
        error instanceof ServiceUnavailableError &&
        name !== "issue_access_link" &&
        name !== "revoke_access_link" &&
        name !== "issue_pairing_code"
      )
        continue;
      throw toolError(
        "io_failure",
        `${name} could not reach the Archer service: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** `pageturner`, or `pageturner (worktree order-notes, branch demo/order-notes)` for a linked git worktree. */
function described(project: ProjectStatus, quote = ""): string {
  const tree = project.repository?.worktree;
  const name = `${quote}${project.name}${quote}`;
  return tree === undefined
    ? name
    : `${name} (worktree ${tree.folder}${tree.branch === undefined ? "" : `, branch ${tree.branch}`})`;
}

/**
 * What the agent should tell the person about a project it just attached: another attached
 * project checks out the same repository (a look-alike in their list), or the folder is
 * temporary (it goes when the folder does).
 */
function attachNotices(project: ProjectStatus, attached: readonly ProjectStatus[]): string[] {
  const notices: string[] = [];
  const commonDir = project.repository?.commonDir;
  const twin =
    commonDir === undefined
      ? undefined
      : attached.find((other) => other.root !== project.root && other.repository?.commonDir === commonDir);
  if (twin !== undefined)
    notices.push(
      `This checks out the same repository as '${twin.name}', already attached at ${twin.root}: tell the person it is listed as a separate project, and keep lasting documents in the attached one.`,
    );
  if (temporary(project.root))
    notices.push("It is in a temporary folder: tell the person it will go when the folder does.");
  return notices;
}

function temporary(root: string): boolean {
  const roots = new Set(["/tmp", "/var/tmp", tmpdir()]);
  for (const dir of [...roots]) {
    try {
      roots.add(realpathSync(dir));
    } catch {
      /* absent */
    }
  }
  return [...roots].some((dir) => {
    const rel = relative(dir, root);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  });
}
