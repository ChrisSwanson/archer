import { useEffect, useRef, useState, type JSX } from "react";
import { browserFetch } from "./browser-resource";
import { projectResourceBase } from "./browser-routes";
import { bodyOf, type ResourcePolicy, resources } from "./resources";
import { answeredRevision, sharedNoteDiagram } from "../comments/transport";
import { useSourceEditor } from "../source-editor/lazy";
import { placeDiagnostics, summarize } from "../source-editor/diagnostics";
import "./SourcePanel.css";

export type SourceTarget =
  | { readonly kind: "view"; readonly viewId: string }
  | { readonly kind: "embedded"; readonly address: string };

type Loaded = (
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | {
      readonly status: "ready";
      readonly path: string;
      readonly source: string;
      readonly diagnostics: readonly unknown[];
      readonly modelRevision?: string;
    }
) & { readonly key?: string };

type SourceRead = {
  readonly path: string;
  readonly source: string;
  readonly diagnostics: readonly unknown[];
  readonly modelRevision?: string;
};

/** For tests: forget reads that will never answer. */
export function forgetSourceReads(): void {
  resources.forget();
}
/**
 * A Save made on this page: what was read of any diagram may predate it, and the page does not know the new
 * revision yet (the panel comes back before it does), so the next reader asks the service.
 */
export function forgetDiagramAnswers(): void {
  resources.supersede("notes");
  resources.supersede("view");
}
const sourcePolicy: ResourcePolicy<unknown> = {
  kind: "view",
  freshMs: 2000,
  revision: (answer) => answeredRevision(answer),
  parse: (raw, response) => {
    if (!response.ok) throw new Error(String(response.status));
    return raw;
  },
};
/**
 * One read per answer, shared by every panel and (for a note's diagram) by the header: the page can put the panel
 * back (after Save it remounts it) while the last one's read is still on its way, or just after it answered, and
 * the new panel takes that read when it answered at the revision the page now knows (`resources.ts`).
 */
async function readSource(target: SourceTarget, known: string | undefined): Promise<SourceRead> {
  const project = projectResourceBase(window.location.href) ?? "";
  const answer =
    target.kind === "embedded"
      ? await sharedNoteDiagram(target.address, known, browserFetch)
      : bodyOf(
          await resources.read(`diagram-source:${project}:${target.viewId}`, sourcePolicy, {
            url: `api/diagram-source/${encodeURIComponent(target.viewId)}`,
            fetch: browserFetch,
            revision: known,
          }),
        );
  const body = answer as { path?: unknown; notePath?: unknown; source?: unknown; diagnostics?: unknown };
  if (typeof body?.source !== "string") throw new Error("no source");
  const path = typeof body.path === "string" ? body.path : typeof body.notePath === "string" ? body.notePath : "";
  const modelRevision = answeredRevision(answer);
  return {
    path,
    source: body.source,
    diagnostics: Array.isArray(body.diagnostics) ? body.diagnostics : [],
    ...(modelRevision === undefined ? {} : { modelRevision }),
  };
}

/**
 * A diagram's raw Mermaid on its reading page: shown as written, copyable, and a way into
 * editing it as source. Read-only here; every edit goes through the editor's Save. The text is shown
 * plainly until the source editor has loaded, then with line numbers, colouring, search and the
 * compiler's problems marked, when the read carried them (a note's diagram does; one read, no more).
 */
