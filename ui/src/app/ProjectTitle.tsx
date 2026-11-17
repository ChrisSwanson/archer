/**
 * The project page's title section: the project's name, its description, one
 * facts line and the Project settings gear; and, when the project has a root
 * README the service admits, a collapsed preview of it.
 *
 * Every fact is optional. The catalog's facts win; counts the catalog does not
 * give are counted from the files the page already has, and a fact neither
 * knows is left out rather than shown as a zero.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type JSX, type Ref } from "react";
import { placeNoteHtml, renderNoteMarkdown } from "../comments/markdown";
import { longDate, shortDate } from "./file-facts";
import type { FileRow } from "./file-index";
import type { ProjectFacts } from "./project-directory";
import "./ProjectTitle.css";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type ProjectTitleProps = {
  readonly name: string;
  readonly description?: string;
  readonly facts?: ProjectFacts;
  /** This project's files, unfiltered: the counts the catalog does not give. */
  readonly rows: readonly FileRow[];
  readonly now: number;
  /** Opens Project settings; the gear is shown only where settings can open (the web page). */
  readonly onOpenSettings?: () => void;
  /** The gear button, for the settings dialog's focus return. */
  readonly settingsButtonRef?: Ref<HTMLButtonElement>;
};

/** What the facts line says, in order; each part only when known. */
export function projectFactParts(
  facts: ProjectFacts | undefined,
  rows: readonly FileRow[],
): {
  readonly diagrams: number;
  readonly notes: number;
  readonly openThreads: number | undefined;
  readonly lastEditedAt: string | undefined;
  readonly projectFolder: string | undefined;
  readonly git: ProjectFacts["git"];
} {
  const diagrams = facts?.diagrams ?? rows.filter((row) => row.kind === "diagram").length;
  const notes = facts?.notes ?? rows.filter((row) => row.kind === "note").length;
  const openThreads =
    facts?.openThreads ??
    (rows.length === 0 ? undefined : rows.reduce((sum, row) => sum + (row.unresolvedThreads ?? row.openThreads), 0));
  const latest = rows.reduce<string | undefined>(
    (best, row) =>
      row.modifiedAt !== undefined && (best === undefined || Date.parse(row.modifiedAt) > Date.parse(best))
        ? row.modifiedAt
        : best,
    undefined,
  );
  return {
    diagrams,
    notes,
    openThreads,
    lastEditedAt: facts?.lastEditedAt ?? latest,
    projectFolder: facts?.projectFolder,
    git: facts?.git,
  };
}

function GearIcon(): JSX.Element {
  // Drawn edge to edge, so it sits at three quarters on the icon scale's padded box (`--icon`).
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <g transform="translate(12 12) scale(0.75) translate(-12 -12)">
        <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path
          d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        />
      </g>
    </svg>
  );
}

function BranchIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <circle cx="4.5" cy="3.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4.5" cy="12.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11.5" cy="5.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.5 5.1v5.8M11.5 7.1c0 2.4-2.6 2.6-5.4 3.9" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

