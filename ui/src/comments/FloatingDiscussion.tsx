import { runtime } from "../app/runtime.ts";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useLayoutEffect,
  type JSX,
  type ReactNode,
} from "react";
import { useLatest } from "../app/latest-callback";
import { layoutFrame, observeLayoutElements } from "../app/layout-observer";
import { fitDiscussion, type Edges } from "./discussion-placement";
export { placeDiscussion } from "./discussion-placement";
import { useReviewHost } from "./review-host";
import { createPortal } from "react-dom";
import type { Anchor, TargetRef, Thread } from "./contract";
import { Composer } from "./Composer";
import { commentDraftScope } from "./comment-draft";
import { COARSE_POINTER_QUERY, useMediaQuery } from "../app/media";
import { ThreadCard, threadElementId } from "./ThreadCard";
import { anchorLabel, byRecentActivity, commentPins, locatePassage, type Pin } from "./state";
import { anchorScope, onTarget, targetParts } from "./target";
import { InboxBar, InboxEntry, InboxTabs, INBOX_TABS, inTab, type InboxTab } from "./ReviewInbox";
import { placeNoteHtml, renderNoteMarkdown } from "./markdown";
import { REVIEW_PANEL_ID, type ReviewPanelProps } from "./ReviewPanel";
import { returnToPassage } from "./NoteItem";
import type { ReviewModel } from "./useReview";
function PublishingControls({ model }: { readonly model: ReviewModel }): JSX.Element | null {
  // New comments are held as drafts until published here, so this shows only
  // when there is something to publish.
  if (!runtime.features.publishing || model.pending === 0) return null;
  return (
    <div className="primary-comment-publishing">
      <>
        <button
          type="button"
          className="archer-review-button"
          disabled={model.submitting}
          onClick={() => void model.actions.submitAll()}
        >
          Send queued comments ({model.pending})
        </button>
      </>
    </div>
  );
}
const threadVersion = (thread: Thread): string =>
  `${thread.status === "resolved" ? "resolved" : ""}:${thread.comments
    .filter((comment) => comment.author === "agent")
    .map((comment) => comment.id)
    .join(":")}`;

type Point = {
  x: number;
  y: number;
};
function anchorElement(anchor: Anchor): Element | null {
  // A step is its row in the walkthrough panel, when that panel is open on it.
  if (anchor.kind === "step")
    return document.querySelector(`.archer-walk-step[data-step-id="${CSS.escape(anchor.step)}"]`);
  if (anchor.kind === "selection") {
    const first = anchor.nodes[0] ?? anchor.edges[0];
    return first ? anchorElement({ kind: anchor.nodes.length ? "node" : "edge", ...first }) : null;
  }
  if (anchor.kind === "node" || anchor.kind === "edge" || anchor.kind === "group") {
    const id = CSS.escape(anchor.id);
    const graphId = CSS.escape(anchor.kind === "group" ? `group:${anchor.id}` : anchor.id);
    const graph = `.react-flow__${anchor.kind === "edge" ? "edge" : "node"}[data-id="${graphId}"]`;
    const sequence =
      anchor.kind === "node"
        ? `[data-seq-channel="participants"][data-seq-id="${id}"], [data-seq-channel="notes"][data-seq-id="${id}"]`
        : anchor.kind === "edge"
          ? `[data-seq-channel="messages"][data-seq-id="${id}"]`
          : `.archer-seq-block-header[data-seq-channel="fragments"][data-seq-id="${id}"]`;
    const journey = anchor.kind === "node" ? `[data-journey-id="${id}"]` : "";
    const candidates = [
      ...document.querySelectorAll([graph, sequence, journey, `[data-element-id="${id}"]`].filter(Boolean).join(", ")),
    ];
    return (
      candidates.find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }) ??
      candidates[0] ??
      null
    );
  }
  return null;
}
function bounded(point: Point, width = 360, height = 260): Point {
  return {
    x: Math.max(12, Math.min(point.x, window.innerWidth - width - 12)),
    y: Math.max(12, Math.min(point.y, window.innerHeight - height - 12)),
  };
}
const union = (a: Edges, b: Edges): Edges => ({
  left: Math.min(a.left, b.left),
  top: Math.min(a.top, b.top),
  right: Math.max(a.right, b.right),
  bottom: Math.max(a.bottom, b.bottom),
});
/** An element's box on screen, with the comment pins that sit off its corner. */
function anchorBox(element: Element): Edges {
  // Inside the element, or (on a box the focus has faded) lifted out beside it, named by its owner.
  const sequenceId = element.getAttribute("data-seq-id");
  const block = element.getAttribute("data-seq-channel") === "fragments" && sequenceId !== null;
  const owner = element.getAttribute("data-id") ?? (block ? `group:${sequenceId}` : null);
  const scope = element.closest(".archer-seq-canvas") ?? document;
  // A block is its whole frame, not only the header strip that takes focus: a card under the header covered the block.
  const frame = block
    ? scope
        .querySelector(`.archer-seq-fragment-border-hit[data-seq-id="${CSS.escape(sequenceId)}"]`)
        ?.getBoundingClientRect()
    : undefined;
  const header = element.getBoundingClientRect();
  const r = frame?.width && frame.height ? union(header, frame) : header;
  const pins = (
    element.querySelector(".archer-pins, .archer-pins-svg") ??
    (owner === null
      ? null
      : scope.querySelector(
          `.archer-pins[data-owner="${CSS.escape(owner)}"], .archer-pins-svg[data-owner="${CSS.escape(owner)}"]`,
        ))
  )?.getBoundingClientRect();
  return pins === undefined || pins.width === 0 ? r : union(r, pins);
}
/** The canvas already excludes docked panels; floating panels and local controls reserve additional room. */
const DISCUSSION_OBSTACLES =
  ".archer-diagram-panel, .archer-diagram-key, .primary-review-inbox:not([hidden]), .archer-canvas-controls, .archer-canvas-tools, .react-flow__controls, .archer-stage-dock, .archer-emph-legend, .archer-artifact-wrapper, .archer-comparison-panel, .archer-theme-toggle, .archer-chat-fab, .archer-offscreen-cue, .archer-overview-cue";
