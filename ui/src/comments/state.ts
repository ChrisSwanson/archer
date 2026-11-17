/**
 * What the page makes of comment threads: their status as a reader sees it,
 * what each is about, which elements carry one, and the threads held per
 * target. Pure, so every rule here is tested without a DOM.
 */
import type { Anchor, Author, TargetRef, Thread } from "./contract";

/**
 * The status a reader is shown: the contract's five, plus the one the person
 * most needs told apart -- a thread they changed after sending it, which is a
 * draft again and goes out on the next send (phase2-feedback-loop.md, "What
 * the person sees"). Orphaned is said beside the status, not instead of it.
 */
export type DisplayStatus = "draft" | "changed" | "sent" | "read" | "answered" | "resolved";

export const STATUS_LABEL: Readonly<Record<DisplayStatus, string>> = {
  draft: "Draft",
  changed: "Changed after sending",
  sent: "Sent",
  read: "Read by the agent",
  answered: "Answered",
  resolved: "Resolved by the agent",
};

/** What each status means, for the badge's tooltip and accessible description. */
export const STATUS_DETAIL: Readonly<Record<DisplayStatus, string>> = {
  draft: "Yours, not sent. Edit or delete it freely.",
  changed: "You edited it after sending. It is a draft again; the agent sees the new text when you send it.",
  sent: "Waiting for the agent to pick it up. It has not seen it yet.",
  read: "The agent has fetched it. An answer is coming.",
  answered: "The agent replied.",
  resolved: "The agent marked it done. Dismiss it to remove it.",
};

export function displayStatus(thread: Thread): DisplayStatus {
  if (thread.status === "draft") {
    return thread.changedAfterSubmit === true ? "changed" : "draft";
  }
  return thread.status;
}

/** Who opened a discussion. Replies never change this provenance. */
export function threadOrigin(thread: Thread): Author | undefined {
  return thread.comments[0]?.author;
}

/** A status label that distinguishes an agent request from an agent answer. */
export function threadStatusLabel(thread: Thread): string {
  const status = displayStatus(thread);
  return status === "answered" && threadOrigin(thread) === "agent" ? "Agent opened" : STATUS_LABEL[status];
}

/** Accessible detail for the origin-aware status label. */
export function threadStatusDetail(thread: Thread): string {
  const status = displayStatus(thread);
  return status === "answered" && threadOrigin(thread) === "agent"
    ? "The agent opened this discussion for your reply."
    : STATUS_DETAIL[status];
}

/**
 * When anything last happened on a thread: the latest comment, reply, agent
 * answer or edit, in milliseconds. An unreadable timestamp counts as nothing.
 */
export function lastActivity(thread: Thread): number {
  let latest = Number.NEGATIVE_INFINITY;
  for (const comment of thread.comments) {
    for (const stamp of [comment.createdAt, comment.editedAt]) {
      const time = stamp === undefined ? Number.NaN : Date.parse(stamp);
      if (!Number.isNaN(time) && time > latest) latest = time;
    }
  }
  return latest;
}

/** Newest activity first; equal times in thread-id order, so the list never shuffles. */
export function byRecentActivity(threads: readonly Thread[]): Thread[] {
  return threads
    .map((thread) => ({ thread, at: lastActivity(thread) }))
    .sort(
      (a, b) =>
        (b.at === a.at ? 0 : b.at > a.at ? 1 : -1) ||
        (a.thread.id < b.thread.id ? -1 : a.thread.id > b.thread.id ? 1 : 0),
    )
    .map(({ thread }) => thread);
}

/**
 * How long ago `at` was, briefly, for a collapsed thread's meta line: "just
 * now", "5m ago", "3h ago", "yesterday", "4d ago", then the date. An unknown
 * time says nothing.
 */
