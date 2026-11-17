import type { AnalysisResult, AnalysisOptions, AnalysisState } from "../../../shared/layout-analysis.mts";
import { DESKTOP_PROFILE } from "../../../shared/layout-analysis.mts";
import type { DiagramEnvelope } from "../model/envelope.ts";
import { revisionOf, type Project } from "../project/index.ts";
import { readEmbedded } from "../notes/embedded.ts";
import { findView, inventory, readSource, type ViewEntry, type WireDiagnostic } from "../application/diagrams.ts";
import { toolError } from "../application/errors.ts";
import type { OperationResult } from "../application/index.ts";
import { frameDiagramGeometry } from "../../../shared/layout-framing.mts";
import {
  LayoutInputError,
  type LayoutPool,
  type CompilationInput,
  LAYOUT_ENGINE_VERSION,
  LAYOUT_LIMITS,
} from "./pool.ts";

export type MeasurementReport = Readonly<Record<string, unknown>> & {
  readonly status: "ready" | "partial" | "unavailable";
  readonly complete: boolean;
  readonly states: AnalysisResult["states"];
  readonly suggestions: AnalysisResult["suggestions"];
  readonly notes?: AnalysisResult["notes"];
};
export interface MeasurementSnapshot {
  readonly compilation?: CompilationInput;
  readonly viewId: string;
  readonly sourceRevision: string | null;
  readonly envelope: DiagramEnvelope | null;
  readonly diagnostics: readonly WireDiagnostic[];
  readonly basis: "saved-source" | "candidate-source";
  readonly source?: string;
  readonly reason?: string;
}
export interface LayoutReview extends Readonly<Record<string, unknown>> {
  readonly version: 1;
  readonly status: "ready" | "partial" | "unavailable" | "pending";
  readonly profile: string;
  readonly sourceRevision: string | null;
}
function optionsOf(args: Readonly<Record<string, unknown>>): AnalysisOptions {
  return {
    ...(args.states === undefined ? {} : { states: args.states as readonly AnalysisState[] }),
    ...(args.viewport === undefined ? {} : { viewport: args.viewport as NonNullable<AnalysisOptions["viewport"]> }),
    ...(args.typeface === undefined ? {} : { typeface: args.typeface as "fira" }),
    ...(args.includeGroups === undefined ? {} : { includeGroups: args.includeGroups as boolean }),
  };
}
function metadata(snapshot: MeasurementSnapshot) {
  return {
    version: 1,
    viewId: snapshot.viewId,
    basis: snapshot.basis,
    sourceRevision: snapshot.sourceRevision,
    modelRevision: snapshot.envelope?.revision ?? null,
    engineVersion: LAYOUT_ENGINE_VERSION,
    typeface: "fira",
    presentation: { mode: "source", revision: null },
  };
}
function unavailable(snapshot: MeasurementSnapshot, reason: string): MeasurementReport {
  return {
    ...metadata(snapshot),
    status: "unavailable",
    reason,
    complete: false,
    states: [],
    suggestions: [],
    ...(snapshot.diagnostics.length === 0 ? {} : { diagnostics: snapshot.diagnostics }),
  };
}
export async function measureSnapshot(
  pool: LayoutPool,
  snapshot: MeasurementSnapshot,
  args: Readonly<Record<string, unknown>> = {},
  automatic?: string,
  deadlineMs?: number,
): Promise<MeasurementReport> {
  if ((args.presentation as { mode?: string } | undefined)?.mode === "saved")
    return unavailable(snapshot, "unsupported_presentation");
  if (!snapshot.envelope && !snapshot.compilation) return unavailable(snapshot, snapshot.reason ?? "does_not_compile");
  const options = optionsOf(args);
  try {
    const outcome = await pool.request({
      envelope: snapshot.envelope,
      ...(snapshot.compilation === undefined ? {} : { compilation: snapshot.compilation }),
      ...(options.states === undefined ? {} : { states: options.states }),
      ...(options.typeface === undefined ? {} : { typeface: options.typeface }),
      ...(automatic === undefined ? {} : { automatic }),
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
    });
    if (outcome.compiled)
      snapshot = { ...snapshot, envelope: outcome.compiled.envelope, diagnostics: outcome.compiled.diagnostics };
    if (!outcome.geometry) return unavailable(snapshot, outcome.reason ?? "worker_failed");
    const framed = frameDiagramGeometry(outcome.geometry, options.viewport);
    const states =
      options.includeGroups === false ? framed.states.map((state) => ({ ...state, groups: [] })) : framed.states;
    return {
      ...framed,
      ...metadata(snapshot),
      ...(framed.basis === "static-export-board" ? { basis: "static-export-board", sourceBasis: snapshot.basis } : {}),
      states,
      status: outcome.status,
      complete: outcome.complete,
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      ...(outcome.unmeasuredStates === undefined ? {} : { unmeasuredStates: outcome.unmeasuredStates }),
    };
  } catch (failure) {
    if (failure instanceof LayoutInputError || (failure as { code?: string })?.code === "invalid_arguments")
      throw toolError("invalid_arguments", (failure as Error).message);
    return unavailable(snapshot, "worker_failed");
  }
}
async function snapshotOf(
  project: Project,
  view: ViewEntry,
  source?: string,
  expectedRevision?: unknown,
): Promise<MeasurementSnapshot> {
  const guard = (revision: string | null) => {
    if (expectedRevision !== undefined && revision !== expectedRevision)
      throw toolError(
        "revision_conflict",
        "measure_diagram expectedRevision differs from the captured source. Read the diagram again.",
        { expectedRevision, sourceRevision: revision },
      );
  };
  const basis = source === undefined ? "saved-source" : "candidate-source";
  if (view.registration === "embedded") {
    const read = readEmbedded(project, view.id);
    if (!read)
      return {
        viewId: view.id,
        sourceRevision: null,
        envelope: null,
        diagnostics: [],
        basis,
        reason: "source_unavailable",
      };
    guard(read.sourceRevision);
    const bytes = source ?? read.source;
    return {
      viewId: view.id,
      sourceRevision: source === undefined ? read.sourceRevision : revisionOf(Buffer.from(bytes)),
      envelope: null,
      diagnostics: [],
      compilation: { view, source: bytes, embedded: read },
      basis,
      ...(source === undefined ? {} : { source }),
    };
  }
  const current = readSource(project, view);
  guard("revision" in current ? current.revision : null);
  if (source === undefined && current.status !== "text")
    return {
      viewId: view.id,
      sourceRevision: "revision" in current ? current.revision : null,
      envelope: null,
      diagnostics: [],
      basis,
      reason: "source_unavailable",
    };
  const bytes = source ?? (current as { text: string }).text;
  const revision = revisionOf(Buffer.from(bytes));
  return {
    viewId: view.id,
    sourceRevision: revision,
    envelope: null,
    diagnostics: [],
    compilation: { view, source: bytes },
    basis,
    ...(source === undefined ? {} : { source }),
  };
}
export function measurementText(report: MeasurementReport): string {
  if (report.status === "unavailable")
    return `Layout measurement unavailable: ${String(report.reason)}. No layout advice changes validity or write status.`;
  const lines = report.states.map(
    (s) =>
      `${s.mode === "full" ? "Full" : s.open?.length === 0 ? "Collapsed" : `Nested (${s.open?.join(", ")})`}: ${s.bounds.width.toFixed(2)}×${s.bounds.height.toFixed(2)} px; aspect ${s.aspectRatio.toFixed(4)}${s.spanScreens === null ? "; static export board, camera fit unavailable" : `; ${s.spanScreens.x.toFixed(2)}×${s.spanScreens.y.toFixed(2)} reading screens; smallest text at fit ${s.minimumTextPxAtFit!.toFixed(2)}px`}.`,
  );
  return [
    `Layout measurement ${report.status} for ${String(report.viewId)} (${String(report.sourceRevision)}).`,
    ...lines,
    ...report.suggestions.map((s) => `Layout suggestion (non-blocking): ${s.message}`),
    ...(report.notes ?? []).map((note) => `Layout note: ${note.message}`),
    ...(report.status === "partial" ? ["Some requested states were not measured; inspect unmeasuredStates."] : []),
    ...((report.limitations as readonly string[] | undefined) ?? []).map((limitation) => `Limitation: ${limitation}`),
  ].join("\n");
}
export async function measureOperation(
  project: Project,
  args: Readonly<Record<string, unknown>>,
  pool: LayoutPool,
): Promise<OperationResult> {
  const deadline = Date.now() + LAYOUT_LIMITS.explicitMs;
  if (args.project === true) {
    if (args.viewId !== undefined || args.source !== undefined || args.expectedRevision !== undefined)
      throw toolError(
        "invalid_arguments",
        "measure_diagram project: true takes no viewId, source or expectedRevision. Nothing was measured.",
      );
    const admitted = inventory(project);
    const results: MeasurementReport[] = [];
    for (const view of admitted.views) {
      if (Date.now() >= deadline) {
        results.push(
          unavailable(
            { viewId: view.id, sourceRevision: null, envelope: null, diagnostics: [], basis: "saved-source" },
            "budget_exceeded",
          ),
        );
        continue;
      }
      const snapshot = await snapshotOf(project, view);
      results.push(
        Date.now() >= deadline
          ? unavailable(snapshot, "budget_exceeded")
          : await measureSnapshot(pool, snapshot, args, undefined, deadline - Date.now()),
      );
    }
    const measured = results.filter((r) => r.complete).length;
    const complete = measured === results.length && admitted.problems.length === 0;
    const errors = [
      ...admitted.problems,
      ...results.filter((r) => !r.complete).map((r) => ({ viewId: r.viewId, code: r.reason ?? "partial" })),
    ];
    return {
      text:
        `Measured ${measured}/${results.length} admitted diagrams. ${errors.length} coverage problem(s).` +
        results
          .filter((r) => r.suggestions.length > 0)
          .map((r) => `\n${String(r.viewId)}: ${r.suggestions[0]!.message}`)
          .join("") +
        results
          .flatMap((r) => (r.notes ?? []).map((note) => `\n${String(r.viewId)}: Layout note: ${note.message}`))
          .join(""),
      structured: {
        version: 1,
        status: complete ? "ready" : "partial",
        complete,
        coverage: { total: results.length, measured, unavailable: results.length - measured },
        results,
        errors,
      },
    };
  }
  if (typeof args.viewId !== "string" || args.viewId.length === 0)
    throw toolError("invalid_arguments", "measure_diagram needs viewId or project: true. Nothing was measured.");
  const view = findView(project, args.viewId, "measure_diagram");
  const snapshot = await snapshotOf(project, view, args.source as string | undefined, args.expectedRevision);
  const report =
    Date.now() >= deadline
      ? unavailable(snapshot, "budget_exceeded")
      : await measureSnapshot(pool, snapshot, args, undefined, deadline - Date.now());
  return { text: measurementText(report), structured: report };
}

