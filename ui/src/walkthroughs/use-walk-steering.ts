/**
 * The page's side of agent steering, the address and the reader's position (ADR 0034 §6), around
 * `useWalkthroughs`:
 *
 * - the address (`?walkthrough=<id>&step=<n>`) opens the panel on that step once, when the diagram opens;
 * - an agent presentation that names a walkthrough opens it there ("Presented by the agent"), a later one
 *   moves it, and one that names none closes the panel so its emphasis shows; each presentation is
 *   applied once, so the person's stepping is never undone by the same one heard again;
 * - while the panel is open the address follows it with `replaceState`, and the host is told the step
 *   (`api/walkthrough-position`, once it settles) so `get_presentation_context` can say it.
 */
import { useEffect, useRef, useState } from "react";
import { browserFetch } from "../app/browser-resource";
import type { Walkthroughs } from "./use-walkthroughs";
import { readWalkAddress, writeWalkAddress, type WalkAddress } from "./walk-address";

/** What the agent last presented: which view and presentation, and the walkthrough step it named, if any. */
export type AgentWalk = {
  readonly presentationId: string;
  readonly viewId: string;
  readonly caption?: string;
  /** When this page heard it made; null for one that stood before the page opened (no "just now"). */
  readonly at: number | null;
  readonly walk?: { readonly id: string; readonly step: number };
};

export type Presented = { readonly id: string; readonly caption?: string; readonly at: number | null };

/** The steering in an agent presentation as the service sends it, or null when it is not one. */
export function agentWalkOf(presentation: unknown, at: number | null): AgentWalk | null {
  const p = presentation as {
    presentationId?: unknown;
    viewId?: unknown;
    annotation?: unknown;
    walkthrough?: { id?: unknown; step?: unknown };
  } | null;
  if (typeof p !== "object" || p === null || typeof p.presentationId !== "string" || typeof p.viewId !== "string")
    return null;
  const w = p.walkthrough;
  const walk =
    typeof w === "object" && w !== null && typeof w.id === "string" && Number.isSafeInteger(w.step)
      ? { id: w.id, step: Number(w.step) }
      : undefined;
  return {
    presentationId: p.presentationId,
    viewId: p.viewId,
    at,
    ...(typeof p.annotation === "string" && p.annotation !== "" ? { caption: p.annotation } : {}),
    ...(walk === undefined ? {} : { walk }),
  };
}

/** How long a step rests before the host is told (Play steps every 1.5 s; a scrub is many presses). */
export const READING_SETTLE_MS = 250;

export function useWalkSteering(options: {
  readonly walkthroughs: Walkthroughs;
  readonly viewId: string | null;
  readonly agent: AgentWalk | null;
  /** False while the page is not a reading page (editing in place, an embedded host): nothing is read or written. */
  readonly enabled: boolean;
}): Presented | null {
  const { walkthroughs, viewId, agent, enabled } = options;
  const { walks, ready, state, walk, select, dispatch } = walkthroughs;
  // The address as the page opened: read once, until it has been acted on.
  const pending = useRef<WalkAddress | null | undefined>(undefined);
  if (pending.current === undefined) pending.current = enabled ? readWalkAddress(window.location.search) : null;
  // A link that named a walkthrough is the person's own place: what the agent had standing when it opened does not replace it.
  const linked = useRef(pending.current !== null);
  const linkOpened = useRef(false);
  const applied = useRef<string | null>(null);
  const [presented, setPresented] = useState<Presented | null>(null);
  // Bumped when the address has been looked at and names nothing here, so the address is free to follow the panel.
  const [settled, settle] = useState(0);

  useEffect(() => {
    const want = pending.current;
    if (want === null || want === undefined || !enabled || !ready) return;
    if (walks.some((w) => w.id === want.id)) {
      // Once only: a later read must not put the person back on the linked step.
      if (!linkOpened.current) select(want.id, want.step);
      linkOpened.current = true;
    } else {
      pending.current = null;
      settle((n) => n + 1);
    }
  }, [enabled, ready, walks, select]);

  useEffect(() => {
    if (!enabled || agent === null || applied.current === agent.presentationId || !ready || viewId !== agent.viewId)
      return;
    if (agent.at === null && linked.current) {
      applied.current = agent.presentationId;
      return;
    }
    if (agent.walk === undefined) {
      applied.current = agent.presentationId;
      // A presentation that stood before the page is not news: only one made while it is open takes the panel down.
      if (agent.at !== null && state.open) dispatch({ type: "close" });
      return;
    }
    // Not found yet: the walkthrough may have been written a moment ago; the next read tries again.
    if (!walks.some((w) => w.id === agent.walk!.id)) return;
    applied.current = agent.presentationId;
    // The agent's step is now the place; the link has done its part.
    pending.current = null;
    settle((n) => n + 1);
    select(agent.walk.id, agent.walk.step);
    setPresented({
      id: agent.walk.id,
      ...(agent.caption === undefined ? {} : { caption: agent.caption }),
      at: agent.at,
    });
  }, [enabled, agent, ready, viewId, walks, state.open, select, dispatch]);

  useEffect(() => {
    if (!state.open && presented !== null) setPresented(null);
  }, [state.open, presented]);

  // An archived walkthrough, and its old version, are linked by id alone.
  const at =
    state.open && walk !== null
      ? { id: walk.id, step: state.step, whole: walk.status === "archived" || walk.old === true }
      : null;
  const atId = at?.id ?? null;
  const atStep = at?.step ?? 0;
  const atWhole = at?.whole ?? false;
  useEffect(() => {
    if (!enabled || viewId === null) return;
    const want = pending.current;
    if (want !== null && want !== undefined) {
      // The address is the person's until it has opened what it names.
      if (atId !== want.id) return;
      pending.current = null;
    }
    writeWalkAddress(atId === null ? null : atWhole ? { id: atId } : { id: atId, step: atStep });
  }, [enabled, viewId, atId, atStep, atWhole, settled]);

  // The view a walkthrough was open on in this page, so closing it clears the host's reading. Kept from the
  // moment one is open, not from the first report: the host may hold a position from an earlier page (a
  // reload, a copied link) that this page closes before its own first report settles.
  const openOn = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || viewId === null) return;
    const body =
      atId === null
        ? openOn.current === null
          ? null
          : { viewId: openOn.current, id: null }
        : { viewId, id: atId, step: atStep };
    if (body === null) return;
    if (atId !== null) openOn.current = viewId;
    const timer = setTimeout(() => {
      if (atId === null) openOn.current = null;
      void browserFetch("api/walkthrough-position", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => undefined);
    }, READING_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [enabled, viewId, atId, atStep]);

  return presented !== null && state.open && state.id === presented.id ? presented : null;
}
