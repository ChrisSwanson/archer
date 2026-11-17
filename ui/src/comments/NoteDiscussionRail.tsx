import { useEffect, useLayoutEffect, useRef, useState, type JSX, type RefObject } from "react";
import type { Thread } from "./contract";
import { ThreadCard } from "./ThreadCard";
import { commentDraftScope } from "./comment-draft";
import type { ReviewActions } from "./useReview";
import "./NoteDiscussionRail.css";

export type DiscussionPositionInput = { readonly id: string; readonly preferredTop: number; readonly height: number };
export type ClampedDiscussion = { readonly top: number; readonly direction: "above" | "below" | null };

/** Keeps an open card with its passage until either one reaches the visible reader edge. */
export function clampDiscussionTop(input: {
  readonly anchorTop: number;
  readonly anchorBottom: number;
  readonly visibleTop: number;
  readonly visibleBottom: number;
  readonly cardHeight: number;
  readonly gap?: number;
}): ClampedDiscussion {
  const gap = input.gap ?? 12;
  const minimum = input.visibleTop + gap;
  const maximum = Math.max(minimum, input.visibleBottom - input.cardHeight - gap);
  return {
    top: Math.max(minimum, Math.min(input.anchorTop, maximum)),
    direction: input.anchorBottom < input.visibleTop ? "above" : input.anchorTop > input.visibleBottom ? "below" : null,
  };
}

/** Stable, line-ordered packing: a later discussion never overlaps the one above it. */
export function solveDiscussionPositions(
  items: readonly DiscussionPositionInput[],
  gap: number,
): { id: string; top: number }[] {
  const ordered = [...items].sort((a, b) => a.preferredTop - b.preferredTop || a.id.localeCompare(b.id));
  let edge = Number.NEGATIVE_INFINITY;
  return ordered.map((item) => {
    const top = Math.max(item.preferredTop, edge);
    edge = top + item.height + gap;
    return { id: item.id, top };
  });
}

type RailActions = Pick<ReviewActions, "markSeen" | "reply" | "edit" | "remove" | "resolve" | "dismiss">;