/** Concise authoring attachment; the explicit operation carries full geometry. */
export async function reviewLayout(
  pool: LayoutPool,
  snapshot: MeasurementSnapshot,
  automatic: string,
  alreadySaid: Set<string>,
  waitForCompletion = false,
): Promise<{ review: LayoutReview; text: string }> {
  const base = {
    version: 1 as const,
    profile: DESKTOP_PROFILE,
    sourceRevision: snapshot.sourceRevision,
    inspect: {
      tool: "measure_diagram",
      arguments: {
        viewId: snapshot.viewId,
        ...(snapshot.basis === "candidate-source" && snapshot.source !== undefined ? { source: snapshot.source } : {}),
      },
    },
  };
  const pending: LayoutReview = { ...base, status: "pending" };
  let timer: NodeJS.Timeout | undefined;
  const measurement = measureSnapshot(pool, snapshot, {}, automatic);
  const report = waitForCompletion
    ? await measurement
    : await Promise.race([
        measurement,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), LAYOUT_LIMITS.authoringMs);
        }),
      ]).finally(() => clearTimeout(timer));
  if (report === null)
    return {
      review: pending,
      text: "\nLayout review pending (non-blocking). Run measure_diagram with the inspect arguments to get the result; it is not delivered automatically.",
    };
  const suggestions = report.suggestions.map((s) => {
    const state = report.states.find((state) => state.stateIndex === s.stateIndex)!;
    return {
      ...s,
      state: { mode: state.mode, ...(state.open === null ? {} : { open: state.open }) },
      spanScreens: state.spanScreens,
    };
  });
  const review: LayoutReview = {
    ...base,
    status: report.status,
    suggestions,
    ...(report.reason === undefined ? {} : { reason: report.reason }),
    ...(report.unmeasuredStates === undefined ? {} : { unmeasuredStates: report.unmeasuredStates }),
  };
  const finding = suggestions[0];
  if (!finding) return { review, text: "" };
  const fingerprint = createFindingFingerprint(snapshot.viewId, finding);
  if (alreadySaid.has(fingerprint)) return { review, text: "" };
  alreadySaid.add(fingerprint);
  if (alreadySaid.size > 256) alreadySaid.delete(alreadySaid.values().next().value!);
  return { review, text: `\nLayout suggestion (non-blocking): ${finding.message}` };
}
function createFindingFingerprint(
  viewId: string,
  finding: { code: string; state: unknown; spanScreens: unknown },
): string {
  return JSON.stringify({
    viewId,
    profile: DESKTOP_PROFILE,
    code: finding.code,
    state: finding.state,
    spanScreens: finding.spanScreens,
  });
}