export function ProjectTitle(props: ProjectTitleProps): JSX.Element {
  const headingId = useId();
  const facts = projectFactParts(props.facts, props.rows);
  return (
    <section className="archer-project-title" aria-labelledby={headingId}>
      <div className="archer-project-title-text">
        <h1 id={headingId}>{props.name}</h1>
        {props.description === undefined || props.description === "" ? null : (
          <p className="archer-project-title-description">{props.description}</p>
        )}
        <p className="archer-project-facts" role="group" aria-label="Project facts">
          <span data-fact="diagrams">
            <span className="archer-project-fact-value">{facts.diagrams.toLocaleString()}</span>{" "}
            {facts.diagrams === 1 ? "diagram" : "diagrams"}
          </span>
          <span data-fact="notes">
            <span className="archer-project-fact-value">{facts.notes.toLocaleString()}</span>{" "}
            {facts.notes === 1 ? "note" : "notes"}
          </span>
          {facts.openThreads === undefined ? null : (
            <span data-fact="threads">
              <span className="archer-project-fact-value" data-open={facts.openThreads > 0 ? "true" : undefined}>
                {facts.openThreads.toLocaleString()}
              </span>{" "}
              open {facts.openThreads === 1 ? "thread" : "threads"}
            </span>
          )}
          {facts.projectFolder === undefined ? null : (
            <span data-fact="folder" className="archer-project-fact-code" title="Project folder">
              {facts.projectFolder}
            </span>
          )}
          {facts.git === undefined ? null : (
            <span
              data-fact="git"
              className="archer-project-fact-code"
              title="Branch and commit of the project's Git checkout"
            >
              <BranchIcon />
              {facts.git.branch === undefined ? null : (
                <span className="archer-project-fact-value">{facts.git.branch}</span>
              )}
              <span>{facts.git.commit.slice(0, 7)}</span>
            </span>
          )}
          {facts.lastEditedAt === undefined ? null : (
            <span data-fact="edited">
              <time dateTime={facts.lastEditedAt} title={longDate(facts.lastEditedAt)}>
                edited {shortDate(facts.lastEditedAt, props.now)}
              </time>
            </span>
          )}
        </p>
      </div>
      {props.onOpenSettings === undefined ? null : (
        <button
          type="button"
          ref={props.settingsButtonRef}
          className="archer-project-settings-gear"
          aria-label="Project settings"
          title="Project settings"
          aria-haspopup="dialog"
          onClick={() => props.onOpenSettings?.()}
        >
          <GearIcon />
        </button>
      )}
    </section>
  );
}

type ReadmeState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly markdown: string }
  | { readonly status: "unavailable" };

/** The root README, read from the project's service; the card is left out while it is loading or unreadable. */
export function ProjectReadme(props: {
  readonly path: string;
  readonly resourceBase: string;
  readonly fetchImpl: FetchLike;
}): JSX.Element | null {
  const [state, setState] = useState<ReadmeState>({ status: "loading" });
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const headingId = useId();
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    let url: string;
    try {
      url = new URL(`api/documents/content?${new URLSearchParams({ path: props.path })}`, props.resourceBase).href;
    } catch {
      setState({ status: "unavailable" });
      return;
    }
    void props
      .fetchImpl(url, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`README read failed with HTTP ${response.status}`);
        const value: unknown = await response.json();
        const markdown =
          typeof value === "object" && value !== null ? (value as Record<string, unknown>).markdown : undefined;
        if (typeof markdown !== "string" || markdown.length > 1024 * 1024 || markdown.trim() === "")
          throw new Error("no README text");
        if (!controller.signal.aborted) setState({ status: "ready", markdown });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: "unavailable" });
      });
    return () => controller.abort();
  }, [props.path, props.resourceBase, props.fetchImpl]);
  const markdown = state.status === "ready" ? state.markdown : null;
  // Before paint, so the card never shows (or is found) without its text.
  useLayoutEffect(() => {
    const root = body.current;
    if (root === null || markdown === null) return;
    placeNoteHtml(root, renderNoteMarkdown(markdown, { headingOffset: 2 }));
    return () => root.replaceChildren();
  }, [markdown]);
  if (state.status !== "ready") return null;
  return (
    <section className="archer-project-readme" aria-labelledby={headingId}>
      <h2 id={headingId} className="archer-project-readme-heading">
        README <span aria-hidden="true">·</span> <span className="archer-project-readme-path">{props.path}</span>
      </h2>
      <div
        id={bodyId}
        ref={body}
        className="archer-project-readme-body archer-note-body"
        data-collapsed={open ? undefined : "true"}
      />
      <button
        type="button"
        className="archer-project-readme-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(!open)}
      >
        {open ? "Show less" : "Show full README"}
      </button>
    </section>
  );
}
