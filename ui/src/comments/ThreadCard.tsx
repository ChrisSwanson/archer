import { runtime } from "../app/runtime.ts";
/**
 * One thread: what it is about, where it stands, and the conversation.
 *
 * The person's own comments are theirs to edit and delete at any time, like a
 * shared document; the agent's are not. A reply is a draft like any comment,
 * and nothing in a thread reaches the agent until "Send to agent". Resolving
 * it yourself removes it at once (the server purges it; git keeps the
 * history). A thread the AGENT resolved stays, with its last reply, until you
 * dismiss it.
 *
 * Two voices: your words under your mark, the agent's on its own wash under
 * a named mark with its glyph, so the two are told apart by word and shape as
 * well as by hue.
 *
 * Every body is text. React escapes it; nothing here may hand one to
 * `dangerouslySetInnerHTML`.
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { MAX_COMMENT_CHARS, type Comment, type Thread } from "./contract";
import { anchorLabel, displayStatus, threadStatusDetail, threadStatusLabel, type Pin } from "./state";
import { PinBadge } from "../diagrams/CommentPins";
import { useAutosizeTextarea } from "./useAutosizeTextarea";
import { walkFacts } from "./walk-anchors";
import { useWalkComments } from "./walk-comments";
import { DraftKept } from "./DraftKept";
import { operationHold, replyKey } from "./operations";
import {
  announceDraft,
  anyEditDraft,
  anyReplyDraft,
  browserDraftStorage,
  onDraftAnnounced,
  watchClaim,
  dropDraft,
  takeDraft,
  editDraftKey,
  forgetEditDraft,
  forgetReplyDraft,
  keepEditDraft,
  keepReplyDraft,
  markDraftWriting,
  readEditDraft,
  readReplyDraft,
  replyDraftKey,
} from "./comment-draft";

/** Where a reply is kept in this browser while it is written (comment-draft.ts): the project, and the thread it answers. */
interface ReplyPlace {
  readonly scope: string;
  readonly target: Thread["target"];
  readonly threadId: string;
}
/** Where an edit of a comment is kept (comment-draft.ts `EditDraft`): its thread's place, and the comment. */
interface EditPlace extends ReplyPlace {
  readonly commentId: string;
}

/** What a kept box reads, writes and forgets: a reply's or an edit's, the one difference between the two. */
interface Kept {
  readonly key: string;
  read(storage: Storage | null): { readonly body: string; readonly base: string | null } | null;
  /** False when the browser would not keep it. */
  keep(storage: Storage | null, body: string, base: string | null): boolean;
  forget(storage: Storage | null): void;
}
function keptReply(p: ReplyPlace): Kept {
  return {
    key: replyDraftKey(p.scope, p.target, p.threadId),
    read: (storage) => {
      const d = readReplyDraft(storage, p.scope, p.target, p.threadId);
      return d === null ? null : { body: d.body, base: null };
    },
    keep: (storage, body) =>
      keepReplyDraft(storage, {
        version: 1,
        scope: p.scope,
        target: p.target,
        threadId: p.threadId,
        body,
        savedAt: Date.now(),
      }),
    forget: (storage) => {
      forgetReplyDraft(storage, p.scope, p.target, p.threadId);
    },
  };
}
function keptEdit(p: EditPlace): Kept {
  return {
    key: editDraftKey(p.scope, p.target, p.threadId, p.commentId),
    read: (storage) => readEditDraft(storage, p.scope, p.target, p.threadId, p.commentId),
    keep: (storage, body, base) =>
      keepEditDraft(storage, {
        version: 1,
        scope: p.scope,
        target: p.target,
        threadId: p.threadId,
        commentId: p.commentId,
        body,
        base: base ?? "",
        savedAt: Date.now(),
      }),
    forget: (storage) => {
      forgetEditDraft(storage, p.scope, p.target, p.threadId, p.commentId);
    },
  };
}

