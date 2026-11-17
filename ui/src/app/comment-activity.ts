import { projectResourceBase } from "./browser-routes.ts";
import type { TargetRef } from "../comments/contract";
import { readTargetRef } from "../comments/target.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import { bodyOf, type ResourcePolicy, resources } from "./resources.ts";
import type { PollTag } from "./polls.ts";

// A project with up to 4,096 notes and 256 durable views is the design size. Each note
// can contribute itself plus 256 embedded views to the service inventory.
export const COMMENT_ACTIVITY_MAX_TARGETS = 256 + 257 * 4_096;

export type CommentActivity = {
  readonly totalThreads: number;
  readonly unresolvedThreads: number;
  readonly lastCommentedAt: string | null;
  /**
   * The agent's comments on the target, by thread and comment id: what the bell counts as answers, with no thread
   * read (PF-2). Undefined from a service that does not list them; then only the threads say.
   */
  readonly agentComments?: readonly AgentCommentRef[];
};

/** One agent comment, by its thread and its own id. */
export type AgentCommentRef = { readonly thread: string; readonly comment: string };

/** More agent comments on one target than a listing names: the threads are read instead. */
const AGENT_COMMENTS_MAX = 512;
const ID_MAX_CHARS = 256;

export type CommentActivityProject = {
  readonly slug: string;
  readonly current: boolean;
  /** Changes when this project's file inventory changes. */
  readonly targetKey?: string;
};

export type CommentActivityByTarget = ReadonlyMap<TargetRef, CommentActivity>;
export type CommentActivityByProject = ReadonlyMap<string, CommentActivityByTarget>;
export type CommentActivityFetch = (url: string, init?: RequestInit) => Promise<Response>;

const TARGET_MAX_CHARS = 4_096;
const DATE_MAX_CHARS = 64;
const CONCURRENCY = 4;

const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

const targetRef = (value: string): value is TargetRef => readTargetRef(value, TARGET_MAX_CHARS) !== null;

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const commentedAt = (value: unknown): value is string | null =>
  value === null || (typeof value === "string" && value.length <= DATE_MAX_CHARS && !Number.isNaN(Date.parse(value)));

const commentId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= ID_MAX_CHARS;

/** A target's agent comment list: `[]` when it is absent from a listing that names them, null when malformed. */
function agentCommentsOf(value: unknown): readonly AgentCommentRef[] | undefined | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  if (value.length > AGENT_COMMENTS_MAX) return undefined;
  const refs: AgentCommentRef[] = [];
  for (const candidate of value) {
    const ref = record(candidate);
    if (ref === null || !commentId(ref.thread) || !commentId(ref.comment) || Object.keys(ref).length !== 2) return null;
    refs.push({ thread: ref.thread, comment: ref.comment });
  }
  return refs;
}

export function parseCommentActivity(
  value: unknown,
  maxTargets = COMMENT_ACTIVITY_MAX_TARGETS,
): CommentActivityByTarget | null {
  const envelope = record(value);
  if (envelope === null || envelope.schemaVersion !== 1) return null;
  // A service that lists agent comments says so once: then a target with none of them simply has no list.
  const listed = envelope.agentCommentsListed === true;
  const targets = record(envelope.targets);
  if (targets === null) return null;
  const parsed = new Map<TargetRef, CommentActivity>();
  let targetCount = 0;
  for (const target in targets) {
    if (!Object.hasOwn(targets, target)) continue;
    targetCount += 1;
    if (targetCount > maxTargets) return null;
    const candidate = targets[target];
    const activity = record(candidate);
    if (
      !targetRef(target) ||
      activity === null ||
      !count(activity.totalThreads) ||
      !count(activity.unresolvedThreads) ||
      activity.unresolvedThreads > activity.totalThreads ||
      !commentedAt(activity.lastCommentedAt) ||
      Object.keys(activity).some(
        (key) =>
          key !== "totalThreads" &&
          key !== "unresolvedThreads" &&
          key !== "lastCommentedAt" &&
          !(listed && key === "agentComments"),
      )
    )
      return null;
    const agentComments = listed ? agentCommentsOf(activity.agentComments) : undefined;
    if (agentComments === null) return null;
    parsed.set(target, {
      totalThreads: activity.totalThreads,
      unresolvedThreads: activity.unresolvedThreads,
      lastCommentedAt: activity.lastCommentedAt,
      ...(agentComments === undefined ? {} : { agentComments }),
    });
  }
  return parsed;
}

