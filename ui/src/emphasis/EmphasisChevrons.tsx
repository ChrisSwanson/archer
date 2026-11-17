/**
 * Moving arrows: what makes `flow` say which way the data goes (ADR 0030).
 *
 * A coloured line is a set. Small chevrons travelling along it are a DIRECTION
 * and a PACE, which is the claim `flow` exists to make. They are drawn in the
 * edge's hue (`currentColor`, which the edge's slot class sets), so the agent's
 * group reaches a class and never a colour value -- and nothing else is drawn:
 * no glow, no halo.
 *
 * A two-way line carries a second set running the other way. Under reduced
 * motion the chevrons are drawn still, at a quarter and three quarters of the
 * route (one each way on a two-way line), moved along the route off the
 * caption's plate. They are never removed: they are the claim that this edge
 * is part of a flow, not just its animation.
 */
import type { JSX } from "react";
import { EMPHASIS_SPEED_PX_PER_SECOND, type EmphasisSpeed } from "./contract";
import { useReducedMotion } from "./reduced-motion";

export type ChevronPoint = { readonly x: number; readonly y: number };
/** A box a parked chevron must not sit under: an edge's caption plate. */
export type ChevronObstacle = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type EmphasisChevronsProps = {
  /** The edge whose routed polyline the chevrons travel, and its `<path>` id. */
  readonly edgeId: string;
  /** The `id` of the `<path>` to travel, where that is not the edge's own id. */
  readonly pathId?: string;
  readonly speed: EmphasisSpeed;
  /** Place in the group's travel order, and the length of that order. */
  readonly hop: number;
  readonly hops: number;
  /** The routed polyline, used to place still chevrons and to time moving ones. */
  readonly route: readonly ChevronPoint[];
  /** Arrowheads at both ends: the chevrons run both ways. */
  readonly twoWay?: boolean;
  /** The edge's caption, which a still chevron must not sit under. */
  readonly avoid?: ChevronObstacle;
  /** The stretch of the route its chevrons travel (`ownStretch`); absent, all of it. */
  readonly stretch?: { readonly from: number; readonly to: number };
};

/** One chevron, pointing along +x, its tip at the origin's right. */
export const CHEVRON_PATH = "M-4,-4.5 L1.5,0 L-4,4.5";
/** How far a chevron reaches from its centre. */
export const CHEVRON_REACH = 6;
/** A route longer than this carries three chevrons each way rather than two. */
const LONG_ROUTE = 160;
/** Never faster round than this, so a short hop does not flicker. */
const MIN_SECONDS = 1.2;

export function routeLength(route: readonly ChevronPoint[]): number {
  return route
    .slice(1)
    .reduce((total, point, index) => total + Math.hypot(point.x - route[index]!.x, point.y - route[index]!.y), 0);
}

