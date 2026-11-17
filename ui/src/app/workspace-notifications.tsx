import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import type { Comment, TargetRef, Thread } from "../comments/contract";
import { parseCapabilities, parseThreadList } from "../comments/parse";
import { ReviewToggle } from "../comments/ReviewToggle";
import {
  browserReviewStorage,
  isSeen,
  EMPTY_SEEN_STATE,
  loadSeenState,
  mergeSeenStates,
  rememberSeen,
  seenEntryIndex,
  storeSeenState,
  type SeenState,
} from "../comments/review-seen";
import { browserFetch, browserResourceUrl } from "./browser-resource";
import { projectResourceBase } from "./browser-routes";
import {
  parseCommentActivity,
  readCommentActivity,
  type CommentActivity,
  type CommentActivityByTarget,
} from "./comment-activity";
import {
  directoryProjectUrl,
  loadProjectCatalog,
  parseProjectCatalog,
  type DirectoryProject,
  type ProjectDestination,
} from "./project-directory";
import { onTarget } from "../comments/target";
import { parseBrowserConnection } from "./http-connection";
import { withThreadAddress } from "./thread-address";
import { withReadDeadline } from "./read-deadline";
import { readBoundedJson, JSON_SNAPSHOT_MAX_BYTES, type JsonReadBudget } from "./bounded-json";
import { POLL_INTERVAL_MS, schedulePoll, withPollTag, type PollTag } from "./polls";
import "./workspace-notifications.css";

export type WorkspaceNotificationScope =
  | { readonly kind: "service" }
  | { readonly kind: "project"; readonly slug: string };
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const WORKSPACE_NOTIFICATION_MAX_TARGET_READS = 512;
export const WORKSPACE_NOTIFICATION_MAX_ITEMS = 4_096;
export const WORKSPACE_NOTIFICATION_DEADLINE_MS = 20_000;
/** Background refresh cadence while the tab is visible. */
export const WORKSPACE_NOTIFICATION_POLL_MS = POLL_INTERVAL_MS.notifications;
const CONCURRENCY = 4;

export type WorkspaceNotificationItem = {
  readonly projectSlug: string;
  readonly projectName: string;
  readonly target: TargetRef;
  readonly targetTitle: string;
  readonly thread: Thread;
  readonly comment: Comment;
  readonly href: string;
};

type ProjectCounts = { readonly total: number; readonly loaded: number };
/** An agent comment the comment activity names, whose thread was not read (`readThreads: false`). */
export type WorkspaceAnswerRef = {
  readonly projectSlug: string;
  readonly target: TargetRef;
  readonly threadId: string;
  readonly commentId: string;
};
// `answers`: the agent comments counted from the activity alone, on targets whose threads were not read.
export type WorkspaceNotificationResult =
  | {
      readonly status: "ready";
      readonly items: readonly WorkspaceNotificationItem[];
      readonly answers?: readonly WorkspaceAnswerRef[];
      readonly projects: ProjectCounts;
    }
  | {
      readonly status: "partial";
      readonly items: readonly WorkspaceNotificationItem[];
      readonly answers?: readonly WorkspaceAnswerRef[];
      readonly projects: ProjectCounts;
      readonly message: string;
    }
  | { readonly status: "access-required" | "incompatible" | "unavailable" | "error"; readonly message: string };

/**
 * The threads one bell last read for each target, keyed by project slug and target, with the activity they were
 * read under. A target whose activity entry is unchanged is not read again. The bell owns it; each finished
 * refresh replaces its contents with the targets it selected, so it holds at most
 * `WORKSPACE_NOTIFICATION_MAX_TARGET_READS` entries. A failed read is not kept.
 */
export type WorkspaceThreadMemo = Map<
  string,
  { readonly activity: CommentActivity; readonly threads: readonly Thread[]; readonly incomplete: boolean }
>;

