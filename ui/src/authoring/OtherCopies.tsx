// O137: several closed tabs (or earlier edits) kept unsaved copies of this diagram. The newest is offered on the status
// line; this list names every copy, newest first, so the person can resume any one or discard each. Taking one keeps
// the others; nothing is dropped without the person's Discard.
import { useState, type JSX } from "react";
import type { ResumableCopy } from "./useAuthoring";

export function keptAt(savedAt: number | undefined, now = Date.now()): string {
  if (savedAt === undefined) return "kept earlier (time not recorded)";
  const at = new Date(savedAt),
    today = new Date(now).toDateString() === at.toDateString();
  return `kept ${today ? "at " + at.toLocaleTimeString() : "on " + at.toLocaleString()}`;
}

// Each row says what its copy changes and whether it holds a save (claude-502, claude-501), and Discard asks first.
export function OtherCopies({
  copies,
  busy,
  onResume,
  onDiscard,
}: {
  copies: readonly ResumableCopy[];
  busy: boolean;
  onResume: (c: ResumableCopy) => void;
  onDiscard: (c: ResumableCopy) => void;
}): JSX.Element {
  const [asking, setAsking] = useState<string | null>(null);
  return (
    <section className="authoring-copies" aria-label="Unsaved copies of this diagram">
      <p>
        {copies.length} unsaved copies of this diagram are kept in this browser, newest first. Resume one; the others
        stay kept until you discard them.
      </p>
      <ol>
        {copies.map((c, i) => (
          <li key={c.key} data-copy-draft={c.draftId}>
            <span>
              {i === 0 ? "Newest copy" : "Copy"}
              {c.closed ? " from a closed tab" : " from an earlier edit"}, {keptAt(c.savedAt)}
              {c.save === "held"
                ? ", a save held here, not sent yet"
                : c.save === "unconfirmed"
                  ? ", a save not known to have reached Archer"
                  : ""}
              {c.change ? ` (${c.change})` : ""}.
            </span>{" "}
            {asking === c.key ? (
              <span role="group" aria-label="Discard this copy?">
                Discard this copy? It cannot be brought back.{" "}
                <button
                  type="button"
                  className="authoring-link-button"
                  disabled={busy}
                  onClick={() => {
                    setAsking(null);
                    onDiscard(c);
                  }}
                >
                  Discard it
                </button>{" "}
                <button type="button" className="authoring-link-button" onClick={() => setAsking(null)}>
                  Keep it
                </button>
              </span>
            ) : (
              <>
                <button type="button" className="authoring-link-button" disabled={busy} onClick={() => onResume(c)}>
                  Resume this copy
                </button>{" "}
                <button
                  type="button"
                  className="authoring-link-button"
                  disabled={busy}
                  onClick={() => setAsking(c.key)}
                >
                  Discard
                </button>
              </>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
