/**
 * The Project review sidebar's parts (decided 2026-10-08): the tabs
 * that choose what is shown, the one action bar that acts on the selection
 * or, with nothing selected, on the tab, and a thread as an entry -- collapsed
 * to the same height as every other, or expanded in place.
 *
 * `FloatingReview` owns the state (tab, selection, expanded thread) and wires
 * these to the review model; nothing here talks to the server.
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { Comment, Thread } from "./contract";
import {
  anchorLabel,
  displayStatus,
  isPending,
  lastActivity,
  relativeTime,
  threadStatusDetail,
  threadStatusLabel,
} from "./state";
import type { ReviewModel } from "./useReview";
import { anchorScope } from "./target";

export type InboxTab = "all" | "unread" | "answered" | "drafts";

export const INBOX_TABS: readonly { readonly id: InboxTab; readonly name: string }[] = [
  { id: "all", name: "All" },
  { id: "unread", name: "Unread" },
  { id: "answered", name: "Answered" },
  { id: "drafts", name: "Drafts" },
];

/**
 * What each tab shows. Answered is every thread the agent has answered,
 * including those it resolved (still the person's to resolve). Sent and Read
 * by the agent have no tab of their own: they are under All, and their badge
 * says which.
 */
export function inTab(tab: InboxTab, thread: Thread, isUnread: (thread: Thread) => boolean): boolean {
  switch (tab) {
    case "all":
      return true;
    case "unread":
      return isUnread(thread);
    case "answered":
      return thread.status === "answered" || thread.status === "resolved";
    case "drafts":
      return isPending(thread);
  }
}

const threadCount = (n: number): string => `${n} ${n === 1 ? "thread" : "threads"}`;
const draftCount = (n: number): string => `${n} ${n === 1 ? "draft" : "drafts"}`;

/** The tab strip: one tab stop, arrow keys move between tabs and choose (ARIA tabs, automatic activation). */
export function InboxTabs(props: {
  readonly tab: InboxTab;
  readonly counts: Readonly<Record<InboxTab, number>>;
  readonly panelId: string;
  readonly tabId: (tab: InboxTab) => string;
  readonly onChoose: (tab: InboxTab) => void;
  /** Before the review's first answer a count would be a false zero: the tabs show their names only. */
  readonly loading?: boolean;
}): JSX.Element {
  const refs = useRef(new Map<InboxTab, HTMLButtonElement>());
  // Drafts shows only while there is one (or it is the tab shown): comments sent at once, the
  // default, never wait, so an empty Drafts tab only suggested they do (decided 2026-10-29).
  const shown = INBOX_TABS.filter((tab) => tab.id !== "drafts" || props.counts.drafts > 0 || props.tab === "drafts");
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, at: number): void => {
    const last = shown.length - 1;
    const to =
      event.key === "ArrowRight"
        ? at === last
          ? 0
          : at + 1
        : event.key === "ArrowLeft"
          ? at === 0
            ? last
            : at - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (to === null) return;
    event.preventDefault();
    const tab = shown[to]!.id;
    props.onChoose(tab);
    refs.current.get(tab)?.focus();
  };
  return (
    <div className="primary-inbox-tabs" role="tablist" aria-label="Show">
      {shown.map((tab, at) => (
        <button
          key={tab.id}
          ref={(element) => {
            if (element === null) refs.current.delete(tab.id);
            else refs.current.set(tab.id, element);
          }}
          type="button"
          role="tab"
          id={props.tabId(tab.id)}
          aria-selected={props.tab === tab.id}
          aria-controls={props.panelId}
          aria-label={props.loading ? undefined : `${tab.name}, ${threadCount(props.counts[tab.id])}`}
          tabIndex={props.tab === tab.id ? 0 : -1}
          onClick={() => props.onChoose(tab.id)}
          onKeyDown={(event) => onKeyDown(event, at)}
        >
          {tab.name}
          {props.loading ? null : <small aria-hidden="true">{props.counts[tab.id]}</small>}
        </button>
      ))}
    </div>
  );
}

