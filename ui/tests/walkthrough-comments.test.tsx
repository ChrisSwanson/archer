// @vitest-environment jsdom
//
// Comments on walkthroughs, in the page (ADR 0034 §9): one gesture everywhere. Right-click and `C` on a
// step row or a Sequence message comment on that step; an element comment while stepping carries the
// step it was seen on; the walkthrough is the default whole when one is open; step rows count their
// threads; a thread names its step and opens it; "?" lists the rows only while a walkthrough is open.
// The real `App` over a stubbed host; the posted body is what the service would be asked to store.
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App";
import { MockEventSource, mountAgentPresented, restoreLocation, fetchCalls } from "./app-harness";

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class MockApp {
    addEventListener(): void {}
    callServerTool = vi.fn(() => Promise.resolve({ content: [] }));
    close = vi.fn(() => Promise.resolve());
    connect = vi.fn(() => Promise.resolve());
    updateModelContext = vi.fn(() => Promise.resolve({}));
  },
}));

const REV = `sha256:${"a".repeat(64)}`;
const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const step = (title: string, over: Record<string, unknown> = {}) => ({
  id: slug(title),
  title,
  kind: "sends",
  what: `${title} what`,
  why: `${title} why`,
  code: [`src/${slug(title)}.ts`],
  ...over,
});
const walk = (id: string, title: string, steps: unknown[]) => ({
  id,
  title,
  revision: 1,
  modelRevision: REV,
  author: "agent",
  writtenAt: "2026-10-23T09:00:00Z",
  steps,
});
const CALLS = {
  edges: [{ id: "calls", source: "web", target: "api", label: "calls" }],
  messages: [{ from: "web", to: "api", label: "x" }],
};
const API = { nodes: [{ kind: "node", id: "api", label: "API" }] };
const WALKS = [walk("ask", "Ask the API", [step("The request", CALLS), step("The API answers", API)])];
const payload = (walkthroughs: unknown[], resolution?: unknown[]) => ({
  schemaVersion: 1,
  viewId: "alpha",
  walkthroughs,
  resolution:
    resolution ??
    walkthroughs.map((w) => ({
      id: (w as { id: string }).id,
      status: "current",
      outOfDate: [],
      changed: [],
      steps: [],
    })),
  deadCode: [],
});
const bootstrap = { capabilities: { comments: true } };
const thread = (id: string, anchor: unknown, status = "draft", over: Record<string, unknown> = {}) => ({
  id,
  target: "view:alpha",
  anchor,
  status,
  revision: 1,
  comments: [{ id: `${id}-c`, author: "person", body: `${id} says`, createdAt: "2026-10-23T10:00:00.000Z" }],
  ...over,
});
const STEP2 = { kind: "step", walkthrough: "ask", step: "the-api-answers", label: "2. The API answers" };

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  restoreLocation();
  localStorage.clear();
});

const mount = (routes: Record<string, unknown> = {}) =>
  mountAgentPresented(<App />, { bootstrap, walkthroughs: payload(WALKS), ...routes });
async function openWalk(): Promise<void> {
  // The side panel's Explore section lists them (0.6.4, D5): no entry button to press first.
  await screen.findByRole("group", { name: "Walkthroughs on this diagram" });
  fireEvent.click(
    within(screen.getByRole("group", { name: "Walkthroughs on this diagram" })).getByRole("button", {
      name: /Ask the API/,
    }),
  );
  await waitFor(() => expect(document.querySelector('[aria-current="step"]')).toHaveTextContent("The request"));
}
const row = (title: string): HTMLElement =>
  [...document.querySelectorAll<HTMLElement>(".archer-walk-step")].find((li) =>
    li.querySelector(".archer-walk-step-title")?.textContent?.startsWith(title),
  )!;
