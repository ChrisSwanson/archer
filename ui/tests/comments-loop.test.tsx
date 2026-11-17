// @vitest-environment jsdom
//
// The feedback loop, phase 2:
// the real `App` over the real service (`support/page-on-service.ts`), with the
// agent's side the service's own `get_comments`, `reply_comment` and
// `resolve_comment` tool code.
//
//   - the drawer collapses to a rail with counts, and opens from the rail, a
//     pin, or "New comment";
//   - every state a thread can be in is named, and each step the agent takes
//     shows, is announced, and moves its pin;
//   - a pin opens its thread; the thread's heading selects its element;
//   - pins on every element kind: node, edge, group, and on a sequence's
//     participants and messages.
import { flushSync } from "react-dom";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const observedConnection = vi.hoisted(() => ({ status: "connecting" }));
vi.mock("../src/app/host-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/app/host-bridge")>();
  return {
    ...actual,
    connectBridge: (callbacks: Parameters<typeof actual.connectBridge>[0]) =>
      actual.connectBridge({
        ...callbacks,
        onConnection: (status) => {
          observedConnection.status = status;
          callbacks.onConnection?.(status);
        },
      }),
  };
});

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class MockApp {
    addEventListener(): void {}
    callServerTool = vi.fn(() => Promise.resolve({ content: [] }));
    close = vi.fn(() => Promise.resolve());
    connect = vi.fn(() => Promise.resolve());
    updateModelContext = vi.fn(() => Promise.resolve({}));
  },
}));

import { App } from "../src/app/App";
import { SequenceCanvas } from "../src/diagrams/SequenceCanvas";
import { computeSequenceLayout } from "../src/layout/sequence-layout";
import { projectEnvelope } from "../src/diagrams/projection";
import { MockEventSource, restoreLocation } from "./app-harness";
import { resetApplicationUpdate } from "../src/app/application-update";
import {
  ownerComments,
  pageOnService,
  SERVICE_HOME,
  SYSTEM_MMD,
  viewEntry,
  type PageOnService,
} from "./support/page-on-service";
import { startTsProject, type TsProject } from "./support/ts-service";
import { installMatchMedia } from "./match-media";
import { loadValidFixture } from "./fixtures";
import { pinsOn } from "./support/pins";
import { createReviewEvents } from "../src/comments/events";
import { useReview } from "../src/comments/useReview";
import { memoryTransport } from "./support/memory-transport";
import { NO_CAPABILITIES, type Thread } from "../src/comments/contract";

/** The system diagram on screen, and another (`elsewhere`) that is not. */
const FILES = {
  "archer.toml": `version = 1\n\n${viewEntry("system", "The system")}${viewEntry("elsewhere", "Elsewhere")}`,
  ".archer/system.mmd": SYSTEM_MMD,
  ".archer/elsewhere.mmd": SYSTEM_MMD,
};

let service: TsProject;
let project: TsProject | undefined;
let page: PageOnService | undefined;
/** The person's comments as their page reads and writes them. */
let comments: ReturnType<typeof ownerComments>;

beforeAll(async () => {
  service = await startTsProject({ files: SERVICE_HOME, commentSubmission: "queued" });
}, 30_000);
afterAll(async () => {
  await service?.stop();
});

async function mount(): Promise<void> {
  project = await service.attachProject(FILES);
  comments = ownerComments(project);
  await project.present("system");
  page = await pageOnService(project, { path: "/" });
  installMatchMedia(false);
  observedConnection.status = "connecting";
  render(<App />);
  await waitFor(() => expect(document.querySelectorAll(".react-flow__node.archer-node")).toHaveLength(3));
  await waitFor(() => expect(observedConnection.status).toBe("connected"));
}

beforeEach(() => {
  MockEventSource.instances = [];
  localStorage.clear();
  localStorage.setItem(`archer-comments:${window.location.pathname}:hold`, "true");
});

afterEach(async () => {
  cleanup();
  await page?.close();
  page = undefined;
  restoreLocation();
  resetApplicationUpdate();
  vi.unstubAllGlobals();
  await project?.stop();
  project = undefined;
});

