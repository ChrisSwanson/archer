/**
 * Adding and removing a source frame beside an element (ADR 0036 §13, A12): a transition of its own
 * that reuses grow in place's axis maps and router instead of laying the canvas out again.
 *
 * `growPlan` opens a closed box into its own frame, so a frame beside an element is made by giving it a
 * box to open: a small seed box goes in the free space beside the element (the flow side first, then
 * across, then the other two, stepping past frames already there) and is grown open into the frame. Only
 * new wires are routed. Removing is the inverse: the frame closes in place into its seed and the seed is
 * dropped. When no side has room or a step throws, the canvas is laid out by the production fallback,
 * seeded ELK (`semi-free`), and the step says so: every fallback is counted, never hidden (A12).
 *
 * Realm-agnostic: ELK comes in as `kernel`. In the page it runs in the layout worker beside the nested
 * view's engine (`frames-protocol.ts`); grow records live in a WeakMap keyed by the layout object, so the
 * engine keeps the layouts it made and removes from those.
 */
import type { ProjectedView } from "../diagrams/projection";
import { computeLayout, type LayoutEngine, type LayoutNode, type LayoutResult } from "../layout/elk-layout";
import type { TypefaceId } from "../layout/text-measure";
import { closeInPlace, growInPlaceV2Staged, type GrowV2Dependencies, type Laid } from "../nesting/grow-in-place-v2";
import { boxes, seededEngine } from "../nesting/seeded-layout";
import { combinedView, frameAnchor, frameGroupId, frameKey, type Frame } from "./frame-view";

export type FrameHow = "grow" | "close" | "fallback";
export type FrameStep = { readonly how: FrameHow; readonly frame: string; readonly why?: string; readonly ms: number };

const SEED = 24;
const CLEAR = 24;
type Rect = { x: number; y: number; width: number; height: number };
const overlaps = (a: Rect, b: Rect, by = 0): boolean =>
  a.x < b.x + b.width + by && b.x < a.x + a.width + by && a.y < b.y + b.height + by && b.y < a.y + a.height + by;
const contains = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

