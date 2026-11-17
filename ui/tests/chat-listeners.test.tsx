// @vitest-environment jsdom
// Who receives the chat's messages (ADR 0035 §7–8): the three honest delivery states, the recipient picker and
// Launch, against a listener transport held in memory and the window event the stream bridge raises.
import { StrictMode, useState, type JSX, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatBubble } from "../src/chat/ChatBubble";
import { AGENT_DELIVERY, chatStatus, deliveryLine, NONE_HINT, pendingLine } from "../src/chat/chat-status";
import { announceListeners, LISTENERS_LOST } from "../src/chat/listener-event";
import {
  httpListenerTransport,
  LAUNCH_WAIT_MS,
  useListeners,
  LISTING_FRESH_MS,
  LISTING_RETRY_MS,
  ListenerRouteError,
  mayChoose,
  parseListing,
  UNKNOWN_AFTER_MS,
  type ListenerTransport,
  type Listing,
} from "../src/chat/listeners";
import type { Thread } from "../src/comments/contract";
import type { CommentsTransport } from "../src/comments/transport";
import type { ReviewModel } from "../src/comments/useReview";
import type { AgentInfo, ListenerState, PendingDelivery } from "../../ts/src/agents/contract";

const SAVED = "Saved · the agent sees this the next time it checks";
const CHECKING = "Sent · checking whether an agent is listening";
const CANT_TELL = "Sent · can't tell whether an agent is listening";
const thread = (status: Thread["status"]): Thread => ({
  id: "t1",
  target: "view:containers",
  anchor: { kind: "view" },
  status,
  revision: 1,
  comments: [{ id: "c0", author: "person", body: "Hi", createdAt: "2026-10-26T10:00:00.000Z" }],
});
const agent = (id: string, label: string, host: AgentInfo["host"] = "claude-code"): AgentInfo => ({
  agentId: id,
  root: "/r",
  cwd: "/r",
  host,
  label,
  lastActive: "2026-10-26T10:00:00.000Z",
});
const CLAUDE = agent("a1", "Claude Code · ~/code/archer");
const CODEX = agent("a2", "Codex · ~/code/archer", "codex");
const WORKTREE = agent("w1", "Claude Code · ~/code/archer-wt");
/** A listing as the service sends it to the person (`personal: true`) unless `personal` says otherwise. */
function listing(
  state: ListenerState,
  extra: {
    listener?: AgentInfo | null;
    agents?: AgentInfo[];
    launcher?: boolean;
    pinned?: boolean;
    personal?: boolean;
  } = {},
): Listing {
  const listener = extra.listener !== undefined ? extra.listener : state === "none" ? null : CLAUDE;
  return {
    current: {
      root: "/r",
      state,
      listener,
      pinnedByPerson: extra.pinned ?? false,
      agents: extra.agents ?? (listener === null ? [] : [listener]),
    },
    otherCheckouts: [
      {
        root: "/r-wt",
        name: "worktree wt",
        state: "next-turn",
        listener: WORKTREE,
        pinnedByPerson: false,
        agents: [WORKTREE],
      },
    ],
    ...(extra.launcher === true ? { launcher: true } : {}),
    ...(extra.personal === undefined ? { personal: true } : { personal: extra.personal }),
  };
}
const withoutPersonal = (l: Listing): Listing => {
  const { personal: _, ...rest } = l;
  return rest;
};
/** A listing as the service's `listeners` event carries it: never `personal` or `launcher` (GET-only, the person's). */
const event = (l: Listing): Listing => {
  const { personal: _p, launcher: _l, ...rest } = l;
  return rest;
};
function listeners(first: Listing): ListenerTransport & {
  list: ReturnType<typeof vi.fn>;
  pin: ReturnType<typeof vi.fn>;
  launch: ReturnType<typeof vi.fn>;
} {
  return {
    list: vi.fn(async () => first),
    pin: vi.fn(async (agentId: string | null) => ({
      ...first.current,
      listener: agentId === null ? first.current.listener : agent(agentId, `picked ${agentId}`),
      pinnedByPerson: agentId !== null,
    })),
    launch: vi.fn(async () => undefined),
  };
}
function review(threads: Thread[], capable: boolean): ReviewModel {
  const actions = { markSeen: vi.fn(), ingest: vi.fn(), refresh: vi.fn(), resolve: vi.fn(async () => true) };
  return {
    threads: new Map([["view:containers", threads]]),
    isUnread: () => false,
    actions,
    capabilities: { comments: true, notes: true, ...(capable ? { listeners: true } : {}) },
  } as unknown as ReviewModel;
}
const comments = {} as CommentsTransport;
function mount(threads: Thread[], t: ListenerTransport, capable = true) {
  return render(
    <ChatBubble
      review={review(threads, capable)}
      transport={comments}
      listenerTransport={t}
      doc={{ viewId: "containers" }}
      title="Containers"
      sidebarHost={null}
      dockHost={null}
      openRequest={0}
      closeRequest={0}
    />,
  );
}
const fab = (): HTMLElement => screen.getByRole("button", { name: /Chat with the agent about Containers/ });
const status = (): HTMLElement => screen.getByTestId("chat-status");
const picker = (): HTMLElement => screen.getByRole("button", { name: /^To / });

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  window.localStorage.clear();
});
afterEach(cleanup);

describe("the delivery line (ADR 0035 §8)", () => {
  it("says the listing's state and nothing more", () => {
    expect(deliveryLine({ kind: "listening", host: "claude-code" })).toBe("Listening · Claude Code");
    expect(deliveryLine({ kind: "listening", host: "codex" })).toBe("Listening · Codex");
    expect(deliveryLine({ kind: "next-turn" })).toBe("Waiting for the agent's next turn");
    expect(deliveryLine({ kind: "none" })).toBe("No agent is listening in this checkout");
    expect(deliveryLine(AGENT_DELIVERY)).toBe(SAVED);
    for (const kind of ["next-turn", "none"] as const)
      expect(deliveryLine({ kind })).not.toMatch(/listening ·|delivered|read/i);
  });
  it("adds what to do when nobody listens, and Launch only when a launcher is configured", () => {
    expect(chatStatus(thread("sent"), false, false, { kind: "none" })).toEqual({
      text: "No agent is listening in this checkout",
      retry: false,
      hint: NONE_HINT,
    });
    expect(NONE_HINT).toMatch(/[Ss]tart an agent session in this project/);
    expect(chatStatus(thread("sent"), false, false, { kind: "none" }, true)?.launch).toBe(true);
    expect(chatStatus(thread("sent"), false, false, { kind: "next-turn" }, true)?.launch).toBeUndefined();
    // Read by the agent wins over any state: the listener fetched it.
    expect(chatStatus(thread("read"), false, false, { kind: "none" }, true)).toEqual({
      text: "Read by the agent",
      retry: false,
    });
  });
});

