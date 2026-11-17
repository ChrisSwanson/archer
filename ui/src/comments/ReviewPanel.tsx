import { runtime } from "../app/runtime.ts";
/**
 * The side panel: the notes about the diagram on screen, and the comment
 * threads on it and on its notes.
 *
 * Beside the drawing, never over it on a wide window: the diagram is the main
 * view, and this is where the conversation about it is kept. On a phone-width
 * window it takes the stage while it is open (`styles.css`), since a column
 * beside a 400px drawing would leave room for neither.
 *
 * Shown only when the server says it supports comments or notes
 * (`capabilities` on `api/bootstrap`); each section only for what it supports.
 *
 * Nothing written here reaches the agent until "Send N to agent", which
 * counts every draft in the PROJECT -- not only this diagram's -- lists where
 * they are, and sends them all in one action. What the agent does next (picks
 * them up, answers, resolves) arrives on the event stream and shows in the
 * threads; the panel says so in a polite live region, the one place it speaks
 * without being asked.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type JSX } from "react";
import type { Anchor, TargetRef, Thread } from "./contract";
import { Composer, type AnchorChoice } from "./Composer";
import type { CommentScopes } from "./canvas-anchors";
import { NoteItem } from "./NoteItem";
import { anchorLabel, commentPins } from "./state";
import { anchorScope } from "./target";
import { ThreadCard, threadElementId } from "./ThreadCard";
import { noteTarget, type ReviewModel } from "./useReview";
import { FloatingReview } from "./FloatingDiscussion";
import "./primary-comments.css";
import { COARSE_POINTER_QUERY, useMediaQuery } from "../app/media";
import { commentDraftScope } from "./comment-draft";

export type ComposeRequest = {
  readonly key: number;
  readonly target: TargetRef;
  readonly anchor: Anchor;
  /** A canvas element to write beside when the target is another view's: a frame part Expand added (ADR 0036 A10). */
  readonly placeAt?: string;
};

/** A thread to bring forward: opened from its pin on the drawing. */
export type ThreadRequest = { readonly key: number; readonly threadId: string };

/** "Send 3 to agent": the one action that sends, and its count. */
export function sendLabel(pending: number): string {
  return pending === 0 ? "Send to agent" : `Send ${pending} to agent`;
}

export const REVIEW_PANEL_ID = "archer-review";

const NO_THREADS: readonly Thread[] = [];

export type ReviewPanelProps = {
  readonly mode?: "sidebar" | "floating";
  readonly documentKey?: string;
  readonly inboxOpen?: boolean;
  readonly inboxHostId?: string;
  readonly selectedNotePath?: string | null;
  readonly onOpenTarget?: (target: TargetRef) => void;
  readonly model: ReviewModel;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly compose: ComposeRequest | null;
  readonly onCompose: (target: TargetRef, anchor: Anchor) => void;
  readonly onComposeEnd: () => void;
  /** What a comment on the diagram can be about, besides what it was asked for. */
  readonly diagramChoices: readonly AnchorChoice[];
  /** Puts an element anchor's ids in front of the reader (selects them). */
  readonly onShowAnchor?: (anchor: Anchor) => void;
  /** A thread opened from its pin: focused and marked. */
  readonly threadRequest?: ThreadRequest | null;
  /** The open note owns its discussions in its reading margin. */
  readonly inlineNoteDiscussions?: boolean;
  /** Brings a note thread forward in that reading margin. */
  readonly onOpenInlineNoteThread?: (threadId: string) => void;
  /** A diagram's or note's title, for the review sidebar's group headings. */
  readonly targetTitle?: (target: TargetRef) => string;
  /** Advances when something else needs the floating discussion out of the way (the chat opened). */
  readonly dismissDiscussion?: number;
  /** Told when a discussion or composer comes up, so the chat (which would overlap it) can close. */
  readonly onDiscussionShown?: () => void;
  /** The model revision of the diagram the composer is about, kept with its draft (comment-draft.ts); null when not known. */
  readonly composeRevision?: string | null;
  /** Scope choices and identity guards supplied by the drawn model. */
  readonly commentScopes?: CommentScopes;
  /** The composer's anchor is no longer in the diagram on screen (claude-205). */
  readonly composeAnchorGone?: (anchor: Anchor) => boolean;
};

