/**
 * The nested view's layout engine (ADR 0029; docs/proposals/zoom-layout-lab.md). Every open set's
 * layout is reached from the base (nothing open, laid out by ELK) by grow in place v2 and its
 * compaction, one box at a time, and kept: the first way into an open set wins, so returning to it
 * shows the identical picture. A deep link is reached in one fixed order, so every viewer of a
 * link sees the same picture. The seeded ELK relayout (`seeded-layout.ts`) is only the fallback,
 * for a grow or close that throws or runs past its deadline.
 *
 * Realm-agnostic (no Worker, no DOM): ELK comes in as `kernel`, so the same engine runs in the
 * page's layout worker (`nest-worker.ts`) and in Node or jsdom (`nest-layout.ts`). Growth records
 * live in a WeakMap keyed by the layout object (`grow-in-place-v2.ts`), so the engine keeps the
 * objects it made, in the realm that grows and closes them.
 */
import type { ProjectedView } from "../diagrams/projection";
import { computeLayout, type LayoutEngine, type LayoutPoint, type LayoutResult } from "../layout/elk-layout";
import { nestSessionKey, type NestSessionSpec } from "./nest-key";
import type { TypefaceId } from "../layout/text-measure";
import { closeInPlace, growInPlaceV2Staged, type GrowV2Dependencies, type Laid } from "./grow-in-place-v2";
import { canonicalOpen, nestView } from "./nest-view";
import type { OrthoRequest } from "./ortho-router";
import { boxes, seededEngine } from "./seeded-layout";

export { nestSessionKey, type NestSessionSpec } from "./nest-key";

/** How a layout was reached: kept, promoted from a prefetch, grown, closed, a deep link's chain, the fallback, or the base. */
export type NestHow = "cache" | "prefetch" | "grow" | "close" | "chain" | "fallback" | "base";

export type NestEngineDependencies = {
  /** ELK: the worker's own kernel there, `elk.bundled` in Node and jsdom. */
  readonly kernel: LayoutEngine;
  /** The router grow and close use (`routeOrthogonalJs` unless replaced). */
  readonly route?: (request: OrthoRequest) => Map<string, LayoutPoint[]>;
  /** How long a grow or close may take before the fallback is laid out instead; none when unset. */
  readonly deadlineMs?: number;
};

/** The press that led here: the open set it was made from and the box opened or closed. */
export type NestStepSpec = { readonly from: readonly string[]; readonly toggled: string };

/** `first` has every box in its final place; `complete` adds the wires routed. For anything but a grow they are one promise. */
export type NestWork = {
  readonly first: Promise<LayoutResult>;
  readonly complete: Promise<LayoutResult>;
  readonly how: Promise<NestHow>;
};

const NEST_SESSIONS = 4;
const NEST_OPEN_SETS = 64;
const NEST_PREFETCHED = 32;

class UnknownNestSession extends Error {
  constructor(key: string) {
    super(`unknown session '${key.slice(0, 40)}'`);
    this.name = "UnknownNestSession";
  }
}

type Done = { readonly layout: LayoutResult; readonly how: NestHow };
/** `staged` only for a grow: its first picture, before the routes. `layout` is `done`'s layout. */
type Entry = {
  readonly staged?: Promise<LayoutResult>;
  readonly done: Promise<Done>;
  readonly layout: Promise<LayoutResult>;
  settled?: LayoutResult;
};

function entryOf(done: Promise<Done>, staged?: Promise<LayoutResult>): Entry {
  return { done, layout: done.then((d) => d.layout), ...(staged === undefined ? {} : { staged }) };
}
type Prefetched = { readonly from: LayoutResult; readonly layout: LayoutResult };
type Session = {
  readonly full: ProjectedView;
  readonly typeface: TypefaceId;
  readonly deps: GrowV2Dependencies;
  /** Every open set reached, by `openKey`; the base is "". */
  readonly cache: Map<string, Entry>;
  /** Presses computed ahead, by `openKey(from)` + "\0" + the box. */
  readonly prefetched: Map<string, Prefetched>;
};

const openKey = (open: readonly string[]): string => open.join(",");