const discussion = () => screen.getByRole("region", { name: "Contextual discussion" });
const posts = () =>
  (fetch as unknown as { mock: { calls: [string, { method?: string; body?: string }][] } }).mock.calls
    .filter(([url, init]) => url === "api/comments" && init?.method === "POST")
    .map(
      ([, init]) => (JSON.parse(init.body!) as { payload: { anchor: Record<string, unknown>; body: string } }).payload,
    );
/** A right-click on a box opens its menu (Comment first, then Expand); Comment opens the composer. */
async function commentFromMenu(id: string): Promise<void> {
  fireEvent.contextMenu(document.querySelector(`.react-flow__node[data-id="${id}"]`)!);
  fireEvent.click(await screen.findByRole("menuitem", { name: /^Comment/ }));
}

async function save(text: string): Promise<void> {
  fireEvent.change(await within(discussion()).findByRole("textbox", { name: "Comment" }), { target: { value: text } });
  fireEvent.click(within(discussion()).getByRole("button", { name: "Add comment" }));
  await waitFor(() => expect(posts()).toHaveLength(1));
}

describe("one gesture on a step row", () => {
  it("right-click opens the composer on that step, and saving posts a step anchor", async () => {
    await mount();
    await openWalk();
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => {
      row("The API answers").querySelector("button")!.dispatchEvent(menu);
    });
    expect(menu.defaultPrevented).toBe(true);
    expect(await within(discussion()).findByRole("textbox", { name: "Comment" })).toBeInTheDocument();
    expect(
      within(discussion()).getByText("Step 2 · The API answers", { selector: ".primary-floating-context" }),
    ).toBeInTheDocument();
    await save("Say the webhook is signed");
    expect(posts()[0]).toMatchObject({
      target: "view:alpha",
      body: "Say the webhook is signed",
      anchor: { kind: "step", walkthrough: "ask", step: "the-api-answers" },
    });
  });

  it("C on a focused step row comments on that step, not on the selection or the whole", async () => {
    await mount();
    await openWalk();
    const head = row("The API answers").querySelector("button")!;
    head.focus();
    fireEvent.keyDown(head, { key: "c" });
    expect(
      await within(discussion()).findByText("Step 2 · The API answers", { selector: ".primary-floating-context" }),
    ).toBeInTheDocument();
  });

  it("right-click on a Sequence message comments on its step", async () => {
    await mount();
    await openWalk();
    fireEvent.click(screen.getByRole("tab", { name: "Sequence" }));
    const message = await waitFor(() => {
      const m = document.querySelector<SVGElement>('.archer-seq-message[data-step="1"]');
      expect(m).not.toBeNull();
      return m!;
    });
    fireEvent.contextMenu(message);
    expect(
      await within(discussion()).findByText("Step 1 · The request", { selector: ".primary-floating-context" }),
    ).toBeInTheDocument();
  });

  it("leaves the browser's menu alone off a step row, and with no walkthrough chosen", async () => {
    await mount();
    // The mode switcher opens the walkthrough on its list, with none chosen.
    fireEvent.click(await screen.findByRole("button", { name: /^Walkthroughs · / }));
    await screen.findByRole("region", { name: "Walkthrough" });
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => {
      document.querySelector(".archer-walk-meta")!.dispatchEvent(menu);
    });
    expect(menu.defaultPrevented).toBe(false);
    expect(screen.queryByRole("region", { name: "Contextual discussion" })).toBeNull();
  });
});