// `poll`: the tag of the scheduled tick reading (app/polls.ts), sent on every read it makes.
// `readThreads: false`: where the activity names a target's agent comments, they are counted from it and its threads
// are not read (the bell before the reader reaches for it, PF-2). Default true.
type Options = {
  readonly fetchImpl?: FetchLike;
  readonly href?: string;
  readonly signal?: AbortSignal;
  readonly budget?: JsonReadBudget;
  readonly poll?: PollTag;
  readonly memo?: WorkspaceThreadMemo;
  readonly readThreads?: boolean;
};
type ProjectSource = { readonly slug: string; readonly name: string; readonly project?: DirectoryProject };
type ProjectRead = {
  readonly source: ProjectSource;
  readonly activity?: CommentActivityByTarget;
  readonly failure?: Exclude<WorkspaceNotificationResult["status"], "ready" | "partial">;
};

function projectUrl(href: string, slug: string, endpoint: string): string | null {
  const base = projectResourceBase(href, slug);
  if (base === null) return null;
  try {
    return new URL(endpoint, base).href;
  } catch {
    return null;
  }
}

function failureForStatus(status: number): ProjectRead["failure"] {
  if (status === 401 || status === 403 || status === 404) return "access-required";
  if (status === 409 || status === 426) return "incompatible";
  return "error";
}

async function jsonRead(
  fetchImpl: FetchLike,
  url: string,
  outer: AbortSignal | undefined,
  budget: JsonReadBudget,
  poll?: PollTag,
): Promise<{ response: Response; body?: unknown }> {
  if (budget.remaining <= 0) throw new Error("The notification byte budget was exhausted.");
  return withReadDeadline(async (signal) => {
    const combined = outer === undefined ? signal : AbortSignal.any([outer, signal]);
    const response = await fetchImpl(url, withPollTag({ cache: "no-store", signal: combined }, poll));
    if (!response.ok) return { response };
    return { response, body: await readBoundedJson(response, budget, combined) };
  });
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  operation: (value: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const answer: R[] = new Array(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      if (signal?.aborted) return;
      const index = next++;
      const value = values[index];
      if (value === undefined) return;
      answer[index] = await operation(value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, values.length) }, worker));
  return answer;
}

function targetTitle(source: ProjectSource, target: TargetRef): string {
  const project = source.project;
  return onTarget(target, {
    view: ({ viewId }) => project?.views.find((view) => view.id === viewId)?.title ?? viewId,
    note: ({ path }) => project?.notes.find((note) => note.path === path)?.title ?? path,
    project: () => source.name,
  });
}

function targetHref(
  href: string,
  slug: string,
  target: TargetRef,
  threadId: string,
  project?: DirectoryProject,
): string | null {
  const destination = onTarget<ProjectDestination | undefined>(target, {
    // A standalone diagram is addressed by its file; the catalog says which file that is.
    view: ({ viewId }) => {
      const sourcePath = project?.views.find(
        (view) => view.id === viewId && view.registration !== "embedded",
      )?.sourcePath;
      return { view: viewId, ...(sourcePath === undefined ? {} : { sourcePath }) };
    },
    note: ({ path }) => ({ note: path }),
    // The project conversation opens in the chat on the project's own page.
    project: () => undefined,
  });
  const destinationUrl = directoryProjectUrl(href, slug, destination);
  if (destinationUrl === null) return null;
  // An address that cannot carry a thread (the project's own page) still opens the project.
  return withThreadAddress(destinationUrl, threadId) ?? (destination === undefined ? destinationUrl : null);
}

