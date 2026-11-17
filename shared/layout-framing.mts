/** Cheap framing of worker geometry. Never imports projection, nesting or layout engines. */
import { fitPadding, frameViewport, overflowOf, READING_TEXT_PX, withHeading } from "./viewport.mts";
import type {
  Box,
  Padding,
  AnalysisViewport,
  ResolvedAnalysisViewport,
  MeasuredState,
  LayoutSuggestion,
  LayoutNote,
  DiagramGeometry,
  AnalysisResult,
} from "./layout-analysis.mts";
export class AnalysisArgumentsError extends Error {
  readonly code = "invalid_arguments";
}
const rounded = (n: number, digits = 4): number => Number(n.toFixed(digits));
const roundedBox = (box: Box): Box => ({
  x: rounded(box.x),
  y: rounded(box.y),
  width: rounded(box.width),
  height: rounded(box.height),
});
function viewportFor(viewport?: AnalysisViewport): ResolvedAnalysisViewport {
  const canvas = viewport?.canvas ?? { width: 1025, height: 896 };
  if (
    !canvas ||
    !Number.isFinite(canvas.width) ||
    !Number.isFinite(canvas.height) ||
    canvas.width <= 0 ||
    canvas.height <= 0
  )
    throw new AnalysisArgumentsError("Canvas width and height must be positive finite pixels.");
  let padding: Padding = viewport?.padding ?? fitPadding(canvas, viewport?.reserveLegend === true);
  if (
    !padding ||
    [padding.top, padding.right, padding.bottom, padding.left].some((n) => !Number.isFinite(n) || n < 0) ||
    padding.left + padding.right >= canvas.width ||
    padding.top + padding.bottom >= canvas.height
  )
    throw new AnalysisArgumentsError("Canvas padding must leave positive usable room on both axes.");
  if (viewport?.reserveHeading === true) padding = withHeading(padding, "reserved");
  if (padding.top + padding.bottom >= canvas.height)
    throw new AnalysisArgumentsError("Canvas is too short for the requested heading reservation.");
  return {
    canvas: { ...canvas },
    padding: { ...padding },
    basis: viewport?.basis ?? (viewport === undefined ? "desktop-profile" : "explicit"),
    reserveLegend: viewport?.reserveLegend === true,
    reserveHeading: viewport?.reserveHeading === true,
  };
}
function suggestionCode(s: { x: number; y: number; aspect: number }): LayoutSuggestion["code"] | null {
  return s.x > 2 && s.aspect > 2
    ? "layout_wide_at_reading_zoom"
    : s.x > 1.5 && s.y > 1.5
      ? "layout_two_axis_navigation"
      : null;
}
function suggested(
  states: readonly MeasuredState[],
  raw: readonly { x: number; y: number; aspect: number }[],
): readonly LayoutSuggestion[] {
  const trips = raw.map(suggestionCode);
  // Name the opening first when it is also expensive; otherwise call out optional expanded detail.
  let index = states.findIndex((s, i) => s.mode === "nested" && s.open?.length === 0 && trips[i] !== null);
  if (index < 0) index = trips.findIndex((code) => code !== null);
  if (index < 0) return [];
  const state = states[index]!,
    code = trips[index]!;
  const collapsed = states.find((s) => s.mode === "nested" && s.open?.length === 0);
  const subject =
    state.mode === "full"
      ? collapsed !== undefined && trips[states.indexOf(collapsed)] === null
        ? "Expanded detail"
        : "Full view"
      : state.open?.length === 0
        ? "Collapsed overview"
        : "Expanded state";
  let message =
    code === "layout_wide_at_reading_zoom"
      ? `${subject} spans ${state.spanScreens!.x.toFixed(2)} reading screens across; Show all reduces the smallest text to ${state.minimumTextPxAtFit!.toFixed(2)}px.`
      : `${subject} spans ${state.spanScreens!.x.toFixed(2)} × ${state.spanScreens!.y.toFixed(2)} reading screens and needs navigation on both axes.`;
  if (collapsed !== undefined && collapsed !== state)
    message += ` Collapsed overview spans ${collapsed.spanScreens!.x.toFixed(2)} across.`;
  message +=
    " Consider a vertical composition or an overview with linked detail. Preserve the story and IDs; width may be intentional.";
  return [{ code, level: "suggestion", stateIndex: state.stateIndex, message }];
}
/** Viewport math is cheap and independent of the cached layout/recipe. No semantic quality score. */
export function frameDiagramGeometry(geometry: DiagramGeometry, viewport?: AnalysisViewport): AnalysisResult {
  const resolved = viewportFor(viewport),
    roomX = resolved.canvas.width - resolved.padding.left - resolved.padding.right,
    roomY = resolved.canvas.height - resolved.padding.top - resolved.padding.bottom;
  const raw = geometry.states.map((s) => ({
    x: geometry.readingZoom === null ? 0 : (s.bounds.width * geometry.readingZoom.min) / roomX,
    y: geometry.readingZoom === null ? 0 : (s.bounds.height * geometry.readingZoom.min) / roomY,
    aspect: s.bounds.width / Math.max(s.bounds.height, Number.EPSILON),
  }));
  const states: MeasuredState[] = geometry.states.map((state, i) => {
    const base = {
      stateIndex: state.stateIndex,
      mode: state.mode,
      open: state.open,
      ...(state.route === undefined ? {} : { route: state.route }),
      bounds: roundedBox(state.bounds),
      aspectRatio: rounded(raw[i]!.aspect),
      groups: state.groups.map((g) => ({ id: g.id, ...roundedBox(g) })),
    };
    if (geometry.readingZoom === null)
      return {
        ...base,
        spanScreens: null,
        panScreensBeyondFirst: null,
        fitZoom: null,
        minimumTextPxAtFit: null,
        overflowAtAutomaticFrame: null,
      };
    const fit = Math.min(
      roomX / Math.max(1, state.bounds.width),
      roomY / Math.max(1, state.bounds.height),
      geometry.readingZoom.max,
    );
    const frame = frameViewport(state.bounds, resolved.canvas, resolved.padding, geometry.readingZoom, state.entry);
    return {
      ...base,
      spanScreens: { x: rounded(raw[i]!.x), y: rounded(raw[i]!.y) },
      panScreensBeyondFirst: { x: rounded(Math.max(0, raw[i]!.x - 1)), y: rounded(Math.max(0, raw[i]!.y - 1)) },
      fitZoom: rounded(fit, 5),
      minimumTextPxAtFit: rounded((geometry.smallestTextPx ?? 0) * fit),
      overflowAtAutomaticFrame: overflowOf(
        state.bounds,
        { across: state.across, down: state.down },
        frame,
        resolved.canvas,
      ),
    };
  });
  const notes: LayoutNote[] = states.flatMap((state, i) => {
    if (
      state.minimumTextPxAtFit === null ||
      state.minimumTextPxAtFit >= READING_TEXT_PX.min ||
      suggestionCode(raw[i]!) !== null
    )
      return [];
    const subject =
      state.mode === "full" ? "Full view" : state.open?.length === 0 ? "Collapsed overview" : "Expanded state";
    return [
      {
        code: "text_below_reading_floor_at_fit",
        level: "info",
        stateIndex: state.stateIndex,
        message: `${subject}: smallest text at fit is ${state.minimumTextPxAtFit.toFixed(2)}px, below the ${READING_TEXT_PX.min}px reading floor. Zoom in to read the text.`,
      },
    ];
  });
  return {
    engineVersion: geometry.engineVersion,
    typeface: geometry.typeface,
    basis: geometry.basis,
    readingZoom:
      geometry.readingZoom === null
        ? null
        : { min: rounded(geometry.readingZoom.min, 5), max: rounded(geometry.readingZoom.max, 5) },
    viewport: resolved,
    states,
    suggestions: geometry.readingZoom === null ? [] : suggested(states, raw),
    ...(notes.length === 0 ? {} : { notes }),
    limitations: geometry.limitations,
  };
}
