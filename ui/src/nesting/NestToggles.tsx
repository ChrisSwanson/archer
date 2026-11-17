/**
 * The nested view's "+" and "−" (ADR 0029 §4; approved reference, rule 8).
 *
 * One real button per closed box ("+", top right of the box) and per open frame ("−", top right
 * of its caption band). They live in SCREEN space, over the flow rather than inside its zoomed
 * viewport, so they keep their size and tap area at any zoom: 20 px drawn, a 44 px hit area on a
 * touch screen. A large view fitted until it is too small to read hides them; the canvas's
 * "show all / back" cue is the way back from there, so they never shrink to an untappable speck.
 *
 * Outside React Flow's pane, a press here never pans, selects, drags or edits, in hand mode and
 * in select mode alike. A button is keyed by its container, so the "+" that opens a box is the
 * same element as the "−" that closes its frame: focus stays on it across the press.
 */
import { useStore, useStoreApi } from "@xyflow/react";
import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { LayoutResult } from "../layout/elk-layout";
import { tooSmallToRead } from "../diagrams/viewport-fit";
import { prefetchOrder } from "./nest-page";
import { BOX_RADIUS, FRAME_TOGGLE_RADIUS, togglePosition, toggleRadius } from "./toggle-place";
import "./nesting.css";

/** What the canvas needs from the page to draw and run the controls. */
export type CanvasNesting = {
  /** Open (`true`) or close (`false`) a container, by its group id. */
  readonly onToggle: (groupId: string, open: boolean) => void;
  /**
   * Laying opens out ahead (the page's prefetch): `run` with the closed boxes best first (the "+"
   * pointed at or focused, then emphasised boxes, then nearest the middle of the screen), once the
   * canvas is idle after a layout or a move; `cancel` as soon as the camera moves.
   */
  readonly prefetch?: { run(order: readonly string[]): void; cancel(): void };
  /** Bumped once per press; the canvas animates the layout that arrives after it. */
  readonly pressKey?: number;
};

/** A press, as the canvas keeps it until the new layout arrives: where the toggled box was on screen. */
export type NestAnchor = { readonly groupId: string; readonly screen: { readonly x: number; readonly y: number } };

export { TOGGLE_DRAWN_PX } from "./toggle-place";

type Control = {
  readonly groupId: string;
  /** The drawn element it sits on (a closed box's node id). */
  readonly drawnId: string;
  readonly label: string;
  readonly open: boolean;
  /** The container's box in layout coordinates. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** What is inside, for the announcement after it opens. */
  readonly inside?: string;
};

/** Every control the layout calls for: a "+" per closed box, a "−" per open frame, in reading order. */
export function nestControls(layout: LayoutResult): Control[] {
  const controls: Control[] = [
    ...layout.nodes.flatMap((node): Control[] =>
      node.folded === undefined
        ? []
        : [
            {
              groupId: node.folded.groupId,
              drawnId: node.id,
              label: node.label,
              open: false,
              x: node.x,
              y: node.y,
              width: node.width,
              height: node.height,
              ...(node.folded.caption !== undefined
                ? { inside: node.folded.caption }
                : node.figure?.type === "c4" && node.figure.description !== undefined
                  ? { inside: node.figure.description }
                  : {}),
            },
          ],
    ),
    // A source's frame (Expand, `xf~…`) is not one of the view's containers: it has × and Open of its own.
    ...layout.groups
      .filter((group) => !group.id.startsWith("xf~"))
      .map(
        (group): Control => ({
          groupId: group.id,
          drawnId: group.id,
          label: group.label,
          open: true,
          x: group.x,
          y: group.y,
          width: group.width,
          height: group.height,
        }),
      ),
  ];
  return controls.sort((a, b) => a.y - b.y || a.x - b.x || a.groupId.localeCompare(b.groupId));
}

/** Where a control's drawn mark goes, in layout coordinates' screen projection. */
function placed(
  control: Control,
  transform: readonly [number, number, number],
  corner: number,
): { left: number; top: number } {
  return togglePosition(control, control.open, transform, corner);
}

