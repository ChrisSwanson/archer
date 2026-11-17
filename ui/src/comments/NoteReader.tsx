import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import type { Anchor, NoteSummary, TargetRef } from "./contract";
import { NoteItem, type SearchPassage } from "./NoteItem";
import { NoteOutline } from "./NoteOutline";
import { NoteEmphasisLegend } from "./NoteEmphasisLegend";
import { markRouteReady, noteFiguresSettled } from "../diagrams/route-ready";
import { NoteDiscussionRail } from "./NoteDiscussionRail";
import type { ReviewModel } from "./useReview";
import { appendPersonHighlight, highlightSaveResult } from "./useNoteEmphasis";
import type { FigureLoader } from "./note-figures";
import { useLegendFocus } from "../emphasis/useLegendFocus";
import "./primary-comments.css";

/** Reads production Markdown and durable passage anchors directly in the workspace. */
export function NoteReader(props: {
  readonly model: ReviewModel;
  readonly path: string;
  readonly note?: NoteSummary;
  /**
   * Opens a link the note's words make, or says it cannot (false). A promise when the answer needs a request (a
   * file of the project outside the Archer folder, which only the document catalog can vouch for).
   */
  readonly onOpenLink?: (href: string, path: string) => boolean | Promise<boolean>;
  readonly onCompose: (target: TargetRef, anchor: Anchor) => void;
  readonly onOpenThread?: (threadId: string) => void;
  readonly incomingThreadRequest?: { readonly key: number; readonly threadId: string } | null;
  /** Draws the note's mermaid fences in place (`note-figures.ts`). */
  readonly figures?: { readonly load: FigureLoader; readonly now: () => number };
  /** Opens a figure's diagram in the canvas, with where the reader was in the note. */
  readonly onOpenDiagram?: (address: string, scrollTop: number) => void;
  /** Coming back from a diagram opened here: where the reader was, and which figure to focus. */
  readonly returnTo?: { readonly address: string; readonly scrollTop: number };
  /** Told once the reader is back where they were. */
  readonly onReturned?: () => void;
  /** Opened from a search match (J3-F1): the passage to mark and show. */
  readonly searchMatch?: SearchPassage | null;
}): JSX.Element {
  const { model, path } = props;
  const note = props.note ??
    model.notes.notes.find((n) => n.path === path) ?? { path, title: path.split("/").pop() ?? path };
  const target: TargetRef = `note:${path}`;
  const emphasisState = model.noteEmphases?.get(path);
  const emphasisRead =
    emphasisState?.status === "ready" || emphasisState?.status === "loading" ? emphasisState.read : undefined;
  const hasEmphasisLegend =
    model.capabilities.noteEmphasis &&
    ((emphasisRead?.snapshot.emphases.length ?? 0) > 0 ||
      (emphasisState?.status === "ready" && emphasisState.error !== undefined));
  const [activeEmphasisId, setActiveEmphasisId] = useState<string | null | undefined>(undefined);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [expandedThreadId, setExpandedThreadId] = useState<string | null>(null);
  const [focusedThreadId, setFocusedThreadId] = useState<string | null>(null);
  const [missingThreadIds, setMissingThreadIds] = useState<ReadonlySet<string>>(new Set());
  const [discussionLayout, setDiscussionLayout] = useState<"margin" | "compact">("compact");
  const open = useCallback(() => model.actions.openNote(path), [model.actions.openNote, path]);
  const missing = useCallback(
    (notePath: string, threadIds: ReadonlySet<string>) => {
      if (notePath === path) setMissingThreadIds(threadIds);
    },
    [path],
  );
  useEffect(open, [open]);
  useEffect(() => setUnavailable(null), [path]);
  // The latest link activation: an asynchronous answer speaks only while its click is still the latest one in this
  // note. A newer click, leaving the note (even to come back) and unmounting each start a new one.
  const linkActivation = useRef(0);
  useEffect(() => {
    linkActivation.current += 1;
    return () => {
      linkActivation.current += 1;
    };
  }, [path]);
  useEffect(() => setActiveEmphasisId(undefined), [path]);
  useEffect(() => {
    setExpandedThreadId(null);
    setFocusedThreadId(null);
    setMissingThreadIds(new Set());
  }, [path]);
  const emphasisIds = emphasisRead?.snapshot.emphases.map((emphasis) => emphasis.id).join("\0") ?? "";
  useEffect(() => {
    if (emphasisRead === undefined) return;
    setActiveEmphasisId((held) => {
      if (held === null) return null;
      if (held !== undefined && emphasisRead.snapshot.emphases.some((emphasis) => emphasis.id === held)) return held;
      return emphasisRead.snapshot.emphases.at(-1)?.id;
    });
  }, [path, emphasisRead?.snapshot.revision, emphasisIds]);
  const activeEmphasis = emphasisRead?.snapshot.emphases.find((emphasis) => emphasis.id === activeEmphasisId);
  const actionableGroupIds =
    activeEmphasis?.groups.flatMap((group) => {
      const unavailable =
        emphasisRead?.orphans.filter((orphan) => orphan.emphasisId === activeEmphasis.id && orphan.groupId === group.id)
          .length ?? 0;
      return unavailable < group.passages.length ? [group.id] : [];
    }) ?? [];
  const groupFocus = useLegendFocus(`${path}\0${activeEmphasisId ?? ""}`, actionableGroupIds);
  const article = useRef<HTMLElement>(null);
  const noteColumn = useRef<HTMLDivElement>(null);
  const ready = model.noteContents.get(path)?.status === "ready";
  // Back where the reader was, once the note is laid down again: a passive
  // effect, so it runs after NoteItem's, which places the note's words. The
  // figure they came from takes the focus as it mounts, without scrolling
  // (NoteFigure), and then the request is spent.
  const { onReturned, onOpenDiagram } = props;
  const returnTo = props.returnTo;
  useEffect(() => {
    const root = article.current;
    if (ready && returnTo !== undefined && root !== null) root.scrollTop = returnTo.scrollTop;
  }, [ready, returnTo]);
  const focused = useCallback(() => {
    const root = article.current;
    if (root !== null && returnTo !== undefined) root.scrollTop = returnTo.scrollTop;
    onReturned?.();
  }, [returnTo, onReturned]);
  const figures = useMemo(
    () =>
      props.figures === undefined
        ? undefined
        : {
            ...props.figures,
            ...(onOpenDiagram === undefined
              ? {}
              : { onOpen: (address: string) => onOpenDiagram(address, article.current?.scrollTop ?? 0) }),
            ...(returnTo === undefined ? {} : { focusAddress: returnTo.address, onFocused: focused }),
          },
    [props.figures, onOpenDiagram, returnTo, focused],
  );
  const noteThreads = model.threads.get(target) ?? [];
  const marginAvailable = model.capabilities.comments && noteThreads.length > 0;
  const [requestedThreadIds, setRequestedThreadIds] = useState<readonly string[]>([]);
  const consumedThreadRequest = useRef<string | null>(null);
  useEffect(() => {
    const request = props.incomingThreadRequest;
    if (!request || !marginAvailable || !noteThreads.some((thread) => thread.id === request.threadId)) return;
    const token = JSON.stringify([path, request.key, request.threadId]);
    if (consumedThreadRequest.current === token) return;
    consumedThreadRequest.current = token;
    setRequestedThreadIds([request.threadId]);
    setExpandedThreadId(request.threadId);
    setFocusedThreadId(request.threadId);
  }, [path, props.incomingThreadRequest, marginAvailable, noteThreads]);
  useLayoutEffect(() => {
    const root = article.current;
    if (!marginAvailable || root === null) return;
    const classify = (): void => setDiscussionLayout(root.getBoundingClientRect().width >= 1116 ? "margin" : "compact");
    classify();
    const observer = new ResizeObserver(classify);
    observer.observe(root);
    return () => observer.disconnect();
  }, [marginAvailable]);
  const openThread = useCallback(
    (threadId: string) => {
      const thread = noteThreads.find((candidate) => candidate.id === threadId);
      if (marginAvailable && thread !== undefined) {
        setRequestedThreadIds([]);
        setExpandedThreadId(threadId);
        return;
      }
      props.onOpenThread?.(threadId);
    },
    [marginAvailable, noteThreads, model.actions, props.onOpenThread],
  );
  const openThreads = useCallback(
    (threadIds: readonly string[]) => {
      const available = threadIds.filter((id) => noteThreads.some((thread) => thread.id === id));
      if (!marginAvailable || available.length === 0) {
        if (threadIds[0] !== undefined) props.onOpenThread?.(threadIds[0]);
        return;
      }
      if (available.length === 1) openThread(available[0]!);
      else {
        setExpandedThreadId(null);
        setRequestedThreadIds(available);
      }
    },
    [marginAvailable, noteThreads, openThread, props.onOpenThread],
  );

  // The note's text, with the figures in view drawn: the note page's route-ready point (performance rubric S7).
  const contentReady = model.noteContents.get(path)?.status === "ready";
  useEffect(() => {
    const root = article.current;
    if (!contentReady || root === null) return undefined;
    const check = (): boolean => {
      if (!noteFiguresSettled(root, window.innerHeight)) return false;
      markRouteReady("note");
      return true;
    };
    if (check() || typeof MutationObserver === "undefined") return undefined;
    const observer = new MutationObserver(() => {
      if (check()) observer.disconnect();
    });
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state"] });
    return () => observer.disconnect();
  }, [contentReady]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: delegates events bubbling from the focusable controls inside it; it is no control itself.
    <article
      ref={article}
      className={`primary-note-reader${hasEmphasisLegend ? " primary-note-reader--has-emphasis" : ""}${marginAvailable ? " primary-note-reader--has-discussions" : ""}`}
      aria-label={`Reading ${note.title}`}
      onClick={(event) => {
        const element = event.target instanceof Element ? event.target : null;
        const mark = element?.closest<HTMLElement>("mark[data-thread-id]");
        if (mark?.dataset.threadId) openThread(mark.dataset.threadId);
        const link = element?.closest<HTMLAnchorElement>("a[href]");
        // A figure opens its own diagram (NoteFigure); it is no link in the note's words.
        if (!link || event.defaultPrevented || link.dataset.address !== undefined) return;
        const href = link.getAttribute("href") ?? "";
        // An external reference opens in a new tab and an anchor stays put: neither supersedes a link this tab is
        // still opening, so only an in-tab link starts a new activation.
        if (!/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) linkActivation.current += 1;
        const activation = linkActivation.current;
        const opened = props.onOpenLink?.(href, path);
        const localDocument = !/^[a-z][a-z\d+.-]*:|^\/\//i.test(href) && /\.(?:mmd|md)(?:#.*)?$/i.test(href);
        const unavailableHere = `Unavailable: ${href} is not a registered diagram or note in this project.`;
        if (opened instanceof Promise) {
          event.preventDefault();
          setUnavailable(null);
          void opened.then(
            (handled) => {
              if (!handled && linkActivation.current === activation) setUnavailable(unavailableHere);
            },
            () => {
              if (linkActivation.current === activation) setUnavailable(unavailableHere);
            },
          );
          return;
        }
        const handled = opened === true;
        if (handled || localDocument) event.preventDefault();
        if (localDocument && !handled) setUnavailable(unavailableHere);
        else setUnavailable(null);
      }}
    >
      {unavailable ? (
        <p className="archer-review-quiet" role="status">
          {unavailable}
        </p>
      ) : null}
      {model.capabilities.noteEmphasis ? (
        <NoteEmphasisLegend
          state={emphasisState}
          activeId={activeEmphasisId}
          focusedGroupId={groupFocus.heldId}
          groupBindings={(groupId) => (actionableGroupIds.includes(groupId) ? groupFocus.bind(groupId) : undefined)}
          onSelect={(id) => {
            groupFocus.clear();
            setActiveEmphasisId(id);
          }}
          onClear={async (emphasis, read) => {
            const saved =
              (await model.actions.saveNoteEmphasis?.({
                notePath: path,
                id: emphasis.id,
                groups: [],
                expectedRevision: read.snapshot.revision,
              })) === "saved";
            if (saved) {
              groupFocus.clear();
              setActiveEmphasisId(undefined);
            }
            return saved;
          }}
        />
      ) : null}
      <div
        className="primary-note-discussion-layout"
        data-rail-layout={discussionLayout}
        data-focused-thread={focusedThreadId === null ? undefined : "true"}
      >
        <div ref={noteColumn} className="primary-note-document-column">
          <NoteOutline documentRoot={noteColumn} scrollRoot={article} path={path} />
          <ul className="archer-notes">
            <NoteItem
              key={path}
              note={note}
              state={model.noteContents.get(path)}
              threads={noteThreads}
              searchMatch={props.searchMatch ?? null}
              commentsEnabled={model.capabilities.comments}
              direct
              onOpenThread={model.capabilities.comments ? openThread : props.onOpenThread}
              onOpenThreads={model.capabilities.comments ? openThreads : undefined}
              focusedThreadId={focusedThreadId}
              focusedHighlightGroupId={groupFocus.effectiveId}
              emphasisEnabled={model.capabilities.noteEmphasis && model.actions.saveNoteEmphasis !== undefined}
              activeEmphasis={activeEmphasis}
              emphasisOrphans={emphasisRead?.orphans}
              highlightGroups={emphasisRead?.snapshot.emphases.flatMap((emphasis) =>
                emphasis.groups.map((group) => ({
                  key: JSON.stringify([emphasis.id, group.id]),
                  id: group.id,
                  label: group.label,
                  author: emphasis.author,
                  setTitle: emphasis.title ?? emphasis.id,
                })),
              )}
              onHighlight={async (anchor, label: string) => {
                if (emphasisRead === undefined || model.actions.saveNoteEmphasis === undefined)
                  return { ok: false, problem: "Highlights are still loading. Try again." };
                const built = appendPersonHighlight(emphasisRead, label, anchor);
                if (!built.ok) return built;
                // Saved, refused or not known (its answer lost) reach the form as they are (codex-402).
                const outcome = await model.actions.saveNoteEmphasis(built.input);
                if (outcome === "saved") setActiveEmphasisId(built.setId);
                return highlightSaveResult(outcome);
              }}
              expandKey={1}
              onOpen={open}
              onCompose={props.onCompose}
              onMissing={missing}
              {...(figures === undefined ? {} : { figures })}
            />
          </ul>
        </div>
        {marginAvailable ? (
          <NoteDiscussionRail
            threads={noteThreads}
            actions={model.actions}
            scrollRoot={article}
            documentRoot={noteColumn}
            missingThreadIds={missingThreadIds}
            expandedThreadId={expandedThreadId}
            requestedThreadIds={requestedThreadIds}
            onExpandedThreadChange={(id) => {
              setExpandedThreadId(id);
              setRequestedThreadIds([]);
            }}
            onFocusedThreadChange={setFocusedThreadId}
          />
        ) : null}
      </div>
      {!marginAvailable && props.onOpenThread ? (
        <div className="primary-note-thread-links" role="group" aria-label="Note discussions">
          {noteThreads.map((thread) => (
            <button
              type="button"
              className="archer-review-button"
              key={thread.id}
              onClick={() => props.onOpenThread?.(thread.id)}
            >
              {thread.anchor.kind === "passage" ? thread.anchor.quote : "Note discussion"}
            </button>
          ))}
        </div>
      ) : null}
    </article>
  );
}