describe("parseListing", () => {
  it("reads the contract's listing and refuses anything else", () => {
    expect(parseListing(listing("listening", { launcher: true }))).toEqual(listing("listening", { launcher: true }));
    expect(
      parseListing({ ...listing("none"), current: { ...listing("none").current, state: "maybe" } }),
    ).toBeUndefined();
    expect(parseListing({ current: listing("none").current })).toBeUndefined();
    expect(parseListing(null)).toBeUndefined();
  });
  it("reads away and the viewer's authority, and never away for a lapsed claim", () => {
    const away = { ...listing("next-turn"), current: { ...listing("next-turn").current, away: true }, personal: false };
    expect(parseListing(away)).toEqual(away);
    expect(
      parseListing({ ...listing("none"), current: { ...listing("none").current, away: true } })?.current.away,
    ).toBeUndefined();
    expect(parseListing({ ...listing("none"), personal: "yes" })).not.toHaveProperty("personal");
  });
  it("lets only the service say who may choose: personal true, never the page's own address (decision 23)", () => {
    expect(mayChoose(null)).toBe(false);
    expect(mayChoose({ ...listing("none"), personal: false })).toBe(false);
    expect(mayChoose({ ...listing("none"), personal: true })).toBe(true);
    // Without the flag (on loopback too: jsdom's page is localhost) nobody may.
    expect(location.hostname).toBe("localhost");
    expect(mayChoose(withoutPersonal(listing("none")))).toBe(false);
  });
  it("cuts a label at 80 code points as the service counts them, never leaving half an emoji (decision 41)", () => {
    const label = `x${"😀".repeat(79)}`;
    const read = parseListing(listing("listening", { listener: agent("a1", label) }))?.current.listener?.label;
    expect(read).toBe(label);
    const cut =
      parseListing(listing("listening", { listener: agent("a1", `${label}😀😀`) }))?.current.listener?.label ?? "";
    expect(Array.from(cut)).toHaveLength(80);
    expect(cut).toBe(label);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
  it("never reads listening without a listener to name", () => {
    expect(
      parseListing({ ...listing("none"), current: { ...listing("none").current, state: "listening" } })?.current.state,
    ).toBe("none");
  });
});

describe("the delivery order's steps (ADR 0035, amended 2026-10-31)", () => {
  const UNTIL = "2026-10-31T12:02:00.000Z";
  const nextTurn = (host: AgentInfo["host"] = "claude-code", waitMs = 120_000): PendingDelivery => ({
    threadId: "t1",
    step: "next-turn",
    host,
    waitMs,
    until: UNTIL,
  });
  const launching: PendingDelivery = { threadId: "t1", step: "launching", until: UNTIL };

  it("says the active step in words a person reads at a glance", () => {
    expect(pendingLine(nextTurn())).toBe("Waiting 2 min for Claude Code's next turn, then launching an agent");
    expect(pendingLine(nextTurn("codex", 90_000))).toBe(
      "Waiting 1 min 30 s for Codex's next turn, then launching an agent",
    );
    expect(pendingLine(nextTurn("other", 45_000))).toBe(
      "Waiting 45 s for the agent's next turn, then launching an agent",
    );
    expect(pendingLine(launching)).toBe("Starting an agent for this message…");
  });

  it("the step wins over the listener's state for a sent message, and an agent starting offers no Launch", () => {
    expect(chatStatus(thread("sent"), false, false, { kind: "next-turn" }, true, nextTurn())).toEqual({
      text: "Waiting 2 min for Claude Code's next turn, then launching an agent",
      retry: false,
    });
    expect(chatStatus(thread("sent"), false, false, { kind: "none" }, true, launching)).toEqual({
      text: "Starting an agent for this message…",
      retry: false,
    });
    // Read, sending or failed say what they always said.
    expect(chatStatus(thread("read"), false, false, { kind: "none" }, true, launching)).toEqual({
      text: "Read by the agent",
      retry: false,
    });
    expect(chatStatus(thread("sent"), true, false, { kind: "none" }, true, launching)).toEqual({
      text: "Not sent",
      retry: true,
    });
  });

  it("parseListing reads the steps and drops one it cannot read", () => {
    const read = parseListing({
      ...listing("none"),
      pending: [nextTurn(), launching, { threadId: "t2", step: "teleport", until: UNTIL }, { step: "launching" }],
    });
    expect(read?.pending).toEqual([nextTurn(), launching]);
    expect(parseListing(listing("none"))).not.toHaveProperty("pending");
  });

  it("a viewer who is not the person never shows a step, even if one arrived (D10)", async () => {
    const t = listeners(listing("none", { personal: false }));
    mount([thread("sent")], t);
    fireEvent.click(fab());
    await waitFor(() => expect(status()).toHaveTextContent("No agent is listening in this checkout"));
    act(() => announceListeners({ ...event(listing("next-turn")), pending: [nextTurn()] }));
    expect(status()).toHaveTextContent("Waiting for the agent's next turn");
    expect(status()).not.toHaveTextContent(/launching/);
  });

  it("shows the step the event carries (the service sends it to the owner only, D10); while an agent starts, the person gets no Launch", async () => {
    const t = listeners(listing("none", { launcher: true }));
    mount([thread("sent")], t);
    fireEvent.click(fab());
    expect(await screen.findByRole("button", { name: "Launch an agent" })).toBeInTheDocument();
    act(() => announceListeners({ ...event(listing("next-turn")), pending: [nextTurn()] }));
    expect(status()).toHaveTextContent("Waiting 2 min for Claude Code's next turn, then launching an agent");
    act(() => announceListeners({ ...event(listing("none")), pending: [launching] }));
    expect(status()).toHaveTextContent("Starting an agent for this message…");
    expect(screen.queryByRole("button", { name: /Launch/ })).toBeNull();
    // Another thread's step is not this one's.
    act(() => announceListeners({ ...event(listing("none")), pending: [{ ...launching, threadId: "t9" }] }));
    expect(status()).toHaveTextContent("No agent is listening in this checkout");
    expect(screen.getByRole("button", { name: "Launch an agent" })).toBeInTheDocument();
  });
});

describe("the chat with listeners", () => {
  it("without the capability keeps 0.6.4's line, shows no recipient and asks nothing", async () => {
    const t = listeners(listing("listening"));
    mount([thread("sent")], t, false);
    fireEvent.click(fab());
    expect(status()).toHaveTextContent(SAVED);
    expect(screen.queryByRole("button", { name: /^To / })).toBeNull();
    await act(async () => {});
    expect(t.list).not.toHaveBeenCalled();
  });

  it("reads the listing once, when the chat opens, and says Listening · Claude Code only while the listing says listening", async () => {
    const t = listeners(listing("listening"));
    mount([thread("sent")], t);
    await act(async () => {});
    expect(t.list).not.toHaveBeenCalled();
    fireEvent.click(fab());
    // While it is read: the recipient row is there already (nothing moves), and the line says only what is true.
    expect(picker()).toBeDisabled();
    expect(status()).toHaveTextContent(CHECKING);
    await waitFor(() => expect(status()).toHaveTextContent("Listening · Claude Code"));
    expect(picker()).toHaveAccessibleName("To Claude Code · ~/code/archer");
    expect(t.list).toHaveBeenCalledTimes(1);
    // The service says the claim lapsed: at once, from the event, with no second read.
    act(() => announceListeners(event(listing("none"))));
    expect(status()).toHaveTextContent("No agent is listening in this checkout");
    expect(status()).toHaveTextContent(NONE_HINT);
    expect(picker()).toHaveAccessibleName("To No agent is listening");
    // Something the page cannot read changes nothing.
    act(() => announceListeners({ current: { state: "listening" } }));
    expect(status()).toHaveTextContent("No agent is listening in this checkout");
    expect(t.list).toHaveBeenCalledTimes(1);
  });

  it("a wait that ends and is called again is not announced; a listener that stays between waits is, after the gap", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const t = listeners(listing("listening"));
      mount([thread("sent")], t);
      fireEvent.click(fab());
      await waitFor(() => expect(status()).toHaveTextContent("Listening · Claude Code"));
      // `archer wait` returns after ten minutes and is called again at once: the line does not flip.
      act(() => announceListeners(event(listing("next-turn"))));
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      act(() => announceListeners(event(listing("listening"))));
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(status()).toHaveTextContent("Listening · Claude Code");
      // It stays between waits: after the gap, the next turn.
      act(() => announceListeners(event(listing("next-turn"))));
      expect(status()).toHaveTextContent("Listening · Claude Code");
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(status()).toHaveTextContent("Waiting for the agent's next turn");
      expect(screen.getByRole("dialog")).not.toHaveTextContent(/Listening ·/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never keeps Listening once the stream drops: unknown until a fresh listing, and a failed read is retried", async () => {
    const t = listeners(listing("listening"));
    mount([thread("sent")], t);
    fireEvent.click(fab());
    await waitFor(() => expect(status()).toHaveTextContent("Listening · Claude Code"));
    act(() => announceListeners(LISTENERS_LOST));
    expect(status()).toHaveTextContent(CHECKING);
    expect(picker()).toBeDisabled();
    // The stream is back but the read fails: still unknown, never the old listing; the retry finds a fresh one.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      t.list.mockRejectedValueOnce(new Error("offline"));
      t.list.mockResolvedValueOnce(listing("next-turn"));
      act(() => announceListeners(null));
      await waitFor(() => expect(t.list).toHaveBeenCalledTimes(2));
      await act(async () => {});
      expect(status()).toHaveTextContent(CHECKING);
      expect(status()).not.toHaveTextContent(/Listening ·/);
      await act(async () => {
        vi.advanceTimersByTime(LISTING_RETRY_MS[0]!);
      });
      await waitFor(() => expect(status()).toHaveTextContent("Waiting for the agent's next turn"));
      expect(t.list).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a read that keeps failing is retried with backoff, then says it can't tell (never checking for ever)", async () => {
    // Only the test moves the clock: a slow first render must not run a retry early.
    vi.useFakeTimers();
    try {
      const t = listeners(listing("listening"));
      t.list.mockRejectedValue(new Error("offline"));
      mount([thread("sent")], t);
      fireEvent.click(fab());
      await act(async () => {});
      expect(t.list).toHaveBeenCalledTimes(1);
      expect(status()).toHaveTextContent(CHECKING);
      for (const [i, wait] of LISTING_RETRY_MS.entries()) {
        // Not before the wait is over.
        await act(async () => {
          vi.advanceTimersByTime(wait - 1);
        });
        expect(t.list).toHaveBeenCalledTimes(i + 1);
        await act(async () => {
          vi.advanceTimersByTime(1);
        });
        expect(t.list).toHaveBeenCalledTimes(i + 2);
      }
      await act(async () => {});
      expect(status()).toHaveTextContent(CANT_TELL);
      expect(picker()).toHaveAccessibleName("To Can't tell who is listening");
      expect(picker()).toBeDisabled();
      // No more reads until something changes; a listing from the service is said at once.
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(t.list).toHaveBeenCalledTimes(LISTING_RETRY_MS.length + 1);
      act(() => announceListeners(event(listing("listening"))));
      expect(status()).toHaveTextContent("Listening · Claude Code");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a stream that drops and does not come back says it can't tell after a while", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const t = listeners(listing("listening"));
      mount([thread("sent")], t);
      fireEvent.click(fab());
      await waitFor(() => expect(status()).toHaveTextContent("Listening · Claude Code"));
      act(() => announceListeners(LISTENERS_LOST));
      expect(status()).toHaveTextContent(CHECKING);
      await act(async () => {
        vi.advanceTimersByTime(UNKNOWN_AFTER_MS);
      });
      expect(status()).toHaveTextContent(CANT_TELL);
      // It comes back: read again, and said.
      act(() => announceListeners(null));
      await waitFor(() => expect(status()).toHaveTextContent("Listening · Claude Code"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("tags an away listener in the row and the list, and offers Launch for it", async () => {
    const away = { ...listing("next-turn", { launcher: true, agents: [CLAUDE, CODEX] }) };
    const t = listeners({ ...away, current: { ...away.current, away: true } });
    mount([thread("sent")], t);
    fireEvent.click(fab());
    await waitFor(() => expect(picker()).toHaveAccessibleName("To Claude Code · ~/code/archer · away"));
    expect(status()).toHaveTextContent("The agent is away");
    expect(screen.getByRole("button", { name: "Launch an agent" })).toBeInTheDocument();
    fireEvent.click(picker());
    expect(within(screen.getByRole("listbox")).getAllByRole("option")[0]).toHaveTextContent(
      "Claude Code · ~/code/archeraway",
    );
  });

  it("without personal true (an older service, a LAN address) shows neither Pin nor Launch", async () => {
    const t = listeners(withoutPersonal(listing("none", { launcher: true, agents: [CODEX] })));
    mount([thread("sent")], t);
    fireEvent.click(fab());
    await waitFor(() => expect(status()).toHaveTextContent("No agent is listening in this checkout"));
    expect(screen.queryByRole("button", { name: /^To / })).toBeNull();
    expect(screen.queryByRole("button", { name: "Launch an agent" })).toBeNull();
  });

  it("keeps the read's personal and launcher across events, which never carry them", async () => {
    const t = listeners(listing("none", { launcher: true, agents: [CODEX] }));
    mount([thread("sent")], t);
    fireEvent.click(fab());
    await waitFor(() => expect(picker()).toBeEnabled());
    act(() => announceListeners(event(listing("none", { agents: [CODEX, CLAUDE] }))));
    expect(picker()).toBeEnabled();
    expect(screen.getByRole("button", { name: "Launch an agent" })).toBeInTheDocument();
  });

  it("offers Launch to the person only when the read names a launcher, and a later read can add or remove it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const t = listeners(listing("none", { agents: [CODEX] }));
      mount([thread("sent")], t);
      fireEvent.click(fab());
      await waitFor(() => expect(picker()).toBeEnabled());
      expect(screen.queryByRole("button", { name: "Launch an agent" })).toBeNull();
      // The person configures a launcher; events never say so. Reopening soon after reads nothing new.
      t.list.mockResolvedValue(listing("none", { launcher: true, agents: [CODEX] }));
      fireEvent.click(screen.getByRole("button", { name: /Close|Collapse/ }));
      fireEvent.click(fab());
      await act(async () => {});
      expect(t.list).toHaveBeenCalledTimes(1);
      // Reopened after LISTING_FRESH_MS: read again, and Launch is offered.
      fireEvent.click(screen.getByRole("button", { name: /Close|Collapse/ }));
      await act(async () => {
        vi.advanceTimersByTime(LISTING_FRESH_MS + 1);
      });
      fireEvent.click(fab());
      expect(await screen.findByRole("button", { name: "Launch an agent" })).toBeInTheDocument();
      expect(t.list).toHaveBeenCalledTimes(2);
      // Removed again: the next read after the window takes Launch away (decision 32).
      t.list.mockResolvedValue(listing("none", { agents: [CODEX] }));
      fireEvent.click(screen.getByRole("button", { name: /Close|Collapse/ }));
      await act(async () => {
        vi.advanceTimersByTime(LISTING_FRESH_MS + 1);
      });
      fireEvent.click(fab());
      await waitFor(() => expect(t.list).toHaveBeenCalledTimes(3));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Launch an agent" })).toBeNull());
      expect(picker()).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the recipient as text and no Launch to anyone but the person", async () => {
    const t = listeners(listing("none", { launcher: true, agents: [CODEX], personal: false }));
    mount([thread("sent")], t);
    fireEvent.click(fab());
    await waitFor(() => expect(status()).toHaveTextContent("No agent is listening in this checkout"));
    expect(screen.queryByRole("button", { name: /^To / })).toBeNull();
    expect(screen.getByText("No agent is listening", { selector: "span" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Launch an agent" })).toBeNull();
    // An event (which never carries the flag) does not make this viewer the person.
    act(() => announceListeners(event(listing("none", { agents: [CODEX] }))));
    expect(screen.queryByRole("button", { name: /^To / })).toBeNull();
  });

  it("a person_only refusal (an access link on this computer) says so plainly and hides Pin and Launch", async () => {
    const t = listeners(listing("none", { launcher: true, agents: [CODEX] }));
    t.launch.mockRejectedValueOnce(new ListenerRouteError("pin and launch are the person's", "person_only", 403));
    mount([thread("sent")], t);
    fireEvent.click(fab());
    fireEvent.click(await screen.findByRole("button", { name: "Launch an agent" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Only the person signed in to Archer on this computer can launch an agent.",
    );
    expect(screen.queryByRole("button", { name: /Launch/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^To / })).toBeNull();
    // A fresh listing does not bring them back for this visit.
    act(() => announceListeners(event(listing("none", { launcher: true, agents: [CODEX] }))));
    expect(screen.queryByRole("button", { name: /Launch/ })).toBeNull();
  });

  it("says the service's reason for a refused Launch and lets it be pressed again", async () => {
    const t = listeners(listing("none", { launcher: true }));
    t.launch.mockRejectedValueOnce(
      new ListenerRouteError("an agent was launched for this project moments ago", "launch_busy", 429),
    );
    mount([thread("sent")], t);
    fireEvent.click(fab());
    fireEvent.click(await screen.findByRole("button", { name: "Launch an agent" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not launch an agent: an agent was launched for this project moments ago",
    );
    expect(screen.getByRole("button", { name: "Launch an agent" })).toBeEnabled();
    // A refusal means the page's view may be old: it reads the listing again (decision 32).
    await waitFor(() => expect(t.list).toHaveBeenCalledTimes(2));
  });

  it("a Launch whose answer was lost is not said as refused: it is not known yet, and Launch waits (write sweep)", async () => {
    const t = listeners(listing("none", { launcher: true }));
    t.launch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    mount([thread("sent")], t);
    fireEvent.click(fab());
    fireEvent.click(await screen.findByRole("button", { name: "Launch an agent" }));
    expect(await screen.findByText(/not known yet whether your launch command started an agent/)).toBeInTheDocument();
    expect(screen.queryByText(/Could not launch/)).toBeNull();
    // Launch waits as after a launch that was answered: no second agent from a second press.
    expect(screen.getByRole("button", { name: /Launching an agent/ })).toBeDisabled();
    await waitFor(() => expect(t.list).toHaveBeenCalledTimes(2));
  });

  it("a Launch refused because the launcher was removed reads again and takes Launch away", async () => {
    const t = listeners(listing("none", { launcher: true }));
    t.launch.mockRejectedValueOnce(
      new ListenerRouteError("no launch command is configured", "launcher_not_configured", 409),
    );
    mount([thread("sent")], t);
    fireEvent.click(fab());
    const launch = await screen.findByRole("button", { name: "Launch an agent" });
    t.list.mockResolvedValue(listing("none"));
    fireEvent.click(launch);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not launch an agent: no launch command is configured",
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: /Launch/ })).toBeNull());
    expect(t.list).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alert")).toHaveTextContent("no launch command is configured");
  });

  it("a launched agent that never claims: after LAUNCH_WAIT_MS Launch is offered again, saying it did not start listening", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const t = listeners(listing("none", { launcher: true }));
      mount([thread("sent")], t);
      fireEvent.click(fab());
      fireEvent.click(await screen.findByRole("button", { name: "Launch an agent" }));
      expect(await screen.findByRole("button", { name: "Launching an agent…" })).toBeDisabled();
      await act(async () => {
        vi.advanceTimersByTime(LAUNCH_WAIT_MS - 1_000);
      });
      expect(screen.getByRole("button", { name: "Launching an agent…" })).toBeDisabled();
      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
      expect(screen.getByRole("button", { name: "Launch an agent" })).toBeEnabled();
      expect(screen.getByRole("alert")).toHaveTextContent("The launched agent did not start listening");
      fireEvent.click(screen.getByRole("button", { name: "Launch an agent" }));
      await waitFor(() => expect(t.launch).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it("each Launch is its own attempt: a late failure of the first neither ends the second nor stops its wait (decision 40)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const t = listeners(listing("none", { launcher: true }));
      let fail1!: (e: unknown) => void;
      t.launch.mockImplementationOnce(
        () =>
          new Promise<void>((_, r) => {
            fail1 = r;
          }),
      );
      t.launch.mockImplementationOnce(() => new Promise<void>(() => undefined));
      mount([thread("sent")], t);
      fireEvent.click(fab());
      fireEvent.click(await screen.findByRole("button", { name: "Launch an agent" }));
      await screen.findByRole("button", { name: "Launching an agent…" });
      await act(async () => {
        vi.advanceTimersByTime(LAUNCH_WAIT_MS);
      });
      fireEvent.click(screen.getByRole("button", { name: "Launch an agent" }));
      expect(t.launch).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("button", { name: "Launching an agent…" })).toBeDisabled();
      await act(async () => {
        vi.advanceTimersByTime(LAUNCH_WAIT_MS / 2);
      });
      await act(async () =>
        fail1(new ListenerRouteError("an agent was launched for this project moments ago", "launch_busy", 429)),
      );
      // Launch2 is still waiting, and nothing of Launch1 is said over it.
      expect(screen.getByRole("button", { name: "Launching an agent…" })).toBeDisabled();
      expect(screen.queryByRole("alert")?.textContent ?? "").not.toMatch(/moments ago/);
      // Launch2's own wait still ends at its own LAUNCH_WAIT_MS.
      await act(async () => {
        vi.advanceTimersByTime(LAUNCH_WAIT_MS / 2 - 1_000);
      });
      expect(screen.getByRole("button", { name: "Launching an agent…" })).toBeDisabled();
      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
      expect(screen.getByRole("button", { name: "Launch an agent" })).toBeEnabled();
      expect(screen.getByRole("alert")).toHaveTextContent("The launched agent did not start listening");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an agent that claims after the Launch wait ran out clears the notice that it did not start (decision 40)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const t = listeners(listing("none", { launcher: true }));
      mount([thread("sent")], t);
      fireEvent.click(fab());
      fireEvent.click(await screen.findByRole("button", { name: "Launch an agent" }));
      await screen.findByRole("button", { name: "Launching an agent…" });
      await act(async () => {
        vi.advanceTimersByTime(LAUNCH_WAIT_MS + 5_000);
      });
      expect(screen.getByRole("alert")).toHaveTextContent("The launched agent did not start listening");
      act(() => announceListeners(event(listing("listening"))));
      expect(status()).toHaveTextContent("Listening · Claude Code");
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the HTTP transport carries the service's refusal code", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: "person_only", message: "only the person" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );
    const failure = await httpListenerTransport(fetchImpl)
      .pin("a1")
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ListenerRouteError);
    expect(failure).toMatchObject({ code: "person_only", status: 403, message: "only the person" });
  });

  it("keeps Launch and Retry out of the announced status", async () => {
    const t = listeners(listing("none", { launcher: true }));
    mount([thread("sent")], t);
    fireEvent.click(fab());
    const launch = await screen.findByRole("button", { name: "Launch an agent" });
    expect(status()).not.toContainElement(launch);
    expect(status().querySelector("button")).toBeNull();
  });

  it("reads again after the stream reconnects, since it replays nothing", async () => {
    const t = listeners(listing("next-turn"));
    mount([thread("sent")], t);
    fireEvent.click(fab());
    await waitFor(() => expect(status()).toHaveTextContent("Waiting for the agent's next turn"));
    t.list.mockResolvedValueOnce(listing("listening"));
    act(() => announceListeners(null));
    await waitFor(() => expect(status()).toHaveTextContent("Listening · Claude Code"));
    expect(t.list).toHaveBeenCalledTimes(2);
  });

  it("offers Launch only when nobody listens and a launcher is configured, and launches this thread", async () => {
    const t = listeners(listing("none", { launcher: true }));
    mount([thread("sent")], t);
    fireEvent.click(fab());
    const launch = await screen.findByRole("button", { name: "Launch an agent" });
    fireEvent.click(launch);
    await waitFor(() => expect(t.launch).toHaveBeenCalledWith("t1"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Asked your launch command to start an agent");
    // Never "listening" because Launch was pressed: only the listing says so.
    expect(status()).toHaveTextContent("No agent is listening in this checkout");
    // Until the listener state changes Launch waits, so a second press cannot start a second agent.
    const waiting = screen.getByRole("button", { name: "Launching an agent…" });
    expect(waiting).toBeDisabled();
    fireEvent.click(waiting);
    expect(t.launch).toHaveBeenCalledTimes(1);
    // A fresh listing that says the same (a heartbeat, a reread), or the stream dropping and coming back, is no change.
    act(() => announceListeners(event(listing("none", { launcher: true }))));
    expect(screen.getByRole("button", { name: "Launching an agent…" })).toBeDisabled();
    act(() => announceListeners(LISTENERS_LOST));
    act(() => announceListeners(event(listing("none", { launcher: true }))));
    expect(screen.getByRole("button", { name: "Launching an agent…" })).toBeDisabled();
    // The launched agent claimed, and its claim lapsed: a change, so Launch may be pressed again.
    act(() => announceListeners(event(listing("listening", { launcher: true }))));
    expect(screen.queryByRole("button", { name: /Launch/ })).toBeNull();
    act(() => announceListeners(event(listing("none", { launcher: true }))));
    expect(screen.getByRole("button", { name: "Launch an agent" })).toBeEnabled();
    // An event never carries `launcher` (only the person's GET does), so one without it keeps Launch.
    act(() => announceListeners(event(listing("none"))));
    expect(screen.getByRole("button", { name: "Launch an agent" })).toBeEnabled();
    act(() => announceListeners(event(listing("next-turn", { launcher: true }))));
    expect(screen.queryByRole("button", { name: "Launch an agent" })).toBeNull();
  });
});

describe("the person's controls are never lost to an event (decision 31)", () => {
  it("an event before the chat first opens does not stand in for the read: the person still gets Pin and Launch", async () => {
    const t = listeners(listing("none", { launcher: true, agents: [CODEX] }));
    mount([thread("sent")], t);
    // An agent registers while the chat is closed: the service's event, with no personal and no launcher.
    act(() => announceListeners(event(listing("none", { agents: [CODEX, CLAUDE] }))));
    fireEvent.click(fab());
    await waitFor(() => expect(picker()).toBeEnabled());
    expect(t.list).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Launch an agent" })).toBeInTheDocument();
  });

  it("an event that overtakes an outstanding read keeps the read's personal and launcher, and the event's agents", async () => {
    const t = listeners(listing("none", { launcher: true, agents: [CODEX] }));
    let resolve!: (l: Listing) => void;
    t.list.mockImplementationOnce(
      () =>
        new Promise<Listing>((r) => {
          resolve = r;
        }),
    );
    mount([thread("sent")], t);
    fireEvent.click(fab());
    act(() => announceListeners(event(listing("listening", { agents: [CLAUDE, CODEX] }))));
    expect(status()).toHaveTextContent("Listening · Claude Code");
    // The read answers with what it saw before the event: its agents are older, its personal/launcher are not.
    await act(async () => resolve(listing("none", { launcher: true, agents: [CODEX] })));
    expect(status()).toHaveTextContent("Listening · Claude Code");
    expect(picker()).toBeEnabled();
    fireEvent.click(picker());
    expect(
      within(screen.getByRole("listbox"))
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([expect.stringContaining("Claude Code"), expect.stringContaining("Codex")]);
    expect(t.list).toHaveBeenCalledTimes(1);
  });

  it("after a reconnect while closed, an event before the next open still leaves the read to happen", async () => {
    const t = listeners(listing("none", { launcher: true, agents: [CODEX] }));
    mount([thread("sent")], t);
    act(() => announceListeners(null));
    act(() => announceListeners(event(listing("none", { agents: [CODEX] }))));
    fireEvent.click(fab());
    await waitFor(() => expect(picker()).toBeEnabled());
    expect(screen.getByRole("button", { name: "Launch an agent" })).toBeInTheDocument();
    expect(t.list).toHaveBeenCalledTimes(1);
  });

  it("a reconnect with the chat open: an event landing before the re-read answers keeps Pin and Launch", async () => {
    const t = listeners(listing("none", { launcher: true, agents: [CODEX] }));
    mount([thread("sent")], t);
    fireEvent.click(fab());
    await waitFor(() => expect(picker()).toBeEnabled());
    let resolve!: (l: Listing) => void;
    t.list.mockImplementationOnce(
      () =>
        new Promise<Listing>((r) => {
          resolve = r;
        }),
    );
    act(() => announceListeners(LISTENERS_LOST));
    act(() => announceListeners(null));
    await waitFor(() => expect(t.list).toHaveBeenCalledTimes(2));
    act(() => announceListeners(event(listing("none", { agents: [CODEX, CLAUDE] }))));
    await act(async () => resolve(listing("none", { launcher: true, agents: [CODEX] })));
    expect(picker()).toBeEnabled();
    expect(screen.getByRole("button", { name: "Launch an agent" })).toBeInTheDocument();
    fireEvent.click(picker());
    // The event is newer than the read: its two agents, not the read's one.
    expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(2);
  });
});

describe("the owner's read always settles (decision 39)", () => {
  it("a read in flight across close and reopen that then fails is tried again, and the person gets Pin and Launch", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let reject!: (e: unknown) => void;
      const t = listeners(listing("none", { launcher: true }));
      t.list.mockImplementationOnce(
        () =>
          new Promise((_, r) => {
            reject = r;
          }),
      );
      mount([thread("sent")], t);
      fireEvent.click(fab());
      await waitFor(() => expect(t.list).toHaveBeenCalledTimes(1));
      fireEvent.click(fab());
      fireEvent.click(fab());
      expect(t.list).toHaveBeenCalledTimes(1);
      await act(async () => {
        reject(new Error("net"));
      });
      await act(async () => {
        vi.advanceTimersByTime(LISTING_RETRY_MS[0]!);
      });
      await waitFor(() => expect(t.list).toHaveBeenCalledTimes(2));
      expect(await screen.findByRole("button", { name: "Launch an agent" })).toBeEnabled();
      expect(picker()).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a read that fails while the chat is closed is still tried again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let reject!: (e: unknown) => void;
      const t = listeners(listing("none", { launcher: true }));
      t.list.mockImplementationOnce(
        () =>
          new Promise((_, r) => {
            reject = r;
          }),
      );
      mount([thread("sent")], t);
      fireEvent.click(fab());
      await waitFor(() => expect(t.list).toHaveBeenCalledTimes(1));
      fireEvent.click(fab());
      await act(async () => {
        reject(new Error("net"));
      });
      await act(async () => {
        vi.advanceTimersByTime(LISTING_RETRY_MS[0]!);
      });
      await waitFor(() => expect(t.list).toHaveBeenCalledTimes(2));
      fireEvent.click(fab());
      expect(await screen.findByRole("button", { name: "Launch an agent" })).toBeEnabled();
      expect(t.list).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("mounted open under StrictMode, a first read that fails is tried again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const t = listeners(listing("none", { launcher: true }));
      t.list.mockRejectedValueOnce(new Error("net"));
      const { result } = renderHook(() => useListeners(t, true, true), {
        wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
      });
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(LISTING_RETRY_MS[0]!);
      });
      expect(t.list.mock.calls.map(() => "list")).toEqual(["list", "list"]);
      await waitFor(() => expect(result.current.listing?.launcher).toBe(true));
      expect(result.current.listing?.personal).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a Launch refused while a read is in flight reads once more after it, and that later answer takes Launch away", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const t = listeners(listing("none", { launcher: true }));
      mount([thread("sent")], t);
      fireEvent.click(fab());
      await screen.findByRole("button", { name: "Launch an agent" });
      fireEvent.click(fab());
      await act(async () => {
        vi.advanceTimersByTime(LISTING_FRESH_MS + 1_000);
      });
      // Reopened after LISTING_FRESH_MS: GET2 goes out and is slow; it saw the launcher before it was removed.
      let answer2!: (l: Listing) => void;
      t.list.mockImplementationOnce(
        () =>
          new Promise<Listing>((r) => {
            answer2 = r;
          }),
      );
      fireEvent.click(fab());
      await waitFor(() => expect(t.list).toHaveBeenCalledTimes(2));
      let answer3!: (l: Listing) => void;
      t.list.mockImplementationOnce(
        () =>
          new Promise<Listing>((r) => {
            answer3 = r;
          }),
      );
      t.launch.mockRejectedValueOnce(
        new ListenerRouteError("no launch command is configured", "launcher_not_configured", 409),
      );
      fireEvent.click(screen.getByRole("button", { name: "Launch an agent" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("no launch command is configured");
      // The refusal's read waits for GET2, then goes out once.
      expect(t.list).toHaveBeenCalledTimes(2);
      await act(async () => answer2(listing("none", { launcher: true })));
      await waitFor(() => expect(t.list).toHaveBeenCalledTimes(3));
      await act(async () => answer3(listing("none")));
      await waitFor(() => expect(screen.queryByRole("button", { name: /Launch/ })).toBeNull());
      expect(t.list).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes during one read queue exactly one more", async () => {
    const t = listeners(listing("none", { launcher: true }));
    let answer1!: (l: Listing) => void;
    t.list.mockImplementationOnce(
      () =>
        new Promise<Listing>((r) => {
          answer1 = r;
        }),
    );
    const { result } = renderHook(() => useListeners(t, true, true));
    expect(t.list).toHaveBeenCalledTimes(1);
    act(() => {
      result.current.refresh();
      result.current.refresh();
    });
    act(() => result.current.refresh());
    expect(t.list).toHaveBeenCalledTimes(1);
    t.list.mockResolvedValueOnce(listing("none", { personal: false }));
    await act(async () => answer1(listing("none", { launcher: true })));
    await waitFor(() => expect(result.current.listing?.personal).toBe(false));
    expect(result.current.listing?.launcher).toBeUndefined();
    expect(t.list).toHaveBeenCalledTimes(2);
  });

  it("a refresh whose render comes after the read in flight answers still reads once more (O28)", async () => {
    const t = listeners(listing("none", { launcher: true }));
    let answer1!: (l: Listing) => void;
    t.list.mockImplementationOnce(
      () =>
        new Promise<Listing>((r) => {
          answer1 = r;
        }),
    );
    const { result } = renderHook(() => useListeners(t, true, true));
    expect(t.list).toHaveBeenCalledTimes(1);
    t.list.mockResolvedValueOnce(listing("none"));
    // One act: the refresh's render is held until the read in flight has answered, as a loaded page can order them.
    await act(async () => {
      result.current.refresh();
      answer1(listing("none", { launcher: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(t.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.listing?.launcher).toBeUndefined());
    expect(t.list).toHaveBeenCalledTimes(2);
  });
});

describe("the recipient picker", () => {
  async function opened(l: Listing) {
    const t = listeners(l);
    mount([thread("sent")], t);
    fireEvent.click(fab());
    await waitFor(() => expect(picker()).toBeEnabled());
    return t;
  }

  it("lists this checkout's agents to choose from, and other checkouts as information only, by keyboard", async () => {
    const t = await opened(listing("listening", { agents: [CLAUDE, CODEX] }));
    fireEvent.keyDown(picker(), { key: "ArrowDown" });
    const list = screen.getByRole("listbox", { name: "Send messages to" });
    const groups = within(list).getAllByRole("group");
    expect(groups).toHaveLength(1);
    const here = groups[0]!;
    expect(here).toHaveAccessibleName("This checkout");
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Claude Code · ~/code/archerlistening", "Codex · ~/code/archer"]);
    // The worktree's listener is said under its own heading, outside the listbox: not an option.
    const elsewhere = screen.getByRole("list", { name: "Other checkouts" });
    expect(within(elsewhere).getByRole("listitem")).toHaveTextContent(
      "Listening in worktree wtClaude Code · ~/code/archer-wt · next turn",
    );
    expect(list).toHaveAccessibleDescription(/Listening in worktree wt/);
    expect(screen.queryByRole("option", { name: /archer-wt/ })).toBeNull();
    // Focus starts on the listener, moves with the arrows, and Enter picks.
    expect(within(here!).getAllByRole("option")[0]).toHaveFocus();
    expect(within(here!).getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(within(here!).getAllByRole("option")[1]).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    await waitFor(() => expect(t.pin).toHaveBeenCalledWith("a2"));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(picker()).toHaveFocus();
    await waitFor(() => expect(picker()).toHaveAccessibleName("To picked a2"));
  });

  it("gives the role back, closes on Escape without closing the chat, and never offers another checkout's agent", async () => {
    const t = await opened(listing("next-turn", { pinned: true }));
    fireEvent.click(picker());
    const list = screen.getByRole("listbox");
    expect(within(list).getAllByRole("option")[0]).toHaveTextContent("Whichever agent claims it");
    // Arrow keys move only between this checkout's options.
    expect(within(list).getAllByRole("option")).toHaveLength(2);
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toHaveTextContent("Claude Code · ~/code/archer");
    // Clicking the other checkout's line does nothing: it is information.
    fireEvent.click(screen.getByText("Listening in worktree wt"));
    expect(t.pin).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(picker()).toHaveFocus();
    fireEvent.click(picker());
    fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: /Whichever agent/ }));
    await waitFor(() => expect(t.pin).toHaveBeenLastCalledWith(null));
    expect(t.pin).toHaveBeenCalledTimes(1);
  });

  it("says another checkout has no agent, and with nothing here to choose still says who listens elsewhere", async () => {
    const quiet = {
      ...listing("none"),
      otherCheckouts: [
        { root: "/r-a", name: "worktree a", state: "none" as const, listener: null, pinnedByPerson: false, agents: [] },
        {
          root: "/r-b",
          name: "worktree b",
          state: "listening" as const,
          listener: WORKTREE,
          pinnedByPerson: false,
          agents: [WORKTREE],
        },
      ],
    };
    await opened(quiet);
    fireEvent.click(picker());
    const note = screen.getByRole("dialog", { name: "Send messages to" });
    expect(note).toHaveTextContent("No agent sessions in this checkout yet");
    expect(
      within(note)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["No agent in worktree a", "Listening in worktree bClaude Code · ~/code/archer-wt"]);
    expect(within(note).queryByRole("option")).toBeNull();
  });

  it("says when there is nobody to choose, and a failed pick is said, not hidden", async () => {
    const t = await opened({ ...listing("none"), otherCheckouts: [] });
    fireEvent.click(picker());
    // A note, not an empty listbox; it takes focus, so Escape closes it and not the chat.
    expect(screen.queryByRole("listbox")).toBeNull();
    const note = screen.getByRole("dialog", { name: "Send messages to" });
    expect(note).toHaveTextContent("No agent sessions in this checkout yet");
    expect(note).toHaveFocus();
    fireEvent.keyDown(note, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Send messages to" })).toBeNull();
    expect(screen.getByRole("dialog", { name: /Chat with the agent/ })).toBeInTheDocument();
    expect(picker()).toHaveFocus();
    act(() => announceListeners(event(listing("listening", { agents: [CLAUDE, CODEX] }))));
    t.pin.mockRejectedValueOnce(new Error("that agent is away"));
    fireEvent.click(picker());
    fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: /Codex/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not choose that agent: that agent is away");
  });

  // A pick whose answer was lost (the write sweep, O125): the pin may have landed, so Archer is read back and the true
  // result is said: chosen, not chosen, or not known yet. Never "Could not choose".
  it.each([
    [
      "landed: said as chosen",
      (l: Listing) => ({ ...l, current: { ...l.current, listener: CODEX, pinnedByPerson: true } }),
      /Agent chosen/,
    ],
    [
      "did not land: said as not chosen, the listing as it reads",
      (l: Listing) => l,
      /did not answer, and it still reads as before, so that agent was not chosen/,
    ],
  ] as const)("a pick whose answer was lost is read back: %s", async (_label, after, words) => {
    const first = listing("listening", { agents: [CLAUDE, CODEX] });
    const t = await opened(first);
    t.pin.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    t.list.mockResolvedValue(after(first));
    fireEvent.click(picker());
    fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: /Codex/ }));
    expect(await screen.findByText(words)).toBeInTheDocument();
    expect(screen.queryByText(/Could not choose/)).toBeNull();
    expect(t.pin).toHaveBeenCalledTimes(1);
  });

  it("a pick whose answer was lost, and Archer cannot be read either: said as not known yet, and read again", async () => {
    const first = listing("listening", { agents: [CLAUDE, CODEX] });
    const t = await opened(first);
    const reads = t.list.mock.calls.length;
    t.pin.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    t.list.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fireEvent.click(picker());
    fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: /Codex/ }));
    expect(await screen.findByText(/not known yet whether that agent was chosen/)).toBeInTheDocument();
    expect(screen.queryByText(/Could not choose/)).toBeNull();
    await waitFor(() => expect(t.list.mock.calls.length).toBeGreaterThanOrEqual(reads + 2));
  });
});

// The page's one place that turns the listing into the line: a component holding a send, so the order of
// "sent, then the listing arrives" is covered as a person meets it.
it("a message sent before the listing arrives gets the listing's line when it does", async () => {
  const t = listeners(listing("listening"));
  let resolve: (l: Listing) => void = () => {};
  t.list.mockImplementationOnce(
    () =>
      new Promise<Listing>((r) => {
        resolve = r;
      }),
  );
  function Live(): JSX.Element {
    const [held] = useState<Thread[]>([thread("sent")]);
    return (
      <ChatBubble
        review={review(held, true)}
        transport={comments}
        listenerTransport={t}
        doc={{ viewId: "containers" }}
        title="Containers"
        sidebarHost={null}
        dockHost={null}
        openRequest={0}
        closeRequest={0}
      />
    );
  }
  render(<Live />);
  fireEvent.click(fab());
  expect(status()).toHaveTextContent(CHECKING);
  await act(async () => resolve(listing("listening")));
  expect(status()).toHaveTextContent("Listening · Claude Code");
});