export function NestToggles(props: {
  readonly layout: LayoutResult;
  readonly nesting: CanvasNesting;
  /** Written on press: where the toggled box sat on screen, for the camera to keep it there. */
  readonly anchor: { current: NestAnchor | null };
  /** Drawn ids the agent's emphasis colours: their opens are laid out ahead first. */
  readonly emphasised?: ReadonlySet<string>;
}): JSX.Element | null {
  const transform = useStore((state) => state.transform);
  const store = useStoreApi();
  const controls = useMemo(() => nestControls(props.layout), [props.layout]);
  // Each closed box's corner radius as drawn (shapes differ: 4, 6, 8 px), read once its box is on the page.
  const corners = useRef(new Map<string, number>());
  useMemo(() => corners.current.clear(), [props.layout]);
  const cornerOf = (drawnId: string): number => {
    const known = corners.current.get(drawnId);
    if (known !== undefined) return known;
    const element = document.querySelector(`.react-flow__node[data-id="${CSS.escape(drawnId)}"]`);
    const radius = element === null ? Number.NaN : parseFloat(getComputedStyle(element).borderTopRightRadius);
    if (!Number.isFinite(radius)) return BOX_RADIUS;
    corners.current.set(drawnId, radius);
    return radius;
  };
  const [said, setSaid] = useState("");
  const pending = useRef<{ groupId: string; open: boolean; inside?: string } | null>(null);

  // Said once the press's layout is on screen, so the words match the picture.
  useEffect(() => {
    const press = pending.current;
    if (press === null) return;
    const now = controls.find((control) => control.groupId === press.groupId);
    if (now === undefined || now.open !== press.open) return;
    pending.current = null;
    setSaid(
      press.open
        ? `Opened ${now.label}${press.inside === undefined ? "" : `: ${press.inside}`}`
        : `Closed ${now.label}`,
    );
  }, [controls]);

  // Prefetch: when the canvas has been still for a moment, best first; any move cancels it.
  const hinted = useRef<string | null>(null);
  const latest = useRef({ layout: props.layout, emphasised: props.emphasised, prefetch: props.nesting.prefetch });
  latest.current = { layout: props.layout, emphasised: props.emphasised, prefetch: props.nesting.prefetch };
  const runPrefetch = useRef(() => {
    const { layout, emphasised, prefetch } = latest.current;
    if (prefetch === undefined) return;
    const {
      width,
      height,
      transform: [tx, ty, zoom],
    } = store.getState();
    const centre = width > 0 && height > 0 ? { x: (width / 2 - tx) / zoom, y: (height / 2 - ty) / zoom } : undefined;
    const order = prefetchOrder(layout, {
      hinted: hinted.current,
      ...(emphasised === undefined ? {} : { emphasised }),
      ...(centre === undefined ? {} : { centre }),
    });
    if (order.length > 0) prefetch.run(order);
  }).current;
  useEffect(() => {
    latest.current.prefetch?.cancel();
    const idle =
      typeof requestIdleCallback === "function"
        ? { id: requestIdleCallback(runPrefetch, { timeout: 1500 }), clear: (id: number) => cancelIdleCallback(id) }
        : { id: setTimeout(runPrefetch, 300) as unknown as number, clear: (id: number) => clearTimeout(id) };
    return () => idle.clear(idle.id);
  }, [props.layout, transform, runPrefetch]);
  const hint = (groupId: string): void => {
    if (hinted.current === groupId) return;
    hinted.current = groupId;
    runPrefetch();
  };

  const hidden = tooSmallToRead(transform[2]);
  return (
    <div className="archer-nest-toggles">
      {hidden
        ? null
        : controls.map((control) => {
            const corner = control.open ? BOX_RADIUS : cornerOf(control.drawnId);
            const at = placed(control, transform, corner);
            const name = `${control.open ? "Close" : "Open"} ${control.label}`;
            return (
              <button
                key={control.groupId}
                type="button"
                className={`archer-nest-toggle nopan nodrag nowheel${control.open ? " archer-nest-toggle-open" : ""}`}
                style={{ left: at.left, top: at.top }}
                aria-label={name}
                aria-expanded={control.open}
                title={name}
                data-nest-toggle={control.groupId}
                onPointerEnter={control.open ? undefined : () => hint(control.groupId)}
                onFocus={control.open ? undefined : () => hint(control.groupId)}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  const [tx, ty, zoom] = store.getState().transform;
                  props.anchor.current = {
                    groupId: control.groupId,
                    screen: { x: control.x * zoom + tx, y: control.y * zoom + ty },
                  };
                  pending.current = {
                    groupId: control.groupId,
                    open: !control.open,
                    ...(control.inside === undefined ? {} : { inside: control.inside }),
                  };
                  props.nesting.onToggle(control.groupId, !control.open);
                }}
              >
                <svg className="archer-nest-toggle-mark" width="20" height="20" aria-hidden="true">
                  <rect
                    width="20"
                    height="20"
                    rx={control.open ? FRAME_TOGGLE_RADIUS : toggleRadius(transform[2], corner)}
                  />
                  <path d={control.open ? "M6 10h8" : "M6 10h8M10 6v8"} />
                </svg>
              </button>
            );
          })}
      <span className="archer-visually-hidden" role="status" aria-live="polite">
        {said}
      </span>
    </div>
  );
}