export function ReviewPanel(props: ReviewPanelProps): JSX.Element {
  return props.mode === "floating" ? <FloatingReview {...props} /> : <SidebarReviewPanel {...props} />;
}

function SidebarReviewPanel(props: ReviewPanelProps): JSX.Element {
  const { model, compose } = props;
  const { capabilities, actions } = model;
  const titleId = useId();
  const commentsHeadingId = useId();
  const notesHeadingId = useId();
  const pendingId = useId();
  const commentsHeading = useRef<HTMLHeadingElement>(null);
  const [focusThread, setFocusThread] = useState<string | null>(null);
  const [missing, setMissing] = useState<ReadonlyMap<string, ReadonlySet<string>>>(new Map());
  const [expand, setExpand] = useState<{ path: string; key: number } | null>(null);
  const touch = useMediaQuery(COARSE_POINTER_QUERY);
  const [active, setActive] = useState<string | null>(null);

  // A pin was pressed: its thread is focused and marked, until the next one.
  useEffect(() => {
    if (props.threadRequest == null) return;
    setActive(props.threadRequest.threadId);
    setFocusThread(props.threadRequest.threadId);
  }, [props.threadRequest]);

  useEffect(() => {
    if (focusThread === null) return;
    const element = document.getElementById(threadElementId(focusThread));
    if (element !== null) {
      element.focus();
      element.scrollIntoView?.({ block: "nearest" });
      setFocusThread(null);
    }
  });

  const onMissing = useCallback((path: string, ids: ReadonlySet<string>) => {
    setMissing((held) => {
      const before = held.get(path);
      if (before !== undefined && before.size === ids.size && [...ids].every((id) => before.has(id))) return held;
      return new Map(held).set(path, ids);
    });
  }, []);

  const viewThreads = model.viewTarget === null ? NO_THREADS : (model.threads.get(model.viewTarget) ?? NO_THREADS);
  // The same numbers the pins on the drawing wear.
  const pins = useMemo(() => commentPins(viewThreads), [viewThreads]);
  const pinOf = (thread: Thread) => {
    const number = pins.numbers.get(thread.id);
    if (number === undefined) return undefined;
    for (const map of [pins.nodePins, pins.edgePins, pins.groupPins]) {
      for (const list of map.values()) {
        const pin = list.find((p) => p.threadId === thread.id);
        if (pin !== undefined) return pin;
      }
    }
    return undefined;
  };
  const title =
    capabilities.comments && capabilities.notes ? "Notes and Comments" : capabilities.comments ? "Comments" : "Notes";

  const afterGone = (): void => {
    commentsHeading.current?.focus();
  };

  const scopeLabel = (anchor: Anchor, scope: "view" | "note", orphaned = false): string => {
    // Reuse the picker's compiled names for sequence blocks and notes. A stale
    // anchor keeps its recorded words, even when its id has been reused.
    const choice =
      scope === "view" && !orphaned && (anchor.kind === "group" || anchor.kind === "node")
        ? props.diagramChoices.find(
            ({ anchor: candidate }) =>
              candidate.kind === anchor.kind && candidate.id === anchor.id && candidate.label === anchor.label,
          )
        : undefined;
    return choice?.label ?? anchorLabel(anchor, scope);
  };

  const card = (thread: Thread, scope: "view" | "note", passageMissing?: boolean): JSX.Element => (
    <ThreadCard
      key={thread.id}
      thread={thread}
      scope={scope}
      scopeLabel={scopeLabel(thread.anchor, scope, thread.orphaned)}
      draftScope={commentDraftScope()}
      passageMissing={passageMissing}
      pin={scope === "view" ? pinOf(thread) : undefined}
      active={active === thread.id}
      onShow={
        scope === "view"
          ? thread.anchor.kind === "node" || thread.anchor.kind === "edge" || thread.anchor.kind === "selection"
            ? () => props.onShowAnchor?.(thread.anchor)
            : undefined
          : thread.anchor.kind === "passage"
            ? () => showPassage(thread)
            : undefined
      }
      onReply={(body) => actions.reply(thread, body)}
      onEdit={(commentId, body) => actions.edit(thread, commentId, body)}
      onDelete={async (commentId) => {
        const deleted = await actions.remove(thread, commentId);
        if (deleted && thread.comments.length === 1) afterGone();
        return deleted;
      }}
      onResolve={async () => {
        const resolved = await actions.resolve(thread);
        if (resolved) afterGone();
        return resolved;
      }}
      onDismiss={async () => {
        const dismissed = await actions.dismiss(thread);
        if (dismissed) afterGone();
        return dismissed;
      }}
    />
  );

  const showPassage = (thread: Thread): void => {
    const path = thread.target.slice("note:".length);
    setExpand((held) => ({ path, key: (held?.key ?? 0) + 1 }));
    requestAnimationFrame(() => {
      const mark = document.querySelector(`mark[data-thread-id="${CSS.escape(thread.id)}"]`);
      mark?.scrollIntoView?.({ block: "center" });
    });
  };

  const composer = (target: TargetRef): JSX.Element | null => {
    if (compose === null || compose.target !== target || !capabilities.comments) return null;
    const scope = anchorScope(target);
    return (
      <Composer
        requestKey={compose.key}
        anchor={compose.anchor}
        anchorLabel={scopeLabel(compose.anchor, scope)}
        choices={scope === "view" ? props.diagramChoices : []}
        keep={{ scope: commentDraftScope(), target, baseRevision: props.composeRevision ?? null }}
        scopeGuard={props.commentScopes?.guard}
        {...(props.composeAnchorGone === undefined ? {} : { anchorGone: props.composeAnchorGone })}
        onSave={async (anchor, body, typedOn, expectedModelRevision) => {
          const thread =
            expectedModelRevision === undefined
              ? await actions.create(target, anchor, body)
              : await actions.create(target, anchor, body, expectedModelRevision);
          if (thread === null) return false;
          // Typed on while it was added (O189): the composer stays with those words.
          if (typedOn()) return true;
          props.onComposeEnd();
          setFocusThread(thread.id);
          return true;
        }}
        onCancel={props.onComposeEnd}
      />
    );
  };

  return (
    <>
      <section id={REVIEW_PANEL_ID} className="archer-review" aria-labelledby={titleId} hidden={!props.open}>
        <div className="archer-review-head">
          <h2 id={titleId} className="archer-review-title">
            {title}
          </h2>
          <button
            type="button"
            className="archer-review-close"
            aria-label={`Close ${title.toLowerCase()}`}
            onClick={props.onClose}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <path
                d="M3.5 3.5l9 9m0-9l-9 9"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <div className="archer-review-scroll">
          {model.viewId === null ? (
            <p className="archer-review-quiet archer-review-section">Nothing is on screen to comment on.</p>
          ) : null}
          {capabilities.notes && model.viewId !== null ? (
            <section className="archer-review-section" aria-labelledby={notesHeadingId}>
              <h3 id={notesHeadingId} className="archer-review-heading">
                Notes
              </h3>
              {model.notes.notes.length === 0 ? (
                <p className="archer-review-quiet">
                  {model.notes.status === "loading" || model.notes.status === "idle"
                    ? "Looking for notes…"
                    : model.notes.status === "error"
                      ? "Could not read the notes."
                      : "No notes are about this diagram."}
                </p>
              ) : (
                <ul className="archer-notes">
                  {model.notes.notes.map((note) => {
                    const target = noteTarget(note.path);
                    const threads = model.threads.get(target) ?? NO_THREADS;
                    const gone = missing.get(note.path);
                    return (
                      <NoteItem
                        key={note.path}
                        note={note}
                        state={model.noteContents.get(note.path)}
                        threads={threads}
                        commentsEnabled={capabilities.comments}
                        expandKey={expand?.path === note.path ? expand.key : undefined}
                        onOpen={() => actions.openNote(note.path)}
                        onCompose={props.onCompose}
                        onMissing={onMissing}
                      >
                        {composer(target)}
                        {threads.length > 0 ? (
                          <div className="archer-threads">
                            {threads.map((thread) => card(thread, "note", gone?.has(thread.id)))}
                          </div>
                        ) : null}
                      </NoteItem>
                    );
                  })}
                </ul>
              )}
            </section>
          ) : null}
          {capabilities.comments && model.viewTarget !== null ? (
            <section className="archer-review-section" aria-labelledby={commentsHeadingId}>
              <div className="archer-review-section-head">
                <h3 id={commentsHeadingId} ref={commentsHeading} tabIndex={-1} className="archer-review-heading">
                  Comments on This Diagram
                </h3>
                {compose?.target === model.viewTarget ? null : (
                  <button
                    type="button"
                    className="archer-review-button"
                    aria-keyshortcuts={touch ? undefined : "C"}
                    title={touch ? undefined : "Comment on what is selected (C)"}
                    onClick={() =>
                      props.onCompose(model.viewTarget!, props.diagramChoices[0]?.anchor ?? { kind: "view" })
                    }
                  >
                    New comment
                  </button>
                )}
              </div>
              {composer(model.viewTarget)}
              {viewThreads.length === 0 && compose?.target !== model.viewTarget ? (
                // Only the gestures this reader's pointer has: a touch screen has
                // no key to press and no right-click to speak of.
                <p className="archer-review-quiet">
                  {touch ? (
                    <>No comments yet. Tap something on the diagram to select it, then New comment.</>
                  ) : (
                    <>
                      No comments yet. Select something and press <kbd>C</kbd>, or right-click it, to comment on it.
                    </>
                  )}
                </p>
              ) : (
                <div className="archer-threads">{viewThreads.map((thread) => card(thread, "view"))}</div>
              )}
            </section>
          ) : null}
        </div>
        {runtime.features.publishing && capabilities.comments && model.viewId !== null ? (
          <div className="archer-review-submit">
            <p className="archer-review-pending" id={pendingId}>
              {model.pending === 0
                ? "Nothing waiting to send."
                : `${model.pending} ${model.pending === 1 ? "draft" : "drafts"} in this project, not sent yet.`}
            </p>
            <button
              type="button"
              className="archer-review-button archer-review-button--primary"
              disabled={model.pending === 0 || model.submitting}
              aria-describedby={pendingId}
              onClick={() => void actions.submitAll()}
            >
              {sendLabel(model.pending)}
            </button>
          </div>
        ) : null}
        {model.error === null ? null : (
          <div className="archer-review-error" role="alert">
            <p>{model.error}</p>
            <button type="button" className="archer-review-link" onClick={actions.dismissError}>
              Dismiss
            </button>
          </div>
        )}
      </section>
      {/* Outside the panel, so it is spoken while the panel is closed: the
        agent replying is news whether or not the panel is open. Every other
        announcement ends in a no-break space, so the same words twice are two
        changes, and are said twice. */}
      <p className="archer-visually-hidden archer-review-announcer" role="status" aria-live="polite">
        {model.announcement === null
          ? ""
          : `${model.announcement.text}${model.announcement.key % 2 === 0 ? "\u00a0" : ""}`}
      </p>
    </>
  );
}
