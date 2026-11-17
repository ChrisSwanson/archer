/**
 * One note in the side panel: its title and file name, collapsed, and when
 * expanded its Markdown and its threads.
 *
 * Collapsed by default and read on demand: the diagram is the main view, and
 * a panel of open notes would make it a document reader.
 *
 * Commented in place, like a shared document. Selecting text in the note
 * offers "Comment on selection", which anchors the comment by the passage's
 * words and a little of each side (`passageAnchor`), so it is found again
 * after the note is edited around it. Passages that have threads are marked
 * in the text; one that can no longer be found says so on its thread.
 *
 * The body is markdown-it's output with raw HTML off (`markdown.ts`): safe to
 * place as HTML, and placed by hand rather than by React so the marks can be
 * laid over it and taken off again without React fighting for the nodes.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  MAX_PASSAGE_QUOTE_CHARS,
  NOTE_EMPHASIS_SLOT_PALETTES,
  type Anchor,
  type Author,
  type NoteEmphasis,
  type NoteEmphasisOrphan,
  type NoteSummary,
  type TargetRef,
  type Thread,
} from "./contract";
import { placeNoteHtml, renderNoteMarkdown } from "./markdown";
import { locatePassage, passageAnchor, threadOrigin, type PassageAnchor } from "./state";
import type { NoteState } from "./useReview";
import { Freshness } from "./Freshness";
import { NoteFigure } from "./NoteFigure";
import { locateSearchMatch } from "./search-passage";
import {
  FIGURE_HOST_ATTRIBUTE,
  mountFigureHosts,
  noteText,
  passageOffsets,
  textNodesOf,
  type FigureLoader,
} from "./note-figures";
import { NoteHighlightEditor, type HighlightGroupChoice, type HighlightSaveResult } from "./NoteHighlightEditor";

export const PASSAGE_MARK_CLASS = "archer-passage";

/** The file's own name: what the ticket says the list shows beside the title. */
export function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

type LocatedThreadPassage = {
  readonly id: string;
  readonly origin: Author | null;
  readonly start: number;
  readonly end: number;
};

/**
 * Paints all discussion passages in one pass. Splitting at every range
 * boundary avoids nested interactive marks when threads overlap. A segment
 * carries every covering thread ID; the first segment that introduces a
 * logical thread becomes its keyboard route, and exact overlaps share one.
 */
function markThreadRanges(root: HTMLElement, ranges: readonly LocatedThreadPassage[]): void {
  const boundaries = [...new Set(ranges.flatMap(({ start, end }) => [start, end]))].sort((a, b) => a - b);
  const covered = new Set<string>();
  const segments = boundaries.slice(0, -1).flatMap((start, index) => {
    const end = boundaries[index + 1]!;
    const covering = ranges.filter((range) => range.start < end && range.end > start);
    if (covering.length === 0) return [];
    const ids = covering.map(({ id }) => id);
    const keyboard = ids.some((id) => !covered.has(id));
    ids.forEach((id) => covered.add(id));
    return [{ start, end, ids, origin: covering[0]!.origin, keyboard, triggerPainted: false }];
  });
  let offset = 0;
  for (const node of [...textNodesOf(root)]) {
    const nodeStart = offset;
    const nodeEnd = offset + node.data.length;
    const here = segments.filter((segment) => segment.start < nodeEnd && segment.end > nodeStart);
    for (const segment of here.reverse()) {
      const from = Math.max(segment.start, nodeStart) - nodeStart;
      const to = Math.min(segment.end, nodeEnd) - nodeStart;
      const middle = node.splitText(from);
      middle.splitText(to - from);
      const mark = root.ownerDocument.createElement("mark");
      mark.className =
        segment.origin === null ? PASSAGE_MARK_CLASS : `${PASSAGE_MARK_CLASS} ${PASSAGE_MARK_CLASS}--${segment.origin}`;
      mark.dataset.threadIds = segment.ids.join(" ");
      mark.dataset.threadId = segment.ids[0]!;
      mark.dataset.defaultThreadId = segment.ids[0]!;
      if (segment.keyboard && !segment.triggerPainted) {
        mark.dataset.threadTrigger = "true";
        segment.triggerPainted = true;
      }
      middle.replaceWith(mark);
      mark.append(middle);
    }
    offset = nodeEnd;
  }
}

/** Paints a standalone highlight without giving it comment behavior. */
function highlightRange(
  root: HTMLElement,
  start: number,
  end: number,
  emphasisId: string,
  groupId: string,
  label: string,
  description: string | undefined,
  palette: string,
): void {
  const pieces: { node: Text; from: number; to: number }[] = [];
  let offset = 0;
  for (const node of textNodesOf(root)) {
    const length = node.data.length;
    const from = Math.max(start, offset);
    const to = Math.min(end, offset + length);
    if (from < to) pieces.push({ node, from: from - offset, to: to - offset });
    offset += length;
    if (offset >= end) break;
  }
  for (const [index, { node, from, to }] of pieces.entries()) {
    const middle = node.splitText(from);
    middle.splitText(to - from);
    const mark = root.ownerDocument.createElement("mark");
    mark.className = `archer-note-highlight archer-emph-palette-${palette}`;
    mark.dataset.emphasisId = emphasisId;
    mark.dataset.groupId = groupId;
    mark.dataset.highlightLabel = label;
    if (description !== undefined) mark.dataset.highlightDescription = description;
    // Markdown can split one passage into several marks. One tab stop gives
    // the passage a keyboard route without flooding the note's tab order.
    if (index === 0 && middle.parentElement?.closest("mark[data-thread-id]") === null) mark.tabIndex = 0;
    middle.replaceWith(mark);
    mark.append(middle);
  }
}