/** The point `distance` along a polyline from its start, and the direction it runs there in degrees. */
export function pointAlong(
  route: readonly ChevronPoint[],
  distance: number,
): ChevronPoint & { readonly angle: number } {
  let travelled = 0;
  for (let i = 1; i < route.length; i += 1) {
    const from = route[i - 1]!;
    const to = route[i]!;
    const span = Math.hypot(to.x - from.x, to.y - from.y);
    if (travelled + span >= distance && span > 0) {
      const along = (distance - travelled) / span;
      return {
        x: from.x + (to.x - from.x) * along,
        y: from.y + (to.y - from.y) * along,
        angle: (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI,
      };
    }
    travelled += span;
  }
  const last = route[route.length - 1] ?? { x: 0, y: 0 };
  const before = route[route.length - 2] ?? last;
  return { ...last, angle: (Math.atan2(last.y - before.y, last.x - before.x) * 180) / Math.PI };
}

const PARK_STEP = 2;
/**
 * How far from a bend a still chevron keeps: the canvas rounds each corner
 * (`roundedRoute`), so a chevron parked on the raw polyline's corner would sit
 * off the drawn curve and point the wrong way.
 */
const CORNER_CLEARANCE = 12;

/** Distances along the route of its interior bends. */
function bends(route: readonly ChevronPoint[]): number[] {
  const at: number[] = [];
  let travelled = 0;
  for (let i = 1; i < route.length - 1; i += 1) {
    travelled += Math.hypot(route[i]!.x - route[i - 1]!.x, route[i]!.y - route[i - 1]!.y);
    at.push(travelled);
  }
  return at;
}

/**
 * Where a still chevron sits: `fraction` of the way along the route, unless
 * the caption is there, in which case the nearest point along the route
 * where the whole chevron is clear of the plate. A route wholly under its
 * caption has nowhere clear, and keeps the asked-for point.
 */
export function parkedAt(
  route: readonly ChevronPoint[],
  fraction: number,
  avoid: ChevronObstacle | undefined,
): ChevronPoint & { readonly angle: number } {
  const length = routeLength(route);
  const corners = bends(route);
  const offCorner = (at: number): boolean => corners.every((corner) => Math.abs(corner - at) >= CORNER_CLEARANCE);
  const clear = (at: number): boolean => {
    if (!offCorner(at)) return false;
    if (avoid === undefined) return true;
    const point = pointAlong(route, at);
    return (
      point.x + CHEVRON_REACH <= avoid.x ||
      point.x - CHEVRON_REACH >= avoid.x + avoid.width ||
      point.y + CHEVRON_REACH <= avoid.y ||
      point.y - CHEVRON_REACH >= avoid.y + avoid.height
    );
  };
  const wanted = length * fraction;
  if (route.length < 2 || clear(wanted)) return pointAlong(route, wanted);
  for (let away = PARK_STEP; away <= length; away += PARK_STEP) {
    // Toward its own end first: a chevron at a quarter moves back, one at three quarters on.
    const order = fraction < 0.5 ? [-away, away] : [away, -away];
    for (const delta of order) {
      const at = wanted + delta;
      if (at < 0 || at > length) continue;
      if (clear(at)) return pointAlong(route, at);
    }
  }
  return pointAlong(route, wanted);
}

/** How finely a route is walked when finding what of it another route already draws, and how near counts as on it. */
const SHARED_STEP = 2;
const SHARED_NEAR = 0.75;

function onRoute(point: ChevronPoint, route: readonly ChevronPoint[]): boolean {
  for (let i = 1; i < route.length; i += 1) {
    const a = route[i - 1]!;
    const b = route[i]!;
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const lengthSq = vx * vx + vy * vy;
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * vx + (point.y - a.y) * vy) / lengthSq));
    if (Math.hypot(point.x - (a.x + vx * t), point.y - (a.y + vy * t)) <= SHARED_NEAR) return true;
  }
  return false;
}

/**
 * The stretch of `route` its own chevrons travel: all of it, less the run from its start and the run into its end
 * that one of `drawn` already covers. Lines that share a trunk (`route-simplify.ts`) draw the trunk once: chevrons
 * from every member on one stem stacked on one another or ran in a jumble of phases (rendered review, 2026-11-13).
 * `drawn` are the routes whose chevrons are already on screen; an empty stretch draws none.
 */
export function ownStretch(
  route: readonly ChevronPoint[],
  drawn: readonly (readonly ChevronPoint[])[],
): { readonly from: number; readonly to: number } {
  const length = routeLength(route);
  if (drawn.length === 0 || route.length < 2) return { from: 0, to: length };
  const covered = (at: number) => drawn.some((other) => onRoute(pointAlong(route, at), other));
  let from = 0;
  while (from <= length && covered(from)) from += SHARED_STEP;
  let to = length;
  while (to >= from && covered(to)) to -= SHARED_STEP;
  return { from: Math.min(from, length), to: Math.max(to, from) };
}

/** The part of a polyline between two distances along it. */
function sliceRoute(route: readonly ChevronPoint[], from: number, to: number): ChevronPoint[] {
  const out: ChevronPoint[] = [];
  const start = pointAlong(route, from);
  out.push({ x: start.x, y: start.y });
  let travelled = 0;
  for (let i = 1; i < route.length; i += 1) {
    travelled += Math.hypot(route[i]!.x - route[i - 1]!.x, route[i]!.y - route[i - 1]!.y);
    if (travelled > from && travelled < to) out.push(route[i]!);
  }
  const end = pointAlong(route, to);
  out.push({ x: end.x, y: end.y });
  return out;
}

