/**
 * The nested view's layouts, for the page (ADR 0029). Every open set is reached by grow in place
 * in the page's layout worker (`nest-worker.ts`), so routing never blocks the page; where there is
 * no Worker (jsdom, Node) the same engine runs in process, with `elk.bundled`.
 *
 * A press the worker refuses or takes too long over (the transport then stops that worker) is laid
 * out by the fallback on a fresh worker, seeded from the layout the page had before the press.
 */
import type { ProjectedView } from "../diagrams/projection";
import type { LayoutResult } from "../layout/elk-layout";
import { backgroundTransport, currentTransport } from "../layout/elk-worker-transport";
import type { TypefaceId } from "../layout/text-measure";
import { currentLocalNestEngine, localNestEngine, resetLocalNestEngine } from "./nest-local";
import { sessionKeyOf } from "./nest-protocol";
import { canonicalOpen, nestView } from "./nest-view";

export type NestSession = { readonly full: ProjectedView; readonly typeface: TypefaceId; readonly revision: string };
export type NestStep = { readonly from: readonly string[]; readonly toggled: string };
export type NestAnswer = { readonly first: Promise<LayoutResult>; readonly complete: Promise<LayoutResult> };

/** Answers the page has received, newest last: a return to an open set is the same object, at once. */
const NEST_ANSWERS_KEPT = 64;
const answers = new Map<string, LayoutResult>();
const asked = new Map<string, NestAnswer>();

const hasWorker = () => typeof Worker !== "undefined";

function answerKey(session: NestSession, open: readonly string[]): string {
  return `${sessionKeyOf(session)}\0${canonicalOpen(session.full, open).join(",")}`;
}

function remember(key: string, layout: LayoutResult): void {
  answers.delete(key);
  answers.set(key, layout);
  while (answers.size > NEST_ANSWERS_KEPT) answers.delete(answers.keys().next().value!);
}

function settled(layout: LayoutResult): NestAnswer {
  return { first: Promise.resolve(layout), complete: Promise.resolve(layout) };
}

function refused(error: unknown): NestAnswer {
  const reason = Promise.reject(error instanceof Error ? error : new Error(String(error)));
  reason.catch(() => undefined);
  return { first: reason, complete: reason };
}

/** In the worker; on refusal, the fallback on a fresh worker seeded from what the page had at `step.from`. */
function viaWorker(session: NestSession, open: readonly string[], step: NestStep | undefined): NestAnswer {
  const work = backgroundTransport().nest.layout(session, open, step);
  const complete = work.complete.catch(() => {
    const seedLayout = step === undefined ? undefined : answers.get(answerKey(session, step.from));
    const seed =
      seedLayout === undefined || step === undefined
        ? undefined
        : { view: nestView(session.full, canonicalOpen(session.full, step.from)).view, layout: seedLayout };
    return backgroundTransport().nest.fallback(session, open, seed).complete;
  });
  return { first: work.first.catch(() => complete), complete };
}

/**
 * The layout of the nested view of `session.full` with `open` open. `step` is the press that led
 * here (from the open set on screen); without one (a deep link) the open set is reached in one
 * fixed order. `first` has every box placed; `complete` adds the routed wires.
 */
export function nestLayout(session: NestSession, open: readonly string[], step?: NestStep): NestAnswer {
  const key = answerKey(session, open);
  const known = answers.get(key);
  if (known !== undefined) {
    remember(key, known);
    return settled(known);
  }
  const waiting = asked.get(key);
  if (waiting !== undefined) return waiting;
  let answer: NestAnswer;
  try {
    if (hasWorker()) answer = viaWorker(session, open, step);
    else {
      const engine = localNestEngine();
      const work = engine.layout(engine.open(session), open, step);
      answer = { first: work.first, complete: work.complete };
    }
  } catch (error) {
    return refused(error);
  }
  asked.set(key, answer);
  answer.first.catch(() => undefined);
  answer.complete.then(
    (layout) => {
      remember(key, layout);
      if (asked.get(key) === answer) asked.delete(key);
    },
    () => {
      if (asked.get(key) === answer) asked.delete(key);
    },
  );
  return answer;
}

type Battery = { readonly charging: boolean; readonly level: number };
let battery: Battery | null | undefined;

/** The reader asked to save data, or the battery is low and not charging. Best effort: unknown means no. */
function sparing(): boolean {
  try {
    const nav = (
      globalThis as { navigator?: { connection?: { saveData?: boolean }; getBattery?: () => Promise<Battery> } }
    ).navigator;
    if (nav?.connection?.saveData === true) return true;
    const media = (globalThis as { matchMedia?: (query: string) => { matches: boolean } }).matchMedia;
    if (typeof media === "function" && media("(prefers-reduced-data: reduce)").matches) return true;
    if (battery === undefined && typeof nav?.getBattery === "function") {
      battery = null;
      // The manager's fields stay current, so one answer is enough.
      nav.getBattery().then(
        (found) => {
          battery = found;
        },
        () => undefined,
      );
    }
    return battery != null && !battery.charging && battery.level <= 0.2;
  } catch {
    return false;
  }
}

/**
 * Lays out ahead the presses `candidates` (closed boxes at `from`, most likely first), one step
 * ahead, in idle time in the worker. Replaces any list queued before. Skipped when the reader
 * asked to save data or the battery is low.
 */
export function prefetchNest(session: NestSession, from: readonly string[], candidates: readonly string[]): void {
  if (candidates.length === 0 || sparing()) return;
  try {
    if (hasWorker()) backgroundTransport().nest.prefetch(session, from, candidates);
    else {
      const engine = localNestEngine();
      void engine.prefetch(engine.open(session), from, candidates);
    }
  } catch {
    // Prefetch is only a head start.
  }
}

/** Drops the queued prefetch list (the reader moved on). */
export function cancelNestPrefetch(): void {
  currentLocalNestEngine()?.cancelPrefetch();
  if (hasWorker()) currentTransport()?.nest.cancelPrefetch();
}

/** Forgets every prefetched press (the files changed); the open sets reached stay. */
export function dropNestPrefetch(): void {
  currentLocalNestEngine()?.dropPrefetched();
  if (hasWorker()) currentTransport()?.nest.dropPrefetched();
}

/** Tests only: forget every answer and the in-process engine. */
export function resetNestLayout(): void {
  answers.clear();
  asked.clear();
  resetLocalNestEngine();
  battery = undefined;
}
