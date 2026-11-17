/**
 * The chat itself (ADR 0034 §10): a non-modal dialog about one document, a conversation of
 * message bubbles, and a composer that grows upward. It is a floating window, a sidebar beside
 * the walkthrough panel, or (on a phone) a bottom sheet; the controller (`ChatBubble`) decides which.
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
} from "react";
import type { Thread } from "../comments/contract";
import type { ExampleMessage } from "../app/runtime.ts";
import type { PendingDelivery } from "../../../ts/src/agents/contract";
import { AgentGlyph } from "../comments/ThreadCard";
import { DraftKept } from "../comments/DraftKept";
import { composerHeight } from "./chat-window";
import { chatStatus, type AgentDelivery } from "./chat-status";
import { ListenerPicker } from "./ListenerPicker";
import type { Listing } from "./listeners";
import type { ChatScope } from "./chat-target";
import { useGrip } from "../app/use-grip";

export type ChatMode = "float" | "side" | "sheet";
export type { ChatScope };
/**
 * An example conversation in place of a live one (a runtime with no service, `RuntimeExamples`): its messages are
 * shown as the conversation and its note stands where the composer would, so nothing can be sent.
 */
export type ChatExample = { readonly messages: readonly ExampleMessage[]; readonly note: string };
/** One choice of the "Talk about" switch. */
export type ChatScopeOption = { readonly id: ChatScope; readonly label: string };

const ICON = {
  float: <path d="M6.5 3H3v10h10V9.5M9 2.5h4.5V7M13.5 2.5 7.5 8.5" stroke="currentColor" strokeWidth="1.5" />,
  expand: <path d="M9 2.5h4.5V7M13.5 2.5 8.5 7.5M7 13.5H2.5V9M2.5 13.5l5-5" stroke="currentColor" strokeWidth="1.5" />,
  collapse: <path d="M3.5 8h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />,
};
const icon = (name: keyof typeof ICON): JSX.Element => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    {ICON[name]}
  </svg>
);

