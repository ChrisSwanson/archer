/**
 * What a box that keeps its text in this browser (comment-draft.ts) says about it, the same in every one of them:
 * the comment composer, a reply, the chat (codex-201, O100), an edit of the person's own comment. "Restored your unsent <noun> from earlier", with an
 * explicit Discard, when the text came back from an earlier visit; and, before the person relies on it, that this
 * browser cannot keep the text when it refused to store it.
 */
import type { JSX } from "react";

export function DraftKept(props: {
  /** "comment", "reply", "message", "edit". */
  readonly noun: string;
  /** What it is until its action: "unsent" (the default), "unsaved" (an edit of a comment). */
  readonly adjective?: string;
  /** What sends it, for the unkept warning: "Add it", "Send it". */
  readonly action: string;
  readonly body: string;
  readonly restored: boolean;
  readonly unkept: boolean;
  readonly onDiscard: () => void;
  /** Said after "from earlier" (the composer: the diagram has changed since). */
  readonly suffix?: string;
  /**
   * Its last Send got no answer and the identity it went under is kept (claude-202): it may be with the agent
   * already, and sending it again repeats that identity. `verb` is what sending it is called ("adding", "sending").
   */
  readonly maybeSent?: { readonly verb: string };
  /** Another open tab keeps a draft of its own here (claude-201): it stays there, and this tab's is kept apart. */
  readonly elsewhere?: boolean;
  /**
   * A tab that has been closed left its own draft here (the ownership rule, O117): offered, never restored by itself.
   * "Use it here" takes it (and the identity its last Send went under); Discard removes it.
   */
  readonly offer?: { readonly onUse: () => void; readonly onDiscard: () => void };
}): JSX.Element | null {
  const article = /^[aeiou]/.test(props.adjective ?? "unsent") ? "An" : "A";
  const elsewhere =
    props.elsewhere === true ? (
      <p className="archer-composer-kept" role="status">
        {/^[aeiou]/.test(props.noun) ? "An" : "A"} {props.noun} on this is being written in another tab that is still
        open. It stays there; what you write here is kept apart.
      </p>
    ) : null;
  const offer =
    props.offer !== undefined ? (
      <p className="archer-composer-kept" role="status">
        {article} {props.adjective ?? "unsent"} {props.noun} from another tab, now closed, is kept in this browser.{" "}
        <button type="button" className="archer-review-link" onClick={props.offer.onUse}>
          Use it here
        </button>
        {" · "}
        <button type="button" className="archer-review-link" onClick={props.offer.onDiscard}>
          Discard it
        </button>
      </p>
    ) : null;
  if (props.body === "")
    return elsewhere === null && offer === null ? null : (
      <>
        {elsewhere}
        {offer}
      </>
    );
  return (
    <>
      {elsewhere}
      {offer}
      {props.restored ? (
        <p className="archer-composer-kept" role="status">
          {props.maybeSent === undefined ? (
            <>
              Restored your {props.adjective ?? "unsent"} {props.noun} from earlier{props.suffix ?? ""}.
            </>
          ) : (
            <>
              Restored your {props.noun} from earlier{props.suffix ?? ""}. It may already have been sent: Archer did not
              answer when it went. {props.maybeSent.verb} it again sends this same {props.noun}, never a second copy.
            </>
          )}{" "}
          <button type="button" className="archer-review-link" onClick={props.onDiscard}>
            Discard it
          </button>
        </p>
      ) : null}
      {props.unkept ? (
        <p className="archer-composer-kept" role="alert">
          This browser cannot keep this {props.noun} if you reload or close the page. {props.action}, or copy the text
          first.
        </p>
      ) : null}
    </>
  );
}