function validTimestamp(value: string): boolean {
  if (
    value.length > 64 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return false;
  const calendar = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  return Number.isFinite(calendar.getTime()) && calendar.toISOString().slice(0, 10) === value.slice(0, 10);
}

async function inspectProject(
  source: ProjectSource,
  fetchImpl: FetchLike,
  href: string,
  signal: AbortSignal | undefined,
  budget: JsonReadBudget,
  poll: PollTag | undefined,
): Promise<ProjectRead> {
  // The page's own fetcher, for a project the service's catalog listed: the catalog read already proved this
  // service compatible and the project readable, so its comment activity (shared with the project list) is the
  // only read. Two requests per project fewer on /projects/ (perf #7). When it cannot be read, the reads
  // below say why.
  if (fetchImpl === browserFetch && source.project !== undefined) {
    const activityUrl = projectUrl(href, source.slug, "api/comment-activity");
    const shared = activityUrl === null ? null : await readCommentActivity(source.slug, activityUrl, fetchImpl, poll);
    if (shared !== null) return { source, activity: shared };
  }
  const bootstrapUrl = projectUrl(href, source.slug, "api/bootstrap");
  const connectionUrl = projectUrl(href, source.slug, "api/connection");
  if (bootstrapUrl === null || connectionUrl === null) return { source, failure: "error" };
  try {
    const connection = await jsonRead(fetchImpl, connectionUrl, signal, budget, poll);
    if (!connection.response.ok) return { source, failure: failureForStatus(connection.response.status) };
    if (parseBrowserConnection(connection.body) === undefined) return { source, failure: "incompatible" };
    const bootstrap = await jsonRead(fetchImpl, bootstrapUrl, signal, budget, poll);
    if (!bootstrap.response.ok) return { source, failure: failureForStatus(bootstrap.response.status) };
    const capabilities =
      typeof bootstrap.body === "object" && bootstrap.body !== null
        ? (bootstrap.body as Record<string, unknown>).capabilities
        : undefined;
    if (
      typeof capabilities !== "object" ||
      capabilities === null ||
      Array.isArray(capabilities) ||
      ("comments" in capabilities && typeof (capabilities as Record<string, unknown>).comments !== "boolean")
    )
      return { source, failure: "incompatible" };
    if (!parseCapabilities(bootstrap.body).comments) return { source, failure: "unavailable" };
    const advertisedName = (bootstrap.body as { project?: { name?: unknown } }).project?.name;
    const namedSource =
      typeof advertisedName === "string" && advertisedName.trim() !== "" && advertisedName.length <= 512
        ? { ...source, name: advertisedName.trim() }
        : source;
    const activityUrl = projectUrl(href, source.slug, "api/comment-activity");
    if (activityUrl === null) return { source: namedSource, failure: "error" };
    // The page's own fetcher shares the activity read with the inbox and the project list; a caller's own reads for itself.
    if (fetchImpl === browserFetch) {
      const shared = await readCommentActivity(source.slug, activityUrl, fetchImpl, poll);
      return shared === null ? { source: namedSource, failure: "error" } : { source: namedSource, activity: shared };
    }
    const activity = await jsonRead(fetchImpl, activityUrl, signal, budget, poll);
    const snapshot = activity.response.ok ? parseCommentActivity(activity.body) : null;
    return snapshot === null ? { source: namedSource, failure: "error" } : { source: namedSource, activity: snapshot };
  } catch {
    return { source, failure: "error" };
  }
}

const answersKey = (activity: CommentActivity): string | undefined =>
  activity.agentComments?.map((ref) => `${ref.thread}\0${ref.comment}`).join("\n");
const sameActivity = (left: CommentActivity, right: CommentActivity): boolean =>
  left.totalThreads === right.totalThreads &&
  left.unresolvedThreads === right.unresolvedThreads &&
  left.lastCommentedAt === right.lastCommentedAt &&
  answersKey(left) === answersKey(right);

function projectFailure(reads: readonly ProjectRead[]): WorkspaceNotificationResult | null {
  const failures = reads
    .map((read) => read.failure)
    .filter((failure): failure is NonNullable<ProjectRead["failure"]> => failure !== undefined);
  if (failures.length === 0) return null;
  if (reads.some((read) => read.activity !== undefined)) return null;
  const status = failures.every((failure) => failure === failures[0]) ? failures[0]! : "error";
  const messages: Record<typeof status, string> = {
    "access-required": "Notification access is required for this project.",
    incompatible: "This Archer service is not compatible with workspace notifications.",
    unavailable: "Comments are unavailable for this project.",
    error: "Notifications could not be loaded.",
  };
  return { status, message: messages[status] };
}

async function loadWorkspaceNotificationsCore(
  scope: WorkspaceNotificationScope,
  options: Options,
): Promise<WorkspaceNotificationResult> {
  const fetchImpl = options.fetchImpl ?? browserFetch;
  const href = options.href ?? window.location.href;
  const budget = options.budget ?? { remaining: JSON_SNAPSHOT_MAX_BYTES };
  let sources: readonly ProjectSource[];
  if (scope.kind === "project") sources = [{ slug: scope.slug, name: scope.slug }];
  else {
    // The page's own catalog read (or one it just made) serves the default fetcher; a caller's own fetcher reads for itself.
    if (options.fetchImpl === undefined) {
      const shared = await loadProjectCatalog(browserFetch, options.poll);
      if (shared.status === "error") return { status: "error", message: "The project catalog could not be loaded." };
      sources = shared.projects.map((project) => ({ slug: project.slug, name: project.name, project }));
      if (sources.length === 0) return { status: "ready", items: [], projects: { total: 0, loaded: 0 } };
    } else {
      let catalogRead: { response: Response; body?: unknown };
      try {
        catalogRead = await jsonRead(
          fetchImpl,
          browserResourceUrl("api/browser-projects", href),
          options.signal,
          budget,
          options.poll,
        );
      } catch {
        return { status: "error", message: "The project catalog could not be loaded." };
      }
      if (!catalogRead.response.ok) {
        const failure = failureForStatus(catalogRead.response.status);
        return (
          projectFailure([{ source: { slug: "catalog", name: "catalog" }, failure }]) ?? {
            status: "error",
            message: "The project catalog could not be loaded.",
          }
        );
      }
      const catalog = parseProjectCatalog(catalogRead.body);
      if (catalog === null)
        return { status: "incompatible", message: "The project catalog response is incompatible with this page." };
      sources = catalog.map((project) => ({ slug: project.slug, name: project.name, project }));
      if (sources.length === 0) return { status: "ready", items: [], projects: { total: 0, loaded: 0 } };
    }
  }

  const reads = await mapConcurrent(
    sources,
    (source) => inspectProject(source, fetchImpl, href, options.signal, budget, options.poll),
    options.signal,
  );
  const completeFailure = projectFailure(reads);
  if (completeFailure !== null) return completeFailure;

  const selected: { read: ProjectRead; target: TargetRef; activity: CommentActivity }[] = [];
  const answers: WorkspaceAnswerRef[] = [];
  let targetsTruncated = false;
  outer: for (const read of reads) {
    if (read.activity === undefined) continue;
    for (const [target, value] of read.activity) {
      if (value.totalThreads === 0) continue;
      // No agent comment on it: nothing here for the bell, so nothing to read.
      if (value.agentComments !== undefined && value.agentComments.length === 0) continue;
      if (options.readThreads === false && value.agentComments !== undefined) {
        for (const ref of value.agentComments)
          answers.push({ projectSlug: read.source.slug, target, threadId: ref.thread, commentId: ref.comment });
        continue;
      }
      if (selected.length === WORKSPACE_NOTIFICATION_MAX_TARGET_READS) {
        targetsTruncated = true;
        break outer;
      }
      selected.push({ read, target, activity: value });
    }
  }
  const memoKey = (slug: string, target: TargetRef): string => `${slug}\0${target}`;
  const loaded = await mapConcurrent(
    selected,
    async ({ read, target, activity }) => {
      const held = options.memo?.get(memoKey(read.source.slug, target));
      if (held !== undefined && sameActivity(held.activity, activity))
        return { read, target, activity, threads: held.threads, incomplete: held.incomplete };
      const base = projectUrl(href, read.source.slug, "");
      if (base === null) return { read, target, activity, threads: null };
      try {
        const url = new URL(`api/comments?${new URLSearchParams({ target })}`, base).href;
        const answer = await jsonRead(fetchImpl, url, options.signal, budget, options.poll);
        if (!answer.response.ok) return { read, target, activity, threads: null };
        const raw =
          typeof answer.body === "object" && answer.body !== null && !Array.isArray(answer.body)
            ? (answer.body as Record<string, unknown>)
            : null;
        if (raw === null || !Array.isArray(raw.threads)) return { read, target, activity, threads: null };
        const rawThreads = raw.threads.slice(0, 500);
        const list = parseThreadList({ ...raw, threads: rawThreads });
        if (list === undefined || list.target !== target) return { read, target, activity, threads: null };
        const validThreads = list.threads.filter(
          (thread) =>
            thread.target === target &&
            thread.comments.every(
              (comment) =>
                validTimestamp(comment.createdAt) &&
                (comment.editedAt === undefined || validTimestamp(comment.editedAt)),
            ),
        );
        return {
          read,
          target,
          activity,
          threads: validThreads,
          incomplete: raw.threads.length > 500 || validThreads.length !== rawThreads.length,
        };
      } catch {
        return { read, target, activity, threads: null };
      }
    },
    options.signal,
  );
  if (options.memo !== undefined && options.signal?.aborted !== true) {
    options.memo.clear();
    for (const entry of loaded) {
      if (entry === undefined || entry.threads === null) continue;
      options.memo.set(memoKey(entry.read.source.slug, entry.target), {
        activity: entry.activity,
        threads: entry.threads,
        incomplete: entry.incomplete,
      });
    }
  }
  const items: WorkspaceNotificationItem[] = [];
  let itemsTruncated = false;
  let linkFailure = false;
  for (const entry of loaded) {
    if (entry.threads === null) continue;
    for (const thread of entry.threads)
      for (const comment of thread.comments)
        if (comment.author === "agent") {
          if (items.length === WORKSPACE_NOTIFICATION_MAX_ITEMS) {
            itemsTruncated = true;
            break;
          }
          const link = targetHref(href, entry.read.source.slug, entry.target, thread.id, entry.read.source.project);
          if (link === null) {
            linkFailure = true;
            continue;
          }
          items.push({
            projectSlug: entry.read.source.slug,
            projectName: entry.read.source.name,
            target: entry.target,
            targetTitle: targetTitle(entry.read.source, entry.target),
            thread,
            comment,
            href: link,
          });
        }
    if (itemsTruncated) break;
  }
  items.sort(
    (left, right) =>
      Date.parse(right.comment.createdAt) - Date.parse(left.comment.createdAt) ||
      left.projectSlug.localeCompare(right.projectSlug) ||
      left.target.localeCompare(right.target) ||
      left.thread.id.localeCompare(right.thread.id) ||
      left.comment.id.localeCompare(right.comment.id),
  );
  const loadedProjects = reads.filter((read) => read.activity !== undefined).length;
  const incomplete =
    loadedProjects !== sources.length ||
    targetsTruncated ||
    itemsTruncated ||
    linkFailure ||
    loaded.some((entry) => entry.threads === null || entry.incomplete === true);
  const projects = { total: sources.length, loaded: loadedProjects };
  const counted = answers.length === 0 ? {} : { answers };
  return incomplete
    ? {
        status: "partial",
        items,
        ...counted,
        projects,
        message: "Some notifications are unavailable. Showing the results that could be read.",
      }
    : { status: "ready", items, ...counted, projects };
}

/** One opening has a hard ceiling in addition to each request's deadline. */
export async function loadWorkspaceNotifications(
  scope: WorkspaceNotificationScope,
  options: Options = {},
): Promise<WorkspaceNotificationResult> {
  try {
    return await withReadDeadline(
      (deadline) =>
        loadWorkspaceNotificationsCore(scope, {
          ...options,
          signal: options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline]),
        }),
      WORKSPACE_NOTIFICATION_DEADLINE_MS,
    );
  } catch {
    return { status: "error", message: "Notifications could not be loaded before the deadline." };
  }
}

