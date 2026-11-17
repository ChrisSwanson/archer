/**
 * Expand's menu and "Added to This View" (ADR 0036 §11–§13, A13). Loaded on the first
 * menu (`lazy.ts`); the state is `use-expand.tsx`'s, these only draw it and say what was chosen.
 *
 * Comment first, then title rows that navigate once. Details and Additions lives in the diagram
 * panel, with explicit Preview / Add / Open controls. Esc restores context; Tab leaves the menu.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { useDocked } from "../app/stage-dock";
import { CloseGlyph } from "../diagrams/ControlGlyphs";
import { menuKeys } from "../app/menu-keys";
import { descriptionExcerpt, type SourceMetadata, type TypePiece } from "./source-metadata";
import { NARROW_QUERY, useMediaQuery } from "../app/media";
import type { Addition, CopiedLink, MenuState } from "./use-expand";
import type { Frame } from "./frame-view";
import type { Adds, DiagramEntry, Limits, NeighbourEntry } from "./pieces";
import "./ExpandUi.css";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const addsText = (adds: Adds): string =>
  adds.boxes === 0 && adds.wires === 0
    ? "adds nothing new"
    : adds.boxes === 0
      ? `+${plural(adds.wires, "wire")}`
      : `+${plural(adds.boxes, "box", "boxes")}`;
const ARROW: Readonly<Record<string, string>> = { forward: "→", reverse: "←", "two-way": "↔", undirected: "—" };

type Entry = DiagramEntry | NeighbourEntry;

/** Why an entry cannot be added, or null. A source already framed here grows its frame (O7). */
function blocked(entry: Entry, limit: string | null): string | null {
  if (entry.omitted === "own") return "drawn in its own notation: open it";
  if (entry.omitted === "bytes") return "too much for one menu: open it";
  if (entry.omitted === "limit") return limit ?? "over the limit for one view";
  if (entry.piece === null) return "nothing to add here";
  if (entry.adds.boxes === 0 && entry.adds.wires === 0) return "adds nothing new";
  return limit;
}

type NavigationProps = {
  readonly menu: MenuState;
  readonly busy: boolean;
  readonly metadataOf: (source: string, piece?: TypePiece) => SourceMetadata;
  readonly onComment: () => void;
  readonly onDetails: () => void;
  readonly onOpen: (source: string) => void;
  readonly onClose: (refocus: boolean) => void;
};