/** Where the seed goes beside `anchor`: the first free place, the flow side first; undefined when none. */
export function seedPlace(layout: LayoutResult, anchor: Rect, ancestors: readonly Rect[]): Rect | undefined {
  const lr = layout.direction === "lr" || layout.direction === "rl";
  const sides = lr ? ["right", "bottom", "left", "top"] : ["bottom", "right", "top", "left"];
  const others: Rect[] = [...layout.nodes, ...layout.groups.filter((g) => !ancestors.includes(g))].filter(
    (r) => r !== anchor,
  );
  for (const side of sides) {
    for (let k = 0; k < 12; k++) {
      const along = (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * (SEED + CLEAR);
      const at: Rect =
        side === "right"
          ? {
              x: anchor.x + anchor.width + CLEAR,
              y: anchor.y + anchor.height / 2 - SEED / 2 + along,
              width: SEED,
              height: SEED,
            }
          : side === "left"
            ? {
                x: anchor.x - CLEAR - SEED,
                y: anchor.y + anchor.height / 2 - SEED / 2 + along,
                width: SEED,
                height: SEED,
              }
            : side === "bottom"
              ? {
                  x: anchor.x + anchor.width / 2 - SEED / 2 + along,
                  y: anchor.y + anchor.height + CLEAR,
                  width: SEED,
                  height: SEED,
                }
              : {
                  x: anchor.x + anchor.width / 2 - SEED / 2 + along,
                  y: anchor.y - CLEAR - SEED,
                  width: SEED,
                  height: SEED,
                };
      if (others.some((o) => overlaps(o, at, 8))) continue;
      if (ancestors.some((a) => !contains(a, at))) continue;
      return at;
    }
  }
  return undefined;
}

function ancestorsOf(layout: LayoutResult, groupId: string | undefined): Rect[] {
  const out: Rect[] = [];
  const seen = new Set<string>();
  for (let id = groupId; id !== undefined && !seen.has(id); ) {
    seen.add(id);
    const g = layout.groups.find((x) => x.id === id);
    if (g === undefined) break;
    out.push(g);
    id = g.parentId;
  }
  return out;
}

export type FrameEngineDependencies = { readonly kernel: LayoutEngine };

/** What one request laid out: the canvas, and every step taken to reach it from what was cached. */
export type FramesAnswer = { readonly layout: LayoutResult; readonly steps: readonly FrameStep[] };

/** The base a request grows: its view and layout as the page drew them, under a key the page gives. */
export type FrameBase = {
  readonly key: string;
  readonly view: ProjectedView;
  readonly layout: LayoutResult;
  readonly typeface: TypefaceId;
};

type Session = {
  readonly base: FrameBase;
  readonly laid: Map<string, LayoutResult>;
  readonly frames: Map<string, Frame>;
};

const BASES = 4;
const KEPT = 48;

export class FrameEngine {
  readonly #deps: FrameEngineDependencies;
  /** Per base key: layouts by frames key ("" is the base). Newest last. */
  readonly #bases = new Map<string, Session>();

  constructor(deps: FrameEngineDependencies) {
    this.#deps = deps;
  }

  /**
   * `frames` on `base`. Reached from the longest cached prefix by adding the rest in order, or from a
   * cached superset by removing what is gone (latest first); else replayed from the base.
   */
  async layout(base: FrameBase, frames: readonly Frame[]): Promise<FramesAnswer> {
    const session = this.#session(base);
    const keys = frames.map(frameKey);
    const key = (list: readonly string[]): string => list.join("\u0001");
    const hit = session.laid.get(key(keys));
    if (hit !== undefined) return { layout: this.#touch(session, key(keys), hit), steps: [] };
    for (const f of frames) session.frames.set(frameKey(f), f);
    const steps: FrameStep[] = [];
    // A cached superset (the canvas before a remove): remove what is gone, newest first.
    for (const [cached, layout] of [...session.laid].reverse()) {
      const list = cached === "" ? [] : cached.split("\u0001");
      if (list.length <= keys.length || !isSubsequence(keys, list)) continue;
      const known = list.map((k) => frameOf(k, frames, session));
      if (known.some((f) => f === undefined)) continue;
      let now = known as Frame[];
      let laid = layout;
      for (let i = list.length - 1; i >= 0; i--) {
        if (keys.includes(list[i]!)) continue;
        const gone = now.find((f) => frameKey(f) === list[i]);
        if (gone === undefined) break;
        const step = await this.#remove(session.base, now, laid, gone);
        steps.push(step.step);
        now = now.filter((f) => f !== gone);
        laid = step.layout;
        session.laid.set(key(now.map(frameKey)), laid);
      }
      if (key(now.map(frameKey)) === key(keys)) return { layout: this.#trim(session, laid), steps };
      break;
    }
    // The longest cached prefix, then each frame added in order.
    let at = keys.length;
    while (at > 0 && !session.laid.has(key(keys.slice(0, at)))) at--;
    let laid = at === 0 ? session.base.layout : session.laid.get(key(keys.slice(0, at)))!;
    for (let i = at; i < frames.length; i++) {
      const step = await this.#place(session.base, frames.slice(0, i), laid, frames[i]!);
      steps.push(step.step);
      laid = step.layout;
      session.laid.set(key(keys.slice(0, i + 1)), laid);
    }
    return { layout: this.#trim(session, laid), steps };
  }

  #session(base: FrameBase): Session {
    let session = this.#bases.get(base.key);
    if (session !== undefined) {
      this.#bases.delete(base.key);
      this.#bases.set(base.key, session);
      return session;
    }
    // The base is the empty set's layout: removing every frame returns the identical picture.
    session = { base, laid: new Map([["", base.layout]]), frames: new Map() };
    this.#bases.set(base.key, session);
    while (this.#bases.size > BASES) this.#bases.delete(this.#bases.keys().next().value!);
    return session;
  }

  #touch(session: Session, key: string, layout: LayoutResult): LayoutResult {
    session.laid.delete(key);
    session.laid.set(key, layout);
    return layout;
  }

  #trim(session: Session, layout: LayoutResult): LayoutResult {
    for (const k of [...session.laid.keys()]) {
      if (session.laid.size <= KEPT) break;
      if (k !== "") session.laid.delete(k);
    }
    if (session.frames.size > KEPT * 2)
      for (const k of [...session.frames.keys()].slice(0, session.frames.size - KEPT)) session.frames.delete(k);
    return layout;
  }

  #grow(base: FrameBase): GrowV2Dependencies {
    return { layout: (view) => computeLayout(view, base.typeface, this.#deps.kernel), layoutKey: base.typeface };
  }

  async #fallback(
    base: FrameBase,
    after: ProjectedView,
    prior: Laid,
    frame: string,
    why: string,
    started: number,
  ): Promise<{ layout: LayoutResult; step: FrameStep }> {
    const layout = await computeLayout(
      after,
      base.typeface,
      seededEngine("semi-free", boxes(prior.layout, prior.view), after, this.#deps.kernel),
    );
    return { layout, step: { how: "fallback", frame, why: why.slice(0, 200), ms: now() - started } };
  }

  async #place(
    base: FrameBase,
    frames: readonly Frame[],
    current: LayoutResult,
    added: Frame,
  ): Promise<{ layout: LayoutResult; step: FrameStep }> {
    const started = now();
    const id = frameGroupId(added);
    const before = combinedView(base.view, frames);
    const after = combinedView(base.view, [...frames, added]).view;
    const prior: Laid = { view: before.view, layout: current };
    const anchorId = before.drawn.get(frameAnchor(added));
    const plain = anchorId?.startsWith("group:") === true ? anchorId.slice("group:".length) : anchorId;
    const node = current.nodes.find((n) => n.id === plain);
    const group = node === undefined ? current.groups.find((g) => g.id === plain) : undefined;
    const anchor = node ?? group;
    if (anchor === undefined)
      return this.#fallback(base, after, prior, id, `'${frameAnchor(added)}' is not a box on the canvas`, started);
    // The frame's own parent, as the combined view names it: never inside another source's frame.
    const groupId = after.groups.find((g) => g.id === id)?.parentId;
    const at = seedPlace(current, anchor, ancestorsOf(current, groupId));
    if (at === undefined) return this.#fallback(base, after, prior, id, "no free side beside the element", started);
    const seedId = `group:${id}`;
    const seed: LayoutNode = {
      id: seedId,
      ...at,
      label: "",
      shape: undefined,
      classes: [],
      groupId,
      folded: { groupId: id, element: false },
    };
    const from: Laid = {
      view: {
        ...before.view,
        nodes: [
          ...before.view.nodes,
          { id: seedId, label: "", shape: undefined, classes: [], groupId, folded: { groupId: id, element: false } },
        ],
      },
      layout: { ...current, nodes: [...current.nodes, seed] },
    };
    try {
      const staged = await growInPlaceV2Staged(from, after, id, this.#grow(base));
      return { layout: staged.complete(), step: { how: "grow", frame: id, ms: now() - started } };
    } catch (error) {
      return this.#fallback(base, after, prior, id, `grow refused: ${(error as Error).message}`, started);
    }
  }

  async #remove(
    base: FrameBase,
    frames: readonly Frame[],
    current: LayoutResult,
    removed: Frame,
  ): Promise<{ layout: LayoutResult; step: FrameStep }> {
    const started = now();
    const id = frameGroupId(removed);
    const rest = frames.filter((f) => f !== removed);
    const open: Laid = { view: combinedView(base.view, frames).view, layout: current };
    const after = combinedView(base.view, rest).view;
    const parentId = current.groups.find((g) => g.id === id)?.parentId;
    const seedId = `group:${id}`;
    const closed: ProjectedView = {
      ...after,
      nodes: [
        ...after.nodes,
        {
          id: seedId,
          label: removed.title,
          shape: undefined,
          classes: [],
          groupId: parentId,
          folded: { groupId: id, element: false },
        },
      ],
    };
    try {
      const layout = await closeInPlace(open, closed, id, this.#grow(base));
      const pruned: LayoutResult = {
        ...layout,
        nodes: layout.nodes.filter((n) => n.id !== seedId),
        edges: layout.edges.filter((e) => e.source !== seedId && e.target !== seedId),
      };
      return { layout: pruned, step: { how: "close", frame: id, ms: now() - started } };
    } catch (error) {
      return this.#fallback(base, after, open, id, `close refused: ${(error as Error).message}`, started);
    }
  }
}

const now = (): number => (typeof performance === "undefined" ? Date.now() : performance.now());

/** Whether `part` is `whole` with some entries taken out, order kept. */
function isSubsequence(part: readonly string[], whole: readonly string[]): boolean {
  let i = 0;
  for (const k of whole) if (k === part[i]) i++;
  return i === part.length;
}

/** The frame a cached key names: one of the request's, or one the session was sent before. */
function frameOf(key: string, frames: readonly Frame[], session: Session): Frame | undefined {
  return frames.find((f) => frameKey(f) === key) ?? session.frames.get(key);
}

/** Pairs of boxes in both layouts whose left/right or above/below order changed (A12: none on the grow path). */
export function orderChanges(before: LayoutResult, after: LayoutResult): number {
  const a = new Map(before.nodes.map((n) => [n.id, n]));
  const shared = after.nodes.filter((n) => a.has(n.id));
  const cx = (r: Rect) => r.x + r.width / 2,
    cy = (r: Rect) => r.y + r.height / 2;
  let changed = 0;
  for (let i = 0; i < shared.length; i++)
    for (let j = i + 1; j < shared.length; j++) {
      const p = shared[i]!,
        q = shared[j]!,
        p0 = a.get(p.id)!,
        q0 = a.get(q.id)!;
      const sx = Math.sign(cx(p0) - cx(q0)),
        sy = Math.sign(cy(p0) - cy(q0));
      if ((sx !== 0 && Math.sign(cx(p) - cx(q)) !== sx) || (sy !== 0 && Math.sign(cy(p) - cy(q)) !== sy)) changed++;
    }
  return changed;
}

/** Boxes and frames that overlap where neither contains the other: zero is a clean layout. */
export function overlapsIn(layout: LayoutResult): number {
  const groupOf = new Map(layout.nodes.map((n) => [n.id, n.groupId]));
  const parents = new Map(layout.groups.map((g) => [g.id, g.parentId]));
  const under = (group: string | undefined, frame: string): boolean => {
    for (let g = group, k = 0; g !== undefined && k < 64; g = parents.get(g), k++) if (g === frame) return true;
    return false;
  };
  let n = 0;
  const nodes = layout.nodes;
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++) if (overlaps(nodes[i]!, nodes[j]!)) n++;
  for (const g of layout.groups)
    for (const node of nodes) if (overlaps(g, node) && !under(groupOf.get(node.id), g.id) && !contains(node, g)) n++;
  return n;
}
