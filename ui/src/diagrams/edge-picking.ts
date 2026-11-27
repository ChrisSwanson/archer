// Which connection a press on the drawing means (O295). Each edge has a 24 px transparent pointer target
// (`react-flow__edge-interaction`), wider than its visible line, so where two lines run close the browser
// gives the press to whichever target is on top, even when the person pressed the other line's visible
// stroke. The press goes instead to: the connection whose visible stroke is under the pointer, then the
// nearest connection, and only then the one on top (the stack order the browser already used).

/** A connection whose target the press landed in, in stack order (topmost first). */
export interface EdgeCandidate {
  readonly id: string;
  /** Screen pixels from the press to the connection's line. */
  readonly distance: number;
  /** Half the visible stroke's width on screen: a press within it is on the line itself. */
  readonly halfStroke: number;
}

/** Distances closer than this count as equal, so the stack order decides. */
const TIE_PX = 0.5;

/** The connection a press means, from the targets it landed in (topmost first); undefined for none. */
export function pickEdge(candidates: readonly EdgeCandidate[]): string | undefined {
  const onStroke = candidates.find((c) => c.distance <= c.halfStroke);
  if (onStroke !== undefined) return onStroke.id;
  let best: EdgeCandidate | undefined;
  for (const c of candidates) if (best === undefined || c.distance < best.distance - TIE_PX) best = c;
  return best?.id;
}

/** Screen distance from (x, y) to the path, sampled along it and refined around the closest sample. */
function distanceToPath(path: SVGPathElement, x: number, y: number): number | undefined {
  const ctm = path.getScreenCTM();
  if (ctm === null) return undefined;
  const local = new DOMPoint(x, y).matrixTransform(ctm.inverse());
  const length = path.getTotalLength();
  const scale = Math.hypot(ctm.a, ctm.b);
  if (!Number.isFinite(length) || length === 0 || scale === 0) return undefined;
  const at = (s: number): number => {
    const p = path.getPointAtLength(s);
    return Math.hypot(p.x - local.x, p.y - local.y);
  };
  let step = Math.max(length / 400, 1);
  let bestAt = 0;
  let best = at(0);
  for (let s = step; s <= length + step / 2; s += step) {
    const d = at(Math.min(s, length));
    if (d < best) [best, bestAt] = [d, Math.min(s, length)];
  }
  while (step > 0.25) {
    step /= 2;
    for (const s of [bestAt - step, bestAt + step]) {
      if (s < 0 || s > length) continue;
      const d = at(s);
      if (d < best) [best, bestAt] = [d, s];
    }
  }
  return best * scale;
}

/**
 * The connection a press at (x, y) on the page means, given the edge React Flow reported. Falls back to the
 * reported edge when the targets cannot be measured.
 */
export function edgeAtPress(reported: string, x: number, y: number, root: ParentNode = document): string {
  if (typeof document.elementsFromPoint !== "function") return reported;
  const candidates: EdgeCandidate[] = [];
  const seen = new Set<string>();
  for (const element of document.elementsFromPoint(x, y)) {
    if (!(element instanceof SVGPathElement) || !element.classList.contains("react-flow__edge-interaction")) continue;
    const edge = element.closest<SVGElement>(".react-flow__edge[data-id]");
    const id = edge?.dataset.id;
    if (edge === null || id === undefined || seen.has(id) || !root.contains(edge)) continue;
    seen.add(id);
    const visible = edge.querySelector<SVGPathElement>("path.react-flow__edge-path");
    const distance = visible === null ? undefined : distanceToPath(visible, x, y);
    if (visible === null || distance === undefined) return reported;
    const ctm = visible.getScreenCTM();
    const width = Number.parseFloat(getComputedStyle(visible).strokeWidth) || 1;
    candidates.push({ id, distance, halfStroke: (width * Math.hypot(ctm?.a ?? 1, ctm?.b ?? 0)) / 2 });
  }
  return pickEdge(candidates) ?? reported;
}