function discussionWorkspace(element: Element | null) {
  const surface =
    element?.closest(".archer-seq-canvas, .react-flow, .primary-note-reader") ??
    document.querySelector(".archer-diagram-content, .primary-note-reader, .archer-main");
  const measured = surface?.getBoundingClientRect();
  const box = measured?.width && measured.height ? measured : undefined;
  const left = Math.max(0, box?.left ?? 0),
    top = Math.max(0, box?.top ?? 0);
  const right = Math.min(window.innerWidth, box?.right ?? window.innerWidth);
  const bottom = Math.min(window.innerHeight, box?.bottom ?? window.innerHeight);
  const obstacles = [...document.querySelectorAll(DISCUSSION_OBSTACLES)].flatMap((panel) => {
    const r = panel.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? [r] : [];
  });
  return { bounds: { left, top, width: right - left, height: bottom - top }, obstacles };
}
/** One movable conversation. Position is UI state only; its semantic anchor never changes. */

/** The room a focused card's ring takes outside it: 2px outline, 1px offset, and a pixel to spare. */
const CARD_RING_PX = 4;
/**
 * Scrolls the discussion's own body, and nothing else (not the canvas, not the shell), so `card` and its focus ring
 * are inside it; a card taller than the body shows its top. A reopened card was focused without scrolling and its
 * top was cut off (O99).
 */
export function revealCard(card: HTMLElement): void {
  const body = card.closest<HTMLElement>(".primary-floating-content");
  if (body === null) return;
  const c = card.getBoundingClientRect(),
    b = body.getBoundingClientRect();
  const top = b.top + body.clientTop,
    bottom = top + body.clientHeight;
  if (c.top - CARD_RING_PX < top) body.scrollTop -= top - (c.top - CARD_RING_PX);
  else if (c.bottom + CARD_RING_PX > bottom)
    body.scrollTop += Math.min(c.bottom + CARD_RING_PX - bottom, c.top - CARD_RING_PX - top);
}

/**
 * A flag the card renders from that callbacks queued before the next render read at once: set, it holds in the ref
 * immediately and in the state on the next render.
 */
function useFlag(initial: boolean): readonly [boolean, { readonly current: boolean }, (value: boolean) => void] {
  const [value, setValue] = useState(initial);
  const ref = useRef(initial);
  const [set] = useState(() => (next: boolean) => {
    ref.current = next;
    setValue(next);
  });
  return [value, ref, set];
}