/**
 * Discards a kept reply or edit: forgotten, and every other mounted box of it told (O191, codex-1203), so none holds
 * the discarded words to write back. The one way both Discard controls (the form's and the kept-edit notice's) go.
 */
function discardKept(keep: Kept, storage: Storage | null, from: object): void {
  keep.forget(storage);
  announceDraft(keep.key, null, from);
}

/** The agent's mark beside its name: a small four-point star, drawn. */
export function AgentGlyph(): JSX.Element {
  return (
    <svg className="archer-comment-glyph" viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
      <path d="M6 0.5 L7.3 4.7 L11.5 6 L7.3 7.3 L6 11.5 L4.7 7.3 L0.5 6 L4.7 4.7 Z" />
    </svg>
  );
}

export const threadElementId = (threadId: string): string => `archer-thread-${threadId}`;

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** A text editor: Ctrl+Enter (Cmd+Enter) saves, Escape cancels. */
function TextForm(props: {
  readonly label: string;
  readonly initial: string;
  readonly submitLabel: string;
  readonly onSave: (body: string) => Promise<boolean>;
  readonly onCancel: () => void;
  readonly persistent?: boolean;
  readonly secondaryAction?: ReactNode;
  /** Explicit edit/reply modes focus their editor; always-present inline forms do not. */
  readonly autoFocus?: boolean;
  /** Given, what is typed is kept in this browser (a reply, O93; an edit): restored on return, said so, with Discard. */
  readonly keep?: Kept;
  /**
   * An edit of an existing comment: the comment's text now (`current`). What is kept is what differs from it, with the
   * text the edit began from; when the comment reads otherwise than that now, the form says so and Save says it
   * replaces it, so another change is never written over silently.
   */
  readonly editing?: { readonly current: string };
  /** Discard also leaves the form (an edit goes back to reading). */
  readonly onDiscarded?: () => void;
  /** A reply's place, to say whether its last Send may have landed (operations.ts `operationHold`). */
  readonly replyHold?: ReplyPlace;
}): JSX.Element {
  const id = useId();
  const keep = props.keep;
  const editing = props.editing;
  const storage = useMemo(() => (keep === undefined ? null : browserDraftStorage()), [keep === undefined]);
  // A kept box starts from its kept text, the newest wherever it was typed (O188): never from an older copy.
  const held = useMemo(() => (keep === undefined ? null : keep.read(storage)), []);
  const [body, setBody] = useState(held?.body ?? props.initial);
  /** The comment's text when this edit began: the kept one's, else the comment's as the editor opened. */
  const base = useRef(held?.base ?? (editing === undefined ? null : editing.current));
  /** Given back from an earlier visit (said so, with Discard). */
  const [restored, setRestored] = useState(held !== null);
  /** The browser would not keep the text: said before the person relies on it. */
  const [unkept, setUnkept] = useState(false);
  /** Typed in since it mounted: its draft is being written here, not one to reopen (comment-draft.ts `markDraftWriting`). */
  const unmarkWriting = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      unmarkWriting.current?.();
      unmarkWriting.current = null;
    },
    [],
  );
  /** This box, to the other boxes of its key (comment-draft.ts `announceDraft`). */
  const self = useRef({}).current;
  const editingRef = useRef(editing);
  editingRef.current = editing;
  // Another box of this reply or edit changed it: this one reads the same, so it never writes an older text back (O188).
  useEffect(() => {
    if (keep === undefined) return;
    return onDraftAnnounced(keep.key, (text, from) => {
      if (from === self) return;
      const comment = editingRef.current?.current;
      bodyRef.current = text?.body ?? comment ?? "";
      setBody(bodyRef.current);
      base.current = text === null ? (comment ?? null) : text.base;
      if (text === null) {
        setRestored(false);
        setUnkept(false);
      }
    });
  }, [keep?.key]);
  const remember = (text: string): void => {
    if (keep === undefined) return;
    // Nothing to keep: no text, or an edit back to the comment's own words.
    if (text.trim() === "" || (editing !== undefined && text === editing.current)) {
      keep.forget(storage);
      setUnkept(false);
      return;
    }
    setUnkept(!keep.keep(storage, text, base.current));
  };
  /** The comment changed since this edit began, and not to the person's own words. */
  const changed =
    editing !== undefined && base.current !== null && editing.current !== base.current && editing.current !== body;
  /** Another open tab keeps its own reply here (claude-201). */
  const [elsewhere, setElsewhere] = useState(false);
  const bodyRef = useRef(body);
  bodyRef.current = body;
  /** A closed tab's reply or edit here, offered: "Use it here" or Discard (the ownership rule, O117). */
  const [offer, setOffer] = useState<{ readonly onUse: () => void; readonly onDiscard: () => void } | null>(null);
  useEffect(() => {
    // Another tab's reply or edit never comes back here by itself (O117): while that tab is open it is said to be
    // there; once it is closed it is offered.
    if (keep === undefined || held !== null) return;
    let live = true;
    const untouched = props.initial;
    void watchClaim(
      storage,
      keep.key,
      (claim) => {
        setElsewhere(claim.elsewhere);
        const other = claim.offer;
        setOffer(
          other === null
            ? null
            : {
                onUse: () => {
                  void takeDraft(storage, keep.key, other).then((took) => {
                    // Declined because this box was typed in meanwhile (O190): its text stays, and so does the offer.
                    if (!took && keep.read(storage) !== null) return;
                    setOffer(null);
                    const mine = took && bodyRef.current === untouched ? keep.read(storage) : null;
                    if (mine !== null) {
                      if (mine.base !== null) base.current = mine.base;
                      setBody(mine.body);
                      setRestored(true);
                      announceDraft(keep.key, { body: mine.body, base: base.current }, self);
                    }
                  });
                },
                onDiscard: () => {
                  dropDraft(storage, other);
                  setOffer(null);
                },
              },
        );
      },
      () => live,
    );
    return () => {
      live = false;
    };
  }, []);
  const offered = offer !== null && body === props.initial ? { offer } : {};
  const discard = (): void => {
    if (keep !== undefined) discardKept(keep, storage, self);
    bodyRef.current = "";
    setUnkept(false);
    setRestored(false);
    if (props.onDiscarded !== undefined) {
      props.onDiscarded();
      return;
    }
    setBody("");
    area.current?.focus();
  };
  const [saving, setSaving] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useAutosizeTextarea(area, body);
  useEffect(() => {
    if (props.autoFocus === false) return;
    const element = area.current;
    if (element !== null) {
      element.focus();
      element.setSelectionRange(element.value.length, element.value.length);
    }
  }, [props.autoFocus]);
  const save = async (): Promise<void> => {
    if (body.trim() === "" || saving) return;
    setSaving(true);
    const saved = await props.onSave(body);
    setSaving(false);
    if (!saved) return;
    setRestored(false);
    // Only the text this Send or Save carried is done with (O189, codex-1201): words typed while it waited, here or
    // in another box of this reply or edit (each keystroke is kept, so the kept draft is the newest), are not.
    const now = bodyRef.current;
    const stored = keep === undefined ? null : keep.read(storage);
    const newer =
      now !== body && now.trim() !== "" ? now : stored !== null && stored.body !== body ? stored.body : null;
    if (newer !== null && keep !== undefined) {
      // A sent reply's further words are a reply not sent yet; a saved edit's go on from the text it saved.
      if (editing !== undefined) base.current = body;
      setUnkept(!keep.keep(storage, newer, base.current));
      bodyRef.current = newer;
      setBody(newer);
      announceDraft(keep.key, { body: newer, base: base.current }, self);
      return;
    }
    remember("");
    // The other boxes of a sent reply empty; of a saved edit, read what it now says.
    if (keep !== undefined) announceDraft(keep.key, editing === undefined ? null : { body, base: body }, self);
    if (props.persistent) {
      bodyRef.current = "";
      setBody("");
    } else props.onCancel();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void save();
    } else if (event.key === "Escape" && !props.persistent) {
      event.preventDefault();
      event.stopPropagation();
      props.onCancel();
    }
  };
  return (
    <form
      className="archer-thread-form"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void save();
      }}
      onKeyDown={onKeyDown}
    >
      <label className="archer-visually-hidden" htmlFor={id}>
        {props.label}
      </label>
      <textarea
        id={id}
        ref={area}
        className="archer-composer-text"
        value={body}
        rows={2}
        maxLength={MAX_COMMENT_CHARS}
        onChange={(event) => {
          bodyRef.current = event.target.value;
          setBody(event.target.value);
          if (keep !== undefined && unmarkWriting.current === null) unmarkWriting.current = markDraftWriting(keep.key);
          remember(event.target.value);
          if (keep !== undefined) announceDraft(keep.key, { body: event.target.value, base: base.current }, self);
        }}
      />
      {editing === undefined ? (
        <DraftKept
          noun="reply"
          action="Send it"
          body={body}
          restored={restored}
          unkept={unkept}
          onDiscard={discard}
          elsewhere={elsewhere}
          {...offered}
          {...(restored &&
          props.replyHold !== undefined &&
          operationHold(storage, props.replyHold.scope).has(
            replyKey(props.replyHold.target, props.replyHold.threadId, body),
          )
            ? { maybeSent: { verb: "Sending" } }
            : {})}
        />
      ) : (
        <DraftKept
          noun="edit"
          adjective="unsaved"
          action="Save it"
          body={body}
          restored={restored}
          unkept={unkept}
          onDiscard={discard}
          elsewhere={elsewhere}
          {...offered}
        />
      )}
      {changed ? (
        <p className="archer-composer-kept" role="status">
          This comment changed since you started editing it. It now reads: “{editing?.current}”. Your text is kept here;
          Save replaces it with yours.
        </p>
      ) : null}
      <div className="archer-composer-actions">
        <button
          type="submit"
          className="archer-review-button archer-review-button--primary"
          disabled={body.trim() === "" || saving}
        >
          {changed ? "Save over it" : props.submitLabel}
        </button>
        {props.persistent ? (
          props.secondaryAction
        ) : (
          <button type="button" className="archer-review-button" onClick={props.onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function CommentItem(props: {
  readonly comment: Comment;
  readonly onEdit: (body: string) => Promise<boolean>;
  readonly onDelete: () => Promise<boolean>;
  /** False for a first comment that has replies after it. */
  readonly deletable: boolean;
  /** Where an edit of this comment is kept while it is written; absent, it lives in memory only. */
  readonly keep?: EditPlace;
}): JSX.Element {
  const { comment } = props;
  const editKeep = useMemo(
    () => (props.keep === undefined ? undefined : keptEdit(props.keep)),
    [props.keep?.scope, props.keep?.target, props.keep?.threadId, props.keep?.commentId],
  );
  // An edit kept from earlier opens its editor by itself, so it is seen rather than hidden behind Edit.
  const [mode, setMode] = useState<"read" | "edit" | "confirm">(() =>
    props.keep !== undefined &&
    comment.author === "person" &&
    anyEditDraft(browserDraftStorage(), props.keep.scope, props.keep.target, props.keep.threadId, props.keep.commentId)
      ? "edit"
      : "read",
  );
  const editButton = useRef<HTMLButtonElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  /** The action whose button takes focus back once the comment reads again: Edit after an edit, Delete after Keep. */
  const returnFocus = useRef<"edit" | "delete" | null>(null);
  const mine = comment.author === "person";

  useEffect(() => {
    if (mode === "confirm") keepButton.current?.focus();
    if (mode === "read" && returnFocus.current !== null) {
      const back = returnFocus.current === "delete" ? (deleteButton.current ?? editButton.current) : editButton.current;
      returnFocus.current = null;
      back?.focus();
    }
  }, [mode]);

  const back = (to: "edit" | "delete" = "edit"): void => {
    returnFocus.current = to;
    setMode("read");
  };
  /** Escape or Cancel left text kept in this browser (claude-309): said under the comment, with Discard. */
  const [keptAside, setKeptAside] = useState(false);
  /** The notice, as the sender of its Discard (no box of its own to skip). */
  const asideSelf = useRef({}).current;
  const leaveEdit = (): void => {
    setKeptAside(editKeep !== undefined && editKeep.read(browserDraftStorage()) !== null);
    back("edit");
  };

  return (
    <li className="archer-comment" data-author={comment.author}>
      <p className="archer-comment-meta">
        <span className="archer-comment-author">
          {mine ? null : <AgentGlyph />}
          {mine ? "You" : "Agent"}
        </span>
        <time dateTime={comment.createdAt}>{when(comment.createdAt)}</time>
        {comment.editedAt === undefined ? null : <span className="archer-comment-edited">edited</span>}
      </p>
      {mode === "edit" ? (
        <TextForm
          label="Edit your comment"
          initial={comment.body}
          submitLabel="Save"
          onSave={props.onEdit}
          onCancel={leaveEdit}
          keep={editKeep}
          editing={{ current: comment.body }}
          onDiscarded={() => {
            setKeptAside(false);
            back("edit");
          }}
        />
      ) : (
        <p className="archer-comment-body">{comment.body}</p>
      )}
      {mine && mode === "read" && keptAside ? (
        <p className="archer-composer-kept" role="status">
          Your unsaved edit of this comment is kept in this browser: Edit picks it up again.{" "}
          <button
            type="button"
            className="archer-review-link"
            onClick={() => {
              if (editKeep !== undefined) discardKept(editKeep, browserDraftStorage(), asideSelf);
              setKeptAside(false);
              editButton.current?.focus();
            }}
          >
            Discard it
          </button>
        </p>
      ) : null}
      {mine && mode === "read" ? (
        <div className="archer-comment-actions">
          <button type="button" ref={editButton} className="archer-review-link" onClick={() => setMode("edit")}>
            Edit
          </button>
          {props.deletable ? (
            <button type="button" ref={deleteButton} className="archer-review-link" onClick={() => setMode("confirm")}>
              Delete
            </button>
          ) : (
            // The server refuses it (`has_replies`): the replies would be left
            // answering nothing. Resolving removes the whole thread.
            <span className="archer-comment-note">Has replies: resolve the thread to remove it</span>
          )}
        </div>
      ) : null}
      {mine && mode === "confirm" ? (
        <div className="archer-comment-actions" role="group" aria-label="Delete this comment?">
          <span className="archer-comment-confirm">Delete this comment?</span>
          <button
            type="button"
            className="archer-review-link archer-review-link--danger"
            onClick={() => {
              void props.onDelete().then((deleted) => {
                if (!deleted) back("delete");
              });
            }}
          >
            Delete
          </button>
          <button type="button" ref={keepButton} className="archer-review-link" onClick={() => back("delete")}>
            Keep
          </button>
        </div>
      ) : null}
    </li>
  );
}

export function ThreadCard(props: {
  readonly thread: Thread;
  readonly scopeLabel?: string;
  readonly scope: "view" | "note";
  /** Whether the thread's passage could not be found in the note as it is now. */
  readonly passageMissing?: boolean;
  /** Puts what the thread is about in front of the reader: selects it, or scrolls to the passage. */
  readonly onShow?: () => void;
  readonly onReply: (body: string) => Promise<boolean>;
  readonly onEdit: (commentId: string, body: string) => Promise<boolean>;
  readonly onDelete: (commentId: string) => Promise<boolean>;
  readonly onResolve: () => Promise<boolean>;
  /** Removes a thread the agent resolved. */
  readonly onDismiss: () => Promise<boolean>;
  /** The thread's pin on the drawing, when it has one: worn here too, so the two are matched. */
  readonly pin?: Pin;
  /** Just opened from its pin: marked for a moment. */
  readonly active?: boolean;
  /** The article's id, where the same thread may be shown twice (the review sidebar). */
  readonly elementId?: string;
  /** Margin presentation: keep an empty reply editor open beside the inline completion action. */
  readonly inlineReply?: boolean;
  /** A containing surface already shows the anchor as its interactive header. */
  readonly hideAnchorHeading?: boolean;
  /** The project (comment-draft.ts `commentDraftScope`) a reply is kept under while it is written; absent, it lives in memory only. */
  readonly draftScope?: string;
}): JSX.Element {
  const { thread } = props;
  const headingId = useId();
  const statusId = useId();
  const replyKeep = useMemo<ReplyPlace | undefined>(
    () =>
      props.draftScope === undefined
        ? undefined
        : { scope: props.draftScope, target: thread.target, threadId: thread.id },
    [props.draftScope, thread.target, thread.id],
  );
  const replyKept = useMemo(() => (replyKeep === undefined ? undefined : keptReply(replyKeep)), [replyKeep]);
  // A reply kept from earlier opens its editor by itself, so it is seen rather than hidden behind Reply.
  const [replying, setReplying] = useState(
    () =>
      replyKeep !== undefined &&
      anyReplyDraft(browserDraftStorage(), replyKeep.scope, replyKeep.target, replyKeep.threadId),
  );
  const replyButton = useRef<HTMLButtonElement>(null);
  const returnReplyFocus = useRef(false);
  // In the commit that removes the editor, so focus never rests on the body in between (O35).
  useLayoutEffect(() => {
    if (!replying && returnReplyFocus.current && replyButton.current !== null) {
      returnReplyFocus.current = false;
      replyButton.current.focus();
    }
  }, [replying]);
  const status = displayStatus(thread);
  const label = props.scopeLabel ?? anchorLabel(thread.anchor, props.scope);
  const orphaned = thread.orphaned === true || props.passageMissing === true;
  // A thread on a step, a walkthrough, or an element seen while stepping (ADR 0034 §9).
  const walking = useWalkComments();
  const facts = walking === null || walking.target !== thread.target ? null : walkFacts(thread.anchor, walking.walks);
  const flag =
    orphaned || facts === null
      ? null
      : facts.state === "out-of-date"
        ? "Out of date"
        : facts.state === "archived"
          ? "Archived"
          : null;
  const kind = thread.anchor.kind;
  const resolved = status === "resolved";
  const completionAction = resolved ? (
    <button type="button" className="archer-review-button" onClick={() => void props.onDismiss()}>
      Dismiss
    </button>
  ) : (
    <button type="button" className="archer-review-button" onClick={() => void props.onResolve()}>
      Resolve
    </button>
  );

  return (
    <article
      id={props.elementId ?? threadElementId(thread.id)}
      className="archer-thread"
      data-status={status}
      data-orphaned={orphaned ? "true" : undefined}
      data-active={props.active === true ? "true" : undefined}
      aria-labelledby={headingId}
      aria-describedby={statusId}
      tabIndex={-1}
    >
      <header className="archer-thread-head">
        <h4
          id={headingId}
          className={`archer-thread-anchor${props.hideAnchorHeading ? " archer-visually-hidden" : ""}`}
        >
          {props.pin === undefined ? null : (
            <PinBadge pin={props.pin} className="archer-thread-pin" interactive={false} />
          )}
          {props.onShow === undefined || orphaned ? (
            label
          ) : (
            <button type="button" className="archer-thread-show" onClick={props.onShow} title="Show it">
              {label}
            </button>
          )}
        </h4>
        <span id={statusId} className="archer-thread-badges">
          <span
            className="archer-thread-status"
            data-status={status}
            title={runtime.vocabulary.threadStatus?.detail ?? threadStatusDetail(thread)}
          >
            {runtime.vocabulary.threadStatus?.label ?? threadStatusLabel(thread)}
          </span>
          {orphaned ? (
            <span className="archer-thread-status" data-status="orphaned">
              Orphaned
            </span>
          ) : null}
          {flag === null ? null : (
            <span className="archer-thread-status" data-status="orphaned">
              {flag}
            </span>
          )}
        </span>
      </header>
      {facts === null || (facts.state === "gone" && (kind === "step" || kind === "walkthrough")) ? null : (
        <p className="archer-thread-walk">
          {kind === "step" && facts.number !== undefined && facts.step !== undefined ? (
            <button
              type="button"
              className="archer-thread-chip"
              onClick={() => walking?.openStep(facts.walkthrough, facts.step!)}
              title="Open this step"
            >
              Walkthrough · step {facts.number}
            </button>
          ) : kind === "walkthrough" ? (
            <span className="archer-thread-chip" data-plain="true">
              Walkthrough · {facts.title}
            </span>
          ) : facts.number === undefined ? (
            "from a step that no longer exists"
          ) : (
            `on step ${facts.number} · ${facts.title}`
          )}
        </p>
      )}
      {orphaned ? (
        <p className="archer-thread-orphan-note">
          {thread.identity !== undefined && thread.anchor.kind === "node"
            ? "This note cannot be identified safely. Start a new comment on the intended note if this discussion still applies."
            : thread.identity !== undefined && thread.anchor.kind === "group"
              ? "This block cannot be identified safely. Start a new comment on the intended block if this discussion still applies."
              : props.scope === "note"
                ? "This passage is no longer in the note."
                : kind === "step"
                  ? "This step is no longer in the walkthrough."
                  : kind === "walkthrough"
                    ? "This walkthrough is no longer on the diagram."
                    : "This is no longer in the diagram."}{" "}
          Kept until you resolve it.
        </p>
      ) : flag === null ? null : (
        <p className="archer-thread-orphan-note">
          {flag === "Archived" ? "This walkthrough is archived." : "This step is out of date."} Kept until you resolve
          it.
        </p>
      )}
      {resolved ? (
        <p className="archer-thread-resolved-note">The agent marked this done. It stays until you dismiss it.</p>
      ) : null}
      <ol className="archer-thread-comments" aria-label="Comments">
        {thread.comments.map((comment, index) => (
          <CommentItem
            key={comment.id}
            comment={comment}
            onEdit={(body) => props.onEdit(comment.id, body)}
            onDelete={() => props.onDelete(comment.id)}
            deletable={index > 0 || thread.comments.length === 1}
            {...(props.draftScope === undefined
              ? {}
              : {
                  keep: { scope: props.draftScope, target: thread.target, threadId: thread.id, commentId: comment.id },
                })}
          />
        ))}
      </ol>
      {props.inlineReply ? (
        <TextForm
          label="Your reply"
          initial=""
          submitLabel="Reply"
          onSave={props.onReply}
          onCancel={() => {}}
          persistent
          autoFocus={false}
          secondaryAction={completionAction}
          keep={replyKept}
          replyHold={replyKeep}
        />
      ) : replying ? (
        <TextForm
          label="Your reply"
          initial=""
          submitLabel="Reply"
          onSave={props.onReply}
          keep={replyKept}
          replyHold={replyKeep}
          onCancel={() => {
            returnReplyFocus.current = true;
            setReplying(false);
          }}
        />
      ) : (
        <div className="archer-thread-actions">
          <button type="button" ref={replyButton} className="archer-review-button" onClick={() => setReplying(true)}>
            Reply
          </button>
          {completionAction}
        </div>
      )}
    </article>
  );
}
