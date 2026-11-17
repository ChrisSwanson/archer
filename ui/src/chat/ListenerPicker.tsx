/**
 * The chat's recipient (ADR 0035 §7): who gets the person's messages, and the list to choose another from. Only
 * the agents in the checkout on screen can be chosen: an agent listens only to the checkout it works in (review
 * decision 15). Other checkouts of the same repository follow under their own heading as information ("Listening
 * in X", "No agent in X"), never as choices. A pick pins that agent as this checkout's listener (an agent's claim
 * then does not take over); "Whichever agent claims it" gives the role back. Only the person may pick (`canPick`,
 * review decisions 1 and 23); anyone else sees the same row as text. A listener silent for two minutes is tagged
 * "away". Always one row while the service has listeners, so nothing moves when the listing arrives; the list opens
 * over the conversation.
 */
import { useEffect, useId, useRef, useState, type JSX, type KeyboardEvent } from "react";
import type { ListenerStatus } from "../../../ts/src/agents/contract";
import type { AgentInfo, Listing, ListenerState } from "./listeners";

/** What a listener is doing, said only as the listing says it. */
const STATE_TAG: Record<ListenerState, string | null> = {
  listening: "listening",
  "next-turn": "next turn",
  none: null,
};

type Option = {
  readonly key: string;
  readonly agentId: string | null;
  readonly label: string;
  readonly tag: string | null;
};

const tagFor = (status: ListenerStatus, a: AgentInfo): string | null =>
  status.listener?.agentId !== a.agentId ? null : status.away === true ? "away" : STATE_TAG[status.state];

/** This checkout's choices: its agents, and the way back to "whichever claims it" once the person pinned one. */
function choices(listing: Listing): readonly Option[] {
  const { current } = listing;
  return [
    ...(current.pinnedByPerson ? [{ key: "any", agentId: null, label: "Whichever agent claims it", tag: null }] : []),
    ...current.agents.map((a) => ({ key: a.agentId, agentId: a.agentId, label: a.label, tag: tagFor(current, a) })),
  ];
}

/** Another checkout's line: who listens there, said as the listing says it. */
function elsewhere(c: Listing["otherCheckouts"][number]): { readonly text: string; readonly detail: string | null } {
  if (c.state === "none" || c.listener === null) return { text: `No agent in ${c.name}`, detail: null };
  const tag = c.away === true ? "away" : c.state === "next-turn" ? "next turn" : null;
  return { text: `Listening in ${c.name}`, detail: tag === null ? c.listener.label : `${c.listener.label} · ${tag}` };
}