/** Seconds for one chevron to travel the whole route at the group's pace. */
export function travelSeconds(route: readonly ChevronPoint[], speed: EmphasisSpeed): number {
  return Math.max(MIN_SECONDS, routeLength(route) / EMPHASIS_SPEED_PX_PER_SECOND[speed]);
}

export function EmphasisChevrons(props: EmphasisChevronsProps): JSX.Element {
  const reducedMotion = useReducedMotion();
  const twoWay = props.twoWay === true;
  const total = routeLength(props.route);
  const stretch = props.stretch;
  const partial = stretch !== undefined && (stretch.from > 0.5 || stretch.to < total - 0.5);
  // A line wholly under another lit line draws no chevrons of its own: the other's are its direction.
  if (partial && stretch.to - stretch.from < 2 * CHEVRON_REACH) {
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: a decorative SVG part with no tabindex, never focusable; biome misreads SVG elements as focusable.
    return <g className="archer-emph-chevrons" data-edge={props.edgeId} aria-hidden="true" />;
  }
  const own = partial ? sliceRoute(props.route, stretch.from, stretch.to) : props.route;

  if (reducedMotion) {
    const still = twoWay
      ? [
          { ...parkedAt(own, 0.25, props.avoid), back: false },
          { ...parkedAt(own, 0.75, props.avoid), back: true },
        ]
      : [0.25, 0.75].map((fraction) => ({ ...parkedAt(own, fraction, props.avoid), back: false }));
    return (
      // biome-ignore lint/a11y/noAriaHiddenOnFocusable: a decorative SVG part with no tabindex, never focusable; biome misreads SVG elements as focusable.
      <g className="archer-emph-chevrons" data-edge={props.edgeId} aria-hidden="true">
        {still.map((at, index) => (
          <path
            // biome-ignore lint/suspicious/noArrayIndexKey: the position is the identity here (fixed-length or ordered parts drawn from one layout), and the items hold no state.
            key={index}
            className="archer-emph-chevron"
            d={CHEVRON_PATH}
            transform={`translate(${at.x} ${at.y}) rotate(${at.angle + (at.back ? 180 : 0)})`}
          />
        ))}
      </g>
    );
  }

  const seconds = travelSeconds(own, props.speed);
  const count = routeLength(own) > LONG_ROUTE ? 3 : 2;
  // Along the drawn path, only over its own stretch: the path is the whole route, so the stretch is a share of it.
  const a = partial ? (stretch.from / total).toFixed(4) : undefined;
  const b = partial ? (stretch.to / total).toFixed(4) : undefined;
  const travel = (back: boolean) =>
    partial
      ? { keyPoints: back ? `${b};${a}` : `${a};${b}`, keyTimes: "0;1", calcMode: "linear" }
      : back
        ? { keyPoints: "1;0", keyTimes: "0;1", calcMode: "linear" }
        : {};
  // Negative `begin` starts each chevron already mid-flight, and a later hop of
  // the same group a little later still, so a multi-hop flow reads as one
  // stream moving through the chain.
  const hopOffset = seconds * (props.hop / Math.max(props.hops, 1));
  const sets = twoWay ? [false, true] : [false];
  return (
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: a decorative SVG part with no tabindex, never focusable; biome misreads SVG elements as focusable.
    <g className="archer-emph-chevrons" data-edge={props.edgeId} aria-hidden="true">
      {sets.flatMap((back) =>
        Array.from({ length: count }, (_, index) => (
          <path
            // biome-ignore lint/suspicious/noArrayIndexKey: the position is the identity here (fixed-length or ordered parts drawn from one layout), and the items hold no state.
            key={`${back ? "back" : "on"}-${index}`}
            className="archer-emph-chevron"
            d={CHEVRON_PATH}
            data-direction={back ? "back" : "on"}
          >
            <animateMotion
              dur={`${seconds.toFixed(2)}s`}
              begin={`${(-(hopOffset + (index * seconds) / count)).toFixed(2)}s`}
              repeatCount="indefinite"
              rotate={back ? "auto-reverse" : "auto"}
              {...travel(back)}
            >
              <mpath href={`#${props.pathId ?? props.edgeId}`} />
            </animateMotion>
          </path>
        )),
      )}
    </g>
  );
}
