// A project-level refusal, with a stable code a caller branches on and a
// sentence for the person reading it.

export type ProjectErrorCode =
  // archer.toml cannot be used at all (ADR 0002's workspace diagnostic).
  | "manifest_error"
  // archer.toml is a link, owned by another user, or writable by others.
  | "untrusted_manifest"
  // A path leaves the Archer folder: `..`, absolute, or a link leading out.
  | "path_outside_archer_folder"
  // No diagram in the folder answers to a name.
  | "diagram_not_found"
  // Several do, and none of them is the obvious choice.
  | "ambiguous_diagram"
  // A file Archer was asked to read or write could not be.
  | "io_error"
  // `archer init` was asked to write through a link that leaves the project.
  | "path_outside_project"
  // The account's [[projects]] write rules refuse this write (ADR 0013, ADR 0028).
  | "write_rule_denied";

export class ProjectError extends Error {
  constructor(
    readonly code: ProjectErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectError";
  }
}
