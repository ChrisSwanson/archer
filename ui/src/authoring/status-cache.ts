import { bodyOf, type ResourcePolicy, resources, type Transport } from "../app/resources";
import type { AuthoringAccessStatus } from "../../../shared/authoring-contract.mts";
import { authoringClient } from "./client";
import { projectSlugFromPath } from "../app/project-directory";
/** How long one answer serves every asker (NewMenu, the Edit gate, the editor opening). */
const STATUS_TTL_MS = 3000;
const key = (): string =>
  `authoring-status:${typeof location === "undefined" ? "" : (projectSlugFromPath(location.pathname) ?? "")}`;
const statusPolicy: ResourcePolicy<AuthoringAccessStatus> = {
  kind: "authoring-status",
  freshMs: STATUS_TTL_MS,
  parse: (raw) => raw as AuthoringAccessStatus,
};
/** The client's own read (its refusals, its size limit) is the request; the store shares what it answers. */
const viaClient: Transport = async () => Response.json(await authoringClient().status());
/** One `authoringClient().status()` in flight per project, shared for a few seconds. */
export async function authoringStatus(): Promise<AuthoringAccessStatus> {
  return bodyOf(await resources.read(key(), statusPolicy, { fetch: viaClient })) as AuthoringAccessStatus;
}
/** After a write that changes the status (a save, a discard), so the next asker reads the new one. */
export function forgetAuthoringStatus(): void {
  resources.supersede("authoring-status");
}
/** Whether the page may edit (ADR 0028): authorized, and editing not turned off. */
export function mayEdit(status: AuthoringAccessStatus): boolean {
  return status.authorized && status.edit.enabled;
}
/** The quiet tooltip naming where editing was turned off, or null when it is on. */
export function editOffReason(status: AuthoringAccessStatus): string | null {
  if (!status.authorized || status.edit.enabled) return null;
  return status.edit.reason === "account"
    ? "Editing is off in your Archer settings"
    : "Editing is off in archer.toml (edit = false)";
}