export type SearchPassage = { readonly key: number; readonly snippet: string; readonly words: readonly string[] };
export const SEARCH_MATCH_CLASS = "archer-search-match";

/** Marks a search match's ranges (`locateSearchMatch`): plain marks, no comment or highlight behaviour. */
function markSearchMatch(root: HTMLElement, ranges: readonly { start: number; end: number }[]): void {
  for (const { start, end } of [...ranges].reverse()) {
    const pieces: { node: Text; from: number; to: number }[] = [];
    let offset = 0;
    for (const node of textNodesOf(root)) {
      const from = Math.max(start, offset),
        to = Math.min(end, offset + node.data.length);
      if (from < to) pieces.push({ node, from: from - offset, to: to - offset });
      offset += node.data.length;
      if (offset >= end) break;
    }
    for (const { node, from, to } of pieces) {
      const middle = node.splitText(from);
      middle.splitText(to - from);
      const mark = root.ownerDocument.createElement("mark");
      mark.className = SEARCH_MATCH_CLASS;
      mark.dataset.searchMatch = "";
      middle.replaceWith(mark);
      mark.append(middle);
    }
  }
}

/** Where the current text selection is in `root`, as character offsets, if it is wholly inside. */
function selectionIn(root: HTMLElement): { start: number; end: number } | null {
  const selection = root.ownerDocument.getSelection();
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  // A selection in or across a figure is no passage (`passageOffsets`).
  return passageOffsets(root, range);
}

/**
 * The passage selected in the note page's own text, for the comment key (`C`, round 1 F11): the same anchor
 * "Comment on selection" makes. Null when nothing (or too much, or a figure) is selected in a note.
 */
export function selectedNotePassage(doc: Document = document): PassageAnchor | null {
  const selection = doc.getSelection();
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const start = selection.getRangeAt(0).startContainer;
  const root =
    (start instanceof Element ? start : start.parentElement)?.closest<HTMLElement>(".archer-note-body") ?? null;
  const at = root === null ? null : selectionIn(root);
  if (root === null || at === null) return null;
  const anchor = passageAnchor(noteText(root), at.start, at.end);
  return [...anchor.quote].length > MAX_PASSAGE_QUOTE_CHARS ? null : anchor;
}

/**
 * Back to the passage a comment was being written about (round 1, R4-claude-05): the note's body on screen takes focus
 * and the passage is selected again, so Escape from its composer leaves the reader where they were, not at the top of
 * the page. False when no note on screen holds the passage.
 */
export function returnToPassage(anchor: PassageAnchor, doc: Document = document): boolean {
  for (const root of doc.querySelectorAll<HTMLElement>('.archer-note-body[role="document"]')) {
    if (root.closest("[hidden]") !== null) continue;
    const at = locatePassage(noteText(root), anchor);
    if (at === null) continue;
    const range = doc.createRange();
    let offset = 0,
      started = false;
    for (const node of textNodesOf(root)) {
      const end = offset + node.data.length;
      if (!started && at.start < end) {
        range.setStart(node, at.start - offset);
        started = true;
      }
      if (started && at.end <= end) {
        range.setEnd(node, at.end - offset);
        break;
      }
      offset = end;
    }
    if (!started) continue;
    root.focus({ preventScroll: true });
    const selection = doc.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return true;
  }
  return false;
}

