/**
 * Editing-invariant checks (`ui.edit.*`) and render-storm detection (`ui.render-storm`).
 *
 * Product code calls these only behind `__ARCHER_DEBUG__` (a build-time constant, so a hook call
 * behind it is stable for the life of the bundle), and a production build drops them entirely.
 * Each check waits for the page to settle before it reports, so the frame between a state change
 * and the effect that follows it is never mistaken for a broken invariant.
 */
import { Profiler, useEffect, useRef, type ProfilerOnRenderCallback, type ReactNode, type RefObject } from "react";
import { devReport } from "./dev";

/** `ui.edit.pointer-hand`: an editable canvas left in hand mode that the reader did not choose. */
export function usePointerHandCheck(surface: string, editable: boolean, mode: "select" | "hand", settleMs = 500): void {
  const chosen = useRef(false),
    previous = useRef<{ editable: boolean; mode: string } | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = { editable, mode };
    // Switching to hand while already editing is the reader's choice (the control or its shortcut).
    if (before?.editable && editable && before.mode === "select" && mode === "hand") chosen.current = true;
    if (mode === "select" || !editable) chosen.current = false;
    if (!editable || mode !== "hand" || chosen.current) return;
    const timer = setTimeout(
      () => devReport("ui.edit.pointer-hand", `${surface} is editable but in hand mode`, { surface }),
      settleMs,
    );
    return () => clearTimeout(timer);
  }, [surface, editable, mode, settleMs]);
}

export interface HeldIds {
  readonly [role: string]: string | null | undefined;
}

/**
 * `ui.edit.stale-selection`: a selected or editing id the current layout does not draw.
 * `layoutIds` is null while no layout is shown (nothing to compare). Reported once the layout and the
 * ids have both held still for `settleMs`, once per (role, id, layout).
 */
export function useStaleSelectionCheck(
  surface: string,
  layoutIds: ReadonlySet<string> | null,
  held: HeldIds,
  settleMs = 1000,
): void {
  const reported = useRef(new Set<string>());
  const key = Object.entries(held)
    .map(([role, id]) => `${role}=${id ?? ""}`)
    .join("&");
  useEffect(() => {
    if (layoutIds === null) return;
    const timer = setTimeout(() => {
      for (const [role, id] of Object.entries(held)) {
        if (!id || layoutIds.has(id)) continue;
        const signature = `${role}:${id}:${layoutIds.size}`;
        if (reported.current.has(signature)) continue;
        reported.current.add(signature);
        devReport("ui.edit.stale-selection", `${role} ${id} is not in the current ${surface} layout`, {
          surface,
          role,
          id,
          layoutSize: layoutIds.size,
        });
      }
    }, settleMs);
    return () => clearTimeout(timer);
    // `held` is summarised by `key`.
  }, [surface, layoutIds, key, settleMs]);
}

/** The editor chrome that must never overlap (contract `ui.edit.chrome-overlap`). */
export const CHROME_SELECTORS = [
  ".authoring-tools-row > *",
  ".authoring-parts",
  ".authoring-edit-cluster",
  ".authoring-message-panel",
  ".react-flow__controls",
  ".archer-canvas-controls",
  ".authoring-panel",
] as const;

export interface ChromeBox {
  readonly name: string;
  readonly rect: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
}

/** Pairs whose boxes share more than `tolerancePx` in both directions. */
export function chromeOverlaps(boxes: readonly ChromeBox[], tolerancePx = 1): [ChromeBox, ChromeBox][] {
  const pairs: [ChromeBox, ChromeBox][] = [];
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!.rect,
        b = boxes[j]!.rect;
      const x = Math.min(a.right, b.right) - Math.max(a.left, b.left),
        y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (x > tolerancePx && y > tolerancePx) pairs.push([boxes[i]!, boxes[j]!]);
    }
  return pairs;
}

function describe(element: Element): string {
  const classes = [...element.classList].filter(
    (name) => name.startsWith("authoring-") || name.startsWith("archer-") || name.startsWith("react-flow__"),
  );
  return `${element.tagName.toLowerCase()}${classes.length ? `.${classes.join(".")}` : ""}`;
}

