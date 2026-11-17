/**
 * What the chat bubble is about, and which thread it continues (ADR 0034 §10). Pure.
 *
 * A diagram is its view, an open walkthrough is that walkthrough on its view, a note is the
 * whole note. The bubble continues the latest thread on that anchor that is not resolved; with
 * none, the next message starts a new conversation.
 */
import { PROJECT_TARGET, type Anchor, type TargetRef, type Thread } from "../comments/contract";
import { lastActivity } from "../comments/state";

/** What the conversation is about: an open walkthrough, its diagram (or the note), or the whole project. */
export type ChatScope = "walkthrough" | "diagram" | "project";
export type ChatTarget = { readonly target: TargetRef; readonly anchor: Anchor };
export type ChatDocument = {
  readonly viewId: string | null;
  readonly notePath?: string | null;
  readonly walk?: { readonly id: string; readonly title: string } | null;
  /** A page with no document (the project, a folder, search): the project's conversation is all there is. */
  readonly projectOnly?: boolean;
};

/**
 * `scope` picks between an open walkthrough, its diagram and the whole project (the project conversation:
 * one per attached project, ADR 0034 §10 as amended); the walkthrough matters only with one open.
 */
export function chatTarget(doc: ChatDocument, scope: ChatScope): ChatTarget | null {
  if (doc.projectOnly === true || scope === "project") return { target: PROJECT_TARGET, anchor: { kind: "project" } };
  if (doc.notePath != null) return { target: `note:${doc.notePath}`, anchor: { kind: "view" } };
  if (doc.viewId === null) return null;
  const target: TargetRef = `view:${doc.viewId}`;
  if (doc.walk != null && scope === "walkthrough")
    return { target, anchor: { kind: "walkthrough", walkthrough: doc.walk.id, label: doc.walk.title } };
  return { target, anchor: { kind: "view" } };
}

const matches = (thread: Anchor, wanted: Anchor): boolean =>
  wanted.kind === "walkthrough"
    ? thread.kind === "walkthrough" && thread.walkthrough === wanted.walkthrough
    : thread.kind === wanted.kind;

export function pickThread(threads: readonly Thread[] | undefined, anchor: Anchor): Thread | undefined {
  let best: Thread | undefined;
  for (const thread of threads ?? []) {
    if (thread.status === "resolved" || !matches(thread.anchor, anchor)) continue;
    if (best === undefined || lastActivity(thread) > lastActivity(best)) best = thread;
  }
  return best;
}
