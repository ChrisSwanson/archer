import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

/** A box in one coordinate space (client pixels here). */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}
/** Something the panel should not cover, and how much covering it costs per pixel. */
export interface Avoid {
  readonly box: Box;
  readonly weight: number;
}

const overlap = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

/**
 * Where a floating panel stands over the canvas: the corner of `area` that covers the least of what it should not
 * (the canvas controls, the shapes that are drop targets, the selected item itself). Ties keep the order top right,
 * bottom right, top left, bottom left, so an empty canvas always gets the usual top-right panel. A bottom corner over
 * controls (weight 1000: the Source toggle, the zoom cluster) is also tried lifted just above them, so the panel is
 * not pushed onto the drawing's shapes only because a small control sits in the corner.
 */
export function placePanel(
  area: Box,
  size: { width: number; height: number },
  avoid: readonly Avoid[],
  margin = 15,
): { left: number; top: number } {
  const right = area.right - margin - size.width,
    bottom = Math.max(area.top + margin, area.bottom - margin - size.height),
    left = area.left + margin,
    top = area.top + margin;
  const boxAt = (corner: { left: number; top: number }): Box => ({
    left: corner.left,
    top: corner.top,
    right: corner.left + size.width,
    bottom: corner.top + size.height,
  });
  const lifted = (corner: { left: number; top: number }) => {
    const under = avoid.filter((item) => item.weight >= 1000 && overlap(boxAt(corner), item.box) > 0);
    if (!under.length) return [];
    const liftedTop = Math.min(...under.map((item) => item.box.top)) - 8 - size.height;
    return liftedTop >= top ? [{ left: corner.left, top: liftedTop }] : [];
  };
  const corners = [
    { left: right, top },
    { left: right, top: bottom },
    { left, top },
    { left, top: bottom },
    ...lifted({ left: right, top: bottom }),
    ...lifted({ left, top: bottom }),
  ];
  let best = corners[0]!,
    cost = Infinity;
  for (const corner of corners) {
    const box = boxAt(corner);
    const c = avoid.reduce((sum, item) => sum + overlap(box, item.box) * item.weight, 0);
    if (c < cost - 0.5) {
      cost = c;
      best = corner;
    }
  }
  return best;
}

/**
 * The tallest the panel may be at `place` without covering a control (weight ≥ 1000) below its top that it
 * overlaps horizontally: such a control's top less 8px. When no corner is clear (a short canvas: the Source drawer
 * open, the zoom cluster down the left), placePanel takes the least-covering corner, and the panel then stops above
 * the control and scrolls instead of lying over it (macOS's wider system font wrapped the message panel's help onto
 * a third line and laid it 9px over the Source toggle). Infinity when nothing is below.
 */
export function heightClearOfControls(
  place: { left: number; top: number },
  width: number,
  avoid: readonly Avoid[],
): number {
  let limit = Infinity;
  for (const item of avoid) {
    if (item.weight < 1000 || item.box.top <= place.top) continue;
    if (Math.min(place.left + width, item.box.right) - Math.max(place.left, item.box.left) <= 0) continue;
    limit = Math.min(limit, item.box.top - 8 - place.top);
  }
  return limit;
}

const rect = (element: Element): Box | null => {
  const r = element.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r : null;
};
/**
 * What a floating editor panel keeps clear of on the canvas, cheapest last: controls (the Source toggle at the
 * drawing's foot among them), alerts and the diagram key, the selection, shapes. FIXED are page controls outside the
 * canvas that still stand over it (the chat button).
 */
const CONTROLS = ".archer-canvas-controls, .react-flow__controls, .authoring-preview-source",
  CALLOUTS = ".authoring-feedback, .authoring-coach, .archer-diagram-key",
  SHAPES = ".react-flow__node, .archer-seq-participant-box, .archer-seq-note-sheet, g.archer-seq-message",
  FIXED = ".archer-chat-fab";

/** What a panel over `canvas` should not cover, weighted; `selected` names the selected item's own elements. */
export function panelAvoid(canvas: Element, selected: string | null): Avoid[] {
  const avoid: Avoid[] = [];
  const add = (root: ParentNode, selector: string, weight: number) => {
    for (const item of root.querySelectorAll(selector)) {
      const box = rect(item);
      if (box) avoid.push({ box, weight });
    }
  };
  add(canvas, CONTROLS, 1000);
  add(canvas.ownerDocument, FIXED, 1000);
  add(canvas, CALLOUTS, 50);
  if (selected) add(canvas, selected, 20);
  add(canvas, SHAPES, 1);
  return avoid;
}

/**
 * Places the panel (`position:absolute` in its offset parent) over the canvas host each render: inside the host,
 * below its top `inset`, clear of what it would hide. `selected` names the selected item's own elements, kept in view.
 */
export function usePanelPlacement(
  panel: RefObject<HTMLElement | null>,
  host: RefObject<HTMLElement | null>,
  selected: string | null,
): CSSProperties | undefined {
  const [at, setAt] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  useLayoutEffect(() => {
    const element = panel.current,
      canvas = host.current,
      parent = element?.offsetParent;
    if (!element || !canvas || !parent) return;
    const area = rect(canvas),
      own = rect(element),
      origin = parent.getBoundingClientRect();
    if (!area || !own) return;
    const width = own.right - own.left,
      avoid = panelAvoid(canvas, selected);
    const place = placePanel(area, { width, height: own.bottom - own.top }, avoid);
    // A canvas shorter than the panel (the Source drawer open on a small window): the panel scrolls inside the canvas,
    // and stops above a control below it rather than covering it.
    // max-height is the content box's (the panel is content-box): take its padding and border off the room it has.
    const style = getComputedStyle(element),
      frame = ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"].reduce(
        (sum, key) => sum + (Number.parseFloat(style[key as keyof CSSStyleDeclaration] as string) || 0),
        0,
      );
    const next = {
      left: Math.round(place.left - origin.left),
      top: Math.round(place.top - origin.top),
      maxHeight: Math.max(
        160,
        Math.floor(Math.min(area.bottom - area.top - 30, heightClearOfControls(place, width, avoid)) - frame),
      ),
    };
    setAt((previous) =>
      previous &&
      Math.abs(previous.left - next.left) < 2 &&
      Math.abs(previous.top - next.top) < 2 &&
      previous.maxHeight === next.maxHeight
        ? previous
        : next,
    );
  });
  return at ? { left: at.left, top: at.top, right: "auto", maxHeight: at.maxHeight, overflowY: "auto" } : undefined;
}