export function ChatPanel(props: {
  readonly mode: ChatMode;
  readonly title: string;
  /** Shows this example instead of a thread, and no composer. */
  readonly example?: ChatExample;
  readonly what: string;
  readonly thread: Thread | undefined;
  /** The last send was refused (true), or got no answer and is still a draft ("unsure"). */
  readonly failed: boolean | "unsure";
  readonly sending: boolean;
  readonly alsoSends: number;
  readonly notice: string | null;
  /** How the agent gets messages, for the status line: it pulls, or the listener's state (ADR 0035 §8). */
  readonly delivery?: AgentDelivery;
  /** The step this thread's message is on in the delivery order, when it is on one (ADR 0035, amended 2026-10-31). */
  readonly pending?: PendingDelivery;
  /**
   * Who receives the messages, when the service has listeners: the recipient row and its picker. `undefined`
   * without the capability (no row); `null` while the listing is being read.
   */
  readonly listing?: Listing | null;
  /** The listing could not be read (its retries gave up): the row says it cannot tell. */
  readonly unreachable?: boolean;
  readonly onPin?: (agentId: string | null) => void;
  /** The viewer is the person (review decision 1): the picker can choose; else it is text only. */
  readonly canPick?: boolean;
  /** Nobody listens (or the listener is away), the viewer is the person and set a launcher: the status line offers Launch. */
  readonly canLaunch?: boolean;
  /** A launch was asked for and the listener state has not changed since: Launch waits (no second agent). */
  readonly launchPending?: boolean;
  readonly onLaunch?: () => void;
  /** What it is about now; `null` where there is nothing to choose (the project page's chat). */
  readonly scope: ChatScope | null;
  /** The choices, in order, when there are several. */
  readonly scopes?: readonly ChatScopeOption[];
  readonly draft: string;
  /** The text came back from an earlier visit (comment-draft.ts): said so, with Discard. */
  readonly restored?: boolean;
  /** This browser would not keep the text. */
  readonly unkept?: boolean;
  readonly onDiscard?: () => void;
  /** The restored text's last Send got no answer (its identity is kept): it may already have been sent. */
  readonly maybeSent?: boolean;
  /** Another open tab keeps its own message in this conversation. */
  readonly elsewhere?: boolean;
  /** A closed tab's message here, offered (O117). */
  readonly offer?: { readonly onUse: () => void; readonly onDiscard: () => void };
  readonly style: CSSProperties;
  readonly corner: string;
  readonly width: number;
  /** The widest it can be now (the window's or the row's room), for the separator's value range. */
  readonly max: number;
  readonly canExpand: boolean;
  readonly panelId: string;
  readonly panelRef: (el: HTMLElement | null) => void;
  readonly onDraft: (text: string) => void;
  readonly onSend: () => void;
  readonly onRetry: () => void;
  readonly onResolve: () => void;
  readonly onScope: (scope: ChatScope) => void;
  readonly onCollapse: () => void;
  readonly onMode: (mode: "float" | "side") => void;
  /** A change in the pointer's or key's position since the last call; `commit` ends the gesture (remembered). */
  readonly onResize: (dx: number, dy: number, commit: boolean) => void;
}): JSX.Element {
  const eyebrow = useId();
  const heading = useId();
  const log = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLElement | null>(null);
  const { panelRef } = props;
  const setRoot = useCallback(
    (el: HTMLElement | null): void => {
      root.current = el;
      panelRef(el);
    },
    [panelRef],
  );
  const example = props.example;
  const comments: readonly { readonly id: string; readonly author: string; readonly body: string }[] =
    example === undefined
      ? (props.thread?.comments ?? [])
      : example.messages.map((message, at) => ({ id: `example-${at}`, ...message }));
  const status =
    example !== undefined
      ? null
      : chatStatus(props.thread, props.failed, props.sending, props.delivery, props.canLaunch === true, props.pending);
  const tick = status?.text ?? null;

  // The composer grows upward (the bottom edge is fixed) and the log stays on the newest message. It is fitted
  // again whenever the room changes: the text, a notice or the "Also sends" line, the window's size, or the
  // row resizing a side or sheet panel (which has no size of its own to depend on).
  const fit = useCallback((): void => {
    const el = root.current,
      ta = area.current,
      lg = log.current;
    if (el === null || ta === null || lg === null) return;
    ta.style.height = "auto";
    const fixedH = el.clientHeight - lg.offsetHeight - ta.offsetHeight;
    const box = composerHeight({ chatH: el.clientHeight, fixedH, scrollH: ta.scrollHeight });
    ta.style.height = `${box.height}px`;
    ta.style.overflowY = box.scrolls ? "auto" : "hidden";
    lg.scrollTop = lg.scrollHeight;
  }, []);
  useLayoutEffect(fit, [
    fit,
    props.draft,
    props.style.height,
    props.style.width,
    props.mode,
    comments.length,
    tick,
    status?.hint,
    status?.launch,
    props.notice,
    props.alsoSends,
    props.scope,
    props.restored,
    props.unkept,
  ]);
  useEffect(() => {
    if (root.current === null || typeof ResizeObserver !== "function") return;
    const watch = new ResizeObserver(fit);
    watch.observe(root.current);
    return () => watch.disconnect();
  }, [fit, props.mode]);
  useLayoutEffect(() => {
    // An example has no composer: the conversation takes focus, so the keyboard can read and scroll it.
    (area.current ?? log.current)?.focus({ preventScroll: true });
  }, [props.mode]);

  const keys = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.onCollapse();
      return;
    }
    // The chat's keys are its own: the page behind it must not take `C`, arrows or Escape.
    event.stopPropagation();
  };
  const grip = useGrip(props.onResize);
  const resizing = {
    tabIndex: 0,
    "aria-orientation": "vertical",
    "aria-valuenow": Math.round(props.width),
    "aria-valuemin": 280,
    "aria-valuemax": Math.round(props.max),
    ...grip,
  } as const;

  return (
    <section
      ref={setRoot}
      id={props.panelId}
      className="archer-chat"
      data-mode={props.mode}
      data-corner={props.corner}
      role={props.mode === "side" ? "complementary" : "dialog"}
      aria-labelledby={`${eyebrow} ${heading}`}
      style={props.style}
      onKeyDown={keys}
    >
      {props.mode === "side" ? (
        <div
          role="separator"
          {...resizing}
          className="archer-chat-edge"
          aria-label="Resize chat sidebar. Arrow keys change its width."
        />
      ) : props.mode === "float" ? (
        <div
          role="separator"
          {...resizing}
          className="archer-chat-grip"
          aria-label="Resize chat window. Arrow keys change its size."
        >
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 9 9 2M5.5 9 9 5.5" />
          </svg>
        </div>
      ) : null}
      <div className="archer-chat-head">
        <div className="archer-chat-title">
          <span id={eyebrow} className="archer-chat-eyebrow">
            {example === undefined ? "Chat with the agent" : "Example chat"}
          </span>
          <h2 id={heading}>{props.title}</h2>
        </div>
        <div className="archer-chat-acts">
          {props.thread === undefined || example !== undefined ? null : (
            <button type="button" onClick={props.onResolve}>
              Resolve
            </button>
          )}
          {props.mode === "side" ? (
            <button
              type="button"
              aria-label="Float as a window"
              title="Float as a window"
              onClick={() => props.onMode("float")}
            >
              {icon("float")}
            </button>
          ) : null}
          {props.mode === "float" && props.canExpand ? (
            <button
              type="button"
              aria-label="Expand into a sidebar"
              title="Expand into a sidebar"
              onClick={() => props.onMode("side")}
            >
              {icon("expand")}
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Collapse to the bubble"
            title="Collapse to the bubble"
            onClick={props.onCollapse}
          >
            {icon("collapse")}
          </button>
        </div>
      </div>
      {props.scope === null || props.scopes === undefined || props.scopes.length < 2 ? null : (
        <div className="archer-chat-switch" role="group" aria-label="Talk about">
          {props.scopes.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={props.scope === option.id}
              onClick={() => props.onScope(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
      {props.listing === undefined ? null : (
        <ListenerPicker
          listing={props.listing}
          unreachable={props.unreachable === true}
          canPick={props.canPick === true}
          onPin={(agentId) => props.onPin?.(agentId)}
        />
      )}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container is a Tab stop so a keyboard can scroll it (axe scrollable-region-focusable; UI_UX.md, RS1-02). */}
      <div ref={log} className="archer-chat-log" role="log" aria-live="polite" aria-label="Conversation" tabIndex={0}>
        {comments.length === 0 ? (
          <p className="archer-chat-empty">Nothing yet. Ask the agent about {props.what}.</p>
        ) : null}
        {comments.map((comment) => (
          <div key={comment.id} className="archer-chat-bub" data-author={comment.author}>
            {comment.author === "agent" ? (
              <div className="archer-chat-agent-who">
                <AgentGlyph />
                Agent
              </div>
            ) : null}
            <p>{comment.body}</p>
          </div>
        ))}
      </div>
      {/* The one status slot (D7): always mounted so a change is announced; empty takes no room. Its buttons sit
          beside it, outside the live region, so a change of line is not read with them. */}
      <div className="archer-chat-tick">
        <p role="status" data-testid="chat-status">
          {status === null ? null : (
            <>
              {status.text}
              {status.hint === undefined ? null : <span className="archer-chat-hint">{status.hint}</span>}
            </>
          )}
        </p>
        {status?.retry === true ? (
          <button type="button" onClick={props.onRetry}>
            Retry
          </button>
        ) : null}
        {status?.launch === true ? (
          <button
            type="button"
            className="archer-chat-launch"
            disabled={props.launchPending === true}
            onClick={props.onLaunch}
          >
            {props.launchPending === true ? "Launching an agent…" : "Launch an agent"}
          </button>
        ) : null}
      </div>
      {props.notice === null ? null : (
        <p className="archer-chat-note" role="alert">
          {props.notice}
        </p>
      )}
      {example !== undefined ? <p className="archer-chat-example">{example.note}</p> : null}
      {example === undefined && props.alsoSends > 0 ? (
        <p className="archer-chat-note">
          Also sends {props.alsoSends} {props.alsoSends === 1 ? "draft" : "drafts"}
        </p>
      ) : null}
      {example !== undefined ? null : (
        <DraftKept
          noun="message"
          action="Send it"
          body={props.draft}
          restored={props.restored === true}
          unkept={props.unkept === true}
          onDiscard={() => {
            props.onDiscard?.();
            area.current?.focus();
          }}
          {...(props.maybeSent === true ? { maybeSent: { verb: "Sending" } } : {})}
          elsewhere={props.elsewhere === true}
          {...(props.offer === undefined ? {} : { offer: props.offer })}
        />
      )}
      {example !== undefined ? null : (
        <form
          className="archer-chat-form"
          onSubmit={(event) => {
            event.preventDefault();
            props.onSend();
          }}
        >
          <label className="archer-visually-hidden" htmlFor={`${props.panelId}-text`}>
            Message to the agent
          </label>
          <textarea
            ref={area}
            id={`${props.panelId}-text`}
            rows={1}
            value={props.draft}
            placeholder="Message the agent"
            onChange={(event) => props.onDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                props.onSend();
              }
            }}
          />
          <button
            type="submit"
            className="archer-chat-send"
            aria-label="Send"
            disabled={props.draft.trim() === "" || props.sending}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2 8l11-5-4 11-2-4.5z" />
            </svg>
          </button>
        </form>
      )}
    </section>
  );
}