type Act = "read" | "publish" | "resolve";
type Confirm = { readonly threads: readonly Thread[] };
type Running = { readonly act: "publish" | "resolve"; readonly count: number };

/**
 * One bar over the list. With nothing selected it offers the tab's action and
 * Resolve (n) as the primary; with a selection it is tinted and offers only
 * what applies to it. Resolving removes threads for good, so it asks first,
 * inline, with the count. Every action is one batch in the model.
 */
export function InboxBar(props: {
  readonly tab: InboxTab;
  readonly shown: readonly Thread[];
  readonly selected: readonly Thread[];
  readonly isUnread: (thread: Thread) => boolean;
  readonly model: ReviewModel;
  readonly onSelectAll: (all: boolean) => void;
  readonly onMarkRead: (threads: readonly Thread[]) => void;
  /** The action is done (or under way): the selection is spent. */
  readonly onActed: () => void;
  /** Where focus goes when the control that had it can no longer take it. */
  readonly onFocusLost: () => void;
}): JSX.Element {
  const { shown, selected, model } = props;
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [running, setRunning] = useState<Running | null>(null);
  const allBox = useRef<HTMLInputElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const busyRow = useRef<HTMLDivElement>(null);
  const resolveButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const allId = useId();
  const reasonIds = { read: useId(), publish: useId(), resolve: useId() };
  const picking = selected.length > 0;
  const total = shown.length;

  useLayoutEffect(() => {
    if (allBox.current !== null) allBox.current.indeterminate = picking && selected.length < total;
  });
  useEffect(() => {
    if (running !== null) {
      if (busyRow.current !== null && !busyRow.current.contains(document.activeElement)) busyRow.current.focus();
      return;
    }
    if (confirm !== null) {
      keep.current?.focus();
      return;
    }
    if (!returnFocus.current) return;
    returnFocus.current = false;
    const button = resolveButton.current;
    if (button !== null && !button.disabled) button.focus();
    else props.onFocusLost();
  });

  const back = (): void => {
    returnFocus.current = true;
    setConfirm(null);
  };
  const resolveNow = async (): Promise<void> => {
    if (confirm === null || running !== null) return;
    const { threads } = confirm;
    setRunning({ act: "resolve", count: threads.length });
    try {
      if (model.actions.resolveAll) await model.actions.resolveAll(threads);
      else for (const thread of threads) await model.actions.resolve(thread);
    } finally {
      setRunning(null);
      props.onActed();
      back();
    }
  };
  const publishNow = async (threads: readonly Thread[]): Promise<void> => {
    if (running !== null || threads.length === 0 || model.actions.publishAll === undefined) return;
    setRunning({ act: "publish", count: threads.length });
    try {
      await model.actions.publishAll(threads);
    } finally {
      setRunning(null);
      props.onActed();
      returnFocus.current = true;
    }
  };
  const markRead = (threads: readonly Thread[]): void => {
    props.onMarkRead(threads);
    props.onActed();
    returnFocus.current = true;
  };

  const selectAll = (
    <input
      ref={allBox}
      id={allId}
      type="checkbox"
      className="primary-inbox-checkbox"
      aria-label="Select all shown threads"
      disabled={total === 0 || running !== null}
      checked={total > 0 && selected.length === total}
      onChange={(event) => props.onSelectAll(event.target.checked)}
    />
  );

  if (running !== null) {
    const n = running.count;
    const doing = running.act === "resolve" ? `Resolving ${threadCount(n)}…` : `Publishing ${draftCount(n)}…`;
    return (
      <div
        ref={busyRow}
        tabIndex={-1}
        className="primary-inbox-bar"
        data-active={picking ? "true" : undefined}
        role="group"
        aria-label={doing}
        aria-busy="true"
      >
        {selectAll}
        <span className="primary-inbox-bar-label" role="status">
          {doing}
        </span>
      </div>
    );
  }
  if (confirm !== null) {
    const n = confirm.threads.length;
    const question = `Resolve ${threadCount(n)}?`;
    return (
      <div
        className="primary-inbox-bar primary-inbox-bar--confirm"
        role="group"
        aria-label={question}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            back();
          }
        }}
      >
        <span className="primary-inbox-bar-label">{question} Resolving removes them for good.</span>
        <span className="primary-inbox-bar-actions">
          <button type="button" ref={keep} className="archer-review-button" onClick={back}>
            Keep
          </button>
          <button type="button" className="archer-review-button primary-inbox-danger" onClick={() => void resolveNow()}>
            Resolve {n}
          </button>
        </span>
      </div>
    );
  }

  const reason: Record<Act, string> = {
    read: "Nothing shown is unread.",
    publish: "Nothing shown is a draft.",
    resolve: "Nothing is shown.",
  };
  const control = (
    act: Act,
    label: string,
    threads: readonly Thread[],
    primary: boolean,
    onClick: () => void,
  ): JSX.Element => {
    const n = threads.length;
    // With nothing selected the count says how many it will act on; a selection's count is in the bar already.
    const text = picking || n === 0 ? label : `${label} (${n})`;
    return (
      <>
        <button
          type="button"
          ref={act === "resolve" ? resolveButton : undefined}
          className={primary ? "archer-review-button archer-review-button--primary" : "archer-review-button"}
          disabled={n === 0 || model.submitting}
          aria-describedby={n === 0 ? reasonIds[act] : undefined}
          title={n === 0 ? reason[act] : undefined}
          onClick={onClick}
        >
          {text}
        </button>
        {n === 0 ? (
          <span id={reasonIds[act]} className="archer-visually-hidden">
            {reason[act]}
          </span>
        ) : null}
      </>
    );
  };
  const askResolve = (threads: readonly Thread[]): void => setConfirm({ threads });

  if (picking) {
    const unread = selected.filter(props.isUnread);
    const drafts = selected.filter(isPending);
    const n = selected.length;
    return (
      <div className="primary-inbox-bar" data-active="true" role="group" aria-label={`${n} selected`}>
        {selectAll}
        <span className="primary-inbox-bar-label">
          <b>{n}</b> selected ·{" "}
          <button
            type="button"
            className="archer-review-link primary-inbox-clear"
            onClick={() => {
              props.onSelectAll(false);
              allBox.current?.focus();
            }}
          >
            Clear
          </button>
        </span>
        <span className="primary-inbox-bar-actions">
          {unread.length > 0 ? control("read", "Mark read", unread, false, () => markRead(unread)) : null}
          {drafts.length > 0 && model.actions.publishAll
            ? control("publish", "Publish", drafts, false, () => void publishNow(drafts))
            : null}
          {control("resolve", "Resolve", selected, true, () => askResolve(selected))}
        </span>
      </div>
    );
  }

  const unread = shown.filter(props.isUnread);
  const drafts = shown.filter(isPending);
  return (
    <div className="primary-inbox-bar" role="group" aria-label={`Act on the ${threadCount(total)} shown`}>
      {selectAll}
      <label className="primary-inbox-bar-label primary-inbox-select-label" htmlFor={allId}>
        Select all
      </label>
      <span className="primary-inbox-bar-actions">
        {props.tab === "all" || props.tab === "unread"
          ? control("read", "Mark read", unread, false, () => markRead(unread))
          : null}
        {props.tab === "drafts" && model.actions.publishAll
          ? control("publish", "Publish", drafts, false, () => void publishNow(drafts))
          : null}
        {control("resolve", "Resolve", shown, true, () => askResolve(shown))}
      </span>
    </div>
  );
}