export function ListenerPicker(props: {
  readonly listing: Listing | null;
  /** The listing could not be read (its retries gave up). */
  readonly unreachable?: boolean;
  /** The viewer may choose (the person); else the row is text only. */
  readonly canPick: boolean;
  readonly onPin: (agentId: string | null) => void;
}): JSX.Element {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const { listing } = props;
  // A claim that lapsed names nobody (M10): the row says what the status line says.
  const chosen = listing === null || listing.current.state === "none" ? null : listing.current.listener;
  const away = listing?.current.away === true;
  const name =
    listing === null
      ? props.unreachable === true
        ? "Can't tell who is listening"
        : "Checking who is listening…"
      : chosen === null
        ? "No agent is listening"
        : away
          ? `${chosen.label} · away`
          : chosen.label;
  const options = listing === null ? [] : choices(listing);
  const others = listing === null ? [] : listing.otherCheckouts;
  const selected = (o: Option): boolean => (o.agentId === null ? false : o.agentId === chosen?.agentId);

  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) trigger.current?.focus({ preventScroll: true });
  };
  const items = (): HTMLElement[] => [...(list.current?.querySelectorAll<HTMLElement>("[role=option]") ?? [])];
  useEffect(() => {
    if (!open) return;
    // With no options the note itself takes focus, so Escape and Tab reach the list's keys, not the chat's.
    const first = items().find((el) => el.getAttribute("aria-selected") === "true") ?? items()[0] ?? list.current;
    first?.focus({ preventScroll: true });
    const away = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!list.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const pick = (o: Option): void => {
    close(true);
    if (!selected(o)) props.onPin(o.agentId);
  };
  // Losing the person's authority, or the listing, closes an open list.
  useEffect(() => {
    if (open && (!props.canPick || listing === null)) setOpen(false);
  }, [open, props.canPick, listing]);
  const keys = (event: KeyboardEvent<HTMLDivElement>): void => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const to = (i: number): void => {
      event.preventDefault();
      if (all.length > 0) all[(i + all.length) % all.length]?.focus({ preventScroll: true });
    };
    if (event.key === "ArrowDown") to(at + 1);
    else if (event.key === "ArrowUp") to(at - 1);
    else if (event.key === "Home") to(0);
    else if (event.key === "End") to(all.length - 1);
    else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") close(false);
  };

  // While the listing is read the row is the (disabled) button already, so nothing moves when it arrives.
  if (!props.canPick && listing !== null) {
    return (
      <div className="archer-chat-to">
        <span className="archer-chat-to-label">To</span>
        <span className="archer-chat-to-pick" data-readonly="true">
          <span>{name}</span>
        </span>
      </div>
    );
  }
  // Other checkouts: information under their own heading, outside the listbox (nothing there to choose).
  const info =
    others.length === 0 ? null : (
      <div className="archer-chat-to-elsewhere" id={`${ids}-elsewhere`}>
        <div className="archer-chat-to-head" id={`${ids}-elsewhere-head`}>
          Other checkouts
        </div>
        <ul aria-labelledby={`${ids}-elsewhere-head`}>
          {others.map((c) => {
            const line = elsewhere(c);
            return (
              <li key={c.root} className="archer-chat-to-info">
                <span>{line.text}</span>
                {line.detail === null ? null : <span className="archer-chat-to-detail">{line.detail}</span>}
              </li>
            );
          })}
        </ul>
      </div>
    );
  return (
    <div className="archer-chat-to">
      <span className="archer-chat-to-label" id={`${ids}-to`}>
        To
      </span>
      <button
        ref={trigger}
        type="button"
        className="archer-chat-to-pick"
        aria-haspopup={options.length === 0 ? "dialog" : "listbox"}
        aria-expanded={open}
        aria-controls={open ? `${ids}-list` : undefined}
        aria-labelledby={`${ids}-to ${ids}-name`}
        disabled={listing === null}
        onClick={() => setOpen((now) => !now)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span id={`${ids}-name`}>{name}</span>
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5 5 6.5 8 3.5" />
        </svg>
      </button>
      {!open ? null : options.length === 0 ? (
        // Nothing to choose: a note, not an empty listbox.
        <div
          ref={list}
          id={`${ids}-list`}
          className="archer-chat-to-list"
          role="dialog"
          aria-label="Send messages to"
          tabIndex={-1}
          onKeyDown={keys}
        >
          <p className="archer-chat-to-empty">
            No agent sessions in this checkout yet. Start one in this project and it appears here.
          </p>
          {info}
        </div>
      ) : (
        // biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move through the listbox inside it (APG listbox); the options are the focusable parts.
        <div ref={list} className="archer-chat-to-list" onKeyDown={keys}>
          <div
            id={`${ids}-list`}
            role="listbox"
            aria-label="Send messages to"
            {...(info === null ? {} : { "aria-describedby": `${ids}-elsewhere` })}
          >
            <div role="group" aria-labelledby={`${ids}-here`}>
              <div className="archer-chat-to-head" id={`${ids}-here`} role="presentation">
                This checkout
              </div>
              {options.map((o) => (
                <div
                  key={o.key}
                  role="option"
                  tabIndex={-1}
                  aria-selected={selected(o)}
                  className="archer-chat-to-option"
                  onClick={() => pick(o)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      pick(o);
                    }
                  }}
                >
                  <span>{o.label}</span>
                  {o.tag === null ? null : <span className="archer-chat-to-tag">{o.tag}</span>}
                </div>
              ))}
            </div>
          </div>
          {info}
        </div>
      )}
    </div>
  );
}