/** The one order a deep link is opened in: parents before children (by depth), then by id. */
export function chainOrder(full: ProjectedView, open: readonly string[]): string[] {
  const groups = new Map(full.groups.map((g) => [g.id, g]));
  const depth = new Map<string, number>();
  for (const id of open) {
    let d = 0;
    for (let g = groups.get(id)?.parentId; g !== undefined && d <= full.groups.length; g = groups.get(g)?.parentId) d++;
    depth.set(id, d);
  }
  return [...open].sort((a, b) => depth.get(a)! - depth.get(b)! || (a < b ? -1 : a > b ? 1 : 0));
}

function settledWork(layout: LayoutResult, how: NestHow): NestWork {
  // One promise for both: a reader can tell nothing is staged (`first === complete`).
  const laid = Promise.resolve(layout);
  return { first: laid, complete: laid, how: Promise.resolve(how) };
}

class Deadline extends Error {}

export class NestEngine {
  readonly #deps: NestEngineDependencies;
  readonly #sessions = new Map<string, Session>();
  /** Real requests in flight; queued prefetch work waits for none. */
  #active = 0;
  #idle: (() => void)[] = [];
  /** Bumped by every prefetch list and cancel: a queue whose ticket is old stops. */
  #ticket = 0;
  /** Bumped by `dropPrefetched`: a chunk finishing after it is not kept. */
  #generation = 0;

  constructor(deps: NestEngineDependencies) {
    this.#deps = deps;
  }

  /** The session for `spec`, made on first use; the newest `NEST_SESSIONS` are kept. Returns its key. */
  open(spec: NestSessionSpec): string {
    const key = nestSessionKey(spec);
    const known = this.#sessions.get(key);
    this.#sessions.delete(key);
    if (known !== undefined) this.#sessions.set(key, known);
    else {
      const kernel = this.#deps.kernel;
      const typeface = spec.typeface;
      this.#sessions.set(key, {
        full: spec.full,
        typeface,
        deps: {
          layout: (view) => computeLayout(view, typeface, kernel),
          layoutKey: typeface,
          ...(this.#deps.route === undefined ? {} : { route: this.#deps.route }),
        },
        cache: new Map(),
        prefetched: new Map(),
      });
      while (this.#sessions.size > NEST_SESSIONS) this.#sessions.delete(this.#sessions.keys().next().value!);
    }
    return key;
  }

  has(key: string): boolean {
    return this.#sessions.has(key);
  }

