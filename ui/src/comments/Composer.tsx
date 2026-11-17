import { runtime } from "../app/runtime.ts";
/**
 * Writing a new comment: what it is about, and what it says.
 *
 * What it is about is chosen, not inferred at the moment of saving: the
 * selection can change while the person types, and a comment that silently
 * moved to whatever was selected last would be about the wrong thing. So the
 * anchor is fixed when the composer opens (the selection, the element whose
 * context menu opened it, a passage) and can be changed in the "Comment on"
 * picker, which also lists the diagram as a whole and its groups -- the
 * keyboard path to a group, which the canvas does not select.
 *
 * Saved as a draft: nothing reaches the agent until "Send to agent". Ctrl+Enter
 * (Cmd+Enter) saves, Escape cancels.
 *
 * Given `keep`, what is typed is kept in this browser as it is typed (comment-draft.ts, user-flows G1): a reload
 * or a reopened tab gives it back, said as restored, with Discard; a browser that will not keep it is said not to.
 * Cancel and Escape close the composer and keep the draft; only Add comment or Discard forget it.
 */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type JSX, type KeyboardEvent } from "react";
import { MAX_COMMENT_CHARS, type Anchor } from "./contract";
import { anchorLabel, sameAnchor } from "./state";
import { useAutosizeTextarea } from "./useAutosizeTextarea";
import { DraftKept } from "./DraftKept";
import { createKey, operationHold } from "./operations";
import {
  browserDraftStorage,
  watchClaim,
  commentDraftKey,
  dropDraft,
  forgetCommentDraft,
  takeDraft,
  keepCommentDraft,
  readCommentDraft,
  type CommentDraftPlace,
} from "./comment-draft";

export type ScopeGuard = (anchor: Anchor) => "note" | "block" | undefined;

export type AnchorChoice = { readonly anchor: Anchor; readonly label: string };

