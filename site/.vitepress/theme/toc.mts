/**
 * The right-hand table of contents as progressive disclosure: h2 entries are always listed, and only
 * the section that holds the reader (or the one they open) shows its h3s, and an h3 its h4s.
 * Pure functions so the behaviour is tested without a browser; `ArcherToc.vue` wires them to the page.
 */

export interface TocHeading {
  id: string;
  level: number;
  title: string;
}

export interface TocNode extends TocHeading {
  children: TocNode[];
}

export interface TocState {
  /** The heading the reader is in, by scroll position or the last link they followed. */
  active: string | null;
  /** The chain from the top-level entry down to `active` (empty when nothing is active). */
  trail: string[];
  /** The expanded entries, outermost first: one chain, so opening one section closes its siblings. */
  open: string[];
}

export type TocEvent =
  | { type: "scroll"; id: string | null }
  | { type: "navigate"; id: string }
  | { type: "toggle"; id: string };

/** Nest headings by level within [min, max]; a heading with no parent in range sits at the top. */
export function buildTocTree(headings: readonly TocHeading[], min = 2, max = 4): TocNode[] {
  const roots: TocNode[] = [];
  const stack: TocNode[] = [];
  for (const heading of headings) {
    if (heading.level < min || heading.level > max) continue;
    const node: TocNode = { ...heading, children: [] };
    while (stack.length > 0 && stack[stack.length - 1]!.level >= node.level) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

/** The chain of nodes from a root to `id`, or undefined when `id` is not in the tree. */
export function trailTo(tree: readonly TocNode[], id: string): TocNode[] | undefined {
  for (const node of tree) {
    if (node.id === id) return [node];
    const below = trailTo(node.children, id);
    if (below) return [node, ...below];
  }
  return undefined;
}

export interface ScrollView {
  scrollY: number;
  /** The height of fixed chrome above the reading line (VitePress's nav and local nav). */
  offset: number;
  viewportHeight: number;
  documentHeight: number;
}

/**
 * The heading the reader is in: the last one at or above the reading line. None at the very top;
 * the last heading at the very bottom, since a short final section can never reach the line.
 * The same rule VitePress's own outline uses, so the two never disagree.
 */
export function activeHeadingId(positions: readonly { id: string; top: number }[], view: ScrollView): string | null {
  const placed = positions.filter(({ top }) => !Number.isNaN(top)).sort((a, b) => a.top - b.top);
  if (placed.length === 0 || view.scrollY < 1) return null;
  if (Math.abs(view.scrollY + view.viewportHeight - view.documentHeight) < 1) return placed[placed.length - 1]!.id;
  let active: string | null = null;
  for (const { id, top } of placed) {
    if (top > view.scrollY + view.offset + 4) break;
    active = id;
  }
  return active;
}

export function initialTocState(): TocState {
  return { active: null, trail: [], open: [] };
}

/** Entries to expand so `trail`'s last entry is visible and, if it has children, shows them. */
function openFor(trail: readonly TocNode[]): string[] {
  return trail.filter((node) => node.children.length > 0).map((node) => node.id);
}

export function tocReducer(tree: readonly TocNode[], state: TocState, event: TocEvent): TocState {
  if (event.type === "toggle") {
    const trail = trailTo(tree, event.id);
    if (!trail) return state;
    const at = state.open.indexOf(event.id);
    const open = at >= 0 ? state.open.slice(0, at) : openFor(trail);
    return { ...state, open };
  }
  if (event.id === null) return state.active === null ? state : initialTocState();
  const trail = trailTo(tree, event.id);
  if (!trail) return state;
  // Scrolling within the heading the reader is already in keeps their own toggles; following a
  // link always shows where it led.
  if (event.type === "scroll" && event.id === state.active) return state;
  return { active: event.id, trail: trail.map((node) => node.id), open: openFor(trail) };
}

export function isOpen(state: TocState, id: string): boolean {
  return state.open.includes(id);
}