export function FloatingDiscussion(props: {
  readonly anchor: Anchor;
  readonly title: string;
  readonly children: ReactNode;
  readonly onClose: () => void;
  readonly threadId?: string;
  readonly onRetain?: () => void;
  readonly anchorUnavailable?: boolean;
  readonly anchorOrphaned?: boolean;
  /** A canvas element to stand beside instead of the anchor's own (a frame part Expand added, ADR 0036 A10). */
  readonly placeAt?: string;
  readonly inputMethod?: "pointer" | "keyboard";
  /** A press anywhere else on the page closes it (a saved thread, not a comment being written; decided 2026-10-29). Focus stays where the press went. */
  readonly onPressOutside?: () => void;
}): JSX.Element {
  const root = useRef<HTMLElement>(null);
  const pressOutside = useLatest(props.onPressOutside);
  const closesOutside = props.onPressOutside !== undefined;
  useEffect(() => {
    if (!closesOutside) return;
    // A click, not a press: pressing the canvas to pan it keeps the discussion open beside its anchor.
    let down: { x: number; y: number; at: Element } | null = null;
    const outside = (at: Element | null): at is Element =>
      at !== null &&
      !root.current?.contains(at) &&
      // What opens or acts on a discussion itself: a pin, the review panel, a dialog or menu the thread opened.
      !at.closest(
        `[data-pin-thread], #${REVIEW_PANEL_ID}, dialog, [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]`,
      );
    const press = (event: PointerEvent) => {
      const at = event.target instanceof Element ? event.target : null;
      down = outside(at) ? { x: event.clientX, y: event.clientY, at } : null;
    };
    const release = (event: PointerEvent) => {
      const was = down;
      down = null;
      if (was && Math.hypot(event.clientX - was.x, event.clientY - was.y) < 6) pressOutside.current?.();
    };
    document.addEventListener("pointerdown", press, true);
    document.addEventListener("pointerup", release, true);
    return () => {
      document.removeEventListener("pointerdown", press, true);
      document.removeEventListener("pointerup", release, true);
    };
  }, [closesOutside]);
  // Screen coordinates have one owner. Canvas motion and dragging write them before paint;
  // any later React render reads the same coordinates, without a delayed state reconciliation.
  const shown = useRef<Point>(bounded({ x: window.innerWidth - 390, y: 110 }));
  const follow = useCallback((next: Point) => {
    shown.current = next;
    const el = root.current;
    if (el) {
      el.style.left = `${next.x}px`;
      el.style.top = `${next.y}px`;
    }
  }, []);
  const latest = useLatest(props);
  const anchor = props.anchor;
  const anchorKey = JSON.stringify(
    anchor.kind === "selection"
      ? [anchor.kind, anchor.nodes[0]?.id, anchor.edges[0]?.id]
      : "id" in anchor
        ? [anchor.kind, anchor.id]
        : anchor.kind === "step"
          ? [anchor.kind, anchor.walkthrough, anchor.step]
          : anchor.kind === "walkthrough"
            ? [anchor.kind, anchor.walkthrough]
            : anchor.kind === "passage"
              ? [anchor.kind, anchor.quote, anchor.prefix, anchor.suffix]
              : [anchor.kind],
  );
  const [detached, detachedRef, setDetached] = useFlag(false);
  const [location, setLocation] = useState("");
  const drag = useRef<{
    pointer: number;
    start: Point;
    origin: Point;
  } | null>(null);
  const place = useCallback(
    (moving: boolean) => {
      const props = latest.current;
      // Observer callbacks queued before a drag must not reattach the card as it moves.
      if (moving && detachedRef.current) return;
      const element =
        props.placeAt !== undefined
          ? document.querySelector(
              `.react-flow__node[data-id="${CSS.escape(props.placeAt)}"], .react-flow__edge[data-id="${CSS.escape(props.placeAt)}"]`,
            )
          : props.anchorUnavailable
            ? null
            : props.anchor.kind === "passage" && props.threadId
              ? document.querySelector(`mark[data-thread-id="${CSS.escape(props.threadId)}"]`)
              : anchorElement(props.anchor);
      const r = element?.getBoundingClientRect();
      const onscreen =
        r !== undefined &&
        r.width > 0 &&
        r.height > 0 &&
        r.right > 0 &&
        r.bottom > 0 &&
        r.left < window.innerWidth &&
        r.top < window.innerHeight;
      setLocation(
        onscreen
          ? ""
          : props.anchorOrphaned
            ? "Original location is unavailable. The conversation remains available."
            : props.anchorUnavailable
              ? "Open the discussion’s document to see its original location."
              : r?.width
                ? "Anchor is off screen. The conversation remains available."
                : props.anchor.kind === "view"
                  ? "Whole document discussion."
                  : props.anchor.kind === "walkthrough"
                    ? "Whole walkthrough discussion."
                    : props.anchor.kind === "step"
                      ? "Open the walkthrough to see this step."
                      : "Original location is unavailable. The conversation remains available.",
      );
      const el = root.current;
      const content = el?.querySelector<HTMLElement>(".primary-floating-content");
      const height = (el?.offsetHeight || 260) + (content ? content.scrollHeight - content.clientHeight : 0);
      const workspace = discussionWorkspace(element ?? null);
      const next = fitDiscussion(
        onscreen
          ? anchorBox(element!)
          : {
              left: workspace.bounds.left + workspace.bounds.width,
              right: workspace.bounds.left + workspace.bounds.width,
              top: workspace.bounds.top,
              bottom: workspace.bounds.top,
            },
        { width: 360, height },
        workspace.bounds,
        workspace.obstacles,
        {
          // A note sits between the steps before and after it; a side card leaves both readable.
          preferSide: element?.matches(
            '[data-seq-channel="participants"], [data-seq-channel="messages"], [data-seq-channel="notes"]',
          ),
        },
      );
      if (el) {
        el.style.maxWidth = `${next.width}px`;
        el.style.maxHeight = `${next.height}px`;
      }
      const point = { x: next.x, y: next.y };
      follow(point);
      setDetached(false);
    },
    [anchorKey, props.threadId, props.anchorUnavailable, props.anchorOrphaned, props.placeAt, follow],
  );
  const reattach = useCallback(() => {
    setDetached(false);
    place(false);
  }, [place]);
  // Placed before it is painted: a first frame at the default corner could cover the very pin being pressed.
  useLayoutEffect(reattach, [reattach]);
  useEffect(() => {
    const frame = layoutFrame(() => {
      if (detachedRef.current) follow(bounded(shown.current, root.current?.offsetWidth, root.current?.offsetHeight));
      else place(true);
    });
    window.addEventListener("resize", frame.schedule);
    document.addEventListener("scroll", frame.schedule, true);
    const viewports = ".react-flow__viewport, .archer-seq-viewport";
    // Camera writes must move the card before this frame paints. Scheduling another
    // animation frame here leaves the discussion one frame behind its anchor.
    const camera = new MutationObserver((changes) => {
      if (changes.some((change) => change.target instanceof Element && change.target.matches(viewports))) place(true);
    });
    if (!detached)
      camera.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["style", "transform"] });
    const stop = detached
      ? undefined
      : observeLayoutElements(
          `${DISCUSSION_OBSTACLES}, ${viewports}, .archer-diagram-content, .primary-note-reader, .primary-floating-discussion, .primary-floating-content, .primary-floating-content > *`,
          frame.schedule,
          {
            attributes: `${DISCUSSION_OBSTACLES}, .archer-diagram-content, .primary-note-reader`,
            content:
              ".archer-diagram-content, .archer-seq-canvas, .react-flow, .primary-note-reader, .archer-walk-steps",
          },
        );
    return () => {
      frame.cancel();
      camera.disconnect();
      stop?.();
      window.removeEventListener("resize", frame.schedule);
      document.removeEventListener("scroll", frame.schedule, true);
    };
  }, [detached, place, follow]);
  return (
    <section
      ref={root}
      className="primary-floating-discussion"
      role="region"
      aria-label="Contextual discussion"
      style={{ left: shown.current.x, top: shown.current.y }}
      data-detached={detached}
      data-input-method={props.inputMethod}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          props.onClose();
        }
      }}
      onMouseEnter={props.onRetain}
      onFocusCapture={props.onRetain}
    >
      <header className="primary-floating-head">
        <button
          type="button"
          className="primary-discussion-handle"
          aria-label="Move discussion"
          title="Drag to move. Arrow keys move; Shift moves farther."
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { pointer: e.pointerId, start: { x: e.clientX, y: e.clientY }, origin: shown.current };
          }}
          onPointerMove={(e) => {
            const held = drag.current;
            if (!held || held.pointer !== e.pointerId) return;
            setDetached(true);
            follow(
              bounded(
                { x: held.origin.x + e.clientX - held.start.x, y: held.origin.y + e.clientY - held.start.y },
                root.current?.offsetWidth,
                root.current?.offsetHeight,
              ),
            );
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onKeyDown={(e) => {
            const delta = e.shiftKey ? 40 : 10;
            const moves: Record<string, Point> = {
              ArrowLeft: { x: -delta, y: 0 },
              ArrowRight: { x: delta, y: 0 },
              ArrowUp: { x: 0, y: -delta },
              ArrowDown: { x: 0, y: delta },
            };
            const move = moves[e.key];
            if (move) {
              e.preventDefault();
              e.stopPropagation();
              setDetached(true);
              follow(
                bounded(
                  { x: shown.current.x + move.x, y: shown.current.y + move.y },
                  root.current?.offsetWidth,
                  root.current?.offsetHeight,
                ),
              );
            }
          }}
        >
          Discussion
        </button>
        {detached ? (
          <button type="button" className="archer-review-button" onClick={reattach}>
            Reattach
          </button>
        ) : null}
        <button
          type="button"
          className="primary-icon-close"
          aria-label="Close discussion"
          title="Close"
          onClick={props.onClose}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m6 6 12 12 M18 6 6 18" />
          </svg>
        </button>
      </header>
      <p className="primary-floating-context">{props.title}</p>
      {location ? (
        <p className="primary-floating-location" role="status">
          {location}
        </p>
      ) : null}
      <div className="primary-floating-content">{props.children}</div>
    </section>
  );
}
export function FloatingReview(props: ReviewPanelProps): JSX.Element {
  const { model } = props;
  // Detached graph pins transfer focus without receiving pointer focus themselves.
  // Track the real input event instead of relying on browser focus heuristics.
  const [inputMethod, setInputMethod] = useState<"pointer" | "keyboard">("keyboard");
  useEffect(() => {
    const pointer = () => setInputMethod("pointer");
    const keyboard = () => setInputMethod("keyboard");
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("keydown", keyboard, true);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("keydown", keyboard, true);
    };
  }, []);
  // The pin a thread was opened from (pressed, or Enter on it): closing that thread returns focus to the pin,
  // not to the element it sits on (F52, round 1). Anything else pressed or focused outside the discussion
  // forgets it, so a thread opened from Notifications returns as before.
  const pinOpener = useRef<Element | null>(null);
  const createdPin = useRef<string | null>(null);
  useEffect(() => {
    const note = (event: Event) => {
      const at = event.target instanceof Element ? event.target : null;
      const pin = at?.closest('[data-pin-thread][role="button"]') ?? null;
      if (pin !== null) pinOpener.current = pin;
      else if (at === null || !at.closest(".primary-floating-discussion")) {
        pinOpener.current = null;
        createdPin.current = null;
      }
    };
    document.addEventListener("pointerdown", note, true);
    document.addEventListener("focusin", note, true);
    return () => {
      document.removeEventListener("pointerdown", note, true);
      document.removeEventListener("focusin", note, true);
    };
  }, []);
  const [inboxHost, setInboxHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setInboxHost(props.inboxHostId ? document.getElementById(props.inboxHostId) : null);
  }, [props.inboxHostId, props.inboxOpen, props.open]);
  // On a diagram page the review takes the diagram panel's cell (review-host.ts).
  const panelHost = useReviewHost();
  // The review is drawn into one container for its whole life, and that container is moved between its places
  // (the page, a host, the diagram panel) rather than the review being drawn anew in each: a review opened while
  // the page loads moves into the panel when the panel arrives, keeping its focus, its draft and its scroll
  // (round 1 pass 2, F5 f). `display: contents`, so the review lays out as a child of wherever it is.
  const [inboxFrame] = useState(() => {
    const frame = document.createElement("div");
    frame.className = "primary-review-frame";
    frame.style.display = "contents";
    return frame;
  });
  const inboxSpot = useRef<HTMLDivElement>(null);
  const inboxOpen = props.inboxOpen ?? props.open;
  const closeInbox = useLatest(props.onClose);
  const composing = props.compose != null;
  // A click anywhere else closes it (decided 2026-10-29); a drag (panning the drawing) does not, nor does
  // anything that acts on a discussion: the bell, a pin, an open discussion, a dialog or menu.
  useEffect(() => {
    if (!inboxOpen || composing) return;
    let down: { x: number; y: number } | null = null;
    const press = (event: PointerEvent) => {
      const at = event.target instanceof Element ? event.target : null;
      down =
        at !== null &&
        !at.closest(
          `#${REVIEW_PANEL_ID}, [aria-controls="${REVIEW_PANEL_ID}"], .primary-floating-discussion, [data-pin-thread], dialog, [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]`,
        )
          ? { x: event.clientX, y: event.clientY }
          : null;
    };
    const release = (event: PointerEvent) => {
      const was = down;
      down = null;
      if (was && Math.hypot(event.clientX - was.x, event.clientY - was.y) < 6) closeInbox.current();
    };
    document.addEventListener("pointerdown", press, true);
    document.addEventListener("pointerup", release, true);
    return () => {
      document.removeEventListener("pointerdown", press, true);
      document.removeEventListener("pointerup", release, true);
    };
  }, [inboxOpen, composing]);

  const touch = useMediaQuery(COARSE_POINTER_QUERY);
  const composeTarget: TargetRef | null = props.selectedNotePath ? `note:${props.selectedNotePath}` : model.viewTarget;
  const focusRequested = useRef<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [tab, setTab] = useState<InboxTab>("all");
  // Threads ticked in the sidebar: local to this page, and only ever the ones shown.
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [seen, setSeen] = useState<ReadonlyMap<string, string>>(new Map());
  const previewClose = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPreviewClose = () => {
    if (previewClose.current !== null) clearTimeout(previewClose.current);
    previewClose.current = null;
  };
  useEffect(
    () => () => {
      if (previewClose.current !== null) clearTimeout(previewClose.current);
    },
    [],
  );
  const all = [...model.threads.values()].flat();
  const documentKey = props.documentKey ?? `${model.viewTarget ?? ""}:${props.selectedNotePath ?? ""}`;
  const previousDocument = useRef(documentKey);
  const openingTarget = useRef<TargetRef | null>(null);
  const handledThreadRequest = useRef<number | null>(null);
  useEffect(() => {
    if (previousDocument.current === documentKey) return;
    previousDocument.current = documentKey;
    const target = props.selectedNotePath ? `note:${props.selectedNotePath}` : model.viewTarget;
    if (openingTarget.current === target) {
      openingTarget.current = null;
      return;
    }
    openingTarget.current = null;
    cancelPreviewClose();
    focusRequested.current = null;
    setSelected(null);
    setPreview(null);
    if (props.compose) props.onComposeEnd();
  }, [documentKey, model.viewTarget, props.selectedNotePath, props.threadRequest, props.compose, props.onComposeEnd]);

  useEffect(() => {
    if (props.threadRequest && handledThreadRequest.current !== props.threadRequest.key) {
      handledThreadRequest.current = props.threadRequest.key;
      const requested = all.find((thread) => thread.id === props.threadRequest?.threadId);
      // The project conversation is the chat's, never a card on the page.
      if (requested !== undefined && targetParts(requested.target).kind === "project") {
        setSelected(null);
        setPreview(null);
        props.onOpenTarget?.(requested.target);
        return;
      }
      if (props.inlineNoteDiscussions && requested?.target === `note:${props.selectedNotePath}`) {
        setSelected(null);
        setPreview(null);
        return;
      }
      focusRequested.current = props.threadRequest.threadId;
      setSelected(props.threadRequest.threadId);
      setPreview(null);
    }
  }, [props.threadRequest, props.inlineNoteDiscussions, props.selectedNotePath]);
  // One conversation surface at a time: the chat opening closes this, and this opening closes the chat.
  const dismissed = useRef(props.dismissDiscussion);
  useEffect(() => {
    if (props.dismissDiscussion === dismissed.current) return;
    dismissed.current = props.dismissDiscussion;
    cancelPreviewClose();
    focusRequested.current = null;
    setSelected(null);
    setPreview(null);
    if (props.compose) props.onComposeEnd();
  }, [props.dismissDiscussion]);
  const shown = props.compose !== null || selected !== null;
  const told = useLatest(props.onDiscussionShown);
  useEffect(() => {
    if (shown) told.current?.();
  }, [shown]);
  const chosenCandidate = all.find((t) => t.id === (selected ?? preview));
  const chosen =
    (props.inlineNoteDiscussions && chosenCandidate?.target === `note:${props.selectedNotePath}`) ||
    (chosenCandidate !== undefined && targetParts(chosenCandidate.target).kind === "project")
      ? undefined
      : chosenCandidate;
  const compose = props.compose;
  // While a walkthrough is open the composer offers its walkthrough, step and the diagram (ADR 0034 §9).
  const walking =
    compose !== undefined &&
    compose !== null &&
    targetParts(compose.target).kind === "view" &&
    props.diagramChoices.some((choice) => choice.anchor.kind === "walkthrough");
  const chosenParts = chosen === undefined ? undefined : targetParts(chosen.target);
  const chosenNote = chosenParts?.kind === "note" ? model.noteContents.get(chosenParts.path) : undefined;
  const passageMissing = useMemo(() => {
    if (chosen?.anchor.kind !== "passage" || chosenNote?.status !== "ready") return undefined;
    const body = document.createElement("div");
    placeNoteHtml(body, renderNoteMarkdown(chosenNote.content.markdown));
    return locatePassage(body.textContent ?? "", chosen.anchor) === null;
  }, [chosen, chosenNote]);
  const chosenPins =
    chosen && chosenParts?.kind === "view" ? commentPins(model.threads.get(chosen.target) ?? []) : null;
  const chosenPin = chosenPins
    ? [chosenPins.nodePins, chosenPins.edgePins, chosenPins.groupPins]
        .flatMap((map) => [...map.values()].flat())
        .find((pin) => pin.threadId === chosen?.id)
    : undefined;
  useEffect(() => {
    if (!chosen || selected !== chosen.id) return;
    model.actions.markSeen?.(chosen);
    const version = threadVersion(chosen);
    setSeen((before) => (before.get(chosen.id) === version ? before : new Map(before).set(chosen.id, version)));
  }, [chosen, selected]);
  useEffect(() => {
    if (selected === null || focusRequested.current !== selected) return;
    const element = document.getElementById(threadElementId(selected));
    if (!element) return;
    focusRequested.current = null;
    element.focus({ preventScroll: true });
    revealCard(element);
  }, [selected, props.threadRequest?.key, chosen?.id]);
  const openThread = (thread: Thread) => {
    const currentTarget = props.selectedNotePath ? `note:${props.selectedNotePath}` : model.viewTarget;
    openingTarget.current = thread.target === currentTarget ? null : thread.target;
    model.actions.markSeen?.(thread);
    setSeen((s) => new Map(s).set(thread.id, threadVersion(thread)));
    if (targetParts(thread.target).kind === "project") {
      setSelected(null);
      setPreview(null);
      props.onOpenTarget?.(thread.target);
      return;
    }
    if (props.inlineNoteDiscussions && targetParts(thread.target).kind === "note") {
      setSelected(null);
      setPreview(null);
      props.onOpenTarget?.(thread.target);
      props.onOpenInlineNoteThread?.(thread.id);
      return;
    }
    focusRequested.current = thread.id;
    if (selected === thread.id) document.getElementById(threadElementId(thread.id))?.focus({ preventScroll: true });
    setSelected(thread.id);
    setPreview(null);
    props.onOpenTarget?.(thread.target);
    if (thread.orphaned !== true) props.onShowAnchor?.(thread.anchor);
  };
  const onClose = (removed = false) => {
    const anchor = compose?.anchor ?? chosen?.anchor;
    const noteMark =
      chosen?.anchor.kind === "passage"
        ? document.querySelector(`mark[data-thread-id="${CSS.escape(chosen.id)}"]`)
        : null;
    const opener = pinOpener.current;
    const openerId = opener?.getAttribute("data-pin-thread");
    // The pin may have been drawn anew while its thread was open (a box fading lifts its pins out): the same thread's pin.
    const pin =
      !removed &&
      !compose &&
      chosen &&
      chosen.orphaned !== true &&
      (openerId === chosen.id || createdPin.current === chosen.id)
        ? opener?.isConnected && openerId === chosen.id
          ? opener
          : document.querySelector(`[data-pin-thread="${CSS.escape(chosen.id)}"][role="button"]`)
        : null;
    pinOpener.current = null;
    createdPin.current = null;
    // A fast close can precede the saved thread's passive focus effect. Its request is obsolete now.
    focusRequested.current = null;
    const target =
      pin ??
      noteMark ??
      (anchor && chosen?.orphaned !== true ? anchorElement(anchor) : null) ??
      document.querySelector(`[aria-controls="${REVIEW_PANEL_ID}"]`);
    setSelected(null);
    setPreview(null);
    if (compose) props.onComposeEnd();
    // A passage written about but not sent has no mark yet: back to its words in the note, not to Notifications.
    if (!pin && !noteMark && anchor?.kind === "passage" && returnToPassage(anchor)) return;
    if (target instanceof HTMLElement || target instanceof SVGElement) target.focus({ preventScroll: true });
  };
  const isUnread =
    model.isUnread ??
    ((t: Thread) => t.comments.some((c) => c.author === "agent") && seen.get(t.id) !== threadVersion(t));
  useEffect(() => {
    if (selected !== null || compose !== null) return;
    const over = (event: PointerEvent) => {
      const element = event.target instanceof Element ? event.target.closest("[data-pin-thread]") : null;
      const id = element?.getAttribute("data-pin-thread");
      if (id && all.some((thread) => thread.id === id)) {
        cancelPreviewClose();
        setPreview(id);
      }
    };
    const out = (event: PointerEvent) => {
      const element = event.target instanceof Element ? event.target.closest("[data-pin-thread]") : null;
      if (!element || (event.relatedTarget instanceof Node && element.contains(event.relatedTarget))) return;
      previewClose.current = setTimeout(() => setPreview(null), 200);
    };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    return () => {
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
    };
  }, [selected, compose, model.threads]);
  // The sidebar's own expanded thread, answered in place; one at a time. It
  // stays listed while open, even once reading it takes it out of "Unread".
  const [expanded, setExpanded] = useState<string | null>(null);
  // Grouped by diagram or note, newest first within each group and each
  // group placed by its newest thread; `filtered` is the threads in the
  // order they are shown.
  const groups: { readonly target: TargetRef; readonly threads: Thread[] }[] = [];
  for (const thread of byRecentActivity(all.filter((t) => t.id === expanded || inTab(tab, t, isUnread)))) {
    const group = groups.find((g) => g.target === thread.target);
    if (group) group.threads.push(thread);
    else groups.push({ target: thread.target, threads: [thread] });
  }
  const filtered = groups.flatMap((group) => group.threads);
  const counts = { all: 0, unread: 0, answered: 0, drafts: 0 } as Record<InboxTab, number>;
  for (const thread of all) for (const { id } of INBOX_TABS) if (inTab(id, thread, isUnread)) counts[id] += 1;
  const selectedShown = filtered.filter((t) => picked.has(t.id));
  const panelId = useId();
  const tabBase = useId();
  const tabId = (id: InboxTab): string => `${tabBase}-${id}`;
  const chooseTab = (next: InboxTab): void => {
    setTab(next);
    // A selection the new tab does not show is let go, so an action never touches what is out of sight.
    setPicked((held) => {
      const kept = new Set(
        [...held].filter((id) => {
          const thread = all.find((t) => t.id === id);
          return thread !== undefined && (thread.id === expanded || inTab(next, thread, isUnread));
        }),
      );
      return kept.size === held.size ? held : kept;
    });
  };
  const select = (thread: Thread, on: boolean): void =>
    setPicked((held) => {
      const next = new Set(held);
      if (on) next.add(thread.id);
      else next.delete(thread.id);
      return next;
    });
  const entryId = (thread: Thread): string => `primary-inbox-entry-${thread.id}`;
  const focusEntry = (thread: Thread): void => document.getElementById(entryId(thread))?.focus();
  const focusTabs = (): void => document.getElementById(tabId(tab))?.focus();
  // A thread removed from the sidebar hands focus to the entry that takes its place.
  const removing = useRef<{ readonly id: string; readonly index: number } | null>(null);
  const filteredKey = filtered.map((t) => t.id).join("\n");
  useEffect(() => {
    const held = removing.current;
    if (held === null || filtered.some((t) => t.id === held.id)) return;
    removing.current = null;
    const next = filtered[Math.min(held.index, filtered.length - 1)];
    if (next) focusEntry(next);
    else focusTabs();
  }, [filteredKey]);
  // Threads that are gone are no longer selected.
  useEffect(() => {
    setPicked((held) => {
      if (held.size === 0) return held;
      const kept = new Set([...held].filter((id) => all.some((t) => t.id === id)));
      return kept.size === held.size ? held : kept;
    });
  }, [model.threads]);
  const removal = async (thread: Thread, work: () => Promise<boolean>): Promise<boolean> => {
    removing.current = {
      id: thread.id,
      index: Math.max(
        0,
        filtered.findIndex((t) => t.id === thread.id),
      ),
    };
    const done = await work();
    if (!done) removing.current = null;
    return done;
  };
  const toggle = (thread: Thread): void => {
    if (expanded === thread.id) {
      setExpanded(null);
      return;
    }
    setExpanded(thread.id);
    model.actions.markSeen?.(thread);
    setSeen((s) => new Map(s).set(thread.id, threadVersion(thread)));
    // The same conversation is not open in two places at once.
    if (selected === thread.id || preview === thread.id) {
      setSelected(null);
      setPreview(null);
    }
  };
  const collapse = (thread: Thread): void => {
    setExpanded(null);
    focusEntry(thread);
  };
  const markRead = (threads: readonly Thread[]): void => {
    if (model.actions.markAllSeen) model.actions.markAllSeen(threads);
    else for (const thread of threads) model.actions.markSeen?.(thread);
    setSeen((s) => {
      const next = new Map(s);
      for (const thread of threads) next.set(thread.id, threadVersion(thread));
      return next;
    });
  };
  const pinFor = (thread: Thread): Pin | undefined => {
    if (targetParts(thread.target).kind !== "view") return undefined;
    const pins = commentPins(model.threads.get(thread.target) ?? []);
    return [pins.nodePins, pins.edgePins, pins.groupPins]
      .flatMap((map) => [...map.values()].flat())
      .find((pin) => pin.threadId === thread.id);
  };
  const titleOf = (target: TargetRef): string => {
    const title =
      props.targetTitle?.(target) ??
      onTarget(target, { view: ({ viewId }) => viewId, note: ({ path }) => path, project: () => "Whole project" });
    return targetParts(target).kind === "note" ? `${title} (note)` : title;
  };
  const newComment =
    model.capabilities.comments && composeTarget ? (
      <div className="primary-inbox-compose">
        <button
          type="button"
          className="archer-review-button"
          onClick={() =>
            props.onCompose(
              composeTarget,
              props.selectedNotePath ? { kind: "view" } : (props.diagramChoices[0]?.anchor ?? { kind: "view" }),
            )
          }
        >
          New comment
        </button>
      </div>
    ) : null;
  const scopeLabel = (anchor: Anchor, target: TargetRef): string => {
    const choice =
      target === model.viewTarget &&
      (anchor.kind === "group" || (anchor.kind === "node" && anchor.id.startsWith("note-")))
        ? props.diagramChoices.find(
            (choice) =>
              choice.anchor.kind === anchor.kind &&
              "id" in choice.anchor &&
              choice.anchor.id === anchor.id &&
              choice.anchor.label === anchor.label,
          )
        : undefined;
    return choice?.label ?? anchorLabel(anchor, anchorScope(target));
  };
  const entry = (t: Thread): JSX.Element => {
    const open = expanded === t.id;
    const scope = anchorScope(t.target);
    const show = onTarget(t.target, {
      view: () => "Show on diagram",
      note: () => "Show in note",
      project: () => "Open in chat",
    });
    return (
      <InboxEntry
        key={t.id}
        thread={t}
        scopeLabel={t.orphaned ? anchorLabel(t.anchor, scope) : scopeLabel(t.anchor, t.target)}
        entryId={entryId(t)}
        detailId={`primary-inbox-detail-${t.id}`}
        open={open}
        unread={isUnread(t)}
        selected={picked.has(t.id)}
        onSelect={(on) => select(t, on)}
        onToggle={() => toggle(t)}
        onCollapse={() => collapse(t)}
      >
        <ThreadCard
          thread={t}
          scope={scope}
          scopeLabel={t.orphaned ? anchorLabel(t.anchor, scope) : scopeLabel(t.anchor, t.target)}
          draftScope={commentDraftScope()}
          elementId={`primary-inbox-card-${t.id}`}
          pin={pinFor(t)}
          inlineReply={scope === "view"}
          hideAnchorHeading
          onReply={(body) => model.actions.reply(t, body)}
          onEdit={(id, body) => model.actions.edit(t, id, body)}
          onDelete={(id) =>
            t.comments.length === 1 ? removal(t, () => model.actions.remove(t, id)) : model.actions.remove(t, id)
          }
          onResolve={() => removal(t, () => model.actions.resolve(t))}
          onDismiss={() => removal(t, () => model.actions.dismiss(t))}
        />
        <div className="primary-inbox-show">
          <button
            type="button"
            className="archer-review-button"
            onClick={() => {
              setExpanded(null);
              openThread(t);
            }}
          >
            {show}
          </button>
        </div>
      </InboxEntry>
    );
  };
  const emptyText =
    tab === "all" ? (
      touch ? (
        "No discussions yet. Tap something on the diagram to select it, then New comment."
      ) : (
        <>
          No discussions yet. Select something and press <kbd>C</kbd>, or right-click it, to comment on it.
        </>
      )
    ) : tab === "unread" ? (
      "Nothing unread."
    ) : tab === "answered" ? (
      "Nothing answered yet."
    ) : (
      "No drafts."
    );
  // Until the review's first answer an empty list is not "no discussions" (round 1 pass 6, P7.loading).
  const loadingInbox = model.inboxLoading === true;
  const inPanel = inboxHost === null && panelHost !== null;
  const inboxPlace = inboxHost ?? (inPanel ? panelHost : null);
  useLayoutEffect(() => {
    const place = inboxPlace ?? inboxSpot.current;
    if (place === null || inboxFrame.parentNode === place) return;
    // Moving a node takes focus out of it: what had focus in the review has it again once it is in place.
    const active = document.activeElement;
    const focused = active instanceof HTMLElement && inboxFrame.contains(active) ? active : null;
    place.appendChild(inboxFrame);
    focused?.focus({ preventScroll: true });
  }, [inboxPlace, inboxFrame]);
  useEffect(
    () => () => {
      inboxFrame.remove();
    },
    [inboxFrame],
  );
  const inbox = (
    <section
      id={REVIEW_PANEL_ID}
      data-hosted={inboxHost ? "true" : undefined}
      data-in-panel={inPanel ? "true" : undefined}
      className="primary-review-inbox"
      aria-label="Project Review"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          props.onClose();
        }
      }}
      hidden={!(props.inboxOpen ?? props.open)}
    >
      <header className="archer-review-head">
        <h2 className={inboxHost ? "archer-review-title archer-visually-hidden" : "archer-review-title"}>
          Project Review
        </h2>
        <button
          type="button"
          className="primary-icon-close"
          aria-label="Close project review"
          title="Close"
          onClick={props.onClose}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m6 6 12 12 M18 6 6 18" />
          </svg>
        </button>
      </header>
      <div className="primary-inbox-top">
        <p className="primary-inbox-explanation">
          Read and unread are kept in this browser; each badge is the agent’s status.
        </p>
        <InboxTabs
          tab={tab}
          counts={counts}
          panelId={panelId}
          tabId={tabId}
          onChoose={chooseTab}
          loading={loadingInbox}
        />
        {newComment}
      </div>
      <InboxBar
        tab={tab}
        shown={filtered}
        selected={selectedShown}
        isUnread={isUnread}
        model={model}
        onMarkRead={markRead}
        onFocusLost={focusTabs}
        onSelectAll={(on) => setPicked(on ? new Set(filtered.map((t) => t.id)) : new Set())}
        onActed={() => setPicked(new Set())}
      />
      <div
        className="primary-inbox-list"
        id={panelId}
        role="tabpanel"
        aria-labelledby={tabId(tab)}
        aria-busy={loadingInbox ? true : undefined}
      >
        {filtered.length === 0 ? (
          loadingInbox ? (
            <p className="archer-review-quiet primary-inbox-empty" role="status">
              Loading discussions…
            </p>
          ) : (
            <p className="archer-review-quiet primary-inbox-empty">{emptyText}</p>
          )
        ) : (
          groups.map((group, index) => {
            const headingId = `${panelId}-group-${index}`;
            return (
              <section key={group.target} className="primary-inbox-group" aria-labelledby={headingId}>
                <h3 id={headingId} className="primary-inbox-group-head">
                  <span className="primary-inbox-group-name">{titleOf(group.target)}</span>
                  <span className="primary-inbox-group-count">
                    {group.threads.length}
                    <span className="archer-visually-hidden"> {group.threads.length === 1 ? "thread" : "threads"}</span>
                  </span>
                </h3>
                <ul className="primary-inbox-entries">{group.threads.map(entry)}</ul>
              </section>
            );
          })
        )}
      </div>
      <PublishingControls model={model} />
    </section>
  );
  return (
    <>
      <div ref={inboxSpot} className="primary-review-spot" style={{ display: "contents" }} />
      {createPortal(inbox, inboxFrame)}
      {compose || chosen ? (
        <FloatingDiscussion
          inputMethod={inputMethod}
          {...(compose?.placeAt === undefined ? {} : { placeAt: compose.placeAt })}
          key={compose ? `compose-${compose.key}` : chosen!.id}
          anchor={compose?.anchor ?? chosen!.anchor}
          threadId={chosen?.id}
          anchorOrphaned={chosen?.orphaned === true}
          anchorUnavailable={
            chosen?.orphaned === true ||
            onTarget(compose?.target ?? chosen!.target, {
              view: () => (compose?.target ?? chosen!.target) !== model.viewTarget,
              note: ({ path }) => path !== props.selectedNotePath,
              project: () => false,
            })
          }
          title={
            chosen?.orphaned && !compose
              ? anchorLabel(chosen.anchor, anchorScope(chosen.target))
              : scopeLabel(compose?.anchor ?? chosen!.anchor, compose?.target ?? chosen!.target)
          }
          onClose={() => onClose()}
          {...(compose
            ? {}
            : {
                onPressOutside: () => {
                  setSelected(null);
                  setPreview(null);
                },
              })}
          onRetain={() => {
            cancelPreviewClose();
            if (chosen && !compose) {
              setSelected(chosen.id);
              setPreview(null);
            }
          }}
        >
          {compose ? (
            <Composer
              requestKey={compose.key}
              anchor={compose.anchor}
              anchorLabel={scopeLabel(compose.anchor, compose.target)}
              choices={walking || props.commentScopes?.choices ? props.diagramChoices : []}
              showAbout={walking || props.commentScopes?.choices}
              keep={{ scope: commentDraftScope(), target: compose.target, baseRevision: props.composeRevision ?? null }}
              scopeGuard={props.commentScopes?.guard}
              {...(props.composeAnchorGone === undefined ? {} : { anchorGone: props.composeAnchorGone })}
              onSave={async (anchor, body, typedOn, expectedModelRevision) => {
                const saved =
                  expectedModelRevision === undefined
                    ? await model.actions.create(compose.target, anchor, body)
                    : await model.actions.create(compose.target, anchor, body, expectedModelRevision);
                if (!saved) return false;
                if (typedOn()) return true;
                if (props.inlineNoteDiscussions && targetParts(saved.target).kind === "note") {
                  props.onOpenInlineNoteThread?.(saved.id);
                } else {
                  // This discussion was created on the canvas before its pin existed. Closing it
                  // returns to that new pin, just as reopening an existing pin does.
                  pinOpener.current = document.querySelector(
                    `[data-pin-thread="${CSS.escape(saved.id)}"][role="button"]`,
                  );
                  createdPin.current = saved.id;
                  focusRequested.current = saved.id;
                  setSelected(saved.id);
                }
                props.onComposeEnd();
                return true;
              }}
              onCancel={() => onClose()}
            />
          ) : chosen ? (
            <ThreadCard
              thread={chosen}
              scopeLabel={
                chosen.orphaned
                  ? anchorLabel(chosen.anchor, anchorScope(chosen.target))
                  : scopeLabel(chosen.anchor, chosen.target)
              }
              draftScope={commentDraftScope()}
              passageMissing={passageMissing}
              pin={chosenPin}
              scope={anchorScope(chosen.target)}
              active={selected === chosen.id}
              inlineReply={targetParts(chosen.target).kind === "view"}
              hideAnchorHeading
              onShow={() => {
                props.onOpenTarget?.(chosen.target);
                if (chosen.orphaned !== true) props.onShowAnchor?.(chosen.anchor);
              }}
              onReply={(body) => model.actions.reply(chosen, body)}
              onEdit={(id, body) => model.actions.edit(chosen, id, body)}
              onDelete={async (id) => {
                const removed = await model.actions.remove(chosen, id);
                if (removed && chosen.comments.length === 1) onClose(true);
                return removed;
              }}
              onResolve={async () => {
                const resolved = await model.actions.resolve(chosen);
                if (resolved) onClose(true);
                return resolved;
              }}
              onDismiss={async () => {
                const dismissed = await model.actions.dismiss(chosen);
                if (dismissed) onClose(true);
                return dismissed;
              }}
            />
          ) : null}
          {model.error ? (
            <div className="archer-review-error" role="alert">
              <p>{model.error}</p>
              <button type="button" className="archer-review-link" onClick={model.actions.dismissError}>
                Dismiss
              </button>
            </div>
          ) : null}
          <PublishingControls model={model} />
        </FloatingDiscussion>
      ) : null}
      <p className="archer-visually-hidden archer-review-announcer" role="status" aria-live="polite">
        {model.announcement === null
          ? ""
          : `${model.announcement.text}${model.announcement.key % 2 === 0 ? "\u00a0" : ""}`}
      </p>
      {!compose && !chosen && model.error ? (
        <div className="primary-review-error archer-review-error" role="alert">
          <p>{model.error}</p>
          <button type="button" onClick={model.actions.dismissError}>
            Dismiss
          </button>
        </div>
      ) : null}
    </>
  );
}