export function relativeTime(at: number, now: number = Date.now()): string {
  if (!Number.isFinite(at)) return "";
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  if (hours < 48) return "yesterday";
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** A draft, changed or not, is what "Send to agent" would send. */
export function isPending(thread: Thread): boolean {
  return thread.status === "draft";
}

/**
 * What a pin on the canvas shows: outlined while a draft (changed or not),
 * filled once sent (read is still waiting on the agent), and with the agent's
 * mark once answered or resolved.
 */
export type PinState = "draft" | "sent" | "answered" | "resolved";

const PIN_STATE: Readonly<Record<DisplayStatus, PinState>> = {
  draft: "draft",
  changed: "draft",
  sent: "sent",
  read: "sent",
  answered: "answered",
  resolved: "resolved",
};

/** The pin state a thread wears, on the drawing and on a step row. */
export const pinState = (thread: Thread): PinState => PIN_STATE[displayStatus(thread)];

export type Pin = { readonly threadId: string; readonly number: number; readonly state: PinState };

/** The ids carrying a thread, and the pins on each, by kind of element. */
export type CommentPins = CommentedIds & {
  readonly nodePins: ReadonlyMap<string, readonly Pin[]>;
  readonly edgePins: ReadonlyMap<string, readonly Pin[]>;
  readonly groupPins: ReadonlyMap<string, readonly Pin[]>;
  /** Each pinned thread's number, in the order the threads are listed. */
  readonly numbers: ReadonlyMap<string, number>;
};

/**
 * The pins of a view's threads. Every thread on an element is numbered, in
 * the order the server lists them, and pinned on each element it is about;
 * the panel shows the same number on its card. A thread on the whole diagram
 * has no element to sit on, and an orphan's element is gone (a pin on
 * whatever now has its id would point at the wrong thing), so neither is
 * numbered and the numbers run without gaps.
 */
export function commentPins(threads: readonly Thread[]): CommentPins {
  const nodePins = new Map<string, Pin[]>();
  const edgePins = new Map<string, Pin[]>();
  const groupPins = new Map<string, Pin[]>();
  const numbers = new Map<string, number>();
  const put = (into: Map<string, Pin[]>, id: string, pin: Pin): void => {
    const held = into.get(id);
    if (held === undefined) into.set(id, [pin]);
    else if (!held.some((p) => p.threadId === pin.threadId)) held.push(pin);
  };
  for (const thread of threads) {
    const anchor = thread.anchor;
    if (
      thread.orphaned === true ||
      anchor.kind === "view" ||
      anchor.kind === "passage" ||
      anchor.kind === "walkthrough" ||
      anchor.kind === "step"
    )
      continue;
    const pin: Pin = { threadId: thread.id, number: numbers.size + 1, state: PIN_STATE[displayStatus(thread)] };
    numbers.set(thread.id, pin.number);
    if (anchor.kind === "node") put(nodePins, anchor.id, pin);
    else if (anchor.kind === "edge") put(edgePins, anchor.id, pin);
    else if (anchor.kind === "group") put(groupPins, anchor.id, pin);
    else if (anchor.kind === "selection") {
      for (const node of anchor.nodes) put(nodePins, node.id, pin);
      for (const edge of anchor.edges) put(edgePins, edge.id, pin);
    }
  }
  return {
    nodeIds: new Set(nodePins.keys()),
    edgeIds: new Set(edgePins.keys()),
    groupIds: new Set(groupPins.keys()),
    nodePins,
    edgePins,
    groupPins,
    numbers,
  };
}

type Ref = { readonly id: string; readonly label: string };

/** A label that is empty names nothing; the id is the only other name it has. */
const nameOf = (ref: Ref): string => (ref.label.trim() === "" ? ref.id : ref.label);

/** What a thread is about, in words: its heading in the panel. */
export function anchorLabel(anchor: Anchor, scope: "view" | "note"): string {
  switch (anchor.kind) {
    case "view":
      return scope === "note" ? "Whole note" : "Whole diagram";
    case "node":
      return `Node: ${nameOf(anchor)}`;
    case "edge":
      return `Edge: ${nameOf(anchor)}`;
    case "group":
      return `Group: ${nameOf(anchor)}`;
    case "selection": {
      const names = [...anchor.nodes, ...anchor.edges].map(nameOf);
      return `${names.length} elements: ${names.join(", ")}`;
    }
    case "project":
      return "Whole project";
    case "passage":
      return `Passage: “${anchor.quote}”`;
    case "walkthrough":
      return `This walkthrough · ${anchor.label.trim() === "" ? anchor.walkthrough : anchor.label}`;
    case "step": {
      // The label is "<n>. <title>" (Archer writes it); the panel says "Step n · title".
      const [, n, title] = /^(\d+)\.\s*(.*)$/.exec(anchor.label.trim()) ?? [];
      return n === undefined
        ? `Step · ${anchor.label.trim() === "" ? anchor.step : anchor.label}`
        : `Step ${n} · ${title === "" ? anchor.step : title}`;
    }
  }
}

/**
 * The anchor for what is selected: one element is that element, several are
 * a selection, and nothing selected is the whole diagram.
 */
export function anchorForSelection(nodes: readonly Ref[], edges: readonly Ref[]): Anchor {
  if (nodes.length === 0 && edges.length === 0) {
    return { kind: "view" };
  }
  if (nodes.length === 1 && edges.length === 0) {
    return { kind: "node", id: nodes[0]!.id, label: nodes[0]!.label };
  }
  if (nodes.length === 0 && edges.length === 1) {
    return { kind: "edge", id: edges[0]!.id, label: edges[0]!.label };
  }
  return {
    kind: "selection",
    nodes: nodes.map(({ id, label }) => ({ id, label })),
    edges: edges.map(({ id, label }) => ({ id, label })),
  };
}

/** Two anchors that are about the same thing. */
export function sameAnchor(a: Anchor, b: Anchor): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export type CommentedIds = {
  readonly nodeIds: ReadonlySet<string>;
  readonly edgeIds: ReadonlySet<string>;
  readonly groupIds: ReadonlySet<string>;
};

/** The threads held per target, in the order the server listed them. */
export type ThreadsState = ReadonlyMap<TargetRef, readonly Thread[]>;

export type ThreadsAction =
  /** A target's whole list, as read: replaces what was held. */
  | { readonly type: "loaded"; readonly target: TargetRef; readonly threads: readonly Thread[] }
  /**
   * One thread as the server now has it, after a write. `answer`: the write's own answer, which may arrive after the
   * page has heard of a later change (O208); a thread the page already holds at a later revision, or at the same
   * revision with an agent's read or reply the answer lacks (O210), is then kept.
   */
  | { readonly type: "upsert"; readonly thread: Thread; readonly answer?: true }
  /** Resolved, or its only comment deleted. */
  | { readonly type: "remove"; readonly threadId: string }
  /** A bulk action's outcome, applied at once: every thread that went, in one update. */
  | { readonly type: "removeMany"; readonly threadIds: readonly string[] }
  /** Several targets' lists, as read after a bulk action: all replaced in one update. */
  | {
      readonly type: "loadedMany";
      readonly lists: readonly { readonly target: TargetRef; readonly threads: readonly Thread[] }[];
    };

/** Within one revision a thread only moves on: submitted, read, answered (status), and agent replies appended. */
const STATUS_ORDER: Readonly<Record<Thread["status"], number>> = {
  draft: 0,
  sent: 1,
  read: 2,
  answered: 3,
  resolved: 4,
};

/**
 * Whether the page heard of a later change than a write's `answer` (O208, O210). The person's revision orders their
 * own changes; the agent's read and reply leave it where it was, so at an equal revision the held thread is later
 * when it holds a comment the answer lacks or its status has moved further on.
 */
function heardSince(held: Thread, answer: Thread): boolean {
  if (held.revision !== answer.revision) return held.revision > answer.revision;
  const answered = new Set(answer.comments.map((c) => c.id));
  return held.comments.some((c) => !answered.has(c.id)) || STATUS_ORDER[held.status] > STATUS_ORDER[answer.status];
}

export function threadsReducer(state: ThreadsState, action: ThreadsAction): ThreadsState {
  switch (action.type) {
    case "loaded": {
      const next = new Map(state);
      next.set(action.target, action.threads);
      return next;
    }
    case "upsert": {
      const next = new Map(state);
      const held = next.get(action.thread.target) ?? [];
      const at = held.findIndex((t) => t.id === action.thread.id);
      if (action.answer === true && at !== -1 && heardSince(held[at]!, action.thread)) return state;
      next.set(
        action.thread.target,
        at === -1 ? [...held, action.thread] : held.map((t, i) => (i === at ? action.thread : t)),
      );
      return next;
    }
    case "remove": {
      const next = new Map<TargetRef, readonly Thread[]>();
      for (const [target, threads] of state) {
        next.set(
          target,
          threads.filter((t) => t.id !== action.threadId),
        );
      }
      return next;
    }
    case "loadedMany": {
      if (action.lists.length === 0) return state;
      const next = new Map(state);
      for (const list of action.lists) next.set(list.target, list.threads);
      return next;
    }
    case "removeMany": {
      if (action.threadIds.length === 0) return state;
      const gone = new Set(action.threadIds);
      const next = new Map<TargetRef, readonly Thread[]>();
      for (const [target, threads] of state) {
        next.set(target, threads.some((t) => gone.has(t.id)) ? threads.filter((t) => !gone.has(t.id)) : threads);
      }
      return next;
    }
  }
}

// The service and the page locate exactly the same rendered passage.
export { PASSAGE_CONTEXT_CHARS, passageAnchor, locatePassage } from "../../../shared/note-markdown.mjs";
export type PassageAnchor = Extract<Anchor, { kind: "passage" }>;
