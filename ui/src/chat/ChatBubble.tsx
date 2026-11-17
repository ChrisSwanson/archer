/**
 * The chat bubble (ADR 0034 §10), app-wide: a launcher that can sit anywhere, and the chat it
 * opens about the document on screen. This is the controller; the pieces are `ChatLauncher`,
 * `ChatPanel` and the pure rules in `chat-*.ts`. Not drawn under MCP Apps (the host's chat is one).
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import { useMediaQuery } from "../app/media";
import { DOCK_QUERY, foldDockSheets, useDockSheet } from "../app/stage-dock";
import type { CommentsTransport } from "../comments/transport";
import type { ReviewModel } from "../comments/useReview";
import { browserReviewStorage } from "../comments/review-seen";
import { ChatLauncher } from "./ChatLauncher";
import { PANEL_MOVED } from "./movable";
import { PROJECT_TARGET, type CommentContext, type TargetRef } from "../comments/contract";
import type { ExampleMessage } from "../app/runtime.ts";
import { ChatPanel, type ChatMode, type ChatScopeOption } from "./ChatPanel";
import { growFrom, shrinkInto } from "./chat-motion";
import {
  EDGE_PX,
  LAUNCHER_PX,
  clampPoint,
  defaultPoint,
  fromFraction,
  readPosition,
  toFraction,
  within,
  writePosition,
  type Point,
  type Rect,
  type Win,
} from "./chat-position";
import { alsoSends, retryChat, sendChat, type ChatIntent } from "./chat-send";
import {
  browserDraftStorage,
  chatDraftKey,
  watchClaim,
  commentDraftScope,
  dropDraft,
  takeDraft,
  forgetChatDraft,
  keepChatDraft,
  readChatDraft,
} from "../comments/comment-draft";
import { chatTarget, pickThread, type ChatDocument, type ChatScope } from "./chat-target";
import { clampDock, clampSize, placeChat, readPrefs, writePrefs, type ChatPrefs } from "./chat-window";
import { AGENT_DELIVERY, type AgentDelivery } from "./chat-status";
import {
  httpListenerTransport,
  LAUNCH_WAIT_MS,
  listenerKey,
  ListenerRouteError,
  mayChoose,
  PERSON_ONLY,
  useListeners,
  type ListenerTransport,
  type Listing,
} from "./listeners";
import "./chat.css";

/** What the walkthrough panel and the others take of the stage row, apart from the drawing and this sidebar. */
const othersWidth = (row: HTMLElement, host: HTMLElement | null): number =>
  [...row.children].reduce(
    (sum, el) => (el === host || el.classList.contains("archer-stage") ? sum : sum + (el as HTMLElement).offsetWidth),
    0,
  );

/** What the corner keeps clear of, on the drawing. */
const CHROME =
  ".archer-diagram-key, .archer-diagram-modes, .archer-emph-legend, .archer-compile-notice, .react-flow__controls, .archer-canvas-controls";

const winSize = (): Win => ({ w: window.innerWidth, h: window.innerHeight });
const boxOf = (p: Point): Rect => ({ left: p.x, top: p.y, right: p.x + LAUNCHER_PX, bottom: p.y + LAUNCHER_PX });
const rectOf = (r: DOMRect): Rect => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });

function measureCorner(win: Win): Point {
  const content = document.querySelector(".archer-diagram-content")?.getBoundingClientRect();
  const whole =
    content === undefined || content.width === 0 ? { left: 0, top: 0, right: win.w, bottom: win.h } : rectOf(content);
  // A side panel opened over the drawing (a walkthrough in a narrow window) takes its right side: the corner is left of it.
  const over = document.querySelector(".archer-diagram-panel[data-overlay]")?.getBoundingClientRect();
  const area = over === undefined || over.width === 0 ? whole : { ...whole, right: Math.min(whole.right, over.left) };
  const zones = [...document.querySelectorAll(CHROME)]
    .map((el) => rectOf(el.getBoundingClientRect()))
    .filter((z) => z.right > z.left);
  return defaultPoint(area, zones, win);
}

/** One conversation's text, as the bubble holds it: given back from an earlier visit, and an uncertain Send's identity. */
type Typed = {
  readonly key: string;
  readonly text: string;
  readonly restored: boolean;
  readonly sending: ChatIntent | null;
};
/** Uncertain Sends by project and conversation, for the page's life (the bubble remounts with its document). */
const heldIntents = new Map<string, ChatIntent>();

