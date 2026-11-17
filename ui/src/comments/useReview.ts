/**
 * The review model: the comment threads and notes of the view on screen, kept
 * current, and the actions the panel takes on them.
 *
 * ROUTES FOR STATE, EVENTS FOR CHANGES, as the rest of the page does it (ADR
 * 0010): a target's threads are read when it comes into view, read again when
 * its `comments` event arrives, and everything is read again when the stream
 * reopens, because the stream replays nothing it missed.
 *
 * Every write answers with the thread as the server now has it, and that is
 * what is shown -- the page never guesses at the result of a write. A read
 * that was in flight when a write landed is older than the write and is
 * dropped (`sequence`), so a slow list cannot put back what was just changed.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  Anchor,
  Capabilities,
  CommentOperation,
  CommentOperationName,
  NoteContent,
  NoteSummary,
  OperationAck,
  Pending,
  SubmitOperation,
  SubmitResult,
  TargetRef,
  Thread,
  UpsertNoteEmphasisInput,
} from "./contract";
import type { ReviewEvents } from "./events";
import { TransportError, UncertainWriteError, type CommentsTransport } from "./transport";
import { browserDraftStorage, commentDraftScope } from "./comment-draft";
import {
  createKey,
  createPlace,
  newOperation,
  replyPlace,
  newSubmitOperation,
  operationHold,
  replyKey,
  settleHeld,
  submitThreadOnce,
  uncertainWords,
} from "./operations";
import { anchorLabel, isPending, sameAnchor, threadOrigin, threadsReducer, type ThreadsState } from "./state";
import { anchorScope, onTarget } from "./target";
import { browserFetch } from "../app/browser-resource";
import { invalidateCommentActivity, readCommentActivity } from "../app/comment-activity";
import { useNoteEmphasis, type NoteEmphasisSave, type NoteEmphasisState } from "./useNoteEmphasis";
import {
  EMPTY_SEEN_STATE,
  browserReviewStorage,
  isSeen,
  loadSeenState,
  mergeSeenStates,
  rememberSeen,
  seenStorageKey,
  seenEntryIndex,
  storeSeenState,
  type SeenState,
} from "./review-seen";

export type NoteState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly content: NoteContent }
  | { readonly status: "error"; readonly message: string };

export type NotesList =
  | { readonly status: "idle" | "loading" | "error"; readonly notes: readonly NoteSummary[] }
  | { readonly status: "ready"; readonly notes: readonly NoteSummary[] };

export type Announcement = { readonly text: string; readonly key: number };

export type ReviewActions = {
  markSeen?(thread: Thread): void;
  create(target: TargetRef, anchor: Anchor, body: string, expectedModelRevision?: string): Promise<Thread | null>;
  reply(thread: Thread, body: string): Promise<boolean>;
  edit(thread: Thread, commentId: string, body: string): Promise<boolean>;
  remove(thread: Thread, commentId: string): Promise<boolean>;
  resolve(thread: Thread): Promise<boolean>;
  /** Removes a thread the agent resolved. */
  dismiss(thread: Thread): Promise<boolean>;
  /** Marks every agent answer in these threads seen, in this browser, with one announcement. */
  markAllSeen?(threads: readonly Thread[]): void;
  /** Resolves (removes) each of these threads; one announcement, one error naming what failed. Answers how many went. */
  resolveAll?(threads: readonly Thread[]): Promise<number>;
  /** Dismisses each of these agent-resolved threads, the same way. */
  dismissAll?(threads: readonly Thread[]): Promise<number>;
  /** Publishes the drafts among these threads, and only those; the same way. Answers how many went. */
  publishAll?(threads: readonly Thread[]): Promise<number>;
  /** The chat bubble's own writes: put a thread it just wrote in place, and read a target again. */
  ingest?(thread: Thread): void;
  refresh?(target: TargetRef): void;
  /** Reads a target's threads unless they are held or asked for already (the chat opening on a conversation). */
  load?(target: TargetRef): void;
  /** Sends every draft in the project, in one action. */
  submitAll(): Promise<void>;
  /** Reads a note's content, unless it is held already. */
  openNote(path: string): void;
  /** Replaces one person-owned named note emphasis under the server's CAS revision. */
  saveNoteEmphasis?(input: UpsertNoteEmphasisInput): Promise<NoteEmphasisSave>;
  dismissError(): void;
};

export type ReviewModel = {
  readonly unreadAnswers?: number;
  readonly isUnread?: (thread: Thread) => boolean;
  readonly capabilities: Capabilities;
  readonly viewId: string | null;
  readonly viewTarget: TargetRef | null;
  readonly threads: ThreadsState;
  readonly notes: NotesList;
  readonly noteContents: ReadonlyMap<string, NoteState>;
  readonly noteEmphases?: ReadonlyMap<string, NoteEmphasisState>;
  /**
   * Every draft in the project, changed or not: what "Send to agent" sends,
   * from whichever diagram it is pressed on (`GET api/comments/pending`).
   */
  readonly pending: number;
  /** Where those drafts are: each diagram or note, by title, with its count. */
  readonly pendingTargets: Pending["targets"];
  readonly announcement: Announcement | null;
  readonly error: string | null;
  readonly submitting: boolean;
  /**
   * The project review has not had its first answer yet: the project's comment activity, then the threads it
   * names. Until then an empty inbox is not "no discussions" (round 1 pass 6, P7.loading).
   */
  readonly inboxLoading?: boolean;
  readonly actions: ReviewActions;
};

export const viewTarget = (viewId: string): TargetRef => `view:${viewId}`;
export const noteTarget = (path: string): TargetRef => `note:${path}`;

const NO_NOTES: NotesList = { status: "idle", notes: [] };

/** A definite answer from Archer (a 4xx, or a write it says it did not make), not a lost one. */
function isRefusal(failure: unknown): boolean {
  return (
    failure instanceof TransportError &&
    !(failure instanceof UncertainWriteError) &&
    (failure.code === "not_sent" || (failure.status !== undefined && failure.status < 500))
  );
}

/** An answer that never came or could not be read (the network failed after the request left): read back, not said as failed. */
function isLost(failure: unknown): boolean {
  if (failure instanceof UncertainWriteError || failure instanceof TypeError || failure instanceof SyntaxError)
    return true;
  return failure instanceof TransportError && failure.status === undefined && failure.code !== "not_sent";
}

function message(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : "the server did not answer";
}

const NO_PENDING: Pending = { total: 0, targets: [] };

export { OPERATION_RETRY_DELAYS_MS } from "./operations";

/** What a create or reply did, said truly: a draft is saved, a sent one is with the agent (O69). */
/** When a delete, resolve or dismiss whose answer was lost is read back again, from the failure (claude-405, as O118). */
export const WRITE_RECHECK_MS: readonly number[] = [2_000, 6_000, 15_000];

export function writtenAnnouncement(kind: "Comment" | "Reply", thread: Thread | null): string {
  if (thread === null) return `${kind} added; its thread has since been resolved or deleted.`;
  return thread.status === "draft" ? `${kind} saved as a draft.` : `${kind} sent to the agent.`;
}