export function NoteItem(props: {
  readonly note: NoteSummary;
  readonly state: NoteState | undefined;
  readonly threads: readonly Thread[];
  readonly commentsEnabled: boolean;
  readonly emphasisEnabled?: boolean;
  readonly activeEmphasis?: NoteEmphasis;
  readonly emphasisOrphans?: readonly NoteEmphasisOrphan[];
  readonly focusedThreadId?: string | null;
  readonly focusedHighlightGroupId?: string | null;
  readonly onHighlight?: (anchor: PassageAnchor, label: string) => Promise<HighlightSaveResult>;
  readonly highlightGroups?: readonly HighlightGroupChoice[];
  /** Standalone note surface; legacy sidebar behavior remains the default. */
  readonly direct?: boolean;
  readonly onOpenThread?: (threadId: string) => void;
  readonly onOpenThreads?: (threadIds: readonly string[]) => void;
  /** Expanded from outside: a passage thread asked to be shown. */
  readonly expandKey?: number;
  readonly onOpen: () => void;
  readonly onCompose: (target: TargetRef, anchor: Anchor) => void;
  /** Called with the ids of the passage threads whose words are gone. */
  readonly onMissing: (path: string, threadIds: ReadonlySet<string>) => void;
  /** Draws the note's mermaid fences in place; without it they stay code. */
  readonly figures?: {
    readonly load: FigureLoader;
    readonly now: () => number;
    /** Opens a figure's diagram in the canvas; without it figures are not links. */
    readonly onOpen?: (address: string) => void;
    /** The figure to focus when it mounts: the one the reader came back from. */
    readonly focusAddress?: string;
    /** Told when that figure has taken the focus. */
    readonly onFocused?: () => void;
  };
  readonly children?: ReactNode;
  /** Opened from a search match (J3-F1): its excerpt and the query's words are marked, and shown, once per key. */
  readonly searchMatch?: SearchPassage | null;
}): JSX.Element {
  const { note, state, threads } = props;
  const [openState, setOpen] = useState(false);
  const open = props.direct === true || openState;
  const regionId = useId();
  const body = useRef<HTMLDivElement>(null);
  const [passage, setPassage] = useState<PassageAnchor | null>(null);
  const [selectionPoint, setSelectionPoint] = useState<{ x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; anchor: Anchor } | null>(null);
  const [editingHighlight, setEditingHighlight] = useState<PassageAnchor | null>(null);
  const actionRoot = useRef<HTMLDivElement>(null);
  const menuAction = useRef<HTMLButtonElement>(null);
  const tooltipId = useId();
  const tooltipRoot = useRef<HTMLDivElement>(null);
  const [highlightTooltip, setHighlightTooltip] = useState<{
    readonly mark?: HTMLElement;
    readonly trigger: HTMLElement;
    readonly label?: string;
    readonly description?: string;
    readonly paletteClass: string;
    readonly discussion: boolean;
    readonly discussionCount: number;
    readonly x: number;
    readonly y: number;
  } | null>(null);
  // Clamp the rendered popup, including long-quote warnings and touch targets.
  useLayoutEffect(() => {
    const element = actionRoot.current;
    const point = menu ?? selectionPoint;
    if (!element || !point) return;
    const rect = element.getBoundingClientRect();
    const next = {
      x: Math.max(12, Math.min(point.x, window.innerWidth - rect.width - 12)),
      y: Math.max(12, Math.min(point.y, window.innerHeight - rect.height - 12)),
    };
    if (next.x === point.x && next.y === point.y) return;
    if (menu) setMenu({ ...menu, ...next });
    else setSelectionPoint(next);
  }, [menu, selectionPoint, passage, editingHighlight]);
  useLayoutEffect(() => {
    const tooltip = tooltipRoot.current;
    if (tooltip === null || highlightTooltip === null) return;
    const rect = tooltip.getBoundingClientRect();
    const x = Math.max(12, Math.min(highlightTooltip.x, window.innerWidth - rect.width - 12));
    const y = Math.max(12, Math.min(highlightTooltip.y, window.innerHeight - rect.height - 12));
    if (x !== highlightTooltip.x || y !== highlightTooltip.y) setHighlightTooltip({ ...highlightTooltip, x, y });
  }, [highlightTooltip]);
  const target: TargetRef = `note:${note.path}`;
  const html = useMemo(() => {
    if (state?.status !== "ready") return null;
    const rendered = renderNoteMarkdown(state.content.markdown, {
      internalLinks: props.direct === true,
      headingOffset: props.direct ? 1 : undefined,
    });
    // The page's title is the note's h1; a leading Markdown heading saying the same is not drawn twice.
    return props.direct ? withoutRepeatedTitle(rendered, note.title) : rendered;
  }, [state]);
  // Keyed by content, so threads reloading unchanged (any comments event) don't
  // relay the note and drop what the person has selected in it.
  const passagesKey = JSON.stringify(
    threads.flatMap((thread) =>
      thread.anchor.kind === "passage" ? [[thread.id, thread.anchor, threadOrigin(thread) ?? null]] : [],
    ),
  );
  const passages = useMemo(
    () =>
      (JSON.parse(passagesKey) as [string, PassageAnchor, Author | null][]).map(([id, anchor, origin]) => ({
        id,
        anchor,
        origin,
      })),
    [passagesKey],
  );
  // The same for the active highlight set and its orphans: each read of the
  // note's highlights is a new object even when it says nothing new (the
  // event stream's echo of a write the page already re-read), and laying the
  // note down for it took the reader's selection out from under "Comment on
  // selection" (O40).
  const activeId = props.activeEmphasis?.id;
  const paintedKey = JSON.stringify([
    props.activeEmphasis ?? null,
    (props.emphasisOrphans ?? []).filter((orphan) => orphan.emphasisId === activeId),
  ]);
  const [activeEmphasis, activeOrphans] = useMemo(
    () => JSON.parse(paintedKey) as [NoteEmphasis | null, NoteEmphasisOrphan[]],
    [paintedKey],
  );
  const { onOpen, onMissing } = props;
  const [figureHosts, setFigureHosts] = useState<readonly HTMLElement[]>([]);
  // The figure the reader is on when the note is laid down again (its highlights or threads arriving a moment
  // later): it is mounted afresh in a new host, and takes the focus back as it mounts.
  const [keepFocus, setKeepFocus] = useState<string | null>(null);
  const returnFocused = props.figures?.onFocused;
  const figureFocused = useCallback(() => {
    setKeepFocus(null);
    returnFocused?.();
  }, [returnFocused]);
  // Held by the note's revision: a re-read of the same note is a new array,
  // and laying the note down again for it would remount every figure (and
  // take the focus from the one the reader came back to).
  const noteRevision = state?.status === "ready" ? state.content.revision : null;
  const latestDiagrams = state?.status === "ready" ? state.content.diagrams : undefined;
  const embedded = useMemo(() => latestDiagrams, [noteRevision, latestDiagrams === undefined]);
  const drawFigures = props.figures !== undefined && embedded !== undefined;

  useEffect(() => {
    if (props.expandKey !== undefined && props.expandKey > 0) {
      setOpen(true);
      onOpen();
    }
  }, [props.expandKey]);

  // The callbacks are read through a ref: a parent re-rendering with new ones
  // must not relay the note (and drop the person's selection).
  const callbacks = useRef({
    onMissing,
    onOpenThread: props.onOpenThread,
    onOpenThreads: props.onOpenThreads,
    focusedThreadId: props.focusedThreadId,
  });
  callbacks.current = {
    onMissing,
    onOpenThread: props.onOpenThread,
    onOpenThreads: props.onOpenThreads,
    focusedThreadId: props.focusedThreadId,
  };
  const opensThreads = props.onOpenThread !== undefined || props.onOpenThreads !== undefined;
  const hideHighlightTooltip = useCallback(
    (): void =>
      setHighlightTooltip((current) => {
        current?.trigger.removeAttribute("aria-describedby");
        return null;
      }),
    [],
  );
  const openMarkedThreads = useCallback(
    (mark: HTMLElement): void => {
      hideHighlightTooltip();
      const ids = mark.dataset.threadIds?.split(" ").filter(Boolean) ?? [mark.dataset.threadId!];
      const focused = callbacks.current.focusedThreadId;
      if (focused !== null && focused !== undefined && ids.includes(focused)) callbacks.current.onOpenThread?.(focused);
      else if (ids.length > 1 && callbacks.current.onOpenThreads !== undefined) callbacks.current.onOpenThreads(ids);
      else callbacks.current.onOpenThread?.(ids[0]!);
    },
    [hideHighlightTooltip],
  );

  // Lay the note down, then its marks. Redone whole whenever either changes,
  // so a mark never outlives its thread. Before the browser paints (a layout effect): the note's text, its figure
  // hosts and the figures' placeholders arrive in one frame, so no paragraph is drawn where a figure then pushes it
  // from (PF-6: 0.11 of CLS when the hosts came a frame later).
  useLayoutEffect(() => {
    const root = body.current;
    if (root === null || html === null) return;
    setHighlightTooltip((current) => {
      current?.trigger.removeAttribute("aria-describedby");
      return null;
    });
    const focused = root.ownerDocument.activeElement;
    const onFigure =
      focused === null
        ? -1
        : [...root.querySelectorAll(`[${FIGURE_HOST_ATTRIBUTE}]`)].findIndex((host) => host.contains(focused));
    setKeepFocus(onFigure < 0 ? null : (embedded?.[onFigure]?.address ?? null));
    placeNoteHtml(root, html);
    setFigureHosts(drawFigures ? mountFigureHosts(root, embedded!.length) : []);
    const text = noteText(root);
    const missing = new Set<string>();
    const locatedThreads: LocatedThreadPassage[] = [];
    for (const { id, anchor, origin } of passages) {
      const at = locatePassage(text, anchor);
      if (at === null) missing.add(id);
      else locatedThreads.push({ id, origin, ...at });
    }
    markThreadRanges(root, locatedThreads);
    const active = activeEmphasis;
    if (active !== null) {
      const orphans = new Set(activeOrphans.map((orphan) => `${orphan.groupId}\0${orphan.passageIndex}`));
      // Colour follows the group's position (ADR 0030), whatever palette the wire names.
      for (const [order, group] of active.groups.entries())
        for (let index = 0; index < group.passages.length; index++) {
          if (orphans.has(`${group.id}\0${index}`)) continue;
          const at = locatePassage(text, group.passages[index]!);
          if (at !== null)
            highlightRange(
              root,
              at.start,
              at.end,
              active.id,
              group.id,
              group.label,
              group.description,
              NOTE_EMPHASIS_SLOT_PALETTES[order] ?? "teal",
            );
        }
    }
    if (props.direct && opensThreads) {
      root.querySelectorAll<HTMLElement>("mark[data-thread-id]").forEach((mark) => {
        const ids = mark.dataset.threadIds?.split(" ").filter(Boolean) ?? [mark.dataset.threadId!];
        if (mark.dataset.threadTrigger === "true") {
          mark.tabIndex = 0;
          mark.setAttribute("role", "button");
          mark.setAttribute(
            "aria-label",
            ids.length === 1 ? "Open discussion on this passage" : `Open ${ids.length} discussions on this passage`,
          );
        }
        mark.onclick = (event) => {
          event.stopPropagation();
          openMarkedThreads(mark);
        };
      });
    }
    const match = props.searchMatch;
    if (match != null) {
      const ranges = locateSearchMatch(noteText(root), match.snippet, match.words);
      if (ranges !== null) markSearchMatch(root, ranges);
    }
    callbacks.current.onMissing(note.path, missing);
  }, [
    html,
    passages,
    note.path,
    props.direct,
    opensThreads,
    drawFigures,
    embedded,
    activeEmphasis,
    activeOrphans,
    openMarkedThreads,
    props.searchMatch,
  ]);
  // The match comes into view once per search open, not on every relaying of the note.
  const shownMatch = useRef<number | null>(null);
  useEffect(() => {
    const key = props.searchMatch?.key ?? null;
    if (key === null || html === null || shownMatch.current === key) return;
    const mark = body.current?.querySelector<HTMLElement>(`mark.${SEARCH_MATCH_CLASS}`);
    if (mark == null) return;
    shownMatch.current = key;
    mark.scrollIntoView?.({ block: "center" });
  }, [props.searchMatch, html]);
  // Margin-thread hover/focus changes presentation only. Keep it separate
  // from note painting so moving between bubbles preserves selection, focus,
  // and the exact mark nodes that own keyboard discussion behavior.
  useEffect(() => {
    body.current?.querySelectorAll<HTMLElement>("mark[data-thread-id]").forEach((mark) => {
      const ids = mark.dataset.threadIds?.split(" ").filter(Boolean) ?? [];
      if (
        props.focusedThreadId !== null &&
        props.focusedThreadId !== undefined &&
        ids.includes(props.focusedThreadId)
      ) {
        mark.dataset.activeDiscussion = "true";
        mark.dataset.threadId = props.focusedThreadId;
      } else {
        delete mark.dataset.activeDiscussion;
        mark.dataset.threadId = mark.dataset.defaultThreadId!;
      }
    });
  }, [props.focusedThreadId, html, passages]);
  // Legend preview/focus is presentation-only. Updating attributes on the
  // existing marks preserves text selection and each discussion trigger.
  useEffect(() => {
    const root = body.current;
    if (root === null) return;
    const focused = props.focusedHighlightGroupId;
    const marks = root.querySelectorAll<HTMLElement>("mark[data-emphasis-id][data-group-id]");
    const hasFocusedMark =
      focused !== null && focused !== undefined && [...marks].some((mark) => mark.dataset.groupId === focused);
    if (hasFocusedMark) root.dataset.highlightFocus = "true";
    else delete root.dataset.highlightFocus;
    marks.forEach((mark) => {
      if (hasFocusedMark && mark.dataset.groupId === focused) mark.dataset.highlightFocused = "true";
      else delete mark.dataset.highlightFocused;
    });
  }, [props.focusedHighlightGroupId, html, passages, activeEmphasis]);

  const showHighlightTooltip = useCallback(
    (mark: HTMLElement | null, trigger: HTMLElement, discussion: boolean): void => {
      const label = mark?.dataset.highlightLabel;
      if (label === undefined && !discussion) return;
      const rect = (mark ?? trigger).getBoundingClientRect();
      trigger.setAttribute("aria-describedby", tooltipId);
      setHighlightTooltip((current) => {
        if (current?.trigger !== trigger) current?.trigger.removeAttribute("aria-describedby");
        const paletteClass =
          mark === null ? "" : ([...mark.classList].find((name) => name.startsWith("archer-emph-palette-")) ?? "");
        const discussionCount = discussion ? (trigger.dataset.threadIds?.split(" ").filter(Boolean).length ?? 1) : 0;
        return {
          mark: mark ?? undefined,
          trigger,
          label,
          description: mark?.dataset.highlightDescription,
          paletteClass,
          discussion,
          discussionCount,
          x: rect.left,
          y: rect.bottom + 8,
        };
      });
    },
    [tooltipId],
  );
  useEffect(() => {
    if (highlightTooltip === null) return;
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      hideHighlightTooltip();
    };
    document.addEventListener("keydown", onEscape, true);
    const moved = (event: Event): void => {
      const target = event.target;
      if (target instanceof Node && tooltipRoot.current?.contains(target)) return;
      hideHighlightTooltip();
    };
    window.addEventListener("scroll", moved, true);
    window.addEventListener("resize", moved);
    return () => {
      document.removeEventListener("keydown", onEscape, true);
      window.removeEventListener("scroll", moved, true);
      window.removeEventListener("resize", moved);
    };
  }, [highlightTooltip, hideHighlightTooltip]);

  // What is selected in this note, kept while the person reaches for the button.
  useEffect(() => {
    if (!open || (!props.commentsEnabled && !props.emphasisEnabled)) return;
    const onChange = (): void => {
      const root = body.current;
      if (root === null) return;
      const at = selectionIn(root);
      if (at !== null) {
        setPassage(passageAnchor(noteText(root), at.start, at.end));
        if (props.direct) {
          const range = root.ownerDocument.getSelection()?.getRangeAt(0);
          const rect = range?.getBoundingClientRect?.() ?? root.getBoundingClientRect();
          setSelectionPoint({
            x: Math.max(12, Math.min(rect.right + 8, window.innerWidth - 220)),
            y: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 70)),
          });
        }
      } else {
        const selection = root.ownerDocument.getSelection();
        // A selection made somewhere else replaces this one; a click on the
        // button (which collapses nothing in the note) does not.
        if (editingHighlight === null && (props.direct || (selection !== null && !selection.isCollapsed))) {
          setPassage(null);
          setSelectionPoint(null);
          setMenu((before) => (before?.anchor.kind === "view" ? before : null));
        }
      }
    };
    const onBodyEnd = (event: Event): void => {
      if (!(event.target instanceof Node) || !body.current?.contains(event.target)) return;
      if (event instanceof KeyboardEvent && (event.key === "F10" || event.key === "ContextMenu")) return;
      onChange();
    };
    document.addEventListener("selectionchange", onChange);
    if (props.direct) {
      document.addEventListener("pointerup", onBodyEnd);
      document.addEventListener("keyup", onBodyEnd);
    }
    return () => {
      document.removeEventListener("selectionchange", onChange);
      document.removeEventListener("pointerup", onBodyEnd);
      document.removeEventListener("keyup", onBodyEnd);
    };
  }, [open, props.commentsEnabled, props.emphasisEnabled, props.direct, note.path, editingHighlight]);

  useEffect(() => {
    if (!props.direct) return;
    setPassage(null);
    setSelectionPoint(null);
    setMenu(null);
    setEditingHighlight(null);
    const root = body.current;
    const selection = root?.ownerDocument.getSelection();
    if (root && selection?.rangeCount && root.contains(selection.getRangeAt(0).commonAncestorContainer))
      selection.removeAllRanges();
  }, [note.path, html, props.direct]);
  useEffect(() => {
    if (menu) menuAction.current?.focus({ preventScroll: true });
  }, [menu]);
  useEffect(() => {
    if (!props.direct) return;
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || body.current?.contains(target) || actionRoot.current?.contains(target)) return;
      setMenu(null);
      setPassage(null);
      setSelectionPoint(null);
      setEditingHighlight(null);
      const root = body.current;
      if (root && selectionIn(root)) root.ownerDocument.getSelection()?.removeAllRanges();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [props.direct]);
  const selectedAnchor = (): PassageAnchor | null => {
    const root = body.current;
    const at = root ? selectionIn(root) : null;
    return root && at ? passageAnchor(noteText(root), at.start, at.end) : null;
  };
  const composeHere = (anchor: Anchor): void => {
    const fresh = anchor.kind === "passage" ? selectedAnchor() : anchor;
    if (!fresh || (fresh.kind === "passage" && [...fresh.quote].length > MAX_PASSAGE_QUOTE_CHARS)) return;
    setMenu(null);
    setPassage(null);
    setSelectionPoint(null);
    if (body.current && selectionIn(body.current)) body.current.ownerDocument.getSelection()?.removeAllRanges();
    props.onCompose(target, fresh);
  };
  const highlightHere = (anchor: Anchor): void => {
    const fresh = anchor.kind === "passage" ? selectedAnchor() : null;
    if (fresh === null || [...fresh.quote].length > MAX_PASSAGE_QUOTE_CHARS) return;
    setEditingHighlight(fresh);
  };
  const showContext = (x: number, y: number): boolean => {
    const anchor = selectedAnchor() ?? { kind: "view" as const };
    if (anchor.kind === "passage" && [...anchor.quote].length > MAX_PASSAGE_QUOTE_CHARS) return false;
    setMenu({
      x: Math.max(12, Math.min(x, window.innerWidth - 220)),
      y: Math.max(12, Math.min(y, window.innerHeight - 70)),
      anchor,
    });
    return true;
  };

  const toggle = useCallback(() => {
    if (!open) onOpen();
    setOpen(!open);
  }, [open, onOpen]);

  const count = threads.length;
  const limitId = useId();
  const whyId = useId();
  const quoteTooLong = passage !== null && [...passage.quote].length > MAX_PASSAGE_QUOTE_CHARS;
  return (
    <li className="archer-note" data-open={open ? "true" : "false"}>
      {props.direct ? <h1 className="primary-note-title">{note.title}</h1> : null}
      {props.direct && state?.status === "ready" && state.content.freshness !== undefined ? (
        <p className="primary-note-meta">
          <Freshness freshness={state.content.freshness} now={(props.figures?.now ?? Date.now)()} />
        </p>
      ) : props.direct && (state === undefined || state.status === "loading") ? (
        // Its line kept while the note loads, so the note does not move down when it says how fresh it is (PF-6).
        <p className="primary-note-meta" aria-hidden="true">
          {"\u00a0"}
        </p>
      ) : null}
      {props.direct ? null : (
        <h4 className="archer-note-heading">
          <button
            type="button"
            className="archer-note-toggle"
            aria-expanded={open}
            aria-controls={regionId}
            onClick={toggle}
          >
            <span className="archer-note-chevron" aria-hidden="true" />
            <span className="archer-note-title">{note.title}</span>
            <span className="archer-note-file">{fileName(note.path)}</span>
            {count > 0 ? (
              // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the label replaces the bare number in the name the enclosing control or cell computes from its content (accname); tests pin it.
              <span className="archer-note-count" aria-label={`${count} ${count === 1 ? "thread" : "threads"}`}>
                {count}
              </span>
            ) : null}
          </button>
        </h4>
      )}
      <div id={regionId} className="archer-note-region" hidden={!open}>
        {state === undefined || state.status === "loading" ? (
          <p className="archer-review-quiet">Loading the note…</p>
        ) : state.status === "error" ? (
          <p className="archer-review-quiet">Could not read this note: {state.message}</p>
        ) : null}
        {/* Focusable because it scrolls; labelled because it is a region of
            someone's writing, not the page's own text. */}
        <div
          ref={body}
          className="archer-note-body"
          role="document"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the note body scrolls, so it is a Tab stop (axe scrollable-region-focusable), and is labelled as a document of someone's writing.
          tabIndex={0}
          aria-label={`Note: ${note.title}`}
          hidden={html === null}
          onContextMenu={(event) => {
            if (!props.direct || (!props.commentsEnabled && !props.emphasisEnabled) || html === null) return;
            if (
              !selectedAnchor() &&
              event.target instanceof Element &&
              event.target.closest("a[href],button,input,textarea")
            )
              return;
            if (showContext(event.clientX, event.clientY)) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          onKeyDown={(event) => {
            const discussion =
              event.target instanceof Element
                ? event.target.closest<HTMLElement>('mark[data-thread-trigger="true"]')
                : null;
            if (discussion !== null && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault();
              event.stopPropagation();
              openMarkedThreads(discussion);
              return;
            }
            if (
              !props.direct ||
              (!props.commentsEnabled && !props.emphasisEnabled) ||
              html === null ||
              !(event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))
            )
              return;
            const rect = body.current!.getBoundingClientRect();
            if (showContext(rect.left + 16, rect.top + 24)) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          onMouseOver={(event) => {
            const target = event.target instanceof Element ? event.target : null;
            const mark = target?.closest<HTMLElement>("mark.archer-note-highlight") ?? null;
            const discussion = target?.closest<HTMLElement>("mark[data-thread-id]") ?? null;
            if (mark !== null || discussion !== null)
              showHighlightTooltip(mark, discussion ?? mark!, discussion !== null);
          }}
          onMouseOut={(event) => {
            const next = event.relatedTarget;
            if (
              next instanceof Node &&
              (tooltipRoot.current?.contains(next) ||
                highlightTooltip?.mark?.contains(next) ||
                highlightTooltip?.trigger.contains(next))
            )
              return;
            hideHighlightTooltip();
          }}
          onFocus={(event) => {
            const trigger = event.target instanceof HTMLElement ? event.target : null;
            const mark = trigger?.matches("mark.archer-note-highlight")
              ? trigger
              : trigger?.querySelector<HTMLElement>("mark.archer-note-highlight");
            const discussion = trigger?.matches("mark[data-thread-id]") === true;
            if (((mark !== null && mark !== undefined) || discussion) && trigger !== null)
              showHighlightTooltip(mark ?? null, trigger, discussion);
          }}
          onBlur={(event) => {
            const next = event.relatedTarget;
            if (next instanceof Node && tooltipRoot.current?.contains(next)) return;
            hideHighlightTooltip();
          }}
        />
        {highlightTooltip !== null
          ? createPortal(
              <div
                ref={tooltipRoot}
                id={tooltipId}
                role="tooltip"
                className={`primary-note-highlight-tooltip ${highlightTooltip.paletteClass}`}
                style={{ left: highlightTooltip.x, top: highlightTooltip.y }}
                onMouseLeave={(event) => {
                  const next = event.relatedTarget;
                  if (
                    next instanceof Node &&
                    (highlightTooltip.mark?.contains(next) || highlightTooltip.trigger.contains(next))
                  )
                    return;
                  hideHighlightTooltip();
                }}
              >
                {highlightTooltip.discussion ? (
                  <>
                    <strong>
                      {highlightTooltip.discussionCount === 1
                        ? "Discussion"
                        : `${highlightTooltip.discussionCount} discussions`}
                    </strong>
                    <span>
                      {highlightTooltip.discussionCount === 1
                        ? "Open discussion on this passage"
                        : "Open discussions on this passage"}
                    </span>
                  </>
                ) : null}
                {highlightTooltip.label ? <strong>{highlightTooltip.label}</strong> : null}
                {highlightTooltip.description ? <span>{highlightTooltip.description}</span> : null}
              </div>,
              document.body,
            )
          : null}
        {props.commentsEnabled && html !== null && !props.direct ? (
          <div className="archer-note-tools">
            <button
              type="button"
              className="archer-review-button"
              disabled={passage === null || quoteTooLong}
              aria-describedby={quoteTooLong ? limitId : passage === null ? whyId : undefined}
              onClick={() => {
                if (passage !== null && !quoteTooLong) props.onCompose(target, passage);
              }}
            >
              Comment on selection
            </button>
            <button
              type="button"
              className="archer-review-button"
              onClick={() => props.onCompose(target, { kind: "view" })}
            >
              Comment on note
            </button>
            {quoteTooLong ? (
              <p id={limitId} className="archer-review-quiet">
                Select at most {MAX_PASSAGE_QUOTE_CHARS} characters to comment on a passage.
              </p>
            ) : passage === null ? (
              // Why the button above is greyed out, said where it can be read
              // and as the button's description.
              <p id={whyId} className="archer-review-quiet">
                Select some text in the note to comment on that passage.
              </p>
            ) : null}
          </div>
        ) : null}
        {props.direct &&
        (props.commentsEnabled || props.emphasisEnabled) &&
        html !== null &&
        (editingHighlight || menu || (passage && selectionPoint))
          ? createPortal(
              // biome-ignore lint/a11y/noStaticElementInteractions: pointerdown is cancelled so a press does not clear the text selection; the buttons inside are the controls.
              // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the label is set only together with the role (both conditional on the same test).
              <div
                ref={actionRoot}
                className="primary-note-comment-action"
                style={{ left: (menu ?? selectionPoint)!.x, top: (menu ?? selectionPoint)!.y }}
                role={menu && editingHighlight === null ? "menu" : undefined}
                aria-label={menu && editingHighlight === null ? "Note selection actions" : undefined}
                onPointerDown={(event) => event.preventDefault()}
                onMouseDown={(event) => event.preventDefault()}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setEditingHighlight(null);
                    setMenu(null);
                    setSelectionPoint(null);
                    body.current?.focus({ preventScroll: true });
                  }
                }}
              >
                {editingHighlight === null ? (
                  <>
                    {props.commentsEnabled ? (
                      <button
                        ref={menu ? menuAction : undefined}
                        type="button"
                        className="archer-review-button"
                        role={menu ? "menuitem" : undefined}
                        disabled={!menu && quoteTooLong}
                        aria-describedby={!menu && quoteTooLong ? limitId : undefined}
                        onClick={() => composeHere(menu?.anchor ?? passage!)}
                      >
                        {(menu?.anchor ?? passage)?.kind === "passage" ? "Comment on selection" : "Comment on note"}
                      </button>
                    ) : null}
                    {props.emphasisEnabled && (menu?.anchor ?? passage)?.kind === "passage" ? (
                      <button
                        ref={!props.commentsEnabled && menu ? menuAction : undefined}
                        type="button"
                        className="archer-review-button"
                        role={menu ? "menuitem" : undefined}
                        disabled={!menu && quoteTooLong}
                        onClick={() => highlightHere(menu?.anchor ?? passage!)}
                      >
                        Highlight selection
                      </button>
                    ) : null}
                    {!menu && quoteTooLong ? (
                      <p id={limitId} className="archer-review-quiet">
                        Select at most {MAX_PASSAGE_QUOTE_CHARS} characters.
                      </p>
                    ) : null}
                  </>
                ) : (
                  <NoteHighlightEditor
                    groups={props.highlightGroups}
                    onCancel={() => {
                      setEditingHighlight(null);
                      body.current?.focus({ preventScroll: true });
                    }}
                    onSave={async (label, typedOn) => {
                      const result = (await props.onHighlight?.(editingHighlight, label)) ?? {
                        ok: false,
                        problem: "Highlighting is unavailable.",
                      };
                      if (result.ok && !typedOn()) {
                        setEditingHighlight(null);
                        setMenu(null);
                        setPassage(null);
                        setSelectionPoint(null);
                        body.current?.ownerDocument.getSelection()?.removeAllRanges();
                      }
                      return result;
                    }}
                  />
                )}
              </div>,
              document.body,
            )
          : null}
        {props.figures !== undefined && embedded !== undefined
          ? figureHosts.map((host, index) =>
              embedded[index] === undefined
                ? null
                : createPortal(
                    <NoteFigure
                      diagram={embedded[index]!}
                      load={props.figures!.load}
                      now={props.figures!.now()}
                      autoFocus={
                        props.figures!.focusAddress === embedded[index]!.address ||
                        keepFocus === embedded[index]!.address
                      }
                      onFocused={figureFocused}
                      {...(props.figures!.onOpen === undefined ? {} : { onOpen: props.figures!.onOpen })}
                      {...(state?.status === "ready" && state.content.freshness !== undefined
                        ? { freshness: state.content.freshness }
                        : {})}
                    />,
                    host,
                    embedded[index]!.address,
                  ),
            )
          : null}
        {props.children}
      </div>
    </li>
  );
}

/**
 * `html` without its first element when that is the note's top heading and repeats `title`. The
 * headings under it move up a level, so the page's h1 is followed by an h2, not an h3 (heading-order).
 */
export function withoutRepeatedTitle(html: string, title: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  const first = template.content.firstElementChild;
  const words = (text: string): string => text.replace(/\s+/g, " ").trim();
  if (first === null || !first.classList.contains("archer-note-h1") || words(first.textContent ?? "") !== words(title))
    return html;
  first.remove();
  for (const heading of template.content.querySelectorAll("h3, h4, h5, h6")) {
    // From the level it was written at (its class): the drawn tag is already clamped to h6.
    const written = Number(
      heading.className.match(/archer-note-h([1-6])/)?.[1] ?? Number(heading.tagName.slice(1)) - 1,
    );
    const promoted = document.createElement(`h${Math.max(2, written)}`);
    for (const attribute of heading.attributes) promoted.setAttribute(attribute.name, attribute.value);
    promoted.append(...heading.childNodes);
    heading.replaceWith(promoted);
  }
  return template.innerHTML;
}