const activityPolicy: ResourcePolicy<CommentActivityByTarget> = {
  kind: "comment-activity",
  freshMs: 2_000,
  parse: (raw, response) => (response.ok ? (parseCommentActivity(raw) ?? undefined) : undefined),
};
/**
 * One shared read per project (the inbox in `useReview` and the project overview ask the same
 * question), kept two seconds. `null` when it cannot be read.
 */
export function readCommentActivity(
  slug: string | null,
  url: string,
  fetchImpl: CommentActivityFetch,
  poll?: PollTag,
): Promise<CommentActivityByTarget | null> {
  return resources
    .read(`comment-activity:${slug ?? ""}`, activityPolicy, { url, fetch: fetchImpl, poll })
    .then((result) => bodyOf(result) ?? null)
    .catch(() => null);
}

/** A `comments` event or a reconnect: the next ask reads again, and a read out now is no answer to it. */
export function invalidateCommentActivity(): void {
  resources.supersede("comment-activity");
}

export async function loadCommentActivity(
  projects: readonly CommentActivityProject[],
  baseUrl: string,
  fetchImpl: CommentActivityFetch,
  signal?: AbortSignal,
): Promise<CommentActivityByProject> {
  const loaded = new Map<string, CommentActivityByTarget>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (!signal?.aborted) {
      const index = next;
      next += 1;
      const project = projects[index];
      if (project === undefined) return;
      let url: string;
      if (project.current) url = "api/comment-activity";
      else {
        try {
          const base = projectResourceBase(baseUrl, project.slug);
          if (base === null) continue;
          url = new URL("api/comment-activity", base).href;
        } catch {
          continue;
        }
      }
      try {
        const activity = await readCommentActivity(project.slug, url, fetchImpl);
        if (activity !== null && !signal?.aborted) loaded.set(project.slug, activity);
      } catch {
        // One project being unavailable must not fabricate zeroes for it or hide other projects.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, projects.length) }, worker));
  return loaded;
}

export function useCommentActivity(
  projects: readonly CommentActivityProject[],
  baseUrl: string,
  fetchImpl: CommentActivityFetch,
  refresh: number,
): CommentActivityByProject {
  const [activity, setActivity] = useState<CommentActivityByProject>(new Map());
  const [focusRefresh, setFocusRefresh] = useState(0);
  const projectKey = useMemo(
    () =>
      projects
        .map((project) => `${project.slug}\0${project.current ? "1" : "0"}\0${project.targetKey ?? ""}`)
        .join("\n"),
    [projects],
  );
  useEffect(() => {
    const focused = (): void => setFocusRefresh((value) => value + 1);
    window.addEventListener("focus", focused);
    return () => window.removeEventListener("focus", focused);
  }, []);
  const asked = useRef({ refresh, focusRefresh });
  useEffect(() => {
    // A comment event or the window's focus asks for fresh activity; a changed target set alone shares the read in flight.
    if (asked.current.refresh !== refresh || asked.current.focusRefresh !== focusRefresh) invalidateCommentActivity();
    asked.current = { refresh, focusRefresh };
    const controller = new AbortController();
    void loadCommentActivity(projects, baseUrl, fetchImpl, controller.signal).then((next) => {
      if (!controller.signal.aborted) setActivity(next);
    });
    return () => controller.abort();
    // `projects` is named by the stable project/target signature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectKey, baseUrl, fetchImpl, refresh, focusRefresh]);
  return activity;
}