describe("a comment on a box or line while stepping", () => {
  it("carries the step it was seen on", async () => {
    await mount();
    await openWalk();
    fireEvent.contextMenu(document.querySelector('.react-flow__node[data-id="api"]')!);
    await save("Why the API?");
    expect(posts()[0]!.anchor).toMatchObject({
      kind: "node",
      id: "api",
      context: { walkthrough: "ask", step: "the-request" },
    });
  });

  it("C with a selection does the same", async () => {
    await mount();
    await openWalk();
    fireEvent.click(document.querySelector<HTMLButtonElement>('button[aria-label="Select mode"]')!);
    fireEvent.click(document.querySelector('.react-flow__node[data-id="web"]')!);
    await waitFor(() => expect(document.querySelectorAll(".react-flow__node.selected")).toHaveLength(1));
    fireEvent.keyDown(window, { key: "c" });
    await save("Box thought");
    expect(posts()[0]!.anchor).toMatchObject({ kind: "node", id: "web", context: { walkthrough: "ask" } });
  });

  it("adds nothing with no walkthrough open", async () => {
    await mount();
    await screen.findByRole("group", { name: "Walkthroughs on this diagram" });
    await commentFromMenu("api");
    await save("Plain");
    expect(posts()[0]!.anchor).toEqual({ kind: "node", id: "api", label: "API" });
  });
});

describe("C with nothing selected", () => {
  // It opens the chat bubble about the document (ADR 0034 §10): the walkthrough while one is open, else the diagram.
  it("opens the chat: about the walkthrough while one is open, and the whole diagram otherwise", async () => {
    await mount();
    await screen.findByRole("group", { name: "Walkthroughs on this diagram" });
    fireEvent.keyDown(window, { key: "c" });
    expect(await screen.findByRole("textbox", { name: "Message to the agent" })).toBeInTheDocument();
    // Always a choice now: this diagram or the whole project (and the walkthrough while one is open).
    expect(screen.getByRole("group", { name: "Talk about" }).textContent).toBe("This diagramWhole project");
    expect(screen.getByRole("log")).toHaveTextContent("about this diagram");
    expect(document.querySelector(".archer-composer")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Collapse to the bubble" }));
    await openWalk();
    fireEvent.keyDown(window, { key: "c" });
    expect(await screen.findByRole("log")).toHaveTextContent("about this walkthrough");
    expect(screen.getByRole("button", { name: "Walkthrough" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "This diagram" }));
    expect(screen.getByRole("log")).toHaveTextContent("about this diagram");
  });
});

describe("one conversation surface at a time", () => {
  const pinThreads = [thread("c", { kind: "node", id: "api", label: "API" })];
  const fab = (): HTMLElement => screen.getByRole("button", { name: /^Chat with the agent about/ });
  const pin = async (): Promise<HTMLElement> =>
    waitFor(() => {
      const p = document.querySelector<HTMLElement>('.react-flow__node[data-id="api"] .archer-pin');
      expect(p).not.toBeNull();
      return p!;
    });
  it("opening the chat closes a floating discussion; a pin pressed closes the chat", async () => {
    await mount({ threads: pinThreads });
    fireEvent.click(await pin());
    expect(await screen.findByRole("region", { name: "Contextual discussion" })).toBeInTheDocument();
    fireEvent.click(fab());
    expect(await screen.findByRole("dialog", { name: /Chat with the agent/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("region", { name: "Contextual discussion" })).toBeNull());
    fireEvent.click(await pin());
    expect(await screen.findByRole("region", { name: "Contextual discussion" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Chat with the agent/ })).toBeNull());
  });
  it("a composer opening closes the chat too", async () => {
    await mount();
    await screen.findByRole("group", { name: "Walkthroughs on this diagram" });
    fireEvent.click(fab());
    expect(await screen.findByRole("dialog", { name: /Chat with the agent/ })).toBeInTheDocument();
    await commentFromMenu("api");
    expect(await screen.findByRole("region", { name: "Contextual discussion" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Chat with the agent/ })).toBeNull());
  });
  it("Esc on the page closes the chat, and only the chat", async () => {
    await mount();
    await screen.findByRole("group", { name: "Walkthroughs on this diagram" });
    fireEvent.keyDown(window, { key: "c" });
    expect(await screen.findByRole("dialog", { name: /Chat with the agent/ })).toBeInTheDocument();
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(esc);
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Chat with the agent/ })).toBeNull());
    expect(esc.defaultPrevented).toBe(true);
  });
});