const threadWord = (n: number): string => (n === 1 ? "thread" : "threads");
const threadCount = (n: number): string => `${n} ${threadWord(n)}`;

/** How many of a bulk action's requests are in flight at once: enough to be quick, few enough not to flood the service. */
export const BULK_CONCURRENCY = 6;

type Outcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Runs `work` on every item, at most `limit` at a time, and answers every outcome in the items' order. */
async function settleAll<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<unknown>,
): Promise<Outcome[]> {
  const outcomes: Outcome[] = new Array<Outcome>(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const at = next;
      next += 1;
      try {
        await work(items[at]!);
        outcomes[at] = { ok: true };
      } catch (failure) {
        outcomes[at] = { ok: false, reason: message(failure) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return outcomes;
}

/** What the agent did to a thread between two reads of it, if anything worth saying. */
function agentNews(before: Thread | undefined, now: Thread): "opened" | "read" | "replied" | "resolved" | null {
  if (before === undefined) return now.status === "answered" && threadOrigin(now) === "agent" ? "opened" : null;
  const agentBefore = before.comments.filter((c) => c.author === "agent").length;
  const agentNow = now.comments.filter((c) => c.author === "agent").length;
  if (now.status === "resolved" && before.status !== "resolved") return "resolved";
  if (agentNow > agentBefore) return "replied";
  if (now.status === "read" && before.status === "sent") return "read";
  return null;
}

const NO_TARGETS: readonly TargetRef[] = [];
/** Where frames pause (a hidden tab), arrived lists are still applied this soon. */
const FLUSH_FALLBACK_MS = 100;
function sameTargets(a: readonly TargetRef[], b: readonly TargetRef[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The drafts held in the page, as a pending list: what is said when the
 * server has no `api/comments/pending` (a version-1 service). It knows only
 * the targets the page has read, which is the diagram on screen and its notes.
 */
function heldPending(threads: ThreadsState, titleOf: (target: TargetRef) => string): Pending {
  const targets: { target: TargetRef; title: string; drafts: number }[] = [];
  for (const [target, list] of threads) {
    const drafts = list.filter(isPending).length;
    if (drafts > 0) targets.push({ target, title: titleOf(target), drafts });
  }
  return { total: targets.reduce((sum, t) => sum + t.drafts, 0), targets };
}

export function useReview(options: {
  readonly transport: CommentsTransport;
  readonly capabilities: Capabilities;
  readonly viewId: string | null;
  readonly events: ReviewEvents;
  /** A view's title, for the pending list when the server cannot give one. */
  readonly viewTitle?: (viewId: string) => string;
  /** The project's name, for the project conversation in the pending list; "Whole project" without one. */
  readonly projectTitle?: string;
  /** Registered project targets to include in the review inbox, including unvisited notes. */
  readonly targets?: readonly TargetRef[];
  /** Stable project slug. Without one, read state remains in memory for this hook only. */
  readonly projectIdentity?: string | null;
}): ReviewModel {
  const { transport, capabilities, viewId, events } = options;
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const noteContext = useRef({ viewId, enabled: capabilities.notes, epoch: 0 });
  if (noteContext.current.viewId !== viewId || noteContext.current.enabled !== capabilities.notes) {
    noteContext.current = { viewId, enabled: capabilities.notes, epoch: noteContext.current.epoch + 1 };
  }
  const noteEmphasis = useNoteEmphasis({ transport, events, enabled: capabilities.noteEmphasis });
  // The caller may hand a new array every render; effects follow the list only when its content changes.
  const targetsHeld = useRef<readonly TargetRef[]>(NO_TARGETS);
  const givenTargets = options.targets ?? NO_TARGETS;
  if (!sameTargets(targetsHeld.current, givenTargets)) targetsHeld.current = [...givenTargets];
  const projectTargets = targetsHeld.current;
  const projectTargetsRef = useRef(projectTargets);
  projectTargetsRef.current = projectTargets;
  const projectTargetSet = useMemo(() => new Set(projectTargets), [projectTargets]);
  const projectTargetSetRef = useRef(projectTargetSet);
  projectTargetSetRef.current = projectTargetSet;
  const [threads, dispatch] = useReducer(threadsReducer, new Map() as ThreadsState);
  // The server's own count, or `null` when it cannot say (then the page counts what it holds).
  const [serverPending, setServerPending] = useState<Pending | null>(null);
  const viewTitleRef = useRef(options.viewTitle);
  viewTitleRef.current = options.viewTitle;
  const projectTitleRef = useRef(options.projectTitle ?? "Whole project");
  projectTitleRef.current = options.projectTitle ?? "Whole project";
  const [notes, setNotes] = useState<NotesList>(NO_NOTES);
  const [noteContents, setNoteContents] = useState<ReadonlyMap<string, NoteState>>(new Map());
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const projectIdentity = options.projectIdentity ?? null;
  const projectIdentityRef = useRef(projectIdentity);
  projectIdentityRef.current = projectIdentity;
  const seenStorage = browserReviewStorage();
  const [seenScope, setSeenScope] = useState<{ readonly projectIdentity: string | null; readonly state: SeenState }>(
    () => ({
      projectIdentity,
      state: loadSeenState(projectIdentity, seenStorage),
    }),
  );
  const seenAnswers = seenScope.projectIdentity === projectIdentity ? seenScope.state : EMPTY_SEEN_STATE;
  useEffect(() => {
    setSeenScope({ projectIdentity, state: loadSeenState(projectIdentity, seenStorage) });
  }, [projectIdentity, seenStorage]);
  useEffect(() => {
    const key = projectIdentity === null ? null : seenStorageKey(projectIdentity);
    if (key === null) return;
    const sync = (event: StorageEvent) => {
      if (event.key !== key && event.key !== null) return;
      setSeenScope({ projectIdentity, state: loadSeenState(projectIdentity, seenStorage) });
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [projectIdentity, seenStorage]);
  const rememberAll = useCallback(
    (threads: readonly Thread[]) => {
      setSeenScope((before) => {
        const memory = before.projectIdentity === projectIdentity ? before.state : EMPTY_SEEN_STATE;
        const current = mergeSeenStates(memory, loadSeenState(projectIdentity, seenStorage));
        const next = rememberSeen(current, threads);
        if (next === memory) return before;
        storeSeenState(projectIdentity, next, seenStorage);
        return { projectIdentity, state: next };
      });
    },
    [projectIdentity, seenStorage],
  );
  const remember = useCallback((thread: Thread) => rememberAll([thread]), [rememberAll]);

  // Advances on every read and every write of a target; a read applies only
  // if nothing about its target moved while it was in flight.
  const sequence = useRef(new Map<TargetRef, number>());
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const viewRef = useRef(viewId);
  viewRef.current = viewId;
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const contentsRef = useRef(noteContents);
  contentsRef.current = noteContents;
  // A view's note listing may finish after a direct note read (for example,
  // returning from an embedded diagram to its note). Such an older listing
  // must not prune content that the later navigation just loaded.
  const noteContentsGeneration = useRef(0);
  const notesRequestSequence = useRef(0);
  const noteContentRequestSequence = useRef(new Map<string, number>());
  const announceCount = useRef(0);
  // Targets a bulk action is writing to, by how many batches hold each. A read
  // of one is not applied while held -- the service sends an event for every
  // thread it removes, and applying each would take the list apart one entry at
  // a time -- and is made once the batch's outcome is in.
  const held = useRef(new Map<TargetRef, number>());
  const deferred = useRef(new Set<TargetRef>());
  useEffect(() => {
    if (projectIdentity === null) return;
    setSeenScope((before) => {
      if (before.projectIdentity !== projectIdentity) return before;
      const next = mergeSeenStates(before.state, loadSeenState(projectIdentity, seenStorage));
      if (next === before.state) return before;
      storeSeenState(projectIdentity, next, seenStorage);
      return { projectIdentity, state: next };
    });
  }, [projectIdentity, seenStorage, threads]);

  const announce = useCallback((text: string) => {
    announceCount.current += 1;
    setAnnouncement({ text, key: announceCount.current });
  }, []);

  // Lists that have been read and accepted, waiting to be applied together: each `loaded` copies the whole map of
  // threads, so applying N reads one by one is quadratic. They are applied in one `loadedMany` on the next frame
  // (or, in a hidden tab where frames pause, a moment later), and at once before anything else moves a target.
  const arrived = useRef(new Map<TargetRef, readonly Thread[]>());
  const flushTimers = useRef<{ frame: number | null; timer: ReturnType<typeof setTimeout> | null }>({
    frame: null,
    timer: null,
  });
  const flushArrived = useCallback(() => {
    const timers = flushTimers.current;
    if (timers.frame !== null) cancelAnimationFrame(timers.frame);
    if (timers.timer !== null) clearTimeout(timers.timer);
    timers.frame = null;
    timers.timer = null;
    if (arrived.current.size === 0) return;
    const lists = [...arrived.current].map(([target, threads]) => ({ target, threads }));
    arrived.current.clear();
    if (active.current) dispatch({ type: "loadedMany", lists });
  }, []);
  const scheduleFlush = useCallback(() => {
    const timers = flushTimers.current;
    if (timers.frame !== null || timers.timer !== null) return;
    if (typeof requestAnimationFrame === "function") timers.frame = requestAnimationFrame(flushArrived);
    timers.timer = setTimeout(flushArrived, FLUSH_FALLBACK_MS);
  }, [flushArrived]);
  useEffect(
    () => () => {
      const timers = flushTimers.current;
      if (timers.frame !== null) cancelAnimationFrame(timers.frame);
      if (timers.timer !== null) clearTimeout(timers.timer);
      timers.frame = null;
      timers.timer = null;
      arrived.current.clear();
    },
    [],
  );

  const bump = (target: TargetRef): number => {
    // A read that arrived before this change is applied before it, as it would have been one at a time.
    if (arrived.current.size > 0) flushArrived();
    const next = (sequence.current.get(target) ?? 0) + 1;
    sequence.current.set(target, next);
    return next;
  };

  // Targets whose threads were asked for. A read on arrival (a note listed with the view, which is also a project
  // target) is made once; events, writes and reconnects read again through `loadThreads` (perf #10).
  const asked = useRef(new Set<TargetRef>());
  // The inbox's first read (below): "activity" while the project's comment activity is out, then the targets whose
  // threads it sent for (each leaves when its list arrives, or its read fails), then `null` once it has its answer.
  const [inboxAwaiting, setInboxAwaiting] = useState<"idle" | "activity" | ReadonlySet<TargetRef> | null>("idle");
  const loadThreads = useCallback(
    (target: TargetRef) => {
      if ((held.current.get(target) ?? 0) > 0) {
        deferred.current.add(target);
        return;
      }
      const mine = bump(target);
      asked.current.add(target);
      transport
        .listThreads(target)
        .then((list) => {
          if (sequence.current.get(target) !== mine) {
            return;
          }
          if ((held.current.get(target) ?? 0) > 0) {
            deferred.current.add(target);
            return;
          }
          // What the agent did is the one change the person did not make
          // themselves, and the reason the panel speaks up: picking a
          // comment up, answering it, resolving it.
          // (Against the list that arrived last when it has not been applied yet, so one change is told once.)
          const before = arrived.current.get(target) ?? threadsRef.current.get(target);
          if (before !== undefined) {
            const scope = anchorScope(target);
            let picked = 0;
            for (const thread of list.threads) {
              const news = agentNews(
                before.find((t) => t.id === thread.id),
                thread,
              );
              if (news === "opened") announce(`Agent opened ${anchorLabel(thread.anchor, scope)}.`);
              else if (news === "read") picked += 1;
              else if (news === "replied") announce(`The agent replied on ${anchorLabel(thread.anchor, scope)}.`);
              else if (news === "resolved") announce(`The agent resolved ${anchorLabel(thread.anchor, scope)}.`);
            }
            if (picked > 0)
              announce(`The agent read ${picked} ${picked === 1 ? "comment" : "comments"}; an answer is coming.`);
          }
          arrived.current.set(target, list.threads);
          scheduleFlush();
        })
        .catch((failure: unknown) => {
          // A failed read is asked again by the next reader on arrival.
          asked.current.delete(target);
          setInboxAwaiting((waiting) =>
            waiting instanceof Set && waiting.has(target) ? new Set([...waiting].filter((t) => t !== target)) : waiting,
          );
          if (!active.current) return;
          console.error(`[archer] reading comments for ${target} failed`, failure);
        });
    },
    [transport, announce, scheduleFlush],
  );
  const loadThreadsOnce = useCallback(
    (target: TargetRef) => {
      if (asked.current.has(target) || threadsRef.current.has(target)) return;
      loadThreads(target);
    },
    [loadThreads],
  );

  // The inbox reads real registered targets without turning the displayed page.
  // Only a target the project's comment activity says has threads is read, and
  // each only once as it arrives (a target set that grows reads the added ones).
  // A target with none is recorded as empty without a request; its `comments`
  // event reads it when that changes. When the activity cannot be read, every
  // new target is read, as before.
  const requestedTargets = useRef(new Set<TargetRef>());
  useEffect(() => {
    if (!capabilities.comments) {
      requestedTargets.current.clear();
      return;
    }
    const fresh = projectTargets.filter((target) => !requestedTargets.current.has(target));
    if (fresh.length === 0) return;
    const first = requestedTargets.current.size === 0;
    for (const target of fresh) requestedTargets.current.add(target);
    if (first) setInboxAwaiting((waiting) => (waiting === "idle" ? "activity" : waiting));
    void readCommentActivity(projectIdentity, "api/comment-activity", browserFetch).then((activity) => {
      if (!active.current) return;
      const empty: TargetRef[] = [];
      const sent: TargetRef[] = [];
      for (const target of fresh) {
        if (activity === null || (activity.get(target)?.totalThreads ?? 0) > 0) {
          loadThreadsOnce(target);
          if (asked.current.has(target) && !threadsRef.current.has(target)) sent.push(target);
        } else if (!threadsRef.current.has(target)) empty.push(target);
      }
      if (first)
        setInboxAwaiting((waiting) => (waiting === "activity" ? (sent.length === 0 ? null : new Set(sent)) : waiting));
      if (empty.length > 0) dispatch({ type: "loadedMany", lists: empty.map((target) => ({ target, threads: [] })) });
    });
  }, [projectTargets, capabilities.comments, loadThreadsOnce, projectIdentity]);

  // Every draft in the project. Read on arrival, after every write, on every
  // `comments` event (whichever target: a draft anywhere is counted), and on
  // reconnect. A newer read wins over an older one still in flight.
  const pendingSequence = useRef(0);
  const loadPending = useCallback(() => {
    pendingSequence.current += 1;
    const mine = pendingSequence.current;
    transport
      .pending()
      .then((pending) => {
        if (pendingSequence.current === mine) setServerPending(pending);
      })
      .catch(() => {
        // A server without the route (a version-1 service): count what is held.
        if (pendingSequence.current === mine) setServerPending(null);
      });
  }, [transport]);

  // Read when a list of notes arrives, not a reason to read the list again: a capabilities update
  // that turns comments on must not re-run the view's reads below (perf #10).
  const commentsOn = useRef(capabilities.comments);
  commentsOn.current = capabilities.comments;
  const loadNotes = useCallback(
    (forView: string) => {
      notesRequestSequence.current += 1;
      const mine = notesRequestSequence.current;
      const context = noteContext.current.epoch;
      const contentsAtStart = noteContentsGeneration.current;
      setNotes((held) => ({ status: "loading", notes: held.notes }));
      transport
        .listNotes(forView)
        .then((list) => {
          if (
            !active.current ||
            viewRef.current !== forView ||
            noteContext.current.epoch !== context ||
            notesRequestSequence.current !== mine
          ) {
            return;
          }
          setNotes({ status: "ready", notes: list.notes });
          // Each note's threads, where the project's comment activity says it has some (or cannot say): one with
          // none is recorded empty without a request, as the inbox does (G1, PF-1; it was read or not by which of
          // the two answered first).
          if (commentsOn.current && list.notes.length > 0) {
            const listed = list.notes.map((note) => noteTarget(note.path));
            void readCommentActivity(projectIdentityRef.current, "api/comment-activity", browserFetch).then(
              (activity) => {
                if (!active.current) return;
                const empty: TargetRef[] = [];
                for (const target of listed) {
                  if (activity === null || (activity.get(target)?.totalThreads ?? 0) > 0) loadThreadsOnce(target);
                  else if (!threadsRef.current.has(target)) empty.push(target);
                }
                if (empty.length > 0)
                  dispatch({ type: "loadedMany", lists: empty.map((target) => ({ target, threads: [] })) });
              },
            );
          }
          // A note that changed is read again if it is open; one that left
          // the list is forgotten.
          const listed = new Set(list.notes.map((note) => note.path));
          setNoteContents((held) => {
            if (noteContentsGeneration.current !== contentsAtStart) return held;
            const next = new Map<string, NoteState>();
            for (const [path, state] of held) if (listed.has(path)) next.set(path, state);
            return next;
          });
        })
        .catch((failure: unknown) => {
          if (
            !active.current ||
            viewRef.current !== forView ||
            noteContext.current.epoch !== context ||
            notesRequestSequence.current !== mine
          ) {
            return;
          }
          console.error(`[archer] reading notes for ${forView} failed`, failure);
          setNotes((held) => ({ status: "error", notes: held.notes }));
        });
    },
    [transport, loadThreadsOnce],
  );

  const readNote = useCallback(
    (path: string) => {
      noteContentsGeneration.current += 1;
      const mine = (noteContentRequestSequence.current.get(path) ?? 0) + 1;
      noteContentRequestSequence.current.set(path, mine);
      const context = noteContext.current.epoch;
      setNoteContents((held) =>
        new Map(held).set(path, held.get(path)?.status === "ready" ? held.get(path)! : { status: "loading" }),
      );
      // Said at once, not at the next render: a second open in the same moment (two readers of one note) waits for this read.
      if (contentsRef.current.get(path)?.status !== "ready")
        contentsRef.current = new Map(contentsRef.current).set(path, { status: "loading" });
      transport
        .noteContent(path)
        .then((content) => {
          if (
            !active.current ||
            noteContext.current.epoch !== context ||
            noteContentRequestSequence.current.get(path) !== mine
          )
            return;
          noteContentsGeneration.current += 1;
          setNoteContents((held) => new Map(held).set(path, { status: "ready", content }));
        })
        .catch((failure: unknown) => {
          if (
            !active.current ||
            noteContext.current.epoch !== context ||
            noteContentRequestSequence.current.get(path) !== mine
          )
            return;
          noteContentsGeneration.current += 1;
          setNoteContents((held) => new Map(held).set(path, { status: "error", message: message(failure) }));
        });
    },
    [transport],
  );

  // The view on screen: its threads, and its notes. Each read follows only what it depends on, so
  // capabilities that arrive in two steps (comments, then notes) do not read the threads twice (perf #10).
  const threadsReadFor = useRef<string | null>(null);
  useEffect(() => {
    const sameView = threadsReadFor.current === viewId;
    threadsReadFor.current = viewId;
    if (viewId === null || !capabilities.comments) return;
    loadThreads(viewTarget(viewId));
    // Comments turned on for the view already shown: its notes, listed meanwhile, had their threads left unread.
    if (sameView) for (const note of notesRef.current.notes) loadThreads(noteTarget(note.path));
  }, [viewId, capabilities.comments, loadThreads, loadPending]);
  // The pending list is the project's, not the view's: read when the first view is shown with comments on, not
  // again for each view after it (events, writes and reconnects keep it current).
  const pendingRead = useRef(false);
  useEffect(() => {
    if (!capabilities.comments) {
      pendingRead.current = false;
      return;
    }
    if (viewId === null || pendingRead.current) return;
    pendingRead.current = true;
    loadPending();
  }, [viewId, capabilities.comments, loadPending]);
  useEffect(() => {
    setNotes(NO_NOTES);
    setNoteContents(new Map());
    if (viewId === null || !capabilities.notes) return;
    loadNotes(viewId);
  }, [viewId, capabilities.notes, loadNotes]);

  useEffect(
    () =>
      events.subscribe((event) => {
        const current = viewRef.current;
        const tracked = (target: TargetRef): boolean =>
          projectTargetSetRef.current.has(target) ||
          (current !== null && target === viewTarget(current)) ||
          notesRef.current.notes.some((note) => noteTarget(note.path) === target);
        switch (event.type) {
          case "comments":
            if (capabilities.comments) {
              if (tracked(event.target)) loadThreads(event.target);
              loadPending();
            }
            return;
          case "notes":
            if (capabilities.notes) {
              if (current !== null && (event.viewId === undefined || event.viewId === current)) loadNotes(current);
              for (const [path, state] of contentsRef.current) if (state.status !== "loading") readNote(path);
            }
            return;
          case "reconnect":
            if (capabilities.comments) {
              if (current !== null) loadThreads(viewTarget(current));
              const everyTarget = [
                ...projectTargetsRef.current,
                ...notesRef.current.notes.map((note) => noteTarget(note.path)),
              ];
              invalidateCommentActivity();
              // What the stream missed shows in the activity: read a target that has threads now, or held some.
              void readCommentActivity(projectIdentityRef.current, "api/comment-activity", browserFetch).then(
                (activity) => {
                  if (!active.current) return;
                  for (const target of everyTarget) {
                    if (
                      activity === null ||
                      (activity.get(target)?.totalThreads ?? 0) > 0 ||
                      (threadsRef.current.get(target)?.length ?? 0) > 0
                    )
                      loadThreads(target);
                  }
                },
              );
              loadPending();
            }
            if (capabilities.notes) {
              if (current !== null) loadNotes(current);
              // An open note edited while the stream was down is read again,
              // or its passages would be judged against the old text.
              for (const [path, state] of contentsRef.current) if (state.status !== "loading") readNote(path);
            }
            return;
        }
      }),
    [events, capabilities.comments, capabilities.notes, loadThreads, loadNotes, readNote, loadPending],
  );

  /** Runs one write; what it answers is applied, and a refusal is said. */
  /**
   * A write whose answer was lost (the write sweep, flows-r1 re-score 2): `landed` reads what Archer holds now and
   * gives the result the write would have, when it shows the write's effect. Found: said as done. Still as before:
   * the failure is said. Unreadable: said as not known. Refusals are said as they are.
   */
  /** The latest write's late read-backs (claude-405); bumped by a newer write or a late arrival, which ends them. */
  const lateChecks = useRef(0);
  /**
   * After the last late read-back, the write is still not known (codex-501): the next listing of its target that shows
   * its effect (an event, a reconnect, a reader) settles it as done. A newer write ends it (`lateChecks`).
   */
  const lateWatch = useRef<{
    readonly mine: number;
    readonly target: TargetRef;
    readonly settle: (threads: readonly Thread[]) => boolean;
  } | null>(null);
  useEffect(() => {
    const watch = lateWatch.current;
    if (watch === null) return;
    if (lateChecks.current !== watch.mine) {
      lateWatch.current = null;
      return;
    }
    const list = threads.get(watch.target);
    if (list !== undefined && watch.settle(list)) lateWatch.current = null;
  }, [threads]);
  const write = useCallback(
    async <T>(
      target: TargetRef,
      what: string,
      work: () => Promise<T>,
      apply: (result: T) => void,
      landed?: { readonly check: (threads: readonly Thread[]) => T | null; readonly still: string },
    ): Promise<T | null> => {
      bump(target);
      const done = (result: T): T => {
        bump(target);
        apply(result);
        setError(null);
        // Every write can change what waits to be sent.
        loadPending();
        return result;
      };
      try {
        return done(await work());
      } catch (failure) {
        if (landed === undefined || !isLost(failure)) {
          setError(`Could not ${what}: ${message(failure)}`);
          return null;
        }
        bump(target);
        const readBack = (): Promise<readonly Thread[] | null> =>
          transport.listThreads(target).then(
            (r) => r.threads,
            () => null,
          );
        const read = await readBack();
        const result = read === null ? null : landed.check(read);
        if (result !== null) return done(result);
        // Not there yet is not "did not" (claude-405): a request can reach Archer late. Said as not known yet and read
        // again at WRITE_RECHECK_MS; a late arrival is taken as done and the message cleared; after the last check it
        // says what it read, and nothing says it checks again (claude-407). A newer write ends these checks.
        const mine = ++lateChecks.current;
        const unknown = `Archer did not answer, so it is not known yet whether it did ${what} (${message(failure)}). It checks again shortly; trying again is never done twice.`;
        setError(unknown);
        // The last listing read, with when it was read: a failed check later dates nothing (codex-601).
        const clock = (): string =>
          new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        let lastRead = read === null ? null : { at: clock() };
        WRITE_RECHECK_MS.forEach((at, i) =>
          setTimeout(() => {
            if (lateChecks.current !== mine) return;
            void readBack().then((now) => {
              if (lateChecks.current !== mine) return;
              if (now !== null) lastRead = { at: clock() };
              const late = now === null ? null : landed.check(now);
              if (late !== null) {
                lateChecks.current += 1;
                done(late);
                return;
              }
              if (i < WRITE_RECHECK_MS.length - 1) return;
              // A read made before the request may still arrive is no proof it will not (codex-501): what was last seen is
              // said, with its time, and the outcome stays not known. A later listing showing the effect settles it.
              // A failed last check says so, and the listing keeps the time it was read (codex-601).
              const final =
                lastRead === null
                  ? `Archer did not answer, so it is not known whether it did ${what}. Try again once it answers; it is never done twice.`
                  : now === null
                    ? `Archer did not answer, so it is not known whether it did ${what}: when last read, at ${lastRead.at}, ${landed.still}, and the latest check could not reach Archer. If it is still there, try again; it is never done twice.`
                    : `Archer did not answer, so it is not known whether it did ${what}: when last checked, at ${lastRead.at}, ${landed.still}. If it is still there, try again; it is never done twice.`;
              setError((said) => (said !== unknown ? said : final));
              lateWatch.current = {
                mine,
                target,
                settle: (list) => {
                  const late = landed.check(list);
                  if (late === null) return false;
                  if (lateChecks.current === mine) {
                    lateChecks.current += 1;
                    done(late);
                  }
                  return true;
                },
              };
            });
          }, at),
        );
        return null;
      }
    },
    [loadPending, transport],
  );

  /**
   * Operations sent but not known to have landed, by what they write (the target or thread, the anchor and
   * the text): sending the same again reuses the identity, so the service answers from its receipt instead
   * of adding a second comment. Settled (removed) by an acknowledgement or a refusal that ends the identity.
   */
  const [heldCreates] = useState(() => operationHold<CommentOperation>(browserDraftStorage(), commentDraftScope()));
  const unsettled = useRef(heldCreates);
  /** Submits sent but not known to have landed: every draft (`all`) or one thread, as `unsettled` (O83). */
  const [heldSubmits] = useState(() => operationHold<SubmitOperation>(browserDraftStorage(), commentDraftScope()));
  const unsettledSubmits = useRef(heldSubmits);
  /** Edits whose answer was lost and whose outcome could not be read back, by thread and comment: their text. */
  const uncertainEdits = useRef(new Map<string, string>());

  /**
   * Runs one operation (ADR 0016). An uncertain failure (no answer) is sent again with the same identity, a
   * few times; if it is still uncertain the page says so, keeps the text and reads the target again, and the
   * person's next try sends the same identity. A refusal is said as a refusal.
   */
  const writeOnce = useCallback(
    async (
      target: TargetRef,
      what: string,
      noun: "comment" | "reply",
      key: string,
      name: CommentOperationName,
      send: (operation: CommentOperation) => Promise<OperationAck>,
      apply: (ack: OperationAck) => void,
      place?: { readonly prefix: string; readonly landed: (threads: readonly Thread[], body: string) => boolean },
    ): Promise<OperationAck | null> => {
      // The words changed since a Send that got no answer (claude-304): that earlier version may be with the agent.
      // It is looked for first; found, the person is told before a second one is added; not found, it is settled.
      const earlier =
        place === undefined || unsettled.current.has(key)
          ? []
          : unsettled.current.keysLike(place.prefix).filter((k) => k !== key);
      if (earlier.length > 0 && place !== undefined) {
        const read = await transport.listThreads(target).then(
          (r) => r.threads,
          () => null,
        );
        if (read === null) {
          setError(
            `Archer did not answer when an earlier version of this ${noun} went, and it cannot be checked now. Your text is kept; try again once Archer answers.`,
          );
          return null;
        }
        const seen = earlier.map((k) => k.slice(place.prefix.length)).find((body) => place.landed(read, body));
        for (const k of earlier) unsettled.current.delete(k);
        if (seen !== undefined) {
          loadThreads(target);
          setError(
            `An earlier version of this ${noun} was added when Archer did not answer: “${seen}”. Your text is kept; ${noun === "comment" ? "Add comment" : "Reply"} again adds it as a second ${noun}.`,
          );
          return null;
        }
      }
      bump(target);
      const out = await settleHeld(
        unsettled.current,
        key,
        () => newOperation(name, target),
        send,
        () => active.current,
      );
      if (out.kind === "answered") {
        const ack = out.ack;
        bump(target);
        apply(ack);
        setError(null);
        if (ack.thread === null) loadThreads(target);
        loadPending();
        return ack;
      }
      if (out.kind === "uncertain") {
        // Offline, the page does not keep trying by itself: the person sends it again when they are back.
        setError(uncertainWords(noun, out.failure, out.offline));
        loadThreads(target);
        return null;
      }
      // An identity that cannot be sent again: the next try is a new operation.
      if (out.ended) loadThreads(target);
      setError(`Could not ${what}: ${message(out.failure)}`);
      return null;
    },
    [loadPending, loadThreads, transport],
  );

  /**
   * One write per thread, sent concurrently (`BULK_CONCURRENCY` at a time),
   * and nothing shown changes until every one is answered: then ONE update
   * shows the outcome, ONE announcement says what happened, and one error
   * names how many did not go (they stay as the server still has them).
   *
   * A batch that removes threads (`remove`) takes away every one that went. A
   * batch that changes them (`reload`, publishing) does not guess at the
   * result: it reads every target it wrote to and applies all those lists in
   * one update.
   */
  /** A resolve or dismiss in a batch whose answer was lost: done if the thread is gone when Archer is read back. */
  const goneOnceLost = useCallback(
    async (thread: Thread, work: () => Promise<unknown>): Promise<void> => {
      try {
        await work();
      } catch (failure) {
        if (!isLost(failure)) throw failure;
        const read = await transport.listThreads(thread.target).then(
          (r) => r.threads,
          () => null,
        );
        if (read !== null && !read.some((t) => t.id === thread.id)) return;
        throw new Error(
          read === null
            ? `Archer did not answer (${message(failure)}), so it is not known whether it was done`
            : `Archer did not answer (${message(failure)}), and the thread is still there`,
        );
      }
    },
    [transport],
  );
  const bulk = useCallback(
    async (
      list: readonly Thread[],
      words: { readonly verb: string; readonly done: string; readonly kind: string },
      send: (thread: Thread) => Promise<unknown>,
      outcome: "remove" | "reload" = "remove",
    ): Promise<number> => {
      if (list.length === 0) return 0;
      const targets = [...new Set(list.map((thread) => thread.target))];
      for (const target of targets) {
        held.current.set(target, (held.current.get(target) ?? 0) + 1);
        bump(target);
      }
      let outcomes: Outcome[];
      const release = (): void => {
        for (const target of targets) {
          const count = (held.current.get(target) ?? 1) - 1;
          if (count > 0) held.current.set(target, count);
          else held.current.delete(target);
          // A read that set out before or during the batch is older than its outcome.
          bump(target);
        }
      };
      try {
        outcomes = await settleAll(list, BULK_CONCURRENCY, send);
      } catch (failure) {
        release();
        throw failure;
      }
      let reloaded = new Set<TargetRef>();
      if (outcome === "reload") {
        // Still held, so no event-driven read lands between the writes and this one.
        const mine = new Map(targets.map((target) => [target, bump(target)] as const));
        const lists = await Promise.all(
          targets.map((target) =>
            transport.listThreads(target).then(
              (read) => ({ target, threads: read.threads }),
              () => null,
            ),
          ),
        );
        const fresh = lists.filter(
          (read): read is { target: TargetRef; threads: readonly Thread[] } =>
            read !== null && sequence.current.get(read.target) === mine.get(read.target),
        );
        reloaded = new Set(fresh.map((read) => read.target));
        release();
        dispatch({ type: "loadedMany", lists: fresh });
      } else {
        release();
      }
      const went = list.filter((_, at) => outcomes[at]!.ok);
      const reasons = [...new Set(outcomes.flatMap((result) => (result.ok ? [] : [result.reason])))].join("; ");
      const failed = list.length - went.length;
      if (outcome === "remove") dispatch({ type: "removeMany", threadIds: went.map((thread) => thread.id) });
      announce(
        failed === 0
          ? `${words.done} ${went.length} ${words.kind}${threadWord(went.length)}.`
          : `${words.done} ${went.length} of ${list.length} ${words.kind}${threadWord(list.length)}; ${failed} could not be ${words.done.toLowerCase()}: ${reasons}.`,
      );
      setError(failed === 0 ? null : `Could not ${words.verb} ${threadCount(failed)}: ${reasons}`);
      // What changed while the batch held its targets is read now, once.
      for (const target of targets) {
        if (held.current.has(target)) continue;
        const wanted = deferred.current.delete(target);
        if (reloaded.has(target) || (!wanted && outcome === "remove")) continue;
        loadThreads(target);
      }
      loadPending();
      return went.length;
    },
    [announce, loadPending, loadThreads, transport],
  );

  const actions = useMemo<ReviewActions>(
    () => ({
      markSeen: remember,
      ingest(thread) {
        flushArrived();
        dispatch({ type: "upsert", thread });
      },
      refresh(target) {
        loadThreads(target);
        loadPending();
      },
      load: loadThreadsOnce,
      async create(target, anchor, body, expectedModelRevision) {
        const ack = await writeOnce(
          target,
          "add the comment",
          "comment",
          createKey(target, anchor, body),
          "comment.create",
          (operation) =>
            transport.createThreadOnce(operation, {
              target,
              anchor,
              body,
              ...(expectedModelRevision === undefined ? {} : { expectedModelRevision }),
            }),
          (done) => {
            if (done.thread !== null) dispatch({ type: "upsert", thread: done.thread });
            announce(writtenAnnouncement("Comment", done.thread));
          },
          {
            prefix: createPlace(target, anchor),
            landed: (threads, earlier) =>
              threads.some((t) => sameAnchor(t.anchor, anchor) && t.comments[0]?.body === earlier),
          },
        );
        return ack?.thread ?? null;
      },
      async reply(thread, body) {
        const ack = await writeOnce(
          thread.target,
          "reply",
          "reply",
          replyKey(thread.target, thread.id, body),
          "comment.reply",
          (operation) => transport.replyOnce(operation, thread.id, body),
          (done) => {
            if (done.thread !== null) dispatch({ type: "upsert", thread: done.thread, answer: true });
            else dispatch({ type: "remove", threadId: thread.id });
            announce(writtenAnnouncement("Reply", done.thread));
          },
          {
            prefix: replyPlace(thread.target, thread.id),
            landed: (threads, earlier) =>
              threads.some((t) => t.id === thread.id && t.comments.slice(1).some((c) => c.body === earlier)),
          },
        );
        return ack !== null;
      },
      async edit(thread, commentId, body) {
        // An edit is not an operation (a PATCH of the text), so a lost answer is reconciled by reading the comment
        // back (codex-303, O115): reading as the person's text, it was saved; unreadable, the outcome is uncertain
        // and the next Save reads it first, so a landed edit is never written twice (each one makes the thread a
        // draft again); reading otherwise, it was not saved, and what it reads now is shown (the editor then tells
        // another person's change apart and offers "Save over it", ThreadCard). Each Save names the thread revision
        // the page saw, so a change the page never saw is refused by the service rather than written over (O124).
        const key = `${thread.id}\0${commentId}`;
        const saved = (next: Thread): true => {
          uncertainEdits.current.delete(key);
          bump(thread.target);
          // An older answer than what the page has heard since never replaces it (O208, codex-1302): the editor keeps
          // saying the comment changed while Archer holds the later text.
          dispatch({ type: "upsert", thread: next, answer: true });
          setError(null);
          // Said from the thread as Archer now holds it (codex-405): published at once (immediate mode), it is sent.
          announce(
            next.status !== "draft"
              ? "Comment updated and sent to the agent."
              : thread.status === "draft"
                ? "Comment updated."
                : "Comment updated. It is a draft again; the agent sees the new text when you send it.",
          );
          loadPending();
          return true;
        };
        const readBack = async (): Promise<{ readonly thread: Thread; readonly body: string } | null | undefined> => {
          bump(thread.target);
          try {
            const now = (await transport.listThreads(thread.target)).threads.find((t) => t.id === thread.id);
            const comment = now?.comments.find((c) => c.id === commentId);
            return now === undefined || comment === undefined ? null : { thread: now, body: comment.body };
          } catch {
            return undefined;
          }
        };
        if (uncertainEdits.current.get(key) === body) {
          const now = await readBack();
          if (now?.body === body) return saved(now.thread);
        }
        const before = thread.comments.find((c) => c.id === commentId)?.body;
        // The edit names the thread revision the page saw (O124), so a change the page has not seen is refused, not
        // written over. Refused, the comment is read back: reading as the person's text, it was saved (a landed edit
        // whose answer was lost); reading as before (only the thread moved, a reply), it is sent again at the new
        // revision, once; reading otherwise, what it reads is shown and the editor offers "Save over it".
        let revision = thread.revision;
        try {
          for (let attempt = 0; ; attempt += 1) {
            bump(thread.target);
            try {
              return saved(await transport.edit(thread.id, commentId, body, revision));
            } catch (refused) {
              if (!(refused instanceof TransportError && refused.code === "thread_changed")) throw refused;
              const now = await readBack();
              if (now === undefined) {
                setError(
                  `The comment changed since this page read it, and Archer could not be read again (${message(refused)}), so this change has not been saved. Your text is kept.`,
                );
                return false;
              }
              if (now !== null && now.body === body) return saved(now.thread);
              uncertainEdits.current.delete(key);
              if (now === null) {
                dispatch({ type: "remove", threadId: thread.id });
                setError("The comment is no longer there, so this change was not saved. Your text is kept.");
                return false;
              }
              dispatch({ type: "upsert", thread: now.thread });
              if (now.body === before && attempt === 0) {
                revision = now.thread.revision;
                continue;
              }
              setError(
                "The comment was changed elsewhere, so this change has not been saved. Your text is kept; it now reads as shown, and Save over it replaces it with yours.",
              );
              return false;
            }
          }
        } catch (failure) {
          if (isRefusal(failure)) {
            uncertainEdits.current.delete(key);
            setError(`Could not save the change: ${message(failure)}`);
            return false;
          }
          const now = await readBack();
          if (now === undefined) {
            uncertainEdits.current.set(key, body);
            setError(
              typeof navigator !== "undefined" && navigator.onLine === false
                ? "This browser is offline, so this change may not have been saved. Your text is kept; saving it again once you are back online checks first, and never saves it twice."
                : `Archer did not answer, so this change may have been saved or not (${message(failure)}). Your text is kept; saving it again checks first, and never saves it twice.`,
            );
            return false;
          }
          if (now !== null && now.body === body) return saved(now.thread);
          uncertainEdits.current.delete(key);
          if (now !== null) dispatch({ type: "upsert", thread: now.thread });
          setError(
            now === null
              ? `Archer did not answer, and the comment is no longer there, so this change was not saved (${message(failure)}). Your text is kept.`
              : now.body === before
                ? `Archer did not answer, and the comment still reads as before, so this change has not been saved (${message(failure)}). Your text is kept; Save sends it.`
                : `Archer did not answer, and the comment was changed meanwhile, so this change has not been saved (${message(failure)}). Your text is kept; it now reads as shown.`,
          );
          return false;
        }
      },
      async remove(thread, commentId) {
        const done = await write(
          thread.target,
          "delete the comment",
          () => transport.remove(thread.id, commentId),
          (result) => {
            if (result.deleted) {
              dispatch({ type: "remove", threadId: thread.id });
              announce("Comment and its thread deleted.");
            } else {
              dispatch({ type: "upsert", thread: result.thread });
              announce("Comment deleted.");
            }
          },
          {
            check: (threads) => {
              const now = threads.find((t) => t.id === thread.id);
              if (now === undefined) return { deleted: true } as const;
              return now.comments.some((c) => c.id === commentId) ? null : ({ deleted: false, thread: now } as const);
            },
            still: "the comment is still there",
          },
        );
        return done !== null;
      },
      async resolve(thread) {
        const done = await write(
          thread.target,
          "resolve the thread",
          async () => {
            await transport.resolve(thread.id);
            return true;
          },
          () => {
            dispatch({ type: "remove", threadId: thread.id });
            announce("Thread resolved and removed.");
          },
          {
            check: (threads) => (threads.some((t) => t.id === thread.id) ? null : true),
            still: "the thread is still there",
          },
        );
        return done !== null;
      },
      async dismiss(thread) {
        const done = await write(
          thread.target,
          "dismiss the thread",
          async () => {
            await transport.dismiss(thread.id);
            return true;
          },
          () => {
            dispatch({ type: "remove", threadId: thread.id });
            announce("Thread dismissed.");
          },
          {
            check: (threads) => (threads.some((t) => t.id === thread.id) ? null : true),
            still: "the thread is still there",
          },
        );
        return done !== null;
      },
      markAllSeen(list) {
        rememberAll(list);
        if (list.length > 0) announce(`Marked ${threadCount(list.length)} read.`);
      },
      // A thread the agent resolved is the person's to dismiss; either way it goes.
      resolveAll: (list) =>
        bulk(list, { verb: "resolve", done: "Resolved", kind: "" }, (thread) =>
          goneOnceLost(thread, () =>
            thread.status === "resolved" ? transport.dismiss(thread.id) : transport.resolve(thread.id),
          ),
        ),
      dismissAll: (list) =>
        bulk(list, { verb: "clear", done: "Cleared", kind: "resolved " }, (thread) =>
          goneOnceLost(thread, () => transport.dismiss(thread.id)),
        ),
      publishAll: (list) =>
        bulk(
          list.filter(isPending),
          { verb: "publish", done: "Published", kind: "" },
          async (thread) => {
            const sent = await submitThreadOnce(
              transport,
              unsettledSubmits.current,
              thread.target,
              thread.id,
              () => active.current,
            );
            if (sent.kind === "sent") return;
            if (sent.kind === "refused") throw sent.failure;
            throw new Error(
              `Archer did not answer (${message(sent.failure)}), so it may not have been published; it is kept, and publishing it again never sends it twice`,
            );
          },
          "reload",
        ),
      async submitAll() {
        setSubmitting(true);
        const report = (result: SubmitResult): void => {
          const skipped = result.problems ?? [];
          // The server skipped comments files it could not read; what is in
          // them was NOT sent, and the person is the one who can fix them.
          setError(
            skipped.length === 0
              ? null
              : `${skipped.length === 1 ? "A comments file" : `${skipped.length} comments files`} could not be read and ${skipped.length === 1 ? "was" : "were"} not sent: ${skipped.join("; ")}`,
          );
          announce(
            result.submitted === 0
              ? "Nothing was waiting to be sent."
              : `Sent ${result.submitted} ${result.submitted === 1 ? "thread" : "threads"} to the agent.`,
          );
        };
        try {
          // Every draft in the project, in one action: what the count counts
          // (`api/comments/pending`), wherever it was written.
          // Sent as an operation (O83): a lost answer is sent again with the same identity, and the receipts
          // answer it with what the first try sent; still unanswered, the outcome is said as uncertain.
          const sent = await settleHeld(
            unsettledSubmits.current,
            "all",
            newSubmitOperation,
            (operation) => transport.submitOnce(operation, {}),
            () => active.current,
          );
          if (sent.kind === "answered") report(sent.ack);
          else if (sent.kind === "refused") setError(`Could not send: ${message(sent.failure)}`);
          else
            setError(
              sent.offline
                ? "This browser is offline, so your comments may not have been sent. They are kept; sending again once you are back online sends each of them once, never a second copy."
                : `Archer did not answer, so your comments may have been sent or not (${message(sent.failure)}). What Archer holds is read again below; sending again sends each of them once, never a second copy.`,
            );
        } catch (failure) {
          setError(`Could not send: ${message(failure)}`);
        } finally {
          setSubmitting(false);
        }
        // What was sent is read back rather than assumed.
        const current = viewRef.current;
        if (current !== null) {
          loadThreads(viewTarget(current));
          for (const note of notesRef.current.notes) loadThreads(noteTarget(note.path));
        }
        for (const target of projectTargetsRef.current) loadThreads(target);
        loadPending();
      },
      openNote(path) {
        const held = contentsRef.current.get(path);
        if (held === undefined || held.status === "error") readNote(path);
        if (capabilities.noteEmphasis) noteEmphasis.open(path);
      },
      saveNoteEmphasis(input) {
        return noteEmphasis.save(input);
      },
      dismissError() {
        setError(null);
      },
    }),
    [
      transport,
      write,
      writeOnce,
      bulk,
      announce,
      flushArrived,
      loadThreads,
      loadThreadsOnce,
      readNote,
      loadPending,
      remember,
      rememberAll,
      capabilities.noteEmphasis,
      noteEmphasis.open,
      noteEmphasis.save,
    ],
  );

  const target = viewId === null ? null : viewTarget(viewId);
  const pendingList = useMemo(() => {
    if (!capabilities.comments) return NO_PENDING;
    if (serverPending !== null) return serverPending;
    const noteTitles = new Map(notes.notes.map((note) => [noteTarget(note.path), note.title] as const));
    return heldPending(threads, (t) =>
      onTarget(t, {
        view: ({ viewId }) => viewTitleRef.current?.(viewId) ?? viewId,
        note: ({ path }) => noteTitles.get(t) ?? path,
        project: () => projectTitleRef.current,
      }),
    );
  }, [capabilities.comments, serverPending, threads, notes]);
  const pending = pendingList.total;
  const seenAnswerIndex = useMemo(() => seenEntryIndex(seenAnswers), [seenAnswers]);
  const unreadAnswers = useMemo(
    () =>
      [...threads.values()]
        .flat()
        .reduce(
          (count, thread) =>
            count +
            thread.comments.filter(
              (comment) => comment.author === "agent" && !isSeen(seenAnswerIndex, thread, comment.id),
            ).length,
          0,
        ),
    [seenAnswerIndex, threads],
  );
  const isUnread = useCallback(
    (thread: Thread) =>
      thread.comments.some((comment) => comment.author === "agent" && !isSeen(seenAnswerIndex, thread, comment.id)),
    [seenAnswerIndex],
  );

  const inboxLoading =
    inboxAwaiting === "activity" ||
    (inboxAwaiting instanceof Set &&
      [...inboxAwaiting].some((target) => !threads.has(target) && asked.current.has(target)));
  useEffect(() => {
    if (inboxAwaiting instanceof Set && !inboxLoading) setInboxAwaiting(null);
  }, [inboxAwaiting, inboxLoading]);
  return {
    unreadAnswers,
    inboxLoading,
    isUnread,
    capabilities,
    viewId,
    viewTarget: target,
    threads,
    notes,
    noteContents,
    noteEmphases: noteEmphasis.states,
    pending,
    pendingTargets: pendingList.targets,
    announcement,
    error,
    submitting,
    actions,
  };
}
