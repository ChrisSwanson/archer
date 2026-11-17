import { useEffect, useId, useRef, useState, type FormEvent, type JSX } from "react";
import "./accuracy.css";
import { readComparison, type Comparison, type History } from "./wire";
export type AccuracyOperationCaller = (name: string, args: Readonly<Record<string, unknown>>) => Promise<unknown>;
export interface RevisionCompareProps {
  readonly viewId: string;
  readonly callOperation: AccuracyOperationCaller;
  readonly onClose: () => void;
}
type State =
  | { readonly status: "idle" | "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly result: Comparison; readonly from: string; readonly to: string };
const REASONS: Readonly<Record<string, string>> = {
  git_unavailable: "Git history is unavailable for this project.",
  historical_registry_missing: "This commit has no Archer registry.",
  historical_registry_invalid: "The Archer registry at this commit could not be read.",
  historical_view_unavailable: "This diagram is not registered at this commit.",
  historical_source_missing: "The registered source is missing at this commit.",
  accuracy_path_refused: "This commit includes a source path Archer cannot safely read.",
  accuracy_limit: "This comparison exceeds Archer’s inspection limits. Try a smaller revision range.",
};
function HistoricalStatus({
  label,
  refName,
  history,
}: {
  readonly label: string;
  readonly refName: string;
  readonly history: History;
}): JSX.Element {
  return (
    <div className="accuracy-history">
      <h3>
        {label} <code>{refName}</code>
      </h3>
      {history.commit && <code className="accuracy-commit">{history.commit}</code>}
      {history.path && <p className="accuracy-path">{history.path}</p>}
      {history.status === "unavailable" && (
        <p>{REASONS[history.reason ?? ""] ?? `History unavailable (${history.reason}).`}</p>
      )}
      {history.status === "failed" && (
        <>
          <p>This historical source could not compile.</p>
          <ul>
            {history.result?.diagnostics
              .filter((diagnostic) => diagnostic.severity === "error")
              .map((diagnostic, index) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: a read-only list re-rendered as a whole; its items hold no state.
                  key={index}
                >
                  {diagnostic.message}
                </li>
              ))}
          </ul>
        </>
      )}
    </div>
  );
}
function details(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "Not present";
  } catch {
    return "Details could not be read.";
  }
}
const LABELS = { added: "Added", removed: "Removed", changed: "Changed", moved: "Moved" } as const;
function Changes({ result }: { readonly result: Comparison }): JSX.Element {
  const [limit, setLimit] = useState(50);
  const changes = result.semantic?.changes ?? [];
  return (
    <>
      {result.semantic === null ? (
        <p role="status">Semantic comparison unavailable. Check the historical source status above.</p>
      ) : result.semantic.status === "incompatible" ? (
        <p role="status">These revisions use different diagram models; their semantics cannot be compared.</p>
      ) : (
        <>
          <p role="status">
            {changes.length === 0
              ? result.sourceChanged
                ? "Source changed; diagram semantics are unchanged."
                : "Source and diagram semantics are unchanged."
              : `${changes.length} semantic ${changes.length === 1 ? "change" : "changes"}`}
          </p>
          {changes.length > 0 && (
            <ol className="accuracy-changes">
              {changes.slice(0, limit).map((change, index) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: the list is fixed for its result's lifetime (a new comparison remounts it) and 'show more' only appends; the index disambiguates repeated keys.
                  key={`${change.key}:${index}`}
                >
                  <details>
                    <summary>
                      {LABELS[change.status]} · {change.key}
                    </summary>
                    {(change.beforeIndex !== undefined || change.afterIndex !== undefined) && (
                      <p className="accuracy-order">
                        Event order:{" "}
                        {change.beforeIndex === undefined ? "not present" : `position ${change.beforeIndex + 1}`} to{" "}
                        {change.afterIndex === undefined ? "not present" : `position ${change.afterIndex + 1}`}
                      </p>
                    )}
                    <div className="accuracy-values">
                      <div>
                        <h4>Before</h4>
                        <pre>{details(change.before)}</pre>
                      </div>
                      <div>
                        <h4>After</h4>
                        <pre>{details(change.after)}</pre>
                      </div>
                    </div>
                  </details>
                </li>
              ))}
            </ol>
          )}
          {changes.length > limit && (
            <button type="button" onClick={() => setLimit(limit + 50)}>
              Show next {Math.min(50, changes.length - limit)} changes
            </button>
          )}
        </>
      )}
    </>
  );
}
/** A nonmodal panel. Its owner positions it and controls dismissal. View changes create a fresh request session. */
export function RevisionCompare(props: RevisionCompareProps): JSX.Element {
  return <CompareSession key={props.viewId} {...props} />;
}
function CompareSession({ viewId, callOperation, onClose }: RevisionCompareProps): JSX.Element {
  const heading = useId(),
    fromId = useId(),
    toId = useId();
  const input = useRef<HTMLInputElement>(null),
    generation = useRef(0),
    active = useRef(true);
  const [from, setFrom] = useState("HEAD~1"),
    [to, setTo] = useState("HEAD"),
    [state, setState] = useState<State>({ status: "idle" });
  useEffect(() => {
    active.current = true;
    const previous = document.activeElement;
    input.current?.focus();
    return () => {
      active.current = false;
      generation.current++;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  function edit(value: string, set: (value: string) => void): void {
    generation.current++;
    set(value);
    setState({ status: "idle" });
  }
  async function compare(event: FormEvent): Promise<void> {
    event.preventDefault();
    const stamp = ++generation.current,
      before = from.trim(),
      after = to.trim();
    setState({ status: "loading" });
    try {
      const result = readComparison(await callOperation("compare_diagrams", { viewId, from: before, to: after }));
      if (active.current && stamp === generation.current)
        setState({ status: "ready", result, from: before, to: after });
    } catch (error) {
      if (active.current && stamp === generation.current)
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Comparison failed. Check the commit names and try again.",
        });
    }
  }
  return (
    <section
      className="accuracy-compare"
      aria-labelledby={heading}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="accuracy-header">
        <div>
          <h2 id={heading}>Compare Revisions</h2>
          <p>{viewId}</p>
        </div>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>
      <form
        onSubmit={(event) => {
          void compare(event);
        }}
      >
        <div className="accuracy-refs">
          <label htmlFor={fromId}>
            From commit
            <input
              id={fromId}
              ref={input}
              value={from}
              onChange={(event) => edit(event.target.value, setFrom)}
              maxLength={256}
              required
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label htmlFor={toId}>
            To commit
            <input
              id={toId}
              value={to}
              onChange={(event) => edit(event.target.value, setTo)}
              maxLength={256}
              required
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </div>
        <p className="accuracy-hint">Use Git commit hashes, branches, or tags. HEAD is the latest commit.</p>
        <button type="submit" disabled={!from.trim() || !to.trim()}>
          {state.status === "loading" ? "Compare again" : "Compare"}
        </button>
      </form>
      <div aria-busy={state.status === "loading"} className="accuracy-result">
        {state.status === "idle" && <p>Choose two commits to review source and diagram changes.</p>}
        {state.status === "loading" && <p role="status">Reading committed diagram history…</p>}
        {state.status === "error" && <p role="alert">{state.message}</p>}
        {state.status === "ready" && (
          <>
            <div className="accuracy-histories">
              <HistoricalStatus label="From" refName={state.from} history={state.result.before} />
              <HistoricalStatus label="To" refName={state.to} history={state.result.after} />
            </div>
            {state.result.sourceChanged !== null && (
              <p>Source bytes {state.result.sourceChanged ? "changed" : "unchanged"} between these commits.</p>
            )}
            <Changes key={`${state.from}:${state.to}`} result={state.result} />
          </>
        )}
      </div>
    </section>
  );
}