export function ChatBubble(props: {
  readonly review: ReviewModel;
  readonly transport: CommentsTransport;
  readonly doc: ChatDocument;
  /** The document's name: the chat's heading and the launcher's accessible name. */
  readonly title: string;
  /** The project's name, for the project conversation; "This project" without one. */
  readonly projectTitle?: string;
  /** Where the person is sending from (page and file), told to the agent with every message. */
  readonly context?: CommentContext;
  /** Where the sidebar goes, beside the walkthrough panel; `null` where there is no stage (a note). */
  readonly sidebarHost: HTMLElement | null;
  /** The phone's dock strip, when there is one: the chat is a sheet over it. */
  readonly dockHost: HTMLElement | null;
  /** Advances each time the page asks for the chat (`C` with nothing selected). */
  readonly openRequest: number;
  /** Advances each time the page asks for the project conversation by name: the chat opens on it. */
  readonly projectRequest?: number;
  /** Advances each time the page needs the chat out of the way (a discussion opened, Esc on the page). */
  readonly closeRequest: number;
  /** Told when the chat opens or closes, so the page can close what it would overlap. */
  readonly onOpenChange?: (open: boolean) => void;
  /**
   * Unsent drafts by conversation, held by the page as well, for a browser that will not keep them: the text is kept
   * in this browser (comment-draft.ts `keepChatDraft`) and this map only stands in when that is refused.
   */
  readonly drafts?: Map<string, string>;
  /** The project a draft is kept under (comment-draft.ts `commentDraftScope`); this page's address by default. */
  readonly draftScope?: string;
  /** The listener routes (ADR 0035 §7–8); tests pass one held in memory. */
  readonly listenerTransport?: ListenerTransport;
  /**
   * A runtime with no service (the Playground): each conversation is this example, labelled as one, and nothing
   * can be sent (`RuntimeExamples`). The live page has none.
   */
  readonly example?: {
    readonly note: string;
    messages(target: TargetRef): readonly ExampleMessage[] | null;
  };
}): JSX.Element | null {
  const { review, transport, doc } = props;
  const storage = useMemo(browserReviewStorage, []);
  const ids = useId();
  const [prefs, setPrefs] = useState<ChatPrefs>(() => readPrefs(storage));
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const [pos, setPos] = useState<Point | null>(() => readPosition(storage));
  const [win, setWin] = useState<Win>(winSize);
  const [corner, setCorner] = useState<Point | null>(null);
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<ChatScope>("walkthrough");
  // What it is about: the project alone on a page with no document, else the person's choice (the walkthrough
  // only while one is open).
  const effective: ChatScope =
    doc.projectOnly === true || scope === "project" ? "project" : doc.walk != null ? scope : "diagram";
  const own = useRef(new Map<string, string>());
  const kept = props.drafts ?? own.current;
  // A draft per conversation: the diagram's, the walkthrough's and the project's do not mix. Kept in this browser
  // (codex-201, O100): a reload, a closed and reopened tab and leaving give it back, said as restored, with Discard.
  const draftKey =
    effective === "project"
      ? PROJECT_TARGET
      : doc.notePath != null
        ? `note:${doc.notePath}`
        : `view:${doc.viewId ?? ""}`;
  const aim = chatTarget(doc, effective);
  const draftScope = useMemo(() => props.draftScope ?? commentDraftScope(), [props.draftScope]);
  const draftStorage = useMemo(browserDraftStorage, []);
  const heldKey = `${draftScope}\0${draftKey}`;
  const loadDraft = (key: string): Typed => {
    const stored = aim === null ? null : readChatDraft(draftStorage, draftScope, aim.target, aim.anchor);
    if (stored !== null)
      return {
        key,
        text: stored.body,
        restored: true,
        sending: stored.sending ?? heldIntents.get(`${draftScope}\0${key}`) ?? null,
      };
    return {
      key,
      text: kept.get(`${draftScope}\0${key}`) ?? "",
      restored: false,
      sending: heldIntents.get(`${draftScope}\0${key}`) ?? null,
    };
  };
  const [typed, setTyped] = useState<Typed>(() => loadDraft(draftKey));
  const current = typed.key === draftKey ? typed : loadDraft(draftKey);
  useEffect(() => {
    if (typed.key !== draftKey) setTyped(loadDraft(draftKey));
  }, [draftKey]);
  /** Another open tab keeps its own message in this conversation (claude-201). */
  const [elsewhere, setElsewhere] = useState(false);
  /** A closed tab's message in this conversation, offered: "Use it here" or Discard (the ownership rule, O117). */
  const [offer, setOffer] = useState<{ readonly onUse: () => void; readonly onDiscard: () => void } | null>(null);
  useEffect(() => {
    // Another tab's message never comes back here by itself (O117): said to be there while that tab is open, else offered.
    setElsewhere(false);
    setOffer(null);
    if (aim === null || typedRef.current.text !== "") return;
    let live = true;
    const key = draftKey,
      stored = chatDraftKey(draftScope, aim.target, aim.anchor);
    void watchClaim(
      draftStorage,
      stored,
      (claim) => {
        setElsewhere(claim.elsewhere);
        const other = claim.offer;
        setOffer(
          other === null
            ? null
            : {
                onUse: () => {
                  void takeDraft(draftStorage, stored, other).then((took) => {
                    if (
                      !took &&
                      aim !== null &&
                      readChatDraft(draftStorage, draftScope, aim.target, aim.anchor) !== null
                    )
                      return;
                    setOffer(null);
                    if (took && typedRef.current.key === key && typedRef.current.text === "") setTyped(loadDraft(key));
                  });
                },
                onDiscard: () => {
                  dropDraft(draftStorage, other);
                  setOffer(null);
                },
              },
        );
      },
      () => live,
    );
    return () => {
      live = false;
    };
  }, [draftKey, draftScope]);
  const draft = current.text;
  /** The browser would not keep the text: said before the person relies on it. */
  const [unkept, setUnkept] = useState(false);
  const typedRef = useRef(current);
  typedRef.current = current;
  /** Keeps `next` (and what an uncertain Send left) for this conversation, in this browser and in the page. */
  const keepDraft = (next: Typed): void => {
    setTyped(next);
    typedRef.current = next;
    if (next.sending === null) heldIntents.delete(heldKey);
    else heldIntents.set(heldKey, next.sending);
    if (next.text.trim() === "") {
      kept.delete(heldKey);
      if (aim !== null) forgetChatDraft(draftStorage, draftScope, aim.target, aim.anchor);
      setUnkept(false);
      return;
    }
    kept.set(heldKey, next.text);
    if (aim === null) return;
    const ok = keepChatDraft(draftStorage, {
      version: 1,
      scope: draftScope,
      target: aim.target,
      anchor: aim.anchor,
      threadId: thread?.id ?? null,
      body: next.text,
      savedAt: Date.now(),
      sending: next.sending,
    });
    setUnkept(!ok);
  };
  const setDraft = (text: string): void =>
    keepDraft({ ...typedRef.current, key: draftKey, text, restored: typedRef.current.restored && text !== "" });
  const discardDraft = (): void => keepDraft({ key: draftKey, text: "", restored: false, sending: null });
  const [failed, setFailed] = useState<string | null>(null);
  /** How the failed send ended: refused ("Not sent"), or no answer and still a draft ("May not have been sent"). */
  const [failedKind, setFailedKind] = useState<"refused" | "unsure">("refused");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const [glide, setGlide] = useState(false);
  const [menu, setMenu] = useState<Point | null>(null);
  const [dockMax, setDockMax] = useState(560);
  const phone = useMediaQuery(DOCK_QUERY);
  const launcher = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLElement | null>(null);
  const grow = useRef<Rect | null>(null);
  const refocus = useRef(false);
  const placed = useRef({ x: 0, y: 0 });

  // Who receives the messages, while the service has listeners (read when the chat opens, kept by its event).
  const listenersOn = review.capabilities?.listeners === true;
  const ownListeners = useMemo(() => httpListenerTransport(), []);
  const { listing, unreachable, pin, refresh } = useListeners(
    props.listenerTransport ?? ownListeners,
    listenersOn,
    open,
  );
  const delivery = useSteadyDelivery(listenersOn ? deliveryOf(listing, unreachable) : AGENT_DELIVERY);
  // Pin and Launch are the person's alone (review decision 1). A `person_only` refusal settles it for this visit.
  const [notPerson, setNotPerson] = useState(false);
  const personal = !notPerson && mayChoose(listing);
  const refused = (error: unknown, doing: string): string => {
    if (error instanceof ListenerRouteError && error.code === PERSON_ONLY) {
      setNotPerson(true);
      return `Only the person signed in to Archer on this computer can ${doing}.`;
    }
    return `Could not ${doing}: ${reason(error)}`;
  };
  // A launch waits for the listener state to change (the launched agent claiming, a claim lapsing, a pin): until
  // then Launch cannot start a second agent (L10, decision 25). Compared by state, never by listing object: a
  // refreshed listing that says the same, or the stream dropping and coming back, is no change. Each press is its own
  // attempt (decision 40): its answer and its LAUNCH_WAIT_MS act only while it is the one waiting.
  const [launched, setLaunched] = useState<{ readonly id: number; readonly at: string | null } | undefined>(undefined);
  const attempts = useRef(0);
  const waitingFor = useRef<number | null>(null);
  const endLaunch = useCallback((): void => {
    waitingFor.current = null;
    setLaunched(undefined);
  }, []);
  // The key a launch ran out of time at: a listener claiming after that clears the notice it did not start.
  const [lapsedAt, setLapsedAt] = useState<string | null | undefined>(undefined);
  const key = listenerKey(listing);
  const launchPending = launched !== undefined && (key === null || key === launched.at);
  useEffect(() => {
    if (launched !== undefined && key !== null && key !== launched.at) endLaunch();
  }, [key, launched, endLaunch]);
  // A launched agent that has not claimed within LAUNCH_WAIT_MS is not coming: Launch is offered again (decision 33).
  const pendingId = launchPending ? launched.id : null;
  useEffect(() => {
    if (pendingId === null || launched === undefined) return;
    const at = launched.at;
    const timer = setTimeout(() => {
      if (waitingFor.current !== pendingId) return;
      setLapsedAt(at);
      endLaunch();
      setNotice(LAUNCH_LAPSED);
    }, LAUNCH_WAIT_MS);
    return () => clearTimeout(timer);
  }, [pendingId, launched, endLaunch]);
  useEffect(() => {
    if (lapsedAt === undefined || key === null || key === lapsedAt) return;
    setLapsedAt(undefined);
    if (listing?.current.listener != null) setNotice((said) => (said === LAUNCH_LAPSED ? null : said));
  }, [key, lapsedAt, listing]);
  const nobodyLive = listing !== null && (listing.current.state === "none" || listing.current.away === true);

  const threads = aim === null ? undefined : review.threads.get(aim.target);
  const thread = aim === null ? undefined : pickThread(threads, aim.anchor);
  // The step this thread's message is on in the delivery order (ADR 0035, amended 2026-10-31). The person's alone (D10):
  // the service sends it to nobody else, and the page shows it to nobody else either.
  const pending =
    thread === undefined || !personal ? undefined : listing?.pending?.find((step) => step.threadId === thread.id);
  const side = !phone && prefs.mode === "side" && props.sidebarHost !== null;
  const mode: ChatMode = phone ? "sheet" : side ? "side" : "float";
  const what =
    effective === "project"
      ? "the whole project"
      : doc.notePath != null
        ? "this note"
        : effective === "walkthrough"
          ? "this walkthrough"
          : "this diagram";
  const scopes: readonly ChatScopeOption[] =
    doc.projectOnly === true
      ? []
      : [
          ...(doc.walk != null && doc.notePath == null ? [{ id: "walkthrough" as const, label: "Walkthrough" }] : []),
          { id: "diagram" as const, label: doc.notePath != null ? "This note" : "This diagram" },
          { id: "project" as const, label: "Whole project" },
        ];
  // The conversation's name: the document's, or the project's.
  const heading = effective === "project" ? (props.projectTitle ?? "This project") : props.title;

  // Unread: an agent reply on a document-level thread this viewer has not seen.
  const unread = useMemo(
    () =>
      (threads ?? []).filter(
        (t) =>
          t.status !== "resolved" &&
          (t.anchor.kind === "view" ||
            t.anchor.kind === "project" ||
            (t.anchor.kind === "walkthrough" && t.anchor.walkthrough === doc.walk?.id)) &&
          review.isUnread?.(t) === true,
      ).length,
    [threads, review, doc.walk?.id],
  );
  const label =
    props.example !== undefined
      ? `Example chat about ${heading}`
      : `Chat with the agent about ${heading}${unread === 0 ? "" : unread === 1 ? ", 1 new reply" : `, ${unread} threads with new replies`}`;

  // The window, and the corner (clear of the key, the legend and the walkthroughs' button).
  useEffect(() => {
    const onResize = (): void => setWin(winSize());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // One observer set, built once per document (not per resize), and none at all while the person has put the
  // launcher somewhere: the corner is only for the launcher that has not been moved.
  const placedByPerson = pos !== null;
  useEffect(() => {
    if (placedByPerson) return;
    let frame = 0;
    const measure = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = measureCorner(winSize());
        setCorner((held) => (held !== null && held.x === next.x && held.y === next.y ? held : next));
      });
    };
    const size = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    const seen = new Set<Element>();
    const watchChrome = (): void => {
      for (const el of [document.querySelector(".archer-diagram-content"), ...document.querySelectorAll(CHROME)]) {
        if (el !== null && !seen.has(el)) {
          seen.add(el);
          size?.observe(el);
        }
      }
    };
    watchChrome();
    measure();
    // Chrome comes and goes with the stage's children (the key, the walkthroughs' button, the legend, a notice).
    const stage = document.querySelector(".archer-stage");
    const watch = new MutationObserver(() => {
      watchChrome();
      measure();
    });
    if (stage !== null) watch.observe(stage, { childList: true, subtree: true });
    window.addEventListener("resize", measure);
    // The key or the legend was moved (`movable.tsx`): the corner is measured again against where they are now.
    window.addEventListener(PANEL_MOVED, measure);
    return () => {
      cancelAnimationFrame(frame);
      watch.disconnect();
      size?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener(PANEL_MOVED, measure);
    };
  }, [placedByPerson, doc.viewId, doc.notePath, phone]);

  const at = clampPoint(
    pos !== null ? fromFraction(pos, win) : (corner ?? { x: win.w - LAUNCHER_PX - 16, y: win.h - LAUNCHER_PX - 16 }),
    win,
  );
  const size = clampSize(prefs, win);
  const place = placeChat(boxOf(at), size, win);
  placed.current = place;

  // The sidebar's room: what the walkthrough panel and the drawing's minimum leave of the row, measured again
  // whenever the row or its other children (the panel, which has its own divider) change size.
  const row = props.sidebarHost?.parentElement ?? null;
  useLayoutEffect(() => {
    if (row === null || !side) return;
    const room = (): void =>
      setDockMax(clampDock(Number.MAX_SAFE_INTEGER, row.clientWidth, othersWidth(row, props.sidebarHost)));
    room();
    if (typeof ResizeObserver !== "function") return;
    const watch = new ResizeObserver(room);
    watch.observe(row);
    for (const el of row.children)
      if (el !== props.sidebarHost && !el.classList.contains("archer-stage")) watch.observe(el);
    return () => watch.disconnect();
  }, [row, side, props.sidebarHost, doc.walk?.id]);
  const dockWidth = Math.min(Math.max(prefs.dw, 280), dockMax);

  const say = (text: string): void => setSaid(text);
  const save = (next: ChatPrefs): void => {
    setPrefs(next);
    prefsRef.current = next;
    writePrefs(storage, next);
  };

  const openChat = useCallback(() => {
    grow.current = launcher.current === null || phone ? null : rectOf(launcher.current.getBoundingClientRect());
    setOpen(true);
    setMenu(null);
  }, [phone]);
  const collapse = useCallback(() => {
    refocus.current = true;
    const done = (): void => setOpen(false);
    if (panel.current === null || phone) done();
    else shrinkInto(panel.current, boxOf(at), done);
  }, [phone, at.x, at.y]);
  useEffect(() => {
    if (!open && refocus.current) {
      refocus.current = false;
      launcher.current?.focus({ preventScroll: true });
    }
  }, [open]);
  const { closeRequest } = props;
  const told = useRef(props.onOpenChange);
  told.current = props.onOpenChange;
  useEffect(() => {
    told.current?.(open);
  }, [open]);
  // The page needs the room (a discussion opened): out of the way, without taking focus back.
  const closed = useRef(closeRequest);
  useEffect(() => {
    if (closeRequest === closed.current) return;
    closed.current = closeRequest;
    setOpen(false);
    setMenu(null);
  }, [closeRequest]);
  const asked = useRef(props.openRequest);
  useEffect(() => {
    if (props.openRequest === asked.current) return;
    asked.current = props.openRequest;
    if (open) panel.current?.querySelector("textarea")?.focus();
    else openChat();
  }, [props.openRequest, open, openChat]);
  const askedProject = useRef(props.projectRequest ?? 0);
  useEffect(() => {
    const now = props.projectRequest ?? 0;
    if (now === askedProject.current) return;
    askedProject.current = now;
    setScope("project");
    if (!open) openChat();
  }, [props.projectRequest, open, openChat]);
  // One sheet at a time, on a phone: opening a dock chip's sheet closes this one.
  useDockSheet(props.dockHost, open && phone, () => setOpen(false));

  const setPanel = useCallback((el: HTMLElement | null) => {
    panel.current = el;
    if (el !== null && grow.current !== null) {
      growFrom(el, grow.current);
      grow.current = null;
    }
  }, []);

  // The project's conversation is read when the chat is opened on it, unless the review model holds it already;
  // its `comments` events keep it current from then on (wave 2 review, finding 20).
  const projectOpen = open && effective === "project";
  const loadRef = useRef(review.actions.load);
  loadRef.current = review.actions.load;
  useEffect(() => {
    if (projectOpen) loadRef.current?.(PROJECT_TARGET);
  }, [projectOpen]);
  // Reading it clears the dot.
  useEffect(() => {
    if (open && thread !== undefined && review.isUnread?.(thread) === true) review.actions.markSeen?.(thread);
  }, [open, thread, review]);
  // A thread of another document, or a new conversation, has no failed send.
  useEffect(() => {
    if (failed !== null && thread?.id !== failed) setFailed(null);
  }, [thread?.id, failed]);

  const after = (
    target: NonNullable<typeof aim>["target"],
    thread: import("../comments/contract").Thread | undefined,
    sent: boolean,
  ): void => {
    if (thread !== undefined) review.actions.ingest?.(sent ? { ...thread, status: "sent" } : thread);
    review.actions.refresh?.(target);
  };
  const send = async (): Promise<void> => {
    const body = draft.trim();
    if (aim === null || body === "" || sending) return;
    setSending(true);
    setNotice(null);
    const out = await sendChat(
      transport,
      {
        ...aim,
        ...(thread === undefined ? {} : { thread }),
        body,
        ...(props.context === undefined ? {} : { context: props.context }),
      },
      { held: current.sending, active: () => mounted.current },
    );
    setSending(false);
    if (out.status === "earlier") {
      // The earlier version is there: told, and its identity let go, so the next Send is the person's choice. Unread: kept.
      if (out.landed !== null) keepDraft({ ...typedRef.current, sending: null });
      setNotice(out.reason);
      if (out.landed !== null) after(aim.target, undefined, false);
      return;
    }
    if (out.status === "unsaved") {
      keepDraft({ ...typedRef.current, sending: out.intent ?? null });
      setNotice(`Not saved: ${out.reason}. Your message is still here.`);
      return;
    }
    if (out.status === "unsure" && out.stage === "save") {
      // No answer: the text stays, with the identity the next Send repeats; what Archer holds is read again.
      keepDraft({ ...typedRef.current, sending: out.intent });
      setNotice(out.reason);
      after(aim.target, undefined, false);
      return;
    }
    const now = typedRef.current;
    keepDraft(
      now.text.trim() === body
        ? { key: draftKey, text: "", restored: false, sending: null }
        : { ...now, sending: null },
    );
    const unsure = out.status === "unsure";
    setFailed(out.status === "failed" || unsure ? out.threadId : null);
    setFailedKind(unsure ? "unsure" : "refused");
    if (unsure) setNotice(out.reason);
    after(
      aim.target,
      out.status === "sent" || out.status === "failed" || unsure ? out.thread : undefined,
      out.status === "sent",
    );
    // A send is told once, by the conversation's own "Sent" tick; only a failure needs the status line.
    say(out.status === "sent" ? "" : out.status === "failed" ? `Not sent: ${out.reason}. Use Retry.` : "");
  };
  const retry = async (): Promise<void> => {
    if (aim === null || failed === null || sending) return;
    setSending(true);
    const out = await retryChat(transport, aim.target, failed, { active: () => mounted.current });
    setSending(false);
    if (out.status === "sent") {
      setFailed(null);
      setNotice(null);
    } else if (out.status === "unsure") {
      setFailedKind("unsure");
      setNotice(out.reason);
    } else setFailedKind("refused");
    after(
      aim.target,
      out.status === "unsure" && out.stage === "submit" && out.thread !== undefined ? out.thread : thread,
      out.status === "sent",
    );
    say(out.status === "sent" ? "" : out.status === "failed" ? `Not sent: ${out.reason}. Use Retry.` : "");
  };

  // The launcher: dragged (the chat follows every frame, by transform), nudged, or sent to the corner.
  const follow = (to: Point): void => {
    if (!open || mode !== "float" || panel.current === null) return;
    const next = placeChat(boxOf(to), size, win);
    panel.current.style.transform = `translate(${next.x - placed.current.x}px, ${next.y - placed.current.y}px)`;
  };
  const remember = (to: Point, glideTo: boolean): void => {
    const f = toFraction(clampPoint(to, win), win);
    setGlide(glideTo);
    setPos(f);
    writePosition(storage, f);
  };
  const toCorner = (): void => {
    setGlide(true);
    setPos(null);
    writePosition(storage, null);
    say("Chat button moved to the corner.");
  };

  const resize = (dx: number, dy: number, commit: boolean): void => {
    const p = prefsRef.current;
    let changed = false;
    if (!commit || dx !== 0 || dy !== 0) {
      if (mode === "side") {
        const next = {
          ...p,
          dw: clampDock(p.dw - dx, row?.clientWidth ?? win.w, row === null ? 0 : othersWidth(row, props.sidebarHost)),
        };
        changed = next.dw !== p.dw;
        setPrefs(next);
        prefsRef.current = next;
      } else {
        const s = clampSize(
          { w: p.w + (place.corner[1] === "l" ? -dx : dx), h: p.h + (place.corner[0] === "t" ? -dy : dy) },
          win,
        );
        const next = { ...p, ...s };
        changed = next.w !== p.w || next.h !== p.h;
        setPrefs(next);
        prefsRef.current = next;
      }
    }
    if (commit) {
      writePrefs(storage, prefsRef.current);
      if (changed) say("Chat resized.");
    }
  };
  const setMode = (to: "float" | "side"): void => {
    grow.current = panel.current === null ? null : rectOf(panel.current.getBoundingClientRect());
    save({ ...prefsRef.current, mode: to });
    say(to === "side" ? "Chat expanded into a sidebar." : "Chat is a floating window.");
  };

  if (aim === null) return null;
  const panelStyle =
    mode === "sheet"
      ? {}
      : mode === "side"
        ? { width: dockWidth }
        : { left: place.x, top: place.y, width: size.w, height: size.h };
  const chat = open ? (
    <ChatPanel
      mode={mode}
      title={heading}
      what={what}
      thread={props.example === undefined ? thread : undefined}
      {...(props.example === undefined
        ? {}
        : { example: { messages: props.example.messages(aim.target) ?? [], note: props.example.note } })}
      failed={failed !== null && failed === thread?.id ? (failedKind === "unsure" ? "unsure" : true) : false}
      sending={sending}
      alsoSends={failed !== null || current.sending?.body === draft.trim() ? 0 : alsoSends(thread)}
      notice={notice}
      delivery={delivery}
      {...(pending === undefined ? {} : { pending })}
      {...(listenersOn
        ? {
            listing,
            unreachable,
            canPick: personal,
            onPin: (agentId: string | null) => {
              setNotice(null);
              // A lost answer is read back (O125): said as chosen, as not chosen, or as not known yet; never "Could not".
              pin(agentId).then(
                (outcome) => {
                  if (outcome === "chosen")
                    say(agentId === null ? "Messages go to whichever agent claims this checkout." : "Agent chosen.");
                  else if (outcome === "not-chosen")
                    setNotice(
                      agentId === null
                        ? "Archer did not answer, and it still reads as before, so the agent you chose still receives the messages. Choose again to give the role back."
                        : "Archer did not answer, and it still reads as before, so that agent was not chosen. Choose it again.",
                    );
                  else
                    setNotice(
                      agentId === null
                        ? "Archer did not answer, so it is not known yet whether the role was given back. The list is read again."
                        : "Archer did not answer, so it is not known yet whether that agent was chosen. The list is read again.",
                    );
                },
                (error: unknown) => setNotice(refused(error, "choose that agent")),
              );
            },
            // No Launch while the service is starting an agent for this message itself.
            canLaunch: personal && listing?.launcher === true && nobodyLive && pending?.step !== "launching",
            launchPending,
            onLaunch: () => {
              if (thread === undefined || launchPending) return;
              setNotice(null);
              setLapsedAt(undefined);
              const id = ++attempts.current;
              waitingFor.current = id;
              setLaunched({ id, at: key });
              (props.listenerTransport ?? ownListeners).launch(thread.id).then(
                () => {
                  if (waitingFor.current === id)
                    setNotice("Asked your launch command to start an agent in this project.");
                },
                (error: unknown) => {
                  if (waitingFor.current !== id) return;
                  // No answer (the network dropped it): the launch may have run. Not said as refused; Launch keeps waiting
                  // as after an answered one (the service launches once per message), and the listing is read again.
                  if (error instanceof TypeError) {
                    setNotice(
                      "Archer did not answer, so it is not known yet whether your launch command started an agent. This waits for it, as after a launch.",
                    );
                    refresh();
                    return;
                  }
                  endLaunch();
                  setNotice(refused(error, "launch an agent"));
                  // Refused (busy, no launcher, someone listens): the page's view was old, so read it again (decision 32).
                  if (!(error instanceof ListenerRouteError && error.code === PERSON_ONLY)) refresh();
                },
              );
            },
          }
        : {})}
      scope={scopes.length > 1 ? effective : null}
      scopes={scopes}
      draft={draft}
      restored={current.restored}
      maybeSent={current.sending !== null && current.sending.body === draft.trim()}
      elsewhere={elsewhere}
      {...(offer !== null && draft === "" ? { offer } : {})}
      unkept={unkept}
      onDiscard={discardDraft}
      style={panelStyle}
      corner={place.corner}
      width={mode === "side" ? dockWidth : size.w}
      max={mode === "side" ? dockMax : clampSize({ w: Infinity, h: 0 }, win).w}
      canExpand={props.sidebarHost !== null}
      panelId={`${ids}-chat`}
      panelRef={setPanel}
      onDraft={setDraft}
      onSend={() => void send()}
      onRetry={() => void retry()}
      onResolve={() => {
        if (thread !== undefined)
          void review.actions.resolve(thread).then((done) => {
            if (done) {
              setFailed(null);
              say("Resolved. The next message starts a new conversation.");
            }
          });
      }}
      onScope={(next) => {
        setScope(next);
        setNotice(null);
      }}
      onCollapse={collapse}
      onMode={setMode}
      onResize={resize}
    />
  ) : null;

  return (
    <>
      {side && open ? null : (
        <ChatLauncher
          ref={launcher}
          at={at}
          win={win}
          label={label}
          describedBy={`${ids}-hint`}
          controls={`${ids}-chat`}
          expanded={open}
          unread={unread > 0}
          glide={glide}
          onToggle={() => (open ? collapse() : openChat())}
          onDrag={follow}
          onDragStart={() => foldDockSheets(props.dockHost)}
          onDrop={(to) => {
            if (panel.current !== null) panel.current.style.transform = "";
            remember(to, false);
          }}
          onMove={(to) => {
            remember(to, true);
            say("Chat button moved.");
          }}
          onCorner={toCorner}
          onMenu={setMenu}
        />
      )}
      <p id={`${ids}-hint`} className="archer-visually-hidden">
        Drag it, or use the arrow keys, to move it. Home returns it to the corner.
      </p>
      <p role="status" className="archer-visually-hidden">
        {said}
      </p>
      {menu === null ? null : (
        <CornerMenu
          at={menu}
          onPick={() => {
            setMenu(null);
            toCorner();
            launcher.current?.focus();
          }}
          onClose={(refocus) => {
            setMenu(null);
            if (refocus) launcher.current?.focus();
          }}
        />
      )}
      {chat === null
        ? null
        : mode === "side" && props.sidebarHost !== null
          ? createPortal(chat, props.sidebarHost)
          : chat}
    </>
  );
}