const Chevron = (): JSX.Element => (
  <svg className="primary-inbox-chevron" viewBox="0 0 24 24" aria-hidden="true">
    <path d="m9 6 6 6-6 6" />
  </svg>
);

const authorName = (comment: Comment): string => (comment.author === "agent" ? "Agent" : "You");

function Line(props: { readonly comment: Comment | null; readonly line: "first" | "last" }): JSX.Element {
  const { comment } = props;
  return (
    <span className="primary-inbox-line" data-line={props.line} data-author={comment?.author ?? "none"}>
      <span className="primary-inbox-dot" aria-hidden="true" />
      <span className="primary-inbox-text">
        {comment === null ? (
          "No reply yet"
        ) : (
          <>
            <b className="primary-inbox-name">{authorName(comment)}</b> {comment.body}
          </>
        )}
      </span>
    </span>
  );
}

/**
 * One thread in the list. Collapsed, it is always the same five rows: the
 * target (with the unread dot) and the chevron; the status and "N messages ·
 * time"; the opening message on two lines; "N more messages" or nothing; the
 * latest reply on one line, or "No reply yet". The header is a real button;
 * expanded, the whole conversation and its controls (`children`) follow it.
 */
export function InboxEntry(props: {
  readonly thread: Thread;
  /** Precise scope from the compiled diagram currently on screen. */
  readonly scopeLabel?: string;
  readonly entryId: string;
  readonly detailId: string;
  readonly open: boolean;
  readonly unread: boolean;
  readonly selected: boolean;
  readonly onSelect: (selected: boolean) => void;
  readonly onToggle: () => void;
  readonly onCollapse: () => void;
  readonly children?: ReactNode;
}): JSX.Element {
  const { thread, open } = props;
  const scope = anchorScope(thread.target);
  const label = props.scopeLabel ?? anchorLabel(thread.anchor, scope);
  const status = displayStatus(thread);
  const messages = thread.comments.length;
  const between = messages - 2;
  const when = relativeTime(lastActivity(thread));
  return (
    <li
      className="primary-inbox-item"
      data-expanded={open ? "true" : undefined}
      data-selected={props.selected ? "true" : undefined}
    >
      <label className="primary-inbox-check">
        <input
          type="checkbox"
          className="primary-inbox-checkbox"
          aria-label={`Select thread on ${label}`}
          checked={props.selected}
          onChange={(event) => props.onSelect(event.target.checked)}
        />
      </label>
      <div className="primary-inbox-body">
        <button
          type="button"
          id={props.entryId}
          className="primary-inbox-thread"
          aria-expanded={open}
          aria-controls={open ? props.detailId : undefined}
          onClick={props.onToggle}
          onKeyDown={(event) => {
            if (event.key === "Escape" && open) {
              event.preventDefault();
              event.stopPropagation();
              props.onCollapse();
            }
          }}
        >
          <span className="primary-inbox-headline">
            <span className="primary-inbox-anchor">
              {props.unread ? (
                <span className="primary-inbox-unread">
                  <span className="archer-visually-hidden">Unread: </span>
                </span>
              ) : null}
              <strong>{label}</strong>
            </span>
            <Chevron />
          </span>
          <span className="primary-inbox-meta">
            <span className="archer-thread-status" data-status={status} title={threadStatusDetail(thread)}>
              {threadStatusLabel(thread)}
            </span>
            {thread.orphaned === true ? (
              <span className="archer-thread-status" data-status="orphaned">
                Orphaned
              </span>
            ) : null}
            <span className="primary-inbox-count">
              {messages} {messages === 1 ? "message" : "messages"}
              {when === "" ? "" : ` · ${when}`}
            </span>
          </span>
          {open ? null : (
            <span className="primary-inbox-messages">
              <Line comment={thread.comments[0] ?? null} line="first" />
              <span className="primary-inbox-gap">
                {between > 0 ? `${between} more ${between === 1 ? "message" : "messages"}` : ""}
              </span>
              <Line comment={messages > 1 ? thread.comments[messages - 1]! : null} line="last" />
            </span>
          )}
        </button>
        {open ? (
          // biome-ignore lint/a11y/noStaticElementInteractions: Escape from anywhere in the expanded detail collapses it; the controls inside are focusable.
          <div
            id={props.detailId}
            className="primary-inbox-detail"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                props.onCollapse();
              }
            }}
          >
            {props.children}
          </div>
        ) : null}
      </div>
    </li>
  );
}
