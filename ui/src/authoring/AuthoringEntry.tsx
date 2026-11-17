import { useEffect, useState, type JSX } from "react";
import type { AuthoringTarget } from "../../../shared/authoring-contract.mts";
import { authoringStatus, mayEdit } from "./status-cache";
import { editorHref } from "./address";
import { EditOff, EditRequest, EditUnavailable, useEditReach, useRefocus } from "./edit-reach";
/**
 * Server capability is not entitlement: only an authorized answer exposes an entry.
 * With `onEdit`, the entry is the reading page's Edit button, which edits in place.
 */
/** Whether this browser may edit the project; false until the service says so. */
export function useAuthoringAllowed(projectSlug: string): boolean {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    let live = true;
    void authoringStatus().then(
      (status) => {
        if (live) setAllowed(mayEdit(status));
      },
      () => {
        if (live) setAllowed(false);
      },
    );
    return () => {
      live = false;
    };
  }, [projectSlug]);
  return allowed;
}
/**
 * With `onEdit` (the reading page's Edit, D6): Edit with an editing grant; without one, the same
 * button explains how to get one (`projectName` names the project in the request); when the status
 * cannot be read, it says so and tries again; greyed out, naming the setting, with editing turned off;
 * nothing while the first answer is on its way.
 */
export function AuthoringEntry({
  projectSlug,
  projectName,
  target,
  onEdit,
}: {
  projectSlug: string;
  projectName?: string;
  target?: AuthoringTarget;
  onEdit?: () => void;
}): JSX.Element | null {
  const reach = useEditReach(projectSlug);
  const take = useRefocus("edit");
  if (onEdit) {
    if (reach.kind === "request") return <EditRequest projectName={projectName ?? projectSlug} as="edit" />;
    if (reach.kind === "failed") return <EditUnavailable as="edit" failures={reach.failures} />;
    if (reach.kind === "off") return <EditOff reason={reach.reason} as="edit" />;
    if (reach.kind !== "edit") return null;
    return (
      <button ref={take} type="button" className="archer-reader-edit" title="Edit this diagram here" onClick={onEdit}>
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" />
        </svg>
        Edit
      </button>
    );
  }
  if (reach.kind !== "edit") return null;
  const href = editorHref(projectSlug, target ?? null);
  return href ? (
    <a className="authoring-entry" href={href}>
      {target ? "Edit diagram" : "New diagram"}
    </a>
  ) : null;
}