/** Visible chrome under `root`: drawn (non-zero box, not hidden), nested elements left out (a cluster inside the row). */
export function measureChromeBoxes(root: ParentNode): ChromeBox[] {
  const found = new Set<Element>();
  for (const selector of CHROME_SELECTORS) for (const element of root.querySelectorAll(selector)) found.add(element);
  const visible = [...found].filter((element) => {
    if (element.closest(".authoring-panel-collapsed .authoring-panel")) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  });
  return visible
    .filter((element) => !visible.some((other) => other !== element && other.contains(element)))
    .map((element) => {
      const box = element.getBoundingClientRect();
      return { name: describe(element), rect: { left: box.left, top: box.top, right: box.right, bottom: box.bottom } };
    });
}

/**
 * `ui.edit.chrome-overlap`, checked after layout changes (`trigger`) and resizes, at most every
 * `throttleMs`. A pair is reported once until it stops overlapping.
 */
export function useChromeOverlapCheck(root: RefObject<HTMLElement | null>, trigger: unknown, throttleMs = 750): void {
  const reported = useRef(new Set<string>()),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    last = useRef(0);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const check = () => {
      timer.current = null;
      last.current = performance.now();
      const pairs = chromeOverlaps(measureChromeBoxes(element));
      const now = new Set(pairs.map(([a, b]) => `${a.name}|${b.name}`));
      for (const signature of [...reported.current]) if (!now.has(signature)) reported.current.delete(signature);
      for (const [a, b] of pairs) {
        const signature = `${a.name}|${b.name}`;
        if (reported.current.has(signature)) continue;
        reported.current.add(signature);
        devReport("ui.edit.chrome-overlap", `${a.name} overlaps ${b.name}`, {
          a: a.name,
          b: b.name,
          aRect: a.rect,
          bRect: b.rect,
          viewport: { width: window.innerWidth, height: window.innerHeight },
        });
      }
    };
    const schedule = () => {
      if (timer.current !== null) return;
      timer.current = setTimeout(check, Math.max(100, throttleMs - (performance.now() - last.current)));
    };
    schedule();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(element);
    window.addEventListener("resize", schedule);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [root, trigger, throttleMs]);
}

/**
 * `ui.render-storm`: a component made more than `limit` commits that cost `minCommitMs` or more within `windowMs`.
 * A storm is about cost: the cheap commits of a drag, a live preview or an edit's small steps are not counted.
 */
export function renderStormDetector(
  limit = 30,
  windowMs = 1000,
  quietMs = 5000,
  minMs = 30,
  minCommitMs = 1,
): ProfilerOnRenderCallback {
  const commits = new Map<string, { at: number; ms: number }[]>(),
    lastReport = new Map<string, number>();
  return (id, phase, actualDuration, _base, _start, commitTime) => {
    if (actualDuration < minCommitMs) return;
    const times = (commits.get(id) ?? []).filter((c) => commitTime - c.at < windowMs);
    times.push({ at: commitTime, ms: actualDuration });
    // One more than the limit is all a report needs.
    if (times.length > limit + 1) times.splice(0, times.length - (limit + 1));
    commits.set(id, times);
    if (times.length <= limit) return;
    // Pointer-driven sub-millisecond commits (a drag, a live preview) are not a storm: only report work that costs.
    const spent = times.reduce((sum, c) => sum + c.ms, 0);
    if (spent < minMs) return;
    const reportedAt = lastReport.get(id);
    if (reportedAt !== undefined && commitTime - reportedAt < quietMs) return;
    lastReport.set(id, commitTime);
    devReport(
      "ui.render-storm",
      `${id} committed ${times.length} times within ${windowMs} ms (${Math.round(spent)} ms of rendering)`,
      {
        component: id,
        commits: times.length,
        phase,
        lastRenderMs: Math.round(actualDuration * 10) / 10,
        totalMs: Math.round(spent),
      },
    );
  };
}

let onRender: ProfilerOnRenderCallback | null = null;

/** Dev-only `<Profiler>`; call sites render it only behind `__ARCHER_DEBUG__`. */
export function DevProfiler({ id, children }: { id: string; children: ReactNode }): ReactNode {
  onRender ??= renderStormDetector();
  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  );
}