  /** The layout of `target`, reached by `step` when that is one press from a kept open set. Throws `UnknownNestSession`. */
  layout(key: string, target: readonly string[], step?: NestStepSpec): NestWork {
    const session = this.#session(key);
    const open = canonicalOpen(session.full, target);
    const k = openKey(open);
    const hit = this.#hit(session, k);
    if (hit !== undefined) return hit;
    if (step !== undefined) {
      const from = canonicalOpen(session.full, step.from);
      const fk = openKey(from);
      const pk = `${fk}\0${step.toggled}`;
      const ahead = session.prefetched.get(pk);
      const fromEntry = session.cache.get(fk);
      if (ahead !== undefined) {
        session.prefetched.delete(pk);
        if (fromEntry?.settled === ahead.from && openKey(canonicalOpen(session.full, [...from, step.toggled])) === k) {
          this.#keep(session, k, {
            ...entryOf(Promise.resolve({ layout: ahead.layout, how: "prefetch" })),
            settled: ahead.layout,
          });
          return settledWork(ahead.layout, "prefetch");
        }
      }
      if (fromEntry !== undefined) {
        if (!from.includes(step.toggled) && openKey(canonicalOpen(session.full, [...from, step.toggled])) === k)
          return this.#work(this.#grow(session, k, from, fromEntry, step.toggled, "grow"));
        if (
          from.includes(step.toggled) &&
          openKey(
            canonicalOpen(
              session.full,
              from.filter((id) => id !== step.toggled),
            ),
          ) === k
        )
          return this.#work(this.#close(session, k, from, fromEntry, step.toggled));
      }
    }
    return this.#work(this.#chain(session, open));
  }

  /**
   * The fallback layout of `target`, seeded from `seed` (the layout on screen before the press),
   * unless `target` is already kept. For a press another realm gave up on (the worker timed out).
   */
  fallback(key: string, target: readonly string[], seed?: Laid): NestWork {
    const session = this.#session(key);
    const open = canonicalOpen(session.full, target);
    const k = openKey(open);
    const hit = this.#hit(session, k);
    if (hit !== undefined) return hit;
    const done = this.#track(this.#fallback(session, open, seed));
    return this.#work(this.#keep(session, k, entryOf(done)));
  }

  /**
   * Computes the presses `candidates` (closed boxes at `from`, in the caller's priority order)
   * one per chunk, yielding between chunks, and inside one before its routing, so a real request
   * or a cancel goes first. Replaces any
   * queued list. One step ahead only: `from` must be a kept open set. Settles when the list is
   * done or replaced.
   */
  prefetch(key: string, from: readonly string[], candidates: readonly string[]): Promise<void> {
    const ticket = ++this.#ticket;
    const current = () => ticket === this.#ticket;
    return (async () => {
      for (const candidate of candidates) {
        await this.#yield();
        if (!current()) return;
        const session = this.#sessions.get(key);
        if (session === undefined) return;
        const fromOpen = canonicalOpen(session.full, from);
        const fk = openKey(fromOpen);
        const fromEntry = session.cache.get(fk);
        if (fromEntry === undefined) return;
        let before: Laid;
        try {
          before = { view: nestView(session.full, fromOpen).view, layout: (await fromEntry.done).layout };
        } catch {
          return;
        }
        if (!current()) return;
        if (fromOpen.includes(candidate)) continue;
        const target = canonicalOpen(session.full, [...fromOpen, candidate]);
        const tk = openKey(target);
        const pk = `${fk}\0${candidate}`;
        if (!target.includes(candidate) || session.cache.has(tk) || session.prefetched.has(pk)) continue;
        const generation = this.#generation;
        try {
          const staged = await growInPlaceV2Staged(
            before,
            nestView(session.full, target).view,
            candidate,
            session.deps,
          );
          // The routing runs without a break: a press that arrived meanwhile goes first (its
          // message is a task, so let it in), and this chunk carries on once nothing real is in flight.
          await this.#yield();
          if (!current()) return;
          if (generation !== this.#generation || session.cache.has(tk)) continue;
          const layout = staged.complete();
          if (generation !== this.#generation || session.cache.has(tk)) continue;
          session.prefetched.set(pk, { from: before.layout, layout });
          while (session.prefetched.size > NEST_PREFETCHED)
            session.prefetched.delete(session.prefetched.keys().next().value!);
        } catch {
          // A press that cannot grow is not prefetched; pressing it takes the fallback then.
        }
      }
    })();
  }

  /** Drops the queued prefetch list; a chunk in progress may finish and be kept. */
  cancelPrefetch(): void {
    this.#ticket++;
  }

  /** Forgets every prefetched press (the files changed); the kept open sets stay. */
  dropPrefetched(): void {
    this.#generation++;
    for (const session of this.#sessions.values()) session.prefetched.clear();
  }

  #session(key: string): Session {
    const session = this.#sessions.get(key);
    if (session === undefined) throw new UnknownNestSession(key);
    this.#sessions.delete(key);
    this.#sessions.set(key, session);
    return session;
  }

  #hit(session: Session, k: string): NestWork | undefined {
    const entry = session.cache.get(k);
    if (entry === undefined) return undefined;
    session.cache.delete(k);
    session.cache.set(k, entry);
    if (entry.settled !== undefined) return settledWork(entry.settled, "cache");
    return { first: entry.staged ?? entry.layout, complete: entry.layout, how: Promise.resolve("cache") };
  }

  #work(entry: Entry): NestWork {
    const how = entry.done.then((d) => d.how);
    how.catch(() => undefined);
    return { first: entry.staged ?? entry.layout, complete: entry.layout, how };
  }

  /** Kept under `k` at once (so a second request waits for the same work); dropped if it fails. */
  #keep(session: Session, k: string, entry: Entry): Entry {
    session.cache.set(k, entry);
    entry.staged?.catch(() => undefined);
    entry.layout.catch(() => undefined);
    entry.done.then(
      (d) => {
        entry.settled = d.layout;
      },
      () => {
        if (session.cache.get(k) === entry) session.cache.delete(k);
      },
    );
    for (const old of session.cache.keys()) {
      if (session.cache.size <= NEST_OPEN_SETS) break;
      if (old !== "") session.cache.delete(old);
    }
    return entry;
  }

  /** A real request in flight: queued prefetch work waits until none is. */
  #track<T>(work: Promise<T>): Promise<T> {
    this.#active++;
    const end = () => {
      if (--this.#active === 0) for (const wake of this.#idle.splice(0)) wake();
    };
    work.then(end, end);
    return work;
  }

  async #yield(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    while (this.#active > 0) await new Promise<void>((resolve) => this.#idle.push(resolve));
  }

  async #deadline<T>(work: Promise<T>): Promise<T> {
    const ms = this.#deps.deadlineMs;
    if (ms === undefined) return work;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Deadline("grow in place ran past its deadline")), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  #base(session: Session): Entry {
    const known = session.cache.get("");
    if (known !== undefined) return known;
    const done = this.#track(
      session.deps.layout(nestView(session.full, []).view).then((layout): Done => ({ layout, how: "base" })),
    );
    return this.#keep(session, "", entryOf(done));
  }

  /**
   * `open`'s entry, kept or reached from the base in the fixed order, each step kept. The order is
   * worked out once; every prefix of it is a canonical open set (parents come first).
   */
  #chain(session: Session, open: readonly string[]): Entry {
    const known = session.cache.get(openKey(open));
    if (known !== undefined) return known;
    const order = chainOrder(session.full, open);
    // The longest prefix already kept, then a grow per remaining id.
    let at = order.length - 1;
    let entry: Entry | undefined;
    for (; at >= 0; at--) {
      entry = session.cache.get(openKey([...order.slice(0, at)].sort()));
      if (entry !== undefined) break;
    }
    let from = [...order.slice(0, Math.max(at, 0))].sort();
    entry ??= this.#base(session);
    for (let i = Math.max(at, 0); i < order.length; i++) {
      const next = [...order.slice(0, i + 1)].sort();
      entry = this.#grow(session, openKey(next), from, entry, order[i]!, "chain");
      from = next;
    }
    return entry;
  }

  #grow(
    session: Session,
    k: string,
    from: readonly string[],
    fromEntry: Entry,
    opened: string,
    how: "grow" | "chain",
  ): Entry {
    let showFirst!: (layout: LayoutResult) => void;
    let refuseFirst!: (error: unknown) => void;
    const first = new Promise<LayoutResult>((resolve, reject) => {
      showFirst = resolve;
      refuseFirst = reject;
    });
    const open = canonicalOpen(session.full, [...from, opened]);
    const done = this.#track(
      (async (): Promise<Done> => {
        const before: Laid = { view: nestView(session.full, from).view, layout: (await fromEntry.done).layout };
        try {
          const staged = await this.#deadline(
            growInPlaceV2Staged(before, nestView(session.full, open).view, opened, session.deps),
          );
          showFirst(staged.first);
          // A task between the stages, so `first` reaches its reader (the page, from the worker)
          // before the routing, which runs without a break, starts.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          return { layout: staged.complete(), how };
        } catch {
          return this.#fallback(session, open, before);
        }
      })(),
    );
    done.then((d) => showFirst(d.layout), refuseFirst);
    return this.#keep(session, k, entryOf(done, first));
  }

  #close(session: Session, k: string, from: readonly string[], fromEntry: Entry, closing: string): Entry {
    const open = canonicalOpen(
      session.full,
      from.filter((id) => id !== closing),
    );
    const done = this.#track(
      (async (): Promise<Done> => {
        const before: Laid = { view: nestView(session.full, from).view, layout: (await fromEntry.done).layout };
        try {
          return {
            layout: await this.#deadline(
              closeInPlace(before, nestView(session.full, open).view, closing, session.deps),
            ),
            how: "close",
          };
        } catch {
          return this.#fallback(session, open, before);
        }
      })(),
    );
    return this.#keep(session, k, entryOf(done));
  }

  /** Option 1: the whole view by ELK, semi-interactive and model order off, seeded from `before`'s boxes. */
  async #fallback(session: Session, open: readonly string[], before: Laid | undefined): Promise<Done> {
    const view = nestView(session.full, open).view;
    const prior = before === undefined ? undefined : boxes(before.layout, before.view);
    const layout = await computeLayout(
      view,
      session.typeface,
      seededEngine("semi-free", prior, view, this.#deps.kernel),
    );
    return { layout, how: "fallback" };
  }
}
