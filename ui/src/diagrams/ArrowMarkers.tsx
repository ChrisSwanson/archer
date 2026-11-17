/* @jsxRuntime automatic */
/* @jsxImportSource react */
import { terminalStraightLength, type RoutePoint, type RouteEnds } from "./rounded-route";
import type { JSX } from "react";

export const MIN_ARROW_HEAD_SCREEN_PX = 4;
export const MIN_ARROW_SHAFT_PX = 12;
const BASE_MARKER_WIDTH = 34;
const VIEWBOX_WIDTH = 20;
const HEAD_LENGTH = 5;
const PAINTED_DEPTH = HEAD_LENGTH + 0.5; // the symbol's one-unit stroke

/** Grow small heads, but never let one consume its terminal lane or bend. */
export function arrowMarkerWidth(zoom: number, approach: number, leastShaft = MIN_ARROW_SHAFT_PX): number {
  if (!(zoom > 0) || !(approach > 0) || !Number.isFinite(zoom) || !Number.isFinite(approach)) return 0;
  const desired = Math.max(BASE_MARKER_WIDTH, (MIN_ARROW_HEAD_SCREEN_PX * VIEWBOX_WIDTH) / (HEAD_LENGTH * zoom));
  const shaft = Math.min(leastShaft, approach / 2);
  return Math.min(desired, ((approach - shaft) * VIEWBOX_WIDTH) / PAINTED_DEPTH);
}

/** Local, uniquely named SVG definitions; same symbol and colour as XYFlow.
 *  Mirror the source symbol explicitly: the PNG renderer does not support auto-start-reverse.
 *  Defined inside each edge so `--edge-arrow-ink` (an emphasised edge's hue) inherits. */
export function ArrowMarkers(props: {
  readonly id: string;
  readonly start?: number;
  readonly end?: number;
}): JSX.Element {
  return (
    <defs>
      {(["start", "end"] as const).map((at) => {
        const width = props[at];
        return width === undefined || width <= 0 ? null : (
          <marker
            key={at}
            id={`${props.id}-${at}`}
            className="react-flow__arrowhead"
            markerWidth={width}
            markerHeight={width}
            viewBox="-10 -10 20 20"
            markerUnits="userSpaceOnUse"
            orient="auto"
            refX="0"
            refY="0"
          >
            <polyline
              className="arrowclosed"
              strokeLinecap="round"
              strokeLinejoin="round"
              points={at === "start" ? "5,-4 0,0 5,4 5,-4" : "-5,-4 0,0 -5,4 -5,-4"}
              style={{ strokeWidth: 1, stroke: "var(--edge-arrow-ink)", fill: "var(--edge-arrow-ink)" }}
            />
          </marker>
        );
      })}
    </defs>
  );
}

/** Shared terminal-lane sizing: two heads on a short straight route must not meet. */
export function routeArrowWidths(
  route: readonly RoutePoint[],
  ends: RouteEnds,
  zoom: number,
  /** When the line is drawn curved (`curved-route.ts`): the straight run at each end, and the shaft its head keeps. */
  curved?: { readonly straight: { readonly start: number; readonly end: number }; readonly shaft: number },
): { start: number | undefined; end: number | undefined } {
  const routeLength = route
    .slice(1)
    .reduce((length, point, i) => length + Math.hypot(point.x - route[i].x, point.y - route[i].y), 0);
  const widthAt = (at: "start" | "end"): number => {
    let available = curved === undefined ? terminalStraightLength(route, at, ends) : curved.straight[at];
    if (ends.arrowStart && ends.arrowEnd && available >= routeLength - 0.01) available /= 2;
    return arrowMarkerWidth(zoom, available, curved?.shaft);
  };
  return { start: ends.arrowStart ? widthAt("start") : undefined, end: ends.arrowEnd ? widthAt("end") : undefined };
}