/** Short, playful empty states; one line each so the panel keeps its size. */
export const QUIET_PHRASES: readonly string[] = [
  "Nothing to see here.",
  "All quiet on the western front.",
  "Inbox zero. Savor it.",
  "The agents are napping.",
  "Not a peep.",
  "Crickets. Lovely crickets.",
  "All caught up.",
  "Smooth sailing so far.",
  "No news is good news.",
  "Quiet as a cache hit.",
  "Every thread is tied.",
  "Your diagrams are behaving.",
  "Silence, the good kind.",
  "Nobody's knocking.",
  "Zero pings. Pure bliss.",
  "All boxes, no alarms.",
  "Calm seas ahead.",
  "The queue is empty.",
  "Nothing awaits your reply.",
  "Tumbleweeds roll by.",
  "Peace and quiet.",
  "No replies. Yet.",
  "Clean slate.",
  "All arrows point home.",
  "The mailbox flag is down.",
  "Steady as she goes.",
  "Nothing new under the sun.",
  "Coffee break, then?",
  "No loose ends.",
  "Still waters.",
];
export const QUIET_PHRASE_MS = 6_000;
const QUIET_FADE_MS = 280;

/**
 * Rotates a quiet phrase every few seconds with a short fade. Assistive
 * technology hears one steady sentence; reduced motion keeps one phrase.
 */
