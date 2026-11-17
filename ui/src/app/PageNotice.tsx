/**
 * What the page says instead of a diagram.
 *
 * Plain and factual, one fact per notice: the reader has to be able to tell
 * "nothing is registered" from "nothing is being shown" from "what you were
 * looking at is gone" at a glance, because acting on the wrong one wastes
 * their time chasing a diagram that does not exist -- or trusting one that no
 * longer does.
 *
 * Deliberately the same component in both shells. The MCP view has no chrome,
 * but a blank canvas asserting nothing is exactly the failure being guarded
 * against, so it gets the same sentence in the same place.
 */
import type { JSX } from "react";
import type { PageNotice as Notice } from "./page-state";

export function PageNotice({ notice }: { readonly notice: Notice }): JSX.Element {
  return (
    <div className="archer-notice" role="status" data-notice={notice.kind}>
      <p className="archer-notice-headline">{notice.headline}</p>
      {notice.detail === undefined ? null : <p className="archer-notice-detail">{notice.detail}</p>}
    </div>
  );
}

/**
 * The connection warning shown ALONGSIDE a diagram that is still up.
 *
 * A drawing that was true when it arrived stays on screen -- blanking it would
 * trade one false statement for another -- but it may no longer be current,
 * and the page has to say which of those it is.
 *
 * It stays up after the stream returns, until the page has read what it
 * missed: a reconnected page that has not caught up is exactly as likely to
 * be out of date as a disconnected one. When that read fails, the sentence
 * changes to the thing that is now true -- updates are arriving again, and
 * the drawing is still unconfirmed.
 */
export function StaleConnectionNotice({
  status = "lost",
  subject = "diagram",
}: {
  readonly status?: "lost" | "unsynced" | "incompatible" | "access-required";
  /** What is on screen and may be out of date: a diagram, a note read on its own, or a project document. */
  readonly subject?: "diagram" | "note" | "document";
}): JSX.Element {
  return (
    <div className="archer-stale-strip" role="status" data-connection={status}>
      {status === "lost"
        ? `Reconnecting to Archer. This ${subject} may be out of date.`
        : status === "unsynced"
          ? `Synchronizing with Archer. This ${subject} may be out of date.`
          : status === "incompatible"
            ? "This page needs a compatible Archer version. Keep your unsaved text before opening an updated page."
            : "Archer access is no longer available. Keep your unsaved text and ask for a current project link."}
    </div>
  );
}