const drawer = (): HTMLElement => document.getElementById("archer-review")!;
const panel = (): HTMLElement => screen.getByRole("main");
const rail = (): HTMLElement => {
  const inbox = drawer();
  if (!inbox.hidden) return inbox;
  flushSync(() => fireEvent.click(railOpen()));
  return inbox;
};
const railOpen = (): HTMLElement => document.querySelector<HTMLButtonElement>(".archer-review-toggle")!;
const thread = (name: RegExp): HTMLElement => {
  const shown = within(panel()).queryByRole("article", { name });
  if (shown) return shown;
  const inbox = rail();
  flushSync(() => fireEvent.click(within(inbox).getByRole("button", { name })));
  return within(panel()).getByRole("article", { name });
};
const pinOn = (selector: string): HTMLElement | null => document.querySelector(`${selector} .archer-pin`);
const announced = (text: string) =>
  waitFor(() => expect(document.querySelector(".archer-review-announcer")).toHaveTextContent(text));

/** A draft on the Web app node, written as the person's page writes it. */
function draftOnWeb(body = "Why direct?"): Promise<Thread> {
  return comments.draft("view:system", body, { kind: "node", id: "web", label: "Web app" });
}

describe("the drawer and its rail", () => {
  it("starts with the inbox closed and keeps original draft/sent/answered states in project review", async () => {
    await mount();
    expect(drawer()).not.toBeVisible();
    const a = await draftOnWeb();
    await comments.draft("view:system", "whole");
    await waitFor(() =>
      expect(within(rail().querySelector(".primary-inbox-list") as HTMLElement).getAllByText("Draft")).toHaveLength(2),
    );
    await comments.submit();
    await project!.agentReply(a.id, "Because.", a.revision);
    await waitFor(() =>
      expect(within(rail().querySelector(".primary-inbox-list") as HTMLElement).getByText("Answered")).toBeVisible(),
    );
    expect(within(rail()).getByRole("button", { name: /Unread: Node: Web app/ })).toBeVisible();
    expect(within(rail().querySelector(".primary-inbox-list") as HTMLElement).getByText("Sent")).toBeVisible();
  });

  // `C` with nothing selected opens the chat bubble about the whole diagram (ADR 0034 §10), not a composer.
  it("opens the chat on C with nothing selected, ready to type", async () => {
    await mount();
    fireEvent.keyDown(window, { key: "c" });
    expect(await screen.findByRole("textbox", { name: "Message to the agent" })).toHaveFocus();
    expect(screen.getByRole("dialog", { name: /Chat with the agent/ })).toBeVisible();
    expect(document.querySelector(".archer-composer")).toBeNull();
  });

  it("sends every draft in the project from the rail, in one action", async () => {
    await mount();
    await draftOnWeb();
    await comments.draft("view:elsewhere", "not on screen");
    const send = await within(rail()).findByRole("button", { name: "Send queued comments (2)" });
    fireEvent.click(send);
    await waitFor(() => expect(within(rail()).queryByRole("button", { name: /^Send queued comments/ })).toBeNull());
    const sent = [...(await comments.list("view:system")), ...(await comments.list("view:elsewhere"))];
    expect(sent.map((t) => t.status)).toEqual(["sent", "sent"]);
  });

  it("counts project-wide drafts before sending, without listing where they are", async () => {
    await mount();
    await draftOnWeb();
    await comments.draft("view:elsewhere", "not on screen");
    await waitFor(() => expect(within(rail()).getByRole("button", { name: "Send queued comments (2)" })).toBeEnabled());
    expect(within(rail()).queryByText("2 drafts in this project, not published yet.")).toBeNull();
    expect(within(rail()).queryByRole("list", { name: "Where the drafts are" })).toBeNull();
  });

  it("goes draft, sent, read by the agent, answered, resolved by the agent, then dismissed", async () => {
    await mount();
    const t = await draftOnWeb();
    fireEvent.click(railOpen());
    const card = await waitFor(() => thread(/Node: Web app/));
    expect(within(card).getByText("Draft")).toHaveAttribute("title", "Yours, not sent. Edit or delete it freely.");
    await waitFor(() => expect(pinOn('.react-flow__node[data-id="web"]')).toHaveAttribute("data-state", "draft"));

    fireEvent.click(await within(rail()).findByRole("button", { name: "Send queued comments (1)" }));
    await within(card).findByText("Sent");
    await waitFor(() => expect(pinOn('.react-flow__node[data-id="web"]')).toHaveAttribute("data-state", "sent"));

    await project!.agentInbox();
    await within(card).findByText("Read by the agent");
    await announced("The agent read 1 comment; an answer is coming.");
    expect(pinOn('.react-flow__node[data-id="web"]')).toHaveAttribute("data-state", "sent");

    await project!.agentReply(t.id, "Directly, for latency.", t.revision);
    await within(card).findByText("Answered");
    await announced("The agent replied on Node: Web app.");
    const reply = within(card).getAllByRole("listitem").at(-1)!;
    expect(reply).toHaveAttribute("data-author", "agent");
    expect(within(reply).getByText("Agent")).toBeInTheDocument();
    await waitFor(() =>
      expect(pinOn('.react-flow__node[data-id="web"]')?.querySelector(".archer-pin-agent")).not.toBeNull(),
    );

    await project!.agentResolve(t.id, t.revision);
    await within(card).findByText("Resolved by the agent");
    await announced("The agent resolved Node: Web app.");
    // Kept, with the agent's last reply, until dismissed; resolving is not offered.
    expect(within(card).getByText("Directly, for latency.")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Resolve" })).toBeNull();
    expect(pinOn('.react-flow__node[data-id="web"]')).toHaveAttribute("data-state", "resolved");

    fireEvent.click(within(card).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(within(panel()).queryByRole("article")).toBeNull());
    expect(await comments.list("view:system")).toEqual([]);
    await waitFor(() => expect(pinOn('.react-flow__node[data-id="web"]')).toBeNull());
  });

  it("an edit after sending makes it a draft again, outlined, and counted to send", async () => {
    await mount();
    const t = await draftOnWeb("First");
    await comments.submit();
    fireEvent.click(railOpen());
    const card = await waitFor(() => thread(/Node: Web app/));
    await within(card).findByText("Sent");
    fireEvent.click(within(card).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(card).getByRole("textbox", { name: "Edit your comment" }), { target: { value: "Second" } });
    fireEvent.click(within(card).getByRole("button", { name: "Save" }));
    await within(card).findByText("Changed after sending");
    await announced("Comment updated. It is a draft again; the agent sees the new text when you send it.");
    await waitFor(() => expect(pinOn('.react-flow__node[data-id="web"]')).toHaveAttribute("data-state", "draft"));
    expect(await within(rail()).findByRole("button", { name: "Send queued comments (1)" })).toBeEnabled();
    // The agent's answer to the old text is refused.
    await expect(project!.agentReply(t.id, "To the old words", t.revision)).rejects.toThrow(/changed/);
  });

  it("says orphaned beside the state, and draws no pin for it", async () => {
    await mount();
    await draftOnWeb();
    await waitFor(() => expect(pinOn('.react-flow__node[data-id="web"]')).not.toBeNull());
    // The agent takes the Web app out of the diagram: the thread on it is orphaned.
    await project!.agentWrite("system", ".archer/system.mmd", "flowchart LR\n  api[API] e2@--> db[(Database)]\n");
    await waitFor(() => expect(document.querySelectorAll(".react-flow__node.archer-node")).toHaveLength(2));
    fireEvent.click(railOpen());
    const card = await waitFor(() => thread(/Node: Web app/));
    expect(await within(card).findByText("Orphaned")).toBeInTheDocument();
    expect(within(card).getByText("Draft")).toBeInTheDocument();
    expect(document.querySelector(".archer-stage .archer-pin")).toBeNull();
  });
});

describe("pins", () => {
  it("numbers the threads on elements, on a node, an edge and a group, matching the drawer", async () => {
    await mount();
    await draftOnWeb();
    await comments.draft("view:system", "whole");
    await comments.draft("view:system", "TLS?", { kind: "edge", id: "e1", label: "HTTPS" });
    await comments.draft("view:system", "Split?", { kind: "group", id: "backend", label: "Backend" });
    // Each draft reaches the page on its own comments event from the real service: wait for all three pins.
    await waitFor(() => {
      expect(pinOn('.react-flow__node[data-id="web"]')?.textContent).toBe("1");
      expect(document.querySelector('[data-edge-pins="e1"] .archer-pin')?.textContent).toBe("2");
      expect(pinOn('.react-flow__node[data-id="group:backend"]')?.textContent).toBe("3");
    });
    fireEvent.click(railOpen());
    expect(thread(/Edge: HTTPS/).querySelector(".archer-thread-pin")?.textContent).toBe("2");
    expect(thread(/Whole diagram/).querySelector(".archer-thread-pin")).toBeNull();
  });

  it("opens its thread when pressed, focused and marked, and selects what it is about", async () => {
    await mount();
    await comments.draft("view:system", "TLS?", { kind: "edge", id: "e1", label: "HTTPS" });
    const pin = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-edge-pins="e1"] .archer-pin');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(drawer()).not.toBeVisible();
    fireEvent.click(pin);
    const card = await waitFor(() => thread(/Edge: HTTPS/));
    await waitFor(() => expect(card).toHaveFocus());
    expect(card).toHaveAttribute("data-active", "true");
    await waitFor(() => expect(document.querySelector('.react-flow__edge[data-id="e1"]')).toHaveClass("selected"));
  });

  it("selects the element from Show on diagram in the sidebar, and from the discussion's heading", async () => {
    await mount();
    await draftOnWeb();
    fireEvent.click(railOpen());
    await waitFor(() => thread(/Node: Web app/));
    fireEvent.click(within(rail()).getByRole("button", { name: "Show on diagram" }));
    await waitFor(() => expect(document.querySelector('.react-flow__node[data-id="web"]')).toHaveClass("selected"));
    const discussion = screen.getByRole("region", { name: "Contextual discussion" });
    fireEvent.click(within(discussion).getByRole("button", { name: "Node: Web app" }));
    expect(document.querySelector('.react-flow__node[data-id="web"]')).toHaveClass("selected");
  });
});