export function NoteDiscussionRail(props: {
  readonly threads: readonly Thread[];
  readonly actions: RailActions;
  readonly scrollRoot?: RefObject<HTMLElement | null>;
  readonly documentRoot?: RefObject<HTMLElement | null>;
  readonly missingThreadIds?: ReadonlySet<string>;
  readonly expandedThreadId: string | null;
  readonly requestedThreadIds?: readonly string[];
  readonly onExpandedThreadChange: (threadId: string | null) => void;
  readonly onFocusedThreadChange: (threadId: string | null) => void;
}): JSX.Element | null {
  const rail = useRef<HTMLElement>(null);
  const itemElements = useRef(new Map<string, HTMLElement>());
  const bubbleElements = useRef(new Map<string, HTMLButtonElement>());
  const lastRequestedFocus = useRef<string | null>(null);
  const [positions, setPositions] = useState<ReadonlyMap<string, number>>(new Map());
  const [anchoredIds, setAnchoredIds] = useState<ReadonlySet<string>>(new Set());
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [openedIds, setOpenedIds] = useState<ReadonlySet<string>>(new Set());
  const [expandedQuoteThreadId, setExpandedQuoteThreadId] = useState<string | null>(null);
  const [railBox, setRailBox] = useState<{
    readonly left: number;
    readonly width: number;
    readonly top: number;
    readonly maxHeight: number;
    readonly direction: "above" | "below" | null;
  } | null>(null);
  const passageThreads = props.threads.filter((thread) => thread.anchor.kind === "passage");

  const measure = (): void => {
    const root = props.documentRoot?.current;
    const railElement = rail.current;
    if (root === null || root === undefined || railElement === null) return;
    const railRect = railElement.getBoundingClientRect();
    const width = Math.min(railRect.width, window.innerWidth - 24);
    const marks = new Map<string, HTMLElement>();
    root.querySelectorAll<HTMLElement>("mark[data-thread-id],mark[data-thread-ids]").forEach((mark) => {
      const ids =
        mark.dataset.threadIds?.split(" ").filter(Boolean) ?? (mark.dataset.threadId ? [mark.dataset.threadId] : []);
      for (const id of ids) if (!marks.has(id)) marks.set(id, mark);
    });
    const inputs: DiscussionPositionInput[] = [];
    const found = new Set<string>();
    for (const thread of passageThreads) {
      const mark = marks.get(thread.id) ?? null;
      if (mark === null) continue;
      found.add(thread.id);
      const height = bubbleElements.current.get(thread.id)?.getBoundingClientRect().height ?? 44;
      inputs.push({ id: thread.id, preferredTop: mark.getBoundingClientRect().top - railRect.top, height });
    }
    const expandedMark = props.expandedThreadId === null ? null : (marks.get(props.expandedThreadId) ?? null);
    const readerRect = props.scrollRoot?.current?.getBoundingClientRect();
    const visibleTop = Math.max(
      readerRect?.top ?? 0,
      Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--primary-bar-bottom")) || 0,
    );
    const visibleBottom = Math.min(readerRect?.bottom ?? window.innerHeight, window.innerHeight);
    const expandedItem = props.expandedThreadId === null ? null : itemElements.current.get(props.expandedThreadId);
    const cardHeight = Math.min(
      expandedItem?.getBoundingClientRect().height ?? 44,
      Math.max(44, visibleBottom - visibleTop - 24),
    );
    const clamped =
      expandedMark === null
        ? { top: visibleTop + 12, direction: null }
        : clampDiscussionTop({
            anchorTop: expandedMark.getBoundingClientRect().top,
            anchorBottom: expandedMark.getBoundingClientRect().bottom,
            visibleTop,
            visibleBottom,
            cardHeight,
          });
    setRailBox({
      left: Math.max(12, Math.min(railRect.left, window.innerWidth - width - 12)),
      width,
      maxHeight: Math.max(44, visibleBottom - visibleTop - 24),
      ...clamped,
    });
    setAnchoredIds(found);
    setPositions(new Map(solveDiscussionPositions(inputs, 8).map(({ id, top }) => [id, top])));
  };

  useLayoutEffect(measure, [props.threads, props.expandedThreadId, expandedQuoteThreadId]);
  useEffect(() => {
    const scroll = props.scrollRoot?.current;
    const root = props.documentRoot?.current;
    if (scroll === null || scroll === undefined || root === null || root === undefined) return;
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(root);
    if (rail.current !== null) observer?.observe(rail.current);
    if (props.expandedThreadId !== null) {
      const expandedItem = itemElements.current.get(props.expandedThreadId);
      if (expandedItem !== undefined) observer?.observe(expandedItem);
    }
    scroll.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      scroll.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [props.scrollRoot, props.documentRoot, props.threads, props.expandedThreadId]);

  useEffect(() => {
    const selected = props.threads.find((thread) => thread.id === props.expandedThreadId);
    if (selected !== undefined) {
      setOpenedIds((before) => (before.has(selected.id) ? before : new Set([...before, selected.id])));
      props.actions.markSeen?.(selected);
    } else if (props.expandedThreadId !== null) props.onExpandedThreadChange(null);
  }, [props.expandedThreadId, props.threads]);

  const requestedKey = props.requestedThreadIds?.join("\0") ?? "";
  useEffect(() => {
    const first = props.requestedThreadIds?.find((id) => bubbleElements.current.has(id));
    if (first === undefined) {
      lastRequestedFocus.current = null;
      return;
    }
    const focusKey = `${requestedKey}\0${first}\0${anchoredIds.has(first) ? "anchored" : "unplaced"}`;
    if (lastRequestedFocus.current === focusKey) return;
    lastRequestedFocus.current = focusKey;
    props.onFocusedThreadChange(first);
    bubbleElements.current.get(first)?.focus({ preventScroll: true });
    bubbleElements.current.get(first)?.scrollIntoView?.({ block: "nearest" });
  }, [requestedKey, anchoredIds]);
  useEffect(() => {
    if (props.expandedThreadId !== expandedQuoteThreadId) setExpandedQuoteThreadId(null);
  }, [props.expandedThreadId]);
  useEffect(() => {
    if (props.expandedThreadId === null) return;
    const closeOutside = (event: PointerEvent): void => {
      const target = event.target;
      const item = itemElements.current.get(props.expandedThreadId!);
      if (target instanceof Node && item?.contains(target)) return;
      props.onExpandedThreadChange(null);
    };
    const closeFromKeyboard = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      props.onExpandedThreadChange(null);
      requestAnimationFrame(() => bubbleElements.current.get(props.expandedThreadId!)?.focus());
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeFromKeyboard);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeFromKeyboard);
    };
  }, [props.expandedThreadId, props.onExpandedThreadChange]);

  if (props.threads.length === 0) return null;
  const unplaced = props.threads.filter((thread) => thread.anchor.kind !== "passage" || !anchoredIds.has(thread.id));
  const anchoredBottom = passageThreads.reduce((bottom, thread) => {
    if (!anchoredIds.has(thread.id)) return bottom;
    const top = positions.get(thread.id) ?? 0;
    const height = bubbleElements.current.get(thread.id)?.getBoundingClientRect().height ?? 44;
    return Math.max(bottom, top + height);
  }, 0);

  const open = (thread: Thread): void => {
    setOpenedIds((before) => new Set([...before, thread.id]));
    if (props.expandedThreadId === thread.id) {
      setExpandedQuoteThreadId((before) => (before === thread.id ? null : thread.id));
      return;
    }
    setExpandedQuoteThreadId(null);
    props.onExpandedThreadChange(thread.id);
  };
  const finishRemoval = async (thread: Thread, work: () => Promise<boolean>): Promise<boolean> => {
    setPendingId(thread.id);
    try {
      const done = await work();
      if (done) {
        props.onExpandedThreadChange(null);
        requestAnimationFrame(() =>
          (
            bubbleElements.current.values().next().value ?? rail.current?.querySelector<HTMLButtonElement>("button")
          )?.focus(),
        );
      }
      return done;
    } finally {
      setPendingId(null);
    }
  };

  const discussion = (thread: Thread, anchored: boolean): JSX.Element => {
    const expanded = props.expandedThreadId === thread.id;
    const quoteExpanded = expandedQuoteThreadId === thread.id;
    const quote = thread.anchor.kind === "passage" ? thread.anchor.quote : "Whole note";
    const quoteCharacters = Array.from(quote);
    const shortenQuote = !quoteExpanded && quoteCharacters.length > 80;
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: hover mirrors focus (onFocus/onBlur) to mark the thread's passage; the bubble button inside is the control.
      <div
        key={thread.id}
        ref={(element) => {
          if (element) itemElements.current.set(thread.id, element);
          else itemElements.current.delete(thread.id);
        }}
        className="primary-note-discussion"
        data-expanded={expanded ? "true" : "false"}
        data-quote-expanded={quoteExpanded ? "true" : "false"}
        data-thread-id={thread.id}
        style={{
          ...(anchored ? { top: positions.get(thread.id) ?? 0 } : {}),
          ...(expanded && railBox !== null
            ? { left: railBox.left, width: railBox.width, top: railBox.top, maxHeight: railBox.maxHeight }
            : {}),
        }}
        onMouseEnter={() => props.onFocusedThreadChange(thread.id)}
        onMouseLeave={(event) => {
          if (!event.currentTarget.contains(document.activeElement)) props.onFocusedThreadChange(null);
        }}
        onFocus={() => props.onFocusedThreadChange(thread.id)}
        onBlur={(event) => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget))
            props.onFocusedThreadChange(null);
        }}
      >
        {anchored ? <span className="primary-note-discussion-connector" aria-hidden="true" /> : null}
        <button
          ref={(element) => {
            if (element) bubbleElements.current.set(thread.id, element);
            else bubbleElements.current.delete(thread.id);
          }}
          type="button"
          className="primary-note-discussion-bubble"
          onClick={() => open(thread)}
          aria-expanded={expanded}
          aria-pressed={quoteExpanded}
          aria-controls={`archer-note-margin-panel-${thread.id}`}
          aria-label={
            expanded
              ? `${quoteExpanded ? "Collapse" : "Show full"} quoted passage “${quote}”`
              : `Open discussion on “${quote}”`
          }
        >
          <span className="primary-note-discussion-quote">
            {shortenQuote ? (
              <>
                <span className="primary-note-discussion-quote-start">
                  {quoteCharacters.slice(0, 48).join("").trimEnd()}
                </span>
                <span className="primary-note-discussion-quote-bridge">...</span>
                <span className="primary-note-discussion-quote-end">
                  {quoteCharacters.slice(-24).join("").trimStart()}
                </span>
              </>
            ) : (
              quote
            )}
          </span>
          {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the label replaces the bare number in the name the enclosing control or cell computes from its content (accname); tests pin it. */}
          <span
            className="primary-note-discussion-count"
            aria-label={`${thread.comments.length} ${thread.comments.length === 1 ? "comment" : "comments"}`}
          >
            {thread.comments.length}
          </span>
          {expanded && railBox?.direction ? (
            <span className="primary-note-discussion-direction">Original passage {railBox.direction}</span>
          ) : null}
        </button>
        {openedIds.has(thread.id) ? (
          <fieldset
            id={`archer-note-margin-panel-${thread.id}`}
            hidden={!expanded}
            className="primary-note-discussion-panel"
            disabled={pendingId === thread.id}
            aria-busy={pendingId === thread.id}
          >
            <legend className="archer-visually-hidden">Discussion on {quote}</legend>
            <ThreadCard
              thread={thread}
              scope="note"
              draftScope={commentDraftScope()}
              passageMissing={props.missingThreadIds?.has(thread.id)}
              inlineReply
              hideAnchorHeading
              elementId={`archer-note-margin-${thread.id}`}
              onReply={(body) => props.actions.reply(thread, body)}
              onEdit={(commentId, body) => props.actions.edit(thread, commentId, body)}
              onDelete={(commentId) => props.actions.remove(thread, commentId)}
              onResolve={() => finishRemoval(thread, () => props.actions.resolve(thread))}
              onDismiss={() => finishRemoval(thread, () => props.actions.dismiss(thread))}
            />
          </fieldset>
        ) : null}
      </div>
    );
  };

  return (
    <aside ref={rail} className="primary-note-discussion-rail" aria-label="Note discussions">
      {(props.requestedThreadIds?.length ?? 0) > 1 ? (
        <p className="primary-note-discussion-group-cue" role="status">
          {props.requestedThreadIds!.length} discussions on this passage. Choose one.
        </p>
      ) : null}
      {passageThreads.filter((thread) => anchoredIds.has(thread.id)).map((thread) => discussion(thread, true))}
      {unplaced.length > 0 ? (
        <section
          className="primary-note-discussion-unplaced"
          style={{ marginTop: anchoredBottom + 24 }}
          aria-labelledby="note-unplaced-discussions"
        >
          <h2 id="note-unplaced-discussions">Unplaced Discussions</h2>
          <p>These comments refer to the whole note or to text that moved.</p>
          {unplaced.map((thread) => discussion(thread, false))}
        </section>
      ) : null}
    </aside>
  );
}
