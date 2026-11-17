/**
 * What the page says OVER a drawing whose file no longer compiles.
 *
 * The drawing stays: it is the last version of the file that compiled, and
 * taking it away would trade a useful picture for a blank one. But a reader
 * who is not told cannot tell that picture from a current one, so the notice
 * says two things -- the file no longer compiles, and what is shown is the
 * last version that did -- and then lists why.
 *
 * NOT MODAL, AND NOT DISMISSIBLE. The drawing underneath stays readable and
 * usable, so the notice takes no focus and traps none. It can be collapsed to
 * its sentence, so it stops covering the corner of the diagram it sits on; it
 * cannot be closed, because the statement it makes stays true until the file
 * compiles again, and a notice the reader closed would leave a stale drawing
 * looking current -- the exact thing this exists to prevent. It goes away by
 * itself when the failure does.
 *
 * ANNOUNCED ONCE. The sentence is a `role="alert"`: a drawing silently
 * becoming stale is something a reader must be told when it happens, not when
 * they next go looking, which is what `status` (polite) would mean here. An
 * alert is re-announced whenever its content changes, so the live region holds
 * ONLY the sentence, which does not change while the failure stands. The
 * problems change on every failing save, and the count on the toggle changes
 * with them; both are outside the region, where they can be read but are not
 * read out again each time the author saves.
 *
 * The messages are the compiler's, written for the agent that will fix the
 * file. They are shown as they are -- as text. React escapes them; nothing
 * here may hand one to `dangerouslySetInnerHTML`.
 *
 * The same component in both shells and over both canvases: it is rendered by
 * `App` beside the canvas, not by either canvas.
 */
import { useId, useState, type JSX } from "react";
import { problemPosition, sourceIsMissing, type CompileFailure } from "./compile-status";

function toggleLabel(collapsed: boolean, count: number): string {
  if (!collapsed) {
    return "Hide problems";
  }
  return `Show ${count} ${count === 1 ? "problem" : "problems"}`;
}

/** Where a file that is gone went, when the service knows (one other file holds its last bytes). */
export type MovedPlace = { readonly sourcePath: string; readonly href: string; readonly open?: () => void };

function headline(missing: boolean, drawn: boolean, moved: MovedPlace | undefined): string {
  if (missing) {
    // Gone from here is all the page knows unless the service found where it went (flows-r1 S4):
    // "deleted" would be a claim about a file that may have been renamed or moved.
    return moved === undefined
      ? "This diagram's file is no longer at this address."
      : `This diagram's file was moved to ${moved.sourcePath}.`;
  }
  // "No longer" is a claim that it once did.
  return drawn ? "This diagram's file no longer compiles." : "This diagram's file does not compile.";
}

function detail(missing: boolean, drawn: boolean, moved: MovedPlace | undefined): string {
  if (!drawn) {
    return "There is no earlier version to show.";
  }
  if (missing && moved !== undefined) return "The drawing shown is the last version from this address.";
  return missing
    ? "The drawing shown is the last version that compiled. To edit it, restore the file or ask the agent to write it again."
    : "The drawing shown is the last version that did.";
}

export function CompileNotice({
  failure,
  moved: movedTo,
}: {
  readonly failure: CompileFailure;
  readonly moved?: MovedPlace;
}): JSX.Element {
  // Local, and reset by remounting: `App` keys this by view and unmounts it
  // when the failure clears, so a NEW failure always opens expanded. One that
  // merely changes -- the next save fails differently -- keeps the reader's
  // choice, because nothing remounts.
  const [collapsed, setCollapsed] = useState(false);
  const listId = useId();
  const missing = sourceIsMissing(failure);
  // A moved place is only about a file that is gone; one that is there and fails is this file's problem.
  const moved = missing ? movedTo : undefined;
  // Whether there is a drawing for the sentence to be about. A view that has
  // never compiled has none, and "the drawing shown is the last version" over
  // an empty stage would be this notice making the false statement itself.
  const drawn = failure.lastValidRevision !== null;

  return (
    <section
      className="archer-compile-notice"
      aria-label="Compile problems"
      data-collapsed={collapsed ? "true" : "false"}
    >
      <div className="archer-compile-notice-head">
        <span className="archer-compile-notice-mark" aria-hidden="true">
          !
        </span>
        <p className="archer-compile-notice-text" role="alert">
          <span className="archer-compile-notice-headline">{headline(missing, drawn, moved)}</span>{" "}
          {detail(missing, drawn, moved)}
        </p>
        {moved === undefined ? null : (
          <a
            className="archer-compile-notice-moved"
            href={moved.href}
            onClick={(event) => {
              // In the page: the same navigation as any link to a diagram, with its own history entry.
              if (
                moved.open === undefined ||
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              moved.open();
            }}
          >
            Open it there
          </a>
        )}
        <button
          type="button"
          className="archer-compile-notice-toggle"
          aria-expanded={!collapsed}
          aria-controls={listId}
          onClick={() => setCollapsed((was) => !was)}
        >
          {toggleLabel(collapsed, failure.problems.length)}
        </button>
      </div>
      {/* `hidden` rather than unmounted, so `aria-controls` always names a
          real element. Focusable because it scrolls: a scroll container
          nothing can focus cannot be scrolled from a keyboard. */}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container is a Tab stop so a keyboard can scroll it (axe scrollable-region-focusable; UI_UX.md, RS1-02). */}
      <ol id={listId} className="archer-compile-notice-problems" aria-label="Problems" hidden={collapsed} tabIndex={0}>
        {failure.problems.map((problem, index) => (
          // The index is the identity: the list is replaced whole on every
          // failing save, and two problems can be identical in every field.
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: a read-only list re-rendered as a whole; its items hold no state.
            key={index}
            className="archer-compile-notice-problem"
          >
            {problemPosition(problem) === "" ? null : (
              <span className="archer-compile-notice-where">{problemPosition(problem)}</span>
            )}
            <span className="archer-compile-notice-message">{problem.message}</span>
            <code className="archer-compile-notice-code">{problem.code}</code>
          </li>
        ))}
      </ol>
    </section>
  );
}