describe("what the threads show", () => {
  const threads = [
    thread("a", STEP2),
    thread("b", STEP2, "sent"),
    thread("c", { kind: "node", id: "api", label: "API", context: { walkthrough: "ask", step: "the-api-answers" } }),
  ];

  it("counts a step's threads on its row, and the pin on the box is as before", async () => {
    await mount({ threads });
    await openWalk();
    await waitFor(() =>
      expect(within(row("The API answers")).getByText("2", { selector: ".archer-pin" })).toBeInTheDocument(),
    );
    expect(row("The request").querySelector(".archer-pin")).toBeNull();
    expect(row("The API answers").querySelector(".archer-pin")).toHaveAttribute("data-state", "draft");
    expect(row("The API answers").querySelector("button")).toHaveAccessibleName(/2 comments/);
    // The badge counts: its tooltip says what it is, and pressing it opens the thread that needs the person most.
    expect(row("The API answers").querySelector(".archer-pin")).toHaveAttribute("title", "2 comments on this step");
    await waitFor(() => expect(document.querySelector('.react-flow__node[data-id="api"] .archer-pin')).not.toBeNull());
  });

  it("names the step on a step thread and opens it from the chip", async () => {
    await mount({ threads: [thread("a", STEP2)] });
    await openWalk();
    fireEvent.click(
      await waitFor(() => {
        const pin = row("The API answers").querySelector(".archer-pin");
        expect(pin).not.toBeNull();
        return pin!;
      }),
    );
    const chip = await within(discussion()).findByRole("button", { name: "Walkthrough · step 2" });
    fireEvent.click(chip);
    await waitFor(() => expect(document.querySelector('[aria-current="step"]')).toHaveTextContent("The API answers"));
  });

  it("says where an element thread was seen, and flags a step that is out of date", async () => {
    const stale = payload(WALKS, [
      {
        id: "ask",
        status: "partly-out-of-date",
        outOfDate: [2],
        changed: [],
        steps: [{ status: "current" }, { status: "out-of-date" }],
      },
    ]);
    await mount({
      threads: [
        thread("c", {
          kind: "node",
          id: "api",
          label: "API",
          context: { walkthrough: "ask", step: "the-api-answers" },
        }),
        thread("a", STEP2),
      ],
      walkthroughs: stale,
    });
    await openWalk();
    fireEvent.click(
      await waitFor(() => {
        const pin = document.querySelector('.react-flow__node[data-id="api"] .archer-pin');
        expect(pin).not.toBeNull();
        return pin!;
      }),
    );
    expect(await within(discussion()).findByText("on step 2 · Ask the API")).toBeInTheDocument();
    fireEvent.click(within(discussion()).getByRole("button", { name: "Close discussion" }));
    fireEvent.click(row("The API answers").querySelector(".archer-pin")!);
    expect(await within(discussion()).findByText(/This step is out of date/)).toBeInTheDocument();
  });
});

describe("the ? sheet", () => {
  it("lists the step rows and the Sequence messages only while a walkthrough is open", async () => {
    await mount();
    await screen.findByRole("group", { name: "Walkthroughs on this diagram" });
    fireEvent.keyDown(window, { key: "?" });
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).queryByText("A step row")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await openWalk();
    fireEvent.keyDown(window, { key: "?" });
    const open = await screen.findByRole("dialog");
    expect(await within(open).findByText("A step row")).toBeInTheDocument();
    expect(await within(open).findByText("A Sequence message")).toBeInTheDocument();
    expect(within(open).getByText(/Comment on the selection or the focused step/)).toBeInTheDocument();
  });
});

describe("a page that cannot comment", () => {
  it("has none of it", async () => {
    await mountAgentPresented(<App />, { walkthroughs: payload(WALKS) });
    await openWalk();
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => {
      row("The API answers").querySelector("button")!.dispatchEvent(menu);
    });
    expect(menu.defaultPrevented).toBe(false);
    expect(fetchCalls().some((url) => url.startsWith("api/comments"))).toBe(false);
  });
});
