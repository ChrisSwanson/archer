import { useEffect, useRef, useState, type JSX } from "react";
import type { AccuracyOperationCaller } from "./RevisionCompare";
import "../export/export-controls.css";
export interface StaleView {
  readonly viewId: string;
  readonly status: "current" | "stale" | "not-covered" | "never-reviewed" | "unavailable";
  readonly covers: readonly string[];
  readonly baselineCommit: string | null;
  readonly changedPaths: readonly {
    readonly path: string;
    readonly status: "added" | "modified" | "deleted";
  }[];
  readonly reason?: string;
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const member = (value: unknown, allowed: readonly string[]): boolean =>
  typeof value === "string" && allowed.includes(value);

export function readStaleView(raw: unknown, viewId: string): StaleView {
  if (
    !object(raw) ||
    !member(raw.status, ["available", "unavailable"]) ||
    !Array.isArray(raw.views) ||
    raw.views.length > 256
  ) {
    throw new Error("Archer returned unreadable accuracy information.");
  }
  const view = raw.views.find((value) => object(value) && value.viewId === viewId);
  if (
    !object(view) ||
    !member(view.status, ["current", "stale", "not-covered", "never-reviewed", "unavailable"]) ||
    !(view.baselineCommit === null || typeof view.baselineCommit === "string") ||
    (view.reason !== undefined && typeof view.reason !== "string") ||
    !Array.isArray(view.covers) ||
    view.covers.length > 4096 ||
    view.covers.some((value) => typeof value !== "string") ||
    !Array.isArray(view.changedPaths) ||
    view.changedPaths.length > 4096 ||
    view.changedPaths.some(
      (value) =>
        !object(value) || typeof value.path !== "string" || !member(value.status, ["added", "modified", "deleted"]),
    )
  ) {
    throw new Error("Archer did not return valid accuracy information for this diagram.");
  }
  return view as unknown as StaleView;
}
const COPY = {
  current: "Covered files match the last diagram commit.",
  stale: "Covered files changed since the last diagram commit.",
  "not-covered": "No code paths are declared for this diagram.",
  "never-reviewed": "This diagram has no committed baseline yet.",
  unavailable: "Git accuracy is unavailable for this diagram.",
} as const;
interface StalenessProps {
  viewId: string;
  callOperation: AccuracyOperationCaller;
  onClose: () => void;
}
export function Staleness(props: StalenessProps): JSX.Element {
  return <StaleSession key={props.viewId} {...props} />;
}
function StaleSession({ viewId, callOperation, onClose }: StalenessProps): JSX.Element {
  const first = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const request = useRef(0);
  const [view, setView] = useState<StaleView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    alive.current = true;
    const before = document.activeElement;
    first.current?.focus();
    return () => {
      alive.current = false;
      request.current++;
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);
  async function refresh(): Promise<void> {
    const mine = ++request.current;
    setBusy(true);
    setError("");
    try {
      const result = readStaleView(await callOperation("list_stale_diagrams", { viewId }), viewId);
      if (alive.current && mine === request.current) setView(result);
    } catch (error) {
      if (alive.current && mine === request.current) {
        setError(error instanceof Error ? error.message : "Accuracy could not be checked.");
      }
    } finally {
      if (alive.current && mine === request.current) setBusy(false);
    }
  }
  return (
    <section
      role="region"
      aria-labelledby="archer-stale-heading"
      className="archer-artifact-panel"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="archer-artifact-header">
        <div>
          <h2 id="archer-stale-heading">Diagram Accuracy</h2>
          <p>{viewId}</p>
        </div>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>
      <p>Check current covered files against the last commit that changed this diagram.</p>
      <button
        type="button"
        className="archer-artifact-primary"
        ref={first}
        disabled={busy}
        onClick={() => {
          void refresh();
        }}
      >
        {busy ? "Checking…" : view === null ? "Check covered files" : "Refresh accuracy"}
      </button>
      {error ? <p role="alert">{error}</p> : null}
      {view ? (
        <div aria-busy={busy}>
          <p role="status">{COPY[view.status]}</p>
          {view.reason ? <p className="archer-artifact-detail">{view.reason}</p> : null}
          {view.baselineCommit ? (
            <p>
              Last diagram commit <code>{view.baselineCommit}</code>
            </p>
          ) : null}
          {view.covers.length > 0 ? (
            <>
              <h3>Covered Paths</h3>
              <ul>
                {view.covers.map((path) => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {view.changedPaths.length > 0 ? (
            <>
              <h3>Changed Files</h3>
              <ul>
                {view.changedPaths.map((path) => (
                  <li key={path.path}>
                    <code>{path.path}</code> · {path.status}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