export function ExpandMenu(props: NavigationProps): JSX.Element {
  const { menu } = props;
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const phone = useMediaQuery(NARROW_QUERY);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const items = (): HTMLElement[] =>
    Array.from(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []);

  // Beside the pointer, inside the window; on a phone, a sheet along the bottom.
  useLayoutEffect(() => {
    const el = root.current;
    if (el === null || phone) {
      setPlace(null);
      return;
    }
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(menu.target.x, window.innerWidth - r.width - 8));
    const top = Math.max(8, Math.min(menu.target.y, window.innerHeight - r.height - 8));
    setPlace((p) => (p !== null && p.left === left && p.top === top ? p : { left, top }));
  });

  // Focus goes in once, to the first entry; it stays where the person put it as the answer arrives. The
  // press that opened the menu also selects the box, and the canvas takes focus for its selection a frame
  // later: the entry takes it back then, unless the person has moved on.
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current) return;
    const first = items()[0];
    if (first === undefined) return;
    focused.current = true;
    const moved = () =>
      first.isConnected &&
      document.activeElement !== null &&
      document.activeElement !== document.body &&
      !list.current?.contains(document.activeElement) &&
      !document.activeElement.closest(".react-flow");
    const take = () => {
      if (first.isConnected && !moved() && !list.current?.contains(document.activeElement))
        first.focus({ preventScroll: true });
    };
    take();
    requestAnimationFrame(() => {
      take();
      requestAnimationFrame(take);
    });
    window.setTimeout(take, 120);
  });

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) props.onClose(true);
    };
    const away = () => props.onClose(true);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", away);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", away);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onClose is the page's, stable enough per menu
  }, []);

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => menuKeys(event, items(), props.onClose);

  const answer = menu.answer;
  const ready = answer.status === "ready" ? answer.menu : null;
  // A conflicting source can have several cuts; navigation still offers that destination only once.
  const diagrams = [...new Map((ready?.diagrams.items ?? []).map((entry) => [entry.source, entry])).values()];
  const name = ready?.element?.name ?? menu.target.label;
  const hasDetails = menu.inside !== null || diagrams.length > 0 || (ready?.neighbours.items.length ?? 0) > 0;
  // A roving tab stop: the entry that has (or will take) focus is the one tabbable item, so a menu that scrolls
  // (long titles, 200% text, a phone sheet) still has keyboard-reachable content; the rest are reached by arrows.
  const [active, setActive] = useState<string | null>(null);
  const keys = [
    ...(menu.canComment ? ["comment"] : []),
    ...diagrams.map((entry) => `d:${entry.source}`),
    ...(hasDetails ? ["details"] : []),
  ];
  const stop = active !== null && keys.includes(active) ? active : keys[0];
  const tabStop = (key: string): 0 | -1 => (key === stop ? 0 : -1);
  const expandBody = !menu.expand ? null : (
    <>
      <MenuStatus menu={menu} />
      {diagrams.length === 0 ? null : (
        <div role="group" aria-labelledby={`${id}-diagrams`} className="archer-expand-group">
          <span id={`${id}-diagrams`} className="archer-expand-heading">
            Open Diagram
          </span>
          {diagrams.map((entry, i) => {
            const metadata = props.metadataOf(entry.source, entry.piece);
            const described = `${id}-source-${i}`;
            return (
              <button
                key={entry.source}
                type="button"
                role="menuitem"
                tabIndex={tabStop(`d:${entry.source}`)}
                data-entry={`d:${entry.source}`}
                className="archer-expand-item"
                aria-label={entry.title}
                aria-describedby={described}
                onClick={() => props.onOpen(entry.source)}
              >
                <span className="archer-expand-title" dir="auto">
                  {entry.title}
                </span>
                <span id={described} className="archer-expand-description">
                  <span className="archer-expand-detail">
                    {metadata.type}
                    {entry.proposed ? " · Proposed" : ""}
                  </span>
                  {metadata.cue ? (
                    <span className="archer-expand-detail" dir="auto">
                      {metadata.cue}
                    </span>
                  ) : null}
                  {metadata.description ? (
                    <span className="archer-expand-detail" dir="auto">
                      {descriptionExcerpt(metadata.description)}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
          {ready?.diagrams.truncated ? (
            <p className="archer-expand-more">{ready.diagrams.total - ready.diagrams.items.length} more not listed</p>
          ) : null}
        </div>
      )}
      {hasDetails ? (
        <div className="archer-expand-group">
          <button
            type="button"
            role="menuitem"
            tabIndex={tabStop("details")}
            className="archer-expand-item"
            data-entry="details"
            onClick={props.onDetails}
          >
            Details and additions…
          </button>
        </div>
      ) : null}
      {ready !== null && !hasDetails ? (
        <p className="archer-expand-status" role="status">
          No other diagram draws {name}.
        </p>
      ) : null}
    </>
  );

  return (
    <div
      ref={root}
      className="archer-expand-menu"
      data-sheet={phone || undefined}
      style={
        phone ? undefined : place === null ? { left: menu.target.x, top: menu.target.y, visibility: "hidden" } : place
      }
    >
      <div
        ref={list}
        role="menu"
        aria-label={`Actions for ${menu.target.label}`}
        aria-busy={answer.status === "loading" || props.busy || undefined}
        onKeyDown={onKey}
        onFocus={(event) => {
          const key = (event.target as HTMLElement).dataset.entry;
          if (key !== undefined) setActive(key);
        }}
      >
        {menu.canComment ? (
          <button
            type="button"
            role="menuitem"
            tabIndex={tabStop("comment")}
            className="archer-expand-item archer-expand-comment"
            data-entry="comment"
            onClick={props.onComment}
          >
            <span className="archer-expand-title">Comment</span>
          </button>
        ) : null}
        {expandBody}
      </div>
    </div>
  );
}

function MenuStatus({ menu }: { readonly menu: MenuState }): JSX.Element | null {
  if (menu.answer.status === "loading")
    return (
      <p className="archer-expand-status" role="status">
        Looking for diagrams of {menu.target.label}…
      </p>
    );
  if (menu.answer.status === "failed")
    return (
      <p className="archer-expand-status archer-expand-failed" role="alert">
        {menu.answer.message}
      </p>
    );
  return null;
}

export type DetailsProps = {
  readonly menu: MenuState;
  readonly busy: boolean;
  readonly previewing: string | null;
  readonly metadataOf: (source: string, piece?: TypePiece) => SourceMetadata;
  readonly limitOf: (entry: Entry) => string | null;
  readonly onInside: () => void;
  readonly onPreview: (key: string, entry: Entry) => void;
  readonly onAdd: (entry: Entry) => void;
  readonly onOpen: (source: string) => void;
  readonly onClose: (refocus: boolean) => void;
};

export function DetailsAndAdditions(props: DetailsProps): JSX.Element {
  const { menu } = props;
  const id = useId();
  const root = useRef<HTMLElement>(null);
  const docked = useDocked();
  useLayoutEffect(() => {
    root.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
  }, []);
  const ready = menu.answer.status === "ready" ? menu.answer.menu : null;
  const readings = ready?.element?.readings ?? [];
  const row = (key: string, entry: Entry, title: string, detail: string, source: string): JSX.Element => {
    const why = blocked(entry, props.limitOf(entry));
    const metadata = props.metadataOf(source, entry.piece);
    const actionTitle = "viaTitle" in entry ? `${title} · ${entry.viaTitle}` : title;
    return (
      <div key={key} className="archer-expand-choice" data-previewing={props.previewing === key || undefined}>
        <h3 className="archer-expand-title" dir="auto">
          {title}
        </h3>
        <p className="archer-expand-detail">
          {metadata.type}
          {entry.proposed ? " · Proposed" : ""}
        </p>
        {metadata.cue ? (
          <p className="archer-expand-detail" dir="auto">
            {metadata.cue}
          </p>
        ) : null}
        <p className="archer-expand-detail">
          {detail} · {why ?? addsText(entry.adds)}
        </p>
        {metadata.description ? (
          <p className="archer-expand-detail" dir="auto">
            {metadata.description}
          </p>
        ) : null}
        <div className="archer-expand-actions">
          <button
            type="button"
            className="archer-expand-open"
            disabled={why !== null || props.busy}
            aria-label={`Preview: ${actionTitle}`}
            aria-pressed={props.previewing === key}
            onClick={() => props.onPreview(key, entry)}
          >
            Preview
          </button>
          <button
            type="button"
            className="archer-expand-open"
            disabled={why !== null || props.busy}
            aria-label={`Add to view: ${actionTitle}`}
            onClick={() => props.onAdd(entry)}
          >
            Add to view
          </button>
          <button
            type="button"
            className="archer-expand-open"
            aria-label={`Open full diagram: ${actionTitle}`}
            onClick={() => props.onOpen(source)}
          >
            Open full diagram
          </button>
        </div>
      </div>
    );
  };
  return (
    <section
      ref={root}
      className="archer-expand-details"
      aria-labelledby={`${id}-heading`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          props.onClose(true);
        }
      }}
    >
      {/* Docked on a phone, the sheet's own head already shows the name and carries the close: the heading
          stays for the outline, unseen. */}
      <div className="archer-expand-details-head" data-docked={docked || undefined}>
        <h2 id={`${id}-heading`} className="archer-panel-heading">
          Details and Additions
        </h2>
        {docked ? null : (
          <button
            type="button"
            className="archer-panel-close"
            aria-label="Close Details and Additions"
            title="Close (Esc)"
            onClick={() => props.onClose(true)}
          >
            <CloseGlyph />
          </button>
        )}
      </div>
      <MenuStatus menu={menu} />
      {menu.inside === null ? null : (
        <div className="archer-expand-choice">
          <h3 className="archer-expand-title">Inside {menu.target.label}</h3>
          <p className="archer-expand-detail">Open in place · {plural(menu.inside.count, "element")}</p>
          <button type="button" className="archer-expand-open" onClick={props.onInside}>
            Open inside
          </button>
        </div>
      )}
      {ready?.diagrams.items.map((entry, i) => {
        const r = ready.element?.conflicting ? readings[entry.reading] : undefined;
        const reading = r === undefined ? "" : ` as ${r.kind}${r.parent ? ` in ${r.parent}` : ""}`;
        return row(
          `d${i}:${entry.source}`,
          entry,
          entry.title,
          `${entry.relation === "opens" ? "Opens it" : "Draws it"}${reading}`,
          entry.source,
        );
      })}
      {ready?.diagrams.truncated ? (
        <p className="archer-expand-more">{ready.diagrams.total - ready.diagrams.items.length} more not listed</p>
      ) : null}
      {(ready?.neighbours.items.length ?? 0) === 0 ? null : <h3 className="archer-panel-heading">Not Drawn Here</h3>}
      {ready?.neighbours.items.map((entry, i) =>
        row(
          `n${i}:${entry.element}`,
          entry,
          entry.name,
          `${ARROW[entry.direction] ?? "—"} ${entry.kinds[0] ?? "related"} · in ${entry.viaTitle}`,
          entry.via,
        ),
      )}
      {ready?.neighbours.truncated ? (
        <p className="archer-expand-more">{ready.neighbours.total - ready.neighbours.items.length} more not listed</p>
      ) : null}
    </section>
  );
}

/** The canvas's preview: what an entry would add, faint, until it is chosen or let go. */
export function PreviewStyle({ ids }: { readonly ids: readonly string[] }): JSX.Element {
  const selectors = ids.map(
    (id) => `.react-flow__node[data-id="${CSS.escape(id)}"], .react-flow__edge[data-id="${CSS.escape(id)}"]`,
  );
  return (
    <style>
      {selectors.length === 0 ? "" : `${selectors.join(",\n")} { opacity: 0.35; transition: opacity 120ms ease-out; }`}
    </style>
  );
}

/** "Added to This View", in the side panel: the sources, how much of the limit they use, Open and Remove. */
export function AddedToView(props: {
  readonly frames: readonly Frame[];
  readonly additions: readonly Addition[];
  readonly added: { readonly boxes: number; readonly wires: number };
  readonly limits: Pick<Limits, "maxAddedSources" | "maxAddedBoxes">;
  readonly fallbacks: number;
  readonly steps: number;
  /** Each placement's time in the worker, newest last (ms): read by the perf lab and the e2e. */
  readonly stepMs: string;
  readonly hidden: boolean;
  /** Whose additions these are: the agent's presentation, a link, or the person's own. */
  readonly origin: "own" | "presented" | "link";
  readonly notices: readonly string[];
  readonly onOpen: (source: string) => void;
  readonly onRemove: (source: string) => void;
  /** Copies a link that reopens this picture (O10), or the view's own when no link holds the list (P42). */
  readonly onCopyLink: () => Promise<CopiedLink>;
}): JSX.Element {
  const id = useId();
  const [copied, setCopied] = useState<CopiedLink | null>(null);
  return (
    <section
      className="archer-expand-added"
      aria-labelledby={`${id}-h`}
      data-fallbacks={props.fallbacks}
      data-steps={props.steps}
      data-step-ms={props.stepMs}
      data-origin={props.origin}
    >
      <h2 id={`${id}-h`} className="archer-panel-heading">
        Added to This View
      </h2>
      {props.frames.length === 0 ? null : (
        <p className="archer-expand-added-use">
          {props.origin === "presented" ? "Added by the agent · " : props.origin === "link" ? "From a link · " : ""}
          {props.frames.length} of {props.limits.maxAddedSources} diagrams · {props.added.boxes} of{" "}
          {props.limits.maxAddedBoxes} boxes
        </p>
      )}
      {props.notices.map((line, i) => (
        <p
          // biome-ignore lint/suspicious/noArrayIndexKey: a read-only list re-rendered as a whole; its items hold no state.
          key={i}
          className="archer-expand-added-use archer-expand-notice"
          role="status"
        >
          {line}
        </p>
      ))}
      {props.hidden ? (
        <p className="archer-expand-added-use">Shown in Explore. This mode draws the diagram as written.</p>
      ) : null}
      <ul className="archer-expand-added-list">
        {props.frames.map((frame) => {
          const truncated = props.additions.some((a) => a.source === frame.source && a.truncated);
          return (
            <li key={frame.source} className="archer-expand-added-item">
              <span className="archer-expand-title">
                {frame.title}
                {frame.proposed ? <span className="archer-expand-tag">Proposed</span> : null}
              </span>
              <span className="archer-expand-detail">
                {plural(
                  frame.pieces.reduce((n, p) => n + p.nodes.length, 0),
                  "box",
                  "boxes",
                )}
                {truncated ? " · part of it" : ""}
              </span>
              <span className="archer-expand-added-actions">
                <button
                  type="button"
                  className="archer-expand-open"
                  onClick={() => props.onOpen(frame.source)}
                  aria-label={`Open the full diagram: ${frame.title}`}
                >
                  Open
                </button>
                <button
                  type="button"
                  className="archer-expand-open"
                  onClick={() => props.onRemove(frame.source)}
                  aria-label={`Remove ${frame.title} from this view`}
                >
                  Remove
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      {props.frames.length === 0 ? null : (
        <p className="archer-expand-added-use">
          <button
            type="button"
            className="archer-expand-open"
            onClick={() => {
              void props.onCopyLink().then(setCopied);
            }}
          >
            Copy link
          </button>
          <span role="status">
            {copied === "copied"
              ? " Copied: the link opens this view with these additions."
              : copied === "bare"
                ? " Copied a link to this view without its additions: they are more than a link holds."
                : copied === "failed"
                  ? " The link could not be copied."
                  : ""}
          </span>
        </p>
      )}
    </section>
  );
}
