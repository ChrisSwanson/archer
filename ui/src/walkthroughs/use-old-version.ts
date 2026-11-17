/**
 * A walkthrough's old version (ADR 0034 §3, slice 7b): asked for only when the person asks
 * (`GET api/walkthroughs/old?viewId&id`, slice 7a), projected like any envelope, and held while the
 * walkthrough stays chosen. `refused` and `not-in-history` are honest answers, not errors: the page
 * says them and keeps the text.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { browserFetch } from "../app/browser-resource";
import { projectEnvelope } from "../diagrams/projection";
import type { ProjectedView } from "../diagrams/projection";

export type OldAnswer =
  | {
      readonly status: "found";
      readonly id: string;
      readonly committedAt: string;
      readonly commit: string;
      readonly view: ProjectedView;
    }
  | { readonly status: "refused"; readonly id: string }
  | { readonly status: "not-in-history"; readonly id: string }
  /** The ask itself failed (network, a service that does not have the route). */
  | { readonly status: "failed"; readonly id: string };

export type OldVersion = { readonly status: "idle" } | { readonly status: "loading"; readonly id: string } | OldAnswer;

const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** The service's answer, read; anything that does not read is `failed`. A found model this page cannot draw as a graph is `refused`. */
export function parseOldVersion(id: string, payload: unknown): OldAnswer {
  const p = rec(payload);
  if (p === undefined || p.schemaVersion !== 1 || p.id !== id) return { status: "failed", id };
  if (p.status === "not-in-history") return { status: "not-in-history", id };
  if (p.status === "refused") return { status: "refused", id };
  if (p.status !== "found" || typeof p.committedAt !== "string" || typeof p.commit !== "string")
    return { status: "failed", id };
  const projection = projectEnvelope(p.envelope);
  // Walkthroughs are for graph diagrams (ADR 0034 §2); anything else is the old source this page cannot play.
  return projection.ok && projection.type === "graph"
    ? { status: "found", id, committedAt: p.committedAt, commit: p.commit, view: projection.view }
    : { status: "refused", id };
}

export async function readOldVersion(
  viewId: string,
  id: string,
  fetcher: (url: string, init?: RequestInit) => Promise<Response> = browserFetch,
): Promise<OldAnswer> {
  try {
    const answer = await fetcher(
      `api/walkthroughs/old?viewId=${encodeURIComponent(viewId)}&id=${encodeURIComponent(id)}`,
      { cache: "no-store" },
    );
    return answer.ok ? parseOldVersion(id, await answer.json()) : { status: "failed", id };
  } catch {
    return { status: "failed", id };
  }
}

/** The old version of walkthrough `walkId` of `viewId`: idle until `open`, and idle again on `back` or when either changes. */
export function useOldVersion(
  viewId: string | null,
  walkId: string | null,
): { readonly old: OldVersion; readonly open: () => void; readonly back: () => void } {
  // The answer carries the view it was asked for, so one for another walkthrough or diagram is never shown, not even for the render before the reset.
  const [held, setHeld] = useState<{ readonly viewId: string; readonly old: OldVersion } | null>(null);
  const asked = useRef(0);
  const latest = useRef({ viewId, walkId });
  latest.current = { viewId, walkId };
  useEffect(() => {
    asked.current++;
    setHeld(null);
  }, [viewId, walkId]);
  const open = useCallback(() => {
    const { viewId: view, walkId: id } = latest.current;
    if (view === null || id === null) return;
    const ask = ++asked.current;
    setHeld({ viewId: view, old: { status: "loading", id } });
    void readOldVersion(view, id).then((answer) => {
      if (ask === asked.current) setHeld({ viewId: view, old: answer });
    });
  }, []);
  const back = useCallback(() => {
    asked.current++;
    setHeld(null);
  }, []);
  const old =
    held !== null && held.viewId === viewId && held.old.status !== "idle" && held.old.id === walkId ? held.old : IDLE;
  return { old, open, back };
}

const IDLE: OldVersion = { status: "idle" };