/** What the status line says of delivery: the listing's state, "checking" while it is read, "can't tell" once that gave up. */
function deliveryOf(listing: Listing | null, unreachable: boolean): AgentDelivery {
  if (listing === null) return { kind: unreachable ? "unreachable" : "unknown" };
  const { state, listener, away } = listing.current;
  if (state === "listening") return listener === null ? { kind: "none" } : { kind: "listening", host: listener.host };
  if (state === "next-turn" && away === true) return { kind: "away" };
  return { kind: state };
}

/** How long a listener may be between two waits before the line stops saying "Listening". */
const WAIT_GAP_MS = 5_000;
const LAUNCH_LAPSED = "The launched agent did not start listening. Check your launch command, or press Launch again.";

/**
 * The delivery the status line shows. A listener's `archer wait` returns every ten minutes and is called again at
 * once: the listing says "next turn" for that moment. Shown as it is, the line (a live region) would announce
 * each cycle (L9), so a step from listening to the same host's next turn waits WAIT_GAP_MS; every other change,
 * "unknown" and "none" above all, shows at once.
 */
function useSteadyDelivery(delivery: AgentDelivery): AgentDelivery {
  const [shown, setShown] = useState(delivery);
  const key = JSON.stringify(delivery);
  useEffect(() => {
    if (key === JSON.stringify(shown)) return;
    if (shown.kind === "listening" && delivery.kind === "next-turn") {
      const timer = setTimeout(() => setShown(delivery), WAIT_GAP_MS);
      return () => clearTimeout(timer);
    }
    setShown(delivery);
    return undefined;
    // `delivery` is read through `key`: a new object with the same meaning is no change.
  }, [key, shown]);
  // Never shows "listening" when the listing says otherwise for longer than the gap; anything else is immediate.
  return shown.kind === "listening" && delivery.kind === "next-turn" ? shown : delivery;
}
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The launcher's right-click menu: one item, the keyboard reset's twin. Kept inside the window; closes when focus leaves it. */
function CornerMenu(props: {
  readonly at: Point;
  readonly onPick: () => void;
  readonly onClose: (refocus: boolean) => void;
}): JSX.Element {
  const item = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<Point>(props.at);
  useLayoutEffect(() => {
    const el = menu.current;
    if (el === null) return;
    setPlace({
      x: within(props.at.x, EDGE_PX, window.innerWidth - el.offsetWidth - EDGE_PX),
      y: within(props.at.y, EDGE_PX, window.innerHeight - el.offsetHeight - EDGE_PX),
    });
  }, [props.at.x, props.at.y]);
  useEffect(() => {
    item.current?.focus();
    const away = (event: PointerEvent): void => {
      if (!(event.target as Element).closest(".archer-chat-menu")) props.onClose(true);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, []);
  return (
    <div
      ref={menu}
      className="archer-chat-menu"
      role="menu"
      style={{ left: place.x, top: place.y }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) props.onClose(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          props.onClose(true);
        } else if (event.key === "Tab") props.onClose(true);
      }}
    >
      <button ref={item} type="button" role="menuitem" onClick={props.onPick}>
        Move to corner <kbd>Home</kbd>
      </button>
    </div>
  );
}