export function SourcePanel(props: {
  target: SourceTarget;
  version: unknown;
  /**
   * The served model revision `version` stands for, when the page knows it. A read that already
   * answered at this revision (the service names it, `modelRevision`) is not repeated when the page
   * learns of it afterwards: after a Save the panel reads the saved file before the page hears of
   * its new revision (perf #10).
   */
  revision?: string;
  onEditSource?: () => void;
  onClose: () => void;
}): JSX.Element {
  const [held, setLoaded] = useState<Loaded>({ status: "loading" });
  const [copied, setCopied] = useState(false);
  const Editor = useSourceEditor();
  const key = props.target.kind === "view" ? `view:${props.target.viewId}` : `embedded:${props.target.address}`;
  // What was read belongs to the diagram it was read for: another diagram shows "Loading" (and Copy waits) until its own arrives.
  const loaded: Loaded = held.key === key ? held : { status: "loading" };
  const heldRef = useRef(held);
  heldRef.current = held;
  const revision = props.revision;
  const onClose = props.onClose;
  useEffect(() => {
    const close = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input,textarea,select,dialog[open],[aria-modal="true"]')) return;
      onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  // One read at a time per diagram: a version change while it is in flight is checked when it answers, against
  // the revision the page knows by then, instead of asking again at once (the page often learns the revision
  // of a just-saved file while the panel is already reading it).
  const reading = useRef<{ key: string; recheck: boolean } | null>(null);
  const keyRef = useRef(key);
  keyRef.current = key;
  const targetRef = useRef(props.target);
  targetRef.current = props.target;
  const read = useRef<(key: string, target: SourceTarget) => void>(() => {});
  read.current = (readKey, target) => {
    const mine = { key: readKey, recheck: false };
    reading.current = mine;
    const answered = (next: Loaded, modelRevision?: string): void => {
      if (reading.current !== mine) return;
      reading.current = null;
      setLoaded(next);
      const known = revisionRef.current;
      if (mine.recheck && keyRef.current === readKey && !(known !== undefined && modelRevision === known))
        read.current(readKey, target);
    };
    readSource(target, revisionRef.current).then(
      (body) => answered({ status: "ready", ...body, key: readKey }, body.modelRevision),
      () => answered({ status: "error", key: readKey }),
    );
  };
  useEffect(
    () => () => {
      reading.current = null;
    },
    [],
  );
  useEffect(() => {
    const current = heldRef.current;
    // What is held answers this diagram at this revision: any read still in flight (another diagram, a newer
    // revision left behind) must not land over it.
    if (
      current.key === key &&
      current.status === "ready" &&
      revision !== undefined &&
      current.modelRevision === revision
    ) {
      reading.current = null;
      return;
    }
    if (reading.current?.key === key) {
      reading.current.recheck = true;
      return;
    }
    read.current(key, targetRef.current);
    // `revision` is read when `version` changes; it does not ask on its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, props.version]);
  const copy = (): void => {
    if (loaded.status !== "ready") return;
    void navigator.clipboard?.writeText(loaded.source).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      },
      () => setCopied(false),
    );
  };
  const counts =
    loaded.status === "ready" && loaded.diagnostics.length
      ? summarize(placeDiagnostics(loaded.source, loaded.diagnostics))
      : null;
  const problems = counts
    ? [plural(counts.errors, "error"), plural(counts.warnings, "warning")].filter(Boolean).join(", ")
    : "";
  return (
    <section className="archer-source-panel" aria-label="Mermaid Source">
      <header className="archer-source-panel-bar">
        <span className="archer-source-panel-title">
          Mermaid Source
          {loaded.status === "ready" && loaded.path ? (
            <span className="archer-source-panel-path">
              {props.target.kind === "embedded" ? props.target.address : loaded.path}
            </span>
          ) : null}
          {problems ? (
            <span className={`archer-source-panel-problems${counts?.errors ? " has-errors" : ""}`}>{problems}</span>
          ) : null}
        </span>
        <span className="archer-source-panel-actions">
          <button type="button" onClick={copy} disabled={loaded.status !== "ready"} aria-live="polite">
            {copied ? "Copied" : "Copy"}
          </button>
          {props.onEditSource ? (
            <button type="button" onClick={props.onEditSource}>
              Edit source
            </button>
          ) : null}
          <button
            type="button"
            className="archer-source-panel-close"
            aria-label="Close source"
            title="Close source"
            onClick={props.onClose}
          >
            ×
          </button>
        </span>
      </header>
      {loaded.status === "ready" && Editor ? (
        <Editor
          value={loaded.source}
          readOnly
          ariaLabel="Mermaid source text"
          diagnostics={loaded.diagnostics}
          className="archer-source-panel-editor"
        />
      ) : loaded.status === "ready" ? (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container is a Tab stop so a keyboard can scroll it (axe scrollable-region-focusable; UI_UX.md, RS1-02).
        <pre className="archer-source-panel-code" tabIndex={0}>
          <code>{loaded.source}</code>
        </pre>
      ) : (
        <p className="archer-source-panel-note" role="status">
          {loaded.status === "loading" ? "Loading source…" : "The source couldn’t be read."}
        </p>
      )}
    </section>
  );
}

function plural(count: number, noun: string): string {
  return count === 0 ? "" : `${count} ${noun}${count === 1 ? "" : "s"}`;
}