function QuietPhrase(): JSX.Element {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * QUIET_PHRASES.length));
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      return;
    let swap: ReturnType<typeof setTimeout> | undefined;
    const timer = setInterval(() => {
      if (document.hidden) return;
      setLeaving(true);
      swap = setTimeout(() => {
        setIndex(
          (current) => (current + 1 + Math.floor(Math.random() * (QUIET_PHRASES.length - 1))) % QUIET_PHRASES.length,
        );
        setLeaving(false);
      }, QUIET_FADE_MS);
    }, QUIET_PHRASE_MS);
    return () => {
      clearInterval(timer);
      if (swap !== undefined) clearTimeout(swap);
    };
  }, []);
  return (
    <p className="archer-workspace-notifications-empty">
      <span className="archer-visually-hidden">No notifications.</span>
      <span
        key={index}
        className="archer-workspace-notifications-phrase"
        data-leaving={leaving ? "true" : undefined}
        aria-hidden="true"
      >
        {QUIET_PHRASES[index]}
      </span>
    </p>
  );
}

function itemSeen(state: SeenState, item: WorkspaceNotificationItem): boolean {
  return isSeen(seenEntryIndex(state), item.thread, item.comment.id);
}
function answerSeen(state: SeenState, ref: WorkspaceAnswerRef): boolean {
  return isSeen(seenEntryIndex(state), { id: ref.threadId, target: ref.target } as Thread, ref.commentId);
}
const NO_ITEMS: readonly WorkspaceNotificationItem[] = [];
const NO_ANSWERS: readonly WorkspaceAnswerRef[] = [];