export function Composer(props: {
  /** Advances each time the composer is asked for, so a new ask takes focus. */
  readonly requestKey: number;
  readonly anchor: Anchor;
  /** What else it could be about. Empty for a note, whose anchor is fixed. */
  readonly choices: readonly AnchorChoice[];
  /** The requested anchor, in words. */
  readonly anchorLabel: string;
  /** False where the surrounding panel already names what the comment is about. */
  readonly showAbout?: boolean;
  /**
   * Adds the comment. `typedOn` says, once the write has answered, whether the person typed more while it waited
   * (O189): the composer then stays, holding those words as a new comment not added yet, so a caller closes it only
   * when `typedOn()` is false.
   */
  readonly onSave: (
    anchor: Anchor,
    body: string,
    typedOn: () => boolean,
    expectedModelRevision?: string,
  ) => Promise<boolean>;
  /** Scopes whose identity requires the exact model revision captured when this composer opened. */
  readonly scopeGuard?: ScopeGuard;
  readonly onCancel: () => void;
  /** Where the text is kept in this browser while it is written; absent, it lives only as long as the composer. */
  readonly keep?: CommentDraftPlace;
  /**
   * True for an anchor the diagram on screen no longer has (claude-205: the agent renamed or removed it since the
   * draft was written). The composer says so before Add comment and offers the whole diagram, keeping the text.
   */
  readonly anchorGone?: (anchor: Anchor) => boolean;
}): JSX.Element {
  const textareaId = useId();
  const pickerId = useId();
  const hintId = useId();
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  // Held as the choice itself, not its place in the list: the list is rebuilt
  // as the selection moves, and that must not change what the person chose.
  const [chosen, setChosen] = useState<AnchorChoice>({ anchor: props.anchor, label: props.anchorLabel });
  const options = useMemo(
    () =>
      props.choices.some((choice) => sameAnchor(choice.anchor, chosen.anchor))
        ? props.choices
        : [chosen, ...props.choices],
    [props.choices, chosen],
  );
  const textarea = useRef<HTMLTextAreaElement>(null);
  useAutosizeTextarea(textarea, body);
  const keep = props.keep;
  const storage = useMemo(() => (keep === undefined ? null : browserDraftStorage()), [keep === undefined]);
  /** Given back from an earlier visit (said so, with Discard). */
  const [restored, setRestored] = useState(false);
  /** The browser would not keep the text: said before the person relies on it. */
  const [unkept, setUnkept] = useState(false);
  /** Another open tab keeps its own draft on this (claude-201). */
  const [elsewhere, setElsewhere] = useState(false);
  /** A closed tab's draft here, offered: "Use it here" or Discard (the ownership rule, O117). */
  const [offer, setOffer] = useState<{ readonly onUse: () => void; readonly onDiscard: () => void } | null>(null);
  const bodyRef = useRef(body);
  bodyRef.current = body;
  const requestRef = useRef(props.requestKey);
  requestRef.current = props.requestKey;
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  // Identity belongs to the draft's original scope, even when source later reuses its positional id.
  const guardedScopes = useRef(new Map<string, "note" | "block">());
  const scopeKey = (anchor: Anchor): string => `${anchor.kind}:${"id" in anchor ? anchor.id : ""}`;
  const scopeOf = (anchor: Anchor) => {
    const key = scopeKey(anchor);
    const scope = props.scopeGuard?.(anchor);
    if (scope !== undefined) guardedScopes.current.set(key, scope);
    return guardedScopes.current.get(key);
  };
  scopeOf(chosen.anchor);
  /** The revision the text was first written against; kept with the draft, so a restore reads back the same. */
  const base = useRef<string | null>(
    props.scopeGuard !== undefined || scopeOf(chosen.anchor) !== undefined ? (keep?.baseRevision ?? null) : null,
  );

  const remember = (about: Anchor, text: string): void => {
    if (keep === undefined) return;
    if (text.trim() === "") {
      forgetCommentDraft(storage, keep.scope, keep.target, about);
      if (scopeOf(about) === undefined) base.current = null;
      setUnkept(false);
      return;
    }
    if (scopeOf(about) === undefined) base.current ??= keep.baseRevision;
    setUnkept(
      !keepCommentDraft(storage, {
        version: 1,
        scope: keep.scope,
        target: keep.target,
        anchor: about,
        body: text,
        baseRevision: base.current,
        ...(scopeOf(about) === undefined ? {} : { sequenceScope: scopeOf(about)! }),
        savedAt: Date.now(),
      }),
    );
  };

  useEffect(() => {
    // A new ask: about what it names, and ready to type into.
    setChosen({ anchor: props.anchor, label: props.anchorLabel });
    // What was written about it before and is still kept comes back, unless something is being written already:
    // this tab's at once; another tab's never by itself (O117): said to be there while that tab is open, else offered.
    if (keep !== undefined && body === "") {
      const restore = (): boolean => {
        const held = readCommentDraft(storage, keep.scope, keep.target, props.anchor);
        if (held === null) return false;
        base.current = held.baseRevision;
        if (held.sequenceScope !== undefined) guardedScopes.current.set(scopeKey(held.anchor), held.sequenceScope);
        setBody(held.body);
        bodyRef.current = held.body;
        setRestored(true);
        return true;
      };
      if (!restore()) {
        const asked = props.requestKey;
        const key = commentDraftKey(keep.scope, keep.target, props.anchor);
        void watchClaim(
          storage,
          key,
          (claim) => {
            setElsewhere(claim.elsewhere);
            setOffer(
              claim.offer === null
                ? null
                : {
                    onUse: () => {
                      void takeDraft(storage, key, claim.offer!).then((took) => {
                        if (
                          !live.current ||
                          (!took && readCommentDraft(storage, keep.scope, keep.target, props.anchor) !== null)
                        )
                          return;
                        setOffer(null);
                        if (took && bodyRef.current === "") restore();
                      });
                    },
                    onDiscard: () => {
                      dropDraft(storage, claim.offer!);
                      setOffer(null);
                    },
                  },
            );
          },
          () => live.current && asked === requestRef.current,
        );
      }
    }
    textarea.current?.focus();
  }, [props.requestKey]);

  const anchor = chosen.anchor;
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const chosenIndex = Math.max(
    0,
    options.findIndex((option) => sameAnchor(option.anchor, chosen.anchor)),
  );
  const empty = body.trim() === "";
  const staleScope = scopeOf(anchor) !== undefined && (base.current === null || base.current !== keep?.baseRevision);
  const gone = props.anchorGone?.(anchor) === true || staleScope === true;

  const save = async (): Promise<void> => {
    if (empty || saving || gone) return;
    setSaving(true);
    // Only the text this Add carried is done with (O189, codex-1201): what was typed while it waited stays, kept as
    // it was typed, a comment not added yet. Compared with what the composer and the kept draft hold now.
    const newer = (): boolean => {
      const now = bodyRef.current;
      const stored = keep === undefined ? null : readCommentDraft(storage, keep.scope, keep.target, anchorRef.current);
      return (now !== body && now.trim() !== "") || (stored !== null && stored.body !== body);
    };
    const saved =
      scopeOf(anchor) !== undefined && base.current !== null
        ? await props.onSave(anchor, body, newer, base.current)
        : await props.onSave(anchor, body, newer);
    setSaving(false);
    if (!saved) return;
    setRestored(false);
    if (newer()) return;
    setBody("");
    bodyRef.current = "";
    remember(anchor, "");
    if (keep !== undefined && !sameAnchor(anchorRef.current, anchor))
      forgetCommentDraft(storage, keep.scope, keep.target, anchorRef.current);
  };

  const discard = (): void => {
    setBody("");
    setRestored(false);
    remember(anchor, "");
    textarea.current?.focus();
  };

  const choose = (next: AnchorChoice): void => {
    // The draft moves with what it is about.
    if (!sameAnchor(next.anchor, anchor) && body.trim() !== "") {
      forgetCommentDraft(storage, keep?.scope ?? "", keep?.target ?? "project:", anchor);
      remember(next.anchor, body);
    }
    setChosen(next);
  };

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    void save();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.onCancel();
    }
  };

  return (
    <form className="archer-composer" aria-label="New comment" onSubmit={onSubmit} onKeyDown={onKeyDown}>
      {props.showAbout === false ? null : options.length > 1 ? (
        <div className="archer-composer-about">
          <label htmlFor={pickerId}>Comment on</label>
          <select
            id={pickerId}
            value={chosenIndex}
            onChange={(event) => choose(options[Number(event.target.value)] ?? chosen)}
          >
            {options.map((option, index) => (
              <option
                // biome-ignore lint/suspicious/noArrayIndexKey: the option's value is its index; the options are re-derived together.
                key={index}
                value={index}
              >
                {option.label}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p className="archer-composer-about">
          Comment on <span className="archer-composer-anchor">{options[0]?.label ?? props.anchorLabel}</span>
        </p>
      )}
      <label className="archer-visually-hidden" htmlFor={textareaId}>
        Comment
      </label>
      <textarea
        id={textareaId}
        ref={textarea}
        className="archer-composer-text"
        value={body}
        maxLength={MAX_COMMENT_CHARS}
        rows={3}
        aria-describedby={hintId}
        onChange={(event) => {
          bodyRef.current = event.target.value;
          setBody(event.target.value);
          remember(anchor, event.target.value);
        }}
      />
      <DraftKept
        noun="comment"
        action="Add it"
        body={body}
        restored={restored}
        unkept={unkept}
        onDiscard={discard}
        elsewhere={elsewhere}
        {...(offer !== null && body === "" ? { offer } : {})}
        {...(restored &&
        keep !== undefined &&
        operationHold(storage, keep.scope).has(createKey(keep.target, anchor, body))
          ? { maybeSent: { verb: "Adding" } }
          : {})}
        suffix={
          base.current !== null && keep?.baseRevision != null && base.current !== keep.baseRevision
            ? "; the diagram has changed since you wrote it"
            : ""
        }
      />
      {gone ? (
        <p className="archer-composer-kept" role="alert">
          {staleScope
            ? `The diagram changed. Reopen a comment on the intended ${scopeOf(anchor) ?? "block"}. Your text is kept.`
            : `${chosen.label} is no longer in the diagram, so this comment cannot be added to it. Your text is kept.`}{" "}
          <button
            type="button"
            className="archer-review-link"
            onClick={() => {
              choose({ anchor: { kind: "view" }, label: anchorLabel({ kind: "view" }, "view") });
              textarea.current?.focus();
            }}
          >
            Comment on the whole diagram instead
          </button>
        </p>
      ) : null}
      {/* Heard with the field rather than shown: the panel stays minimal. */}
      <p id={hintId} className="archer-visually-hidden">
        Use {runtime.vocabulary.commitComment} or Ctrl/Command Enter.
      </p>
      <div className="archer-composer-actions">
        <button
          type="submit"
          className="archer-review-button archer-review-button--primary"
          disabled={empty || saving || gone}
        >
          {runtime.vocabulary.commitComment}
        </button>
        <button type="button" className="archer-review-button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