describe("pins on a sequence diagram", () => {
  function layout() {
    const projection = projectEnvelope(loadValidFixture("minimal-sequence.json"));
    if (!projection.ok || projection.type !== "sequence") throw new Error("not a sequence");
    return computeSequenceLayout(projection.view);
  }

  it("draws a numbered pin on a participant and on a message, and says they have comments", () => {
    const drawn = layout();
    const participant = drawn.participants[0]!;
    const message = drawn.messages.find((m) => m.label !== undefined)!;
    const { container } = render(
      <SequenceCanvas
        layout={drawn}
        commented={pinsOn({ nodes: [participant.id], edges: [message.id] }, "answered")}
        onNodeClick={() => {}}
        onEdgeClick={() => {}}
      />,
    );
    const pins = [...container.querySelectorAll(".archer-svg-pin")];
    expect(pins.map((pin) => pin.getAttribute("data-pin-thread"))).toEqual(["t1", "t2"]);
    expect(pins.map((pin) => pin.querySelector("text")?.textContent)).toEqual(["1", "2"]);
    expect(
      pins.every((pin) => pin.getAttribute("data-state") === "answered" && pin.querySelector(".archer-svg-pin-agent")),
    ).toBe(true);
    expect(
      container.querySelector(`[data-seq-id="${participant.id}"][role="button"]`)?.getAttribute("aria-label"),
    ).toMatch(/has comments$/);
    expect(container.querySelector(`[data-seq-id="${message.id}"][role="button"]`)?.getAttribute("aria-label")).toMatch(
      /has comments$/,
    );
  });

  it("draws no pins without threads", () => {
    const { container } = render(<SequenceCanvas layout={layout()} />);
    expect(container.querySelector(".archer-svg-pin")).toBeNull();
  });
});

it("does not report a comments read that fails after its review unmounts", async () => {
  const transport = memoryTransport([]);
  let rejectRead!: (failure: Error) => void;
  transport.listThreads = () =>
    new Promise((_, reject) => {
      rejectRead = reject;
    });
  const reported = vi.spyOn(console, "error");
  const { unmount } = renderHook(() =>
    useReview({
      transport,
      capabilities: { ...NO_CAPABILITIES, comments: true, notes: false },
      viewId: "system",
      events: createReviewEvents(),
    }),
  );
  await waitFor(() => expect(rejectRead).toBeDefined());

  unmount();
  await act(async () => {
    rejectRead(new Error("server closed"));
  });

  expect(reported).not.toHaveBeenCalled();
  reported.mockRestore();
});