export function WorkspaceNotifications(props: {
  readonly scope: WorkspaceNotificationScope;
  readonly fetchImpl?: FetchLike;
}): JSX.Element {
  const id = useId();
  const panelId = `archer-workspace-notifications-${id.replace(/:/g, "")}`;
  const toggle = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const [panelTop, setPanelTop] = useState(64);
  const [loading, setLoading] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [result, setResult] = useState<WorkspaceNotificationResult | null>(null);
  const [seen, setSeen] = useState<ReadonlyMap<string, SeenState>>(new Map());
  const generation = useRef(0);
  const activeRead = useRef<AbortController | null>(null);
  const scopeKind = props.scope.kind;
  const scopeSlug = props.scope.kind === "project" ? props.scope.slug : null;

  const memo = useRef<WorkspaceThreadMemo>(new Map());
  // The threads are read once the reader reaches for the bell (pointer over it, focus on it, or opening it); until
  // then the count comes from the comment activity alone (PF-2).
  const wanted = useRef(false);
  // The last answer counted agent comments whose threads it did not read.
  const answersUnread = useRef(false);

  // Reads in the background and keeps what is on screen until the next
  // answer replaces it, so opening the panel never waits on the network.
  // A poll re-reads only the targets whose comment activity changed. An edited comment changes no activity
  // field, so the first read and the person's return to the window (focus, visibility) read every target again.
  // `poll` is the tick's tag (debug builds only); `reuse` says whether held threads may be used.
  const refresh = useCallback(
    (reuse: boolean, poll?: PollTag) => {
      activeRead.current?.abort();
      const controller = new AbortController();
      activeRead.current = controller;
      const ownGeneration = ++generation.current;
      setLoading(true);
      const scope: WorkspaceNotificationScope =
        scopeKind === "service" ? { kind: "service" } : { kind: "project", slug: scopeSlug! };
      if (!reuse) memo.current.clear();
      const readThreads = wanted.current;
      return loadWorkspaceNotifications(scope, {
        fetchImpl: props.fetchImpl,
        signal: controller.signal,
        poll,
        memo: memo.current,
        readThreads,
      })
        .then((next) => {
          if (generation.current !== ownGeneration || controller.signal.aborted) return;
          answersUnread.current = "items" in next && next.answers !== undefined;
          // Reached for while this count was being read: the threads are read now.
          if (!readThreads && wanted.current && answersUnread.current) {
            void refresh(true);
          }
          setResult(next);
          setCheckedAt(next.status === "ready" ? Date.now() : null);
          const slugs =
            "items" in next
              ? [...next.items.map((item) => item.projectSlug), ...(next.answers ?? []).map((ref) => ref.projectSlug)]
              : [];
          setSeen(new Map([...new Set(slugs)].map((slug) => [slug, loadSeenState(slug, browserReviewStorage())])));
          setLoading(false);
        })
        .catch(() => {
          if (generation.current !== ownGeneration || controller.signal.aborted) return;
          setResult({ status: "error", message: "Notifications could not be loaded." });
          setLoading(false);
        });
    },
    [props.fetchImpl, scopeKind, scopeSlug],
  );

  useEffect(() => {
    // A new scope or fetcher starts with nothing held.
    memo.current = new Map();
    refresh(false);
    const returned = (): void => {
      if (!document.hidden) void refresh(false);
    };
    const stopPoll = schedulePoll("notifications", (poll) => (document.hidden ? undefined : refresh(true, poll)));
    window.addEventListener("focus", returned);
    document.addEventListener("visibilitychange", returned);
    return () => {
      generation.current += 1;
      activeRead.current?.abort();
      stopPoll();
      window.removeEventListener("focus", returned);
      document.removeEventListener("visibilitychange", returned);
    };
  }, [refresh]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent): void => {
      if (
        !(event.target instanceof Node) ||
        panel.current?.contains(event.target) ||
        toggle.current?.contains(event.target)
      )
        return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const header = toggle.current?.closest(".primary-document-bar");
    const measure = (): void => setPanelTop(header ? header.getBoundingClientRect().bottom + 8 : 64);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (header) observer?.observe(header);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [open]);
  useEffect(() => {
    if (open) requestAnimationFrame(() => panel.current?.focus());
  }, [open]);

  const items = result !== null && "items" in result ? result.items : NO_ITEMS;
  const answers = result !== null && "items" in result ? (result.answers ?? NO_ANSWERS) : NO_ANSWERS;
  useEffect(() => {
    if (items.length === 0 && answers.length === 0) return;
    const synchronize = (): void => {
      const storage = browserReviewStorage();
      setSeen(
        new Map(
          [...new Set([...items, ...answers].map((item) => item.projectSlug))].map((slug) => [
            slug,
            loadSeenState(slug, storage),
          ]),
        ),
      );
    };
    window.addEventListener("storage", synchronize);
    return () => window.removeEventListener("storage", synchronize);
  }, [items, answers]);
  const unread = useMemo(
    () =>
      items.filter((item) => !itemSeen(seen.get(item.projectSlug) ?? EMPTY_SEEN_STATE, item)).length +
      answers.filter((ref) => !answerSeen(seen.get(ref.projectSlug) ?? EMPTY_SEEN_STATE, ref)).length,
    [items, answers, seen],
  );
  // The reader reaching for the bell: its threads are read now, so the panel opens on them.
  const reach = (): void => {
    if (wanted.current) return;
    wanted.current = true;
    if (answersUnread.current) void refresh(true);
  };
  const mark = (item: WorkspaceNotificationItem): void =>
    setSeen((current) => {
      const storage = browserReviewStorage();
      const prior = current.get(item.projectSlug) ?? loadSeenState(item.projectSlug, storage);
      const persisted = loadSeenState(item.projectSlug, storage);
      const one = { ...item.thread, comments: [item.comment] };
      const next = rememberSeen(mergeSeenStates(prior, persisted), [one]);
      storeSeenState(item.projectSlug, next, storage);
      return new Map(current).set(item.projectSlug, next);
    });

  // Threads not read yet (the activity counted them): the panel says it is loading, not that there is nothing.
  const waiting = answers.length > 0;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer entry or focus inside loads the notifications early; the toggle inside is the control.
    <div className="archer-workspace-notifications" onPointerEnter={reach} onFocus={reach}>
      <ReviewToggle
        ref={toggle}
        label="Notifications"
        pending={0}
        unreadAnswers={unread}
        {...(checkedAt === null
          ? {}
          : { countDescription: `Last checked ${new Date(checkedAt).toLocaleTimeString()}.` })}
        open={open}
        controls={panelId}
        onToggle={() => {
          reach();
          setOpen((value) => !value);
        }}
      />
      {open ? (
        <section
          ref={panel}
          id={panelId}
          className="archer-workspace-notifications-panel"
          data-empty={
            result !== null && "items" in result && result.items.length === 0 && !waiting && result.status === "ready"
              ? "true"
              : undefined
          }
          style={{ top: panelTop, maxHeight: `min(620px, calc(100vh - ${panelTop + 8}px))` }}
          role="dialog"
          aria-modal="false"
          aria-label="Notifications"
          data-archer-local-keys
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              requestAnimationFrame(() => toggle.current?.focus());
            }
          }}
        >
          <div className="archer-workspace-notifications-heading">
            <h2>Notifications</h2>
          </div>
          {loading && (result === null || waiting) ? <p role="status">Loading notifications…</p> : null}
          {result !== null && !("items" in result) ? <p role="status">{result.message}</p> : null}
          {result?.status === "partial" ? <p role="status">{result.message}</p> : null}
          {result !== null && "items" in result && result.items.length === 0 && !waiting ? <QuietPhrase /> : null}
          {items.length > 0 ? (
            <ol>
              {items.map((item) => {
                const read = itemSeen(seen.get(item.projectSlug) ?? { entries: [] }, item);
                return (
                  <li
                    key={`${item.projectSlug}\0${item.target}\0${item.thread.id}\0${item.comment.id}`}
                    data-read={read ? "true" : "false"}
                  >
                    <a href={item.href} onClick={() => mark(item)}>
                      <span>
                        {item.projectName} · {item.targetTitle}
                      </span>
                      <strong>{item.comment.body}</strong>
                    </a>
                    {read ? (
                      <span className="archer-workspace-notifications-read">Read</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          mark(item);
                          panel.current?.focus();
                        }}
                      >
                        Mark read
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
