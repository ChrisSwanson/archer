/** Source-layout measurements shared by the Node worker and browser. No painter or DOM. */
import { projectEnvelope, type ProjectionResult } from "../diagrams/projection";
import { entryBox, layoutBounds, readingFaces, readingZoom, type Box } from "../diagrams/viewport-fit";
import { messageBox } from "../diagrams/sequence-nav";
import { computeLayout, type LayoutEngine, type LayoutResult } from "./elk-layout";
import { computeSequenceLayout } from "./sequence-layout";
import { computeJourneyLayout } from "./journey-layout";
import { DEFAULT_TYPEFACE } from "./text-measure";
import { NestEngine } from "../nesting/nest-engine";
import { canonicalOpen } from "../nesting/nest-view";
export * from "../../../shared/layout-analysis.mts";
import {
  LAYOUT_ENGINE_VERSION,
  type AnalysisState,
  type AnalysisOptions,
  type GeometryState,
  type DiagramGeometry,
  type AnalysisResult,
} from "../../../shared/layout-analysis.mts";

type Projected = Extract<ProjectionResult, { ok: true }>;
import { AnalysisArgumentsError, frameDiagramGeometry } from "../../../shared/layout-framing.mts";
export { AnalysisArgumentsError, frameDiagramGeometry } from "../../../shared/layout-framing.mts";
function projected(envelope: unknown): Projected {
  const result = projectEnvelope(envelope);
  if (!result.ok)
    throw new AnalysisArgumentsError(`Invalid diagram envelope: ${result.errors.map((e) => e.message).join("; ")}`);
  return result;
}
/** Validate every recipe before running ELK. Unknown/unreachable opens never disappear silently. */
function statesFor(view: Projected, states?: readonly AnalysisState[]): readonly AnalysisState[] {
  if (states === undefined)
    return view.type === "graph" && view.view.groups.length > 0
      ? [{ mode: "full" }, { mode: "nested", open: [] }]
      : [{ mode: "full" }];
  if (!Array.isArray(states) || states.length === 0 || states.length > 8)
    throw new AnalysisArgumentsError("Request between one and eight layout states.");
  return states.map((state) => {
    if (state === null || typeof state !== "object")
      throw new AnalysisArgumentsError("Every layout state needs mode full or nested.");
    if (state.mode === "full") {
      if (Object.keys(state).some((key) => key !== "mode"))
        throw new AnalysisArgumentsError("A full layout state takes only mode.");
      return { mode: "full" };
    }
    if (
      state.mode !== "nested" ||
      !Array.isArray(state.open) ||
      state.open.some((id: unknown) => typeof id !== "string") ||
      Object.keys(state).some((key) => key !== "mode" && key !== "open")
    )
      throw new AnalysisArgumentsError("A nested state needs an open array of group ids.");
    if (view.type !== "graph" || view.view.groups.length === 0)
      throw new AnalysisArgumentsError("This diagram has no nested graph groups to collapse or open.");
    const known = new Set(view.view.groups.map((g) => g.id));
    for (const id of state.open) if (!known.has(id)) throw new AnalysisArgumentsError(`unknown nested group '${id}'.`);
    const open = canonicalOpen(view.view, state.open);
    for (const id of state.open)
      if (!open.includes(id))
        throw new AnalysisArgumentsError(`Nested group '${id}' is unreachable: include its ancestors in open.`);
    return { mode: "nested", open };
  });
}
export function analysisStates(envelope: unknown, states?: readonly AnalysisState[]): readonly AnalysisState[] {
  return statesFor(projected(envelope), states);
}
function graphState(
  layout: LayoutResult,
  state: AnalysisState,
  stateIndex: number,
  includeGroups: boolean,
): GeometryState {
  const bounds = layoutBounds(layout);
  if (bounds === null) throw new Error("empty_diagram: no current drawing to measure");
  return {
    stateIndex,
    mode: state.mode,
    open: state.mode === "nested" ? state.open : null,
    ...(state.mode === "nested" ? { route: "canonical-fresh" as const } : {}),
    bounds,
    entry: entryBox(layout),
    across: layout.nodes.map(boxOf),
    down: layout.nodes.map(boxOf),
    groups: includeGroups ? layout.groups.map((g) => ({ id: g.id, ...boxOf(g) })) : [],
  };
}
function boxOf(box: Box): Box {
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}
/** Only numeric geometry crosses the worker boundary; text uses packaged Fira advances. */
export async function computeDiagramGeometry(
  envelope: unknown,
  options: AnalysisOptions = {},
  engine?: LayoutEngine,
  onState?: (state: GeometryState) => void,
): Promise<DiagramGeometry> {
  const view = projected(envelope),
    recipes = statesFor(view, options.states),
    typeface = options.typeface ?? DEFAULT_TYPEFACE;
  if (typeface !== "fira") throw new AnalysisArgumentsError("Unknown layout typeface; use fira.");
  const states: GeometryState[] = [];
  const push = (state: GeometryState) => {
    states.push(state);
    onState?.(state);
  };
  let kernel = engine;
  const getKernel = async () => {
    if (kernel === undefined) {
      const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
      kernel = new ELK();
    }
    return kernel;
  };
  if (view.type === "graph") {
    for (const [stateIndex, state] of recipes.entries()) {
      const elk = await getKernel();
      let layout: LayoutResult;
      if (state.mode === "full") layout = await computeLayout(view.view, typeface, elk);
      else {
        // Each recipe owns a fresh engine: an earlier requested state cannot seed live history.
        const nest = new NestEngine({ kernel: elk });
        const key = nest.open({ full: view.view, typeface, revision: (envelope as { revision: string }).revision });
        layout = await nest.layout(key, state.open).complete;
      }
      push(graphState(layout, state, stateIndex, options.includeGroups !== false));
    }
    const notation = view.view.notation ?? "flowchart";
    return {
      engineVersion: LAYOUT_ENGINE_VERSION,
      typeface,
      basis: "source-layout",
      readingZoom: readingZoom(notation, typeface),
      smallestTextPx: Math.min(...readingFaces(notation, typeface).map((f) => f.px)),
      states,
      limitations: ["Fresh source layout; live expansion history and private saved positions may differ."],
    };
  }
  if (view.type === "sequence") {
    const layout = computeSequenceLayout(view.view, typeface),
      bounds = { x: layout.originX, y: layout.originY, width: layout.width, height: layout.height };
    for (const [stateIndex] of recipes.entries())
      push({
        stateIndex,
        mode: "full",
        open: null,
        bounds,
        entry: null,
        across: layout.participants.map(boxOf),
        down: layout.messages.map(messageBox),
        groups: options.includeGroups === false ? [] : layout.fragments.map((g) => ({ id: g.id, ...boxOf(g) })),
      });
    return {
      engineVersion: LAYOUT_ENGINE_VERSION,
      typeface,
      basis: "source-layout",
      readingZoom: readingZoom("sequence", typeface),
      smallestTextPx: Math.min(...readingFaces("sequence", typeface).map((f) => f.px)),
      states,
      limitations: ["Fresh source layout; participants count across and messages count down."],
    };
  }
  const layout = computeJourneyLayout(view.view, typeface);
  for (const [stateIndex] of recipes.entries())
    push({
      stateIndex,
      mode: "full",
      open: null,
      bounds: { x: 0, y: 0, width: layout.width, height: layout.height },
      entry: null,
      across: [],
      down: [],
      groups: options.includeGroups === false ? [] : layout.sections.map((s) => ({ id: s.section.id, ...boxOf(s) })),
    });
  return {
    engineVersion: LAYOUT_ENGINE_VERSION,
    typeface,
    basis: "static-export-board",
    readingZoom: null,
    smallestTextPx: null,
    states,
    limitations: [
      "Static export board; the responsive journey page can wrap columns. Camera fit and layout suggestions are unavailable.",
    ],
  };
}
export async function analyzeDiagram(
  envelope: unknown,
  options: AnalysisOptions = {},
  engine?: LayoutEngine,
): Promise<AnalysisResult> {
  return frameDiagramGeometry(await computeDiagramGeometry(envelope, options, engine), options.viewport);
}
