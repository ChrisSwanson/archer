// @vitest-environment jsdom
//
// Comments and notes in the page: the real `App` over the real service
// (`support/page-on-service.ts`): its routes, its event stream, and the agent's
// side through the service's own tool code.
//
// Every state a thread can be in, every action on it, and the gating: a
// server that names no capabilities gets the page it always had (that one is
// the stub harness's, since the service always names them).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { flushSync } from "react-dom";
import { App } from "../src/app/App";
import { resetApplicationUpdate } from "../src/app/application-update";
import { filesTable, openFile } from "./support/primary-navigation";
import { MockEventSource, mountAgentPresented, restoreLocation } from "./app-harness";
import {
  ownerComments,
  pageOnService,
  SERVICE_HOME,
  SYSTEM_MMD,
  viewEntry,
  type PageOnService,
  type ServiceEventSource,
} from "./support/page-on-service";
import { startTsProject, type TsProject } from "./support/ts-service";
import { installMatchMedia, installViewport } from "./match-media";

const NOTE_MARKDOWN =
  "# Auth\n\nTokens expire after an hour. Refresh tokens expire after a week.\n\n<script>window.pwned = 1</script>\n\n- one\n- two\n";

/** The system diagram (and another, when asked), a note on the system, and one on nothing on screen. */
const files = (another = false): Record<string, string> => ({
  "archer.toml": `version = 1\n\n${viewEntry("system", "The system")}${another ? viewEntry("another", "Another diagram") : ""}`,
  ".archer/system.mmd": SYSTEM_MMD,
  ...(another ? { ".archer/another.mmd": SYSTEM_MMD } : {}),
  ".archer/notes/auth.md": `---\ndiagrams: [../system.mmd]\n---\n${NOTE_MARKDOWN}`,
  ".archer/notes/other.md": "# Elsewhere\n",
});

let service: TsProject;
let project: TsProject;
let page: PageOnService | undefined;
/** The person's comments as their page reads and writes them, and the agent's side. */
let comments: ReturnType<typeof ownerComments>;
/** What was sent, as the person's page lists it (the agent has not read it yet). */
const submitted = async (): Promise<readonly { id: string; comments: readonly { body: string }[] }[]> =>
  (await comments.list("view:system")).filter((t) => t.status === "sent");

/** The agent reading what was sent (`get_comments`) and answering the one thread, at the revision it read. */
async function agentAnswers(body: string): Promise<void> {
  const [read, ...more] = (await project.agentInbox()) as { id: string; revision: number }[];
  expect(more).toEqual([]);
  await project.agentReply(read!.id, body, read!.revision);
}

beforeAll(async () => {
  service = await startTsProject({ files: SERVICE_HOME, commentSubmission: "queued" });
}, 30_000);
afterAll(async () => {
  await service?.stop();
});

/** The document action opens the inbox and names its unread count. */
const notificationOpen = (): HTMLElement => screen.getByRole("button", { name: /^Notifications/ });

type MountOptions = { open?: boolean; another?: boolean; viewport?: { width: number; coarse: boolean } };

async function mount(options: MountOptions = {}): Promise<{ source: ServiceEventSource }> {
  const source = await mountClosed(options);
  // Wide, so the drawer is a rail beside the drawing; opened unless asked not to.
  if (options.open !== false) flushSync(() => fireEvent.click(notificationOpen()));
  return { source };
}

async function mountClosed(options: MountOptions = {}): Promise<ServiceEventSource> {
  project = await service.attachProject(files(options.another));
  comments = ownerComments(project);
  await project.present("system");
  page = await pageOnService(project, { path: "/" });
  if (options.viewport === undefined) installMatchMedia(false);
  else installViewport(options.viewport);
  observedConnection.status = "connecting";
  render(<App />);
  if (options.viewport !== undefined) return (await waitFor(() => page!.streams[0]!))!;
  await waitFor(() => expect(document.querySelectorAll(".react-flow__node.archer-node")).toHaveLength(3));
  await waitFor(() => expect(observedConnection.status).toBe("connected"));
  return page.streams[0]!;
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
});

const panel = (): HTMLElement => screen.getByRole("region", { name: "Contextual discussion" });
const inbox = (): HTMLElement => screen.getByRole("region", { name: "Project Review" });
const announcement = (): HTMLElement => document.querySelector(".archer-review-announcer")!;
// `C` with nothing selected opens the chat bubble (ADR 0034 §10); the panel's button starts the whole-diagram composer.
const newComment = (): void => {
  flushSync(() => fireEvent.click(screen.getByRole("button", { name: "New comment" })));
};
async function openNote(): Promise<HTMLElement> {
  await openFile("Auth");
  return await screen.findByRole("article", { name: "Reading Auth" });
}
const thread = (name: RegExp | string): HTMLElement => within(panel()).getByRole("article", { name });

async function writeComment(text: string): Promise<void> {
  const box = await within(panel()).findByRole("textbox", { name: "Comment" });
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(within(panel()).getByRole("button", { name: "Add comment" }));
  await screen.findByText(text, { selector: ".archer-comment-body" });
}

it("offers one notification bell in document actions and none in workspace navigation", async () => {
  await mountClosed();
  expect(
    within(screen.getByRole("navigation", { name: "Workspace" })).queryByRole("button", { name: /Notifications/ }),
  ).toBeNull();
  const actions = document.querySelector<HTMLElement>(".primary-document-actions")!;
  const bell = within(actions).getByRole("button", { name: "Notifications" });
  expect(screen.getAllByRole("button", { name: /Notifications/ })).toHaveLength(1);
  expect(bell.querySelector(".archer-review-toggle-label")).toBeNull();
  fireEvent.click(bell);
  expect(inbox()).toBeVisible();
  expect(document.querySelector(".primary-navigation")).toHaveAttribute("data-expanded", "false");
});

describe("without the capability", () => {
  it("draws exactly the page it always did for a server that names neither", async () => {
    // The service always names both: a server that names neither is the stub harness's.
    installMatchMedia(false);
    vi.stubGlobal("EventSource", MockEventSource);
    await mountAgentPresented(<App />);
    expect(screen.queryByRole("button", { name: /comments|notes/i })).toBeNull();
    expect(document.querySelector(".archer-review, .archer-review-row, .archer-review-rail, .archer-pin")).toBeNull();
    // The stage is still the main landmark's own child, as before.
    expect(document.querySelector("main > .archer-stage")).not.toBeNull();
    // ...and `C` is still nothing.
    fireEvent.keyDown(window, { key: "c" });
    expect(document.querySelector(".archer-composer")).toBeNull();
  });
});

describe("comments on the diagram", () => {
  it("opens the panel from the title bar, and closes it back to the button", async () => {
    await mount({ open: false });
    const toggle = document.querySelector<HTMLButtonElement>(".archer-review-toggle")!;
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(within(inbox()).getByRole("button", { name: "Close project review" }));
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("archer-review")).not.toBeVisible();
    expect(toggle).toHaveFocus();
    fireEvent.click(toggle);
    expect(inbox()).toBeVisible();
  });

  it("still announces the agent's reply while the panel is closed", async () => {
    await mount();
    newComment();
    await writeComment("Closed panel question");
    fireEvent.click(await within(panel()).findByRole("button", { name: "Send queued comments (1)" }));
    await within(thread(/Whole diagram/)).findByText("Sent");
    fireEvent.click(document.querySelector<HTMLButtonElement>(".archer-review-toggle")!);
    fireEvent.click(within(panel()).getByRole("button", { name: "Close discussion" }));
    await agentAnswers("Answer");
    // The live region is outside the hidden panel, so it is still spoken.
    await waitFor(() => expect(announcement()).toHaveTextContent("The agent replied on Whole diagram."));
  });

  it("closes a submitted comment's discussion on a click elsewhere on the page, but not on a drag or while writing (decided 2026-10-29)", async () => {
    await mount();
    const click = (at: Element, to = { x: 10, y: 10 }) => {
      fireEvent.pointerDown(at, { clientX: 10, clientY: 10 });
      fireEvent.pointerUp(at, { clientX: to.x, clientY: to.y });
    };
    newComment();
    // Writing: a click elsewhere keeps the composer, so nothing typed is lost.
    await within(panel()).findByRole("textbox", { name: "Comment" });
    click(document.body);
    expect(within(panel()).getByRole("textbox", { name: "Comment" })).toBeInTheDocument();
    await writeComment("Closes on a click outside");
    // Clicking inside the discussion keeps it.
    click(within(panel()).getByText("Closes on a click outside", { selector: ".archer-comment-body" }));
    expect(panel()).toBeInTheDocument();
    // Dragging the canvas to pan keeps it beside its anchor.
    click(document.body, { x: 200, y: 140 });
    expect(panel()).toBeInTheDocument();
    click(document.body);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Contextual discussion" })).toBeNull());
  });

  it("says the same thing twice as two announcements", async () => {
    await mount();
    for (const text of ["one", "two"]) {
      newComment();
      await writeComment(text);
    }
    // Same words, different content: a screen reader speaks the second too.
    expect(announcement().textContent).not.toBe("Comment saved as a draft.");
    expect(announcement().textContent?.trim()).toBe("Comment saved as a draft.");
  });

  it("counts every draft in the project and sends them all in one action", async () => {
    await mount({ another: true });
    await comments.draft("view:another", "elsewhere");
    await comments.draft("view:another", "and here", { kind: "node", id: "db", label: "Database" });
    newComment();
    await writeComment("here");
    const send = await within(panel()).findByRole("button", { name: "Send queued comments (3)" });
    // No list of where the drafts are (decided 2026-10-29): the count says enough.
    expect(within(panel()).queryByText("Where the drafts are")).toBeNull();
    expect(document.querySelector(".archer-review-toggle")).toHaveAccessibleName("Notifications");

    fireEvent.click(send);
    await within(thread(/Whole diagram/)).findByText("Sent");
    // Every draft, including the two on the diagram not on screen.
    expect((await comments.list("view:another")).map((t) => t.status)).toEqual(["sent", "sent"]);
    await waitFor(() => expect(within(panel()).queryByRole("button", { name: /^Send queued comments/ })).toBeNull());
    expect(within(panel()).queryByRole("list", { name: "Where the drafts are" })).toBeNull();
    expect(announcement()).toHaveTextContent("Sent 3 threads to the agent.");
  });

  it("starts closed on a phone-width window", async () => {
    await mountClosed({ viewport: { width: 390, coarse: true } });
    const toggle = await waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>(".archer-review-toggle");
      expect(button).not.toBeNull();
      return button!;
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("writes a comment on the whole diagram as a draft, and counts it as waiting", async () => {
    await mount();
    newComment();
    expect(within(panel()).getByRole("textbox", { name: "Comment" })).toHaveFocus();
    await writeComment("Is this the whole system?");
    const article = thread(/Whole diagram/);
    expect(within(article).getByText("Draft")).toBeInTheDocument();
    expect(within(article).getByText("You")).toBeInTheDocument();
    expect(document.querySelector(".archer-review-toggle")).toHaveAccessibleName("Notifications");
    expect(await within(panel()).findByRole("button", { name: "Send queued comments (1)" })).toBeEnabled();
    expect(article).toHaveFocus();
  });

  it("comments on the selected node with C, and marks the node", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
    fireEvent.click(document.querySelector('.react-flow__node[data-id="web"]')!);
    fireEvent.keyDown(window, { key: "c" });
    expect(
      await within(panel()).findByText("Node: Web app", { selector: ".primary-floating-context" }),
    ).toBeInTheDocument();
    await writeComment("Why does the web app call the API directly?");
    expect(thread(/Node: Web app/)).toBeInTheDocument();
    await waitFor(() =>
      expect(document.querySelector('.react-flow__node[data-id="web"] .archer-pin')?.textContent).toBe("1"),
    );
    expect(document.querySelector('.react-flow__node[data-id="web"]')).toHaveAttribute(
      "aria-label",
      "Web app, has comments",
    );
    expect(document.querySelector('.react-flow__node[data-id="api"] .archer-pin')).toBeNull();
  });

  it("comments on several selected elements as one selection", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
    fireEvent.click(document.querySelector('.react-flow__node[data-id="web"]')!);
    fireEvent.click(document.querySelector('.react-flow__node[data-id="api"]')!, { shiftKey: true });
    fireEvent.keyDown(window, { key: "c" });
    expect(
      await within(panel()).findByText("2 elements: Web app, API", { selector: ".primary-floating-context" }),
    ).toBeInTheDocument();
    await writeComment("These two are one deployable.");
    expect(thread(/2 elements: Web app, API/)).toBeInTheDocument();
  });

  it("comments on an element from its context menu, and on a group from its own", async () => {
    await mount();
    fireEvent.contextMenu(document.querySelector('.react-flow__node[data-id="db"]')!);
    // A box's menu: Comment first, then Expand (ADR 0036 A9).
    fireEvent.click(await screen.findByRole("menuitem", { name: "Comment" }));
    expect(
      await within(panel()).findByText("Node: Database", { selector: ".primary-floating-context" }),
    ).toBeInTheDocument();
    // The node is selected, so what the comment is about is lit while it is written.
    await waitFor(() => expect(document.querySelector('.react-flow__node[data-id="db"]')).toHaveClass("selected"));
    // The panel names the target; the composer does not repeat it or offer another.
    expect(within(panel()).queryByRole("combobox")).toBeNull();
    await writeComment("Is this the only store?");
    expect(thread(/Node: Database/)).toBeInTheDocument();
  });

  it("keeps the browser's menu on empty canvas", async () => {
    await mount();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    document.querySelector(".react-flow__pane")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("cancels a comment with Escape, and the selection stays", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
    fireEvent.click(document.querySelector('.react-flow__node[data-id="web"]')!);
    fireEvent.keyDown(window, { key: "c" });
    const box = await within(panel()).findByRole("textbox", { name: "Comment" });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("form", { name: "New comment" })).toBeNull();
    expect(document.querySelector('.react-flow__node[data-id="web"]')).toHaveClass("selected");
  });

  it("edits and deletes the person's own comment in place", async () => {
    await mount();
    newComment();
    await writeComment("First thought");
    const article = thread(/Whole diagram/);
    fireEvent.click(within(article).getByRole("button", { name: "Edit" }));
    const editor = within(article).getByRole("textbox", { name: "Edit your comment" });
    expect(editor).toHaveFocus();
    fireEvent.change(editor, { target: { value: "Second thought" } });
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
    expect(
      await within(article).findByText("Second thought", { selector: ".archer-comment-body" }),
    ).toBeInTheDocument();
    expect(within(article).getByText("edited")).toBeInTheDocument();
    expect(within(article).getByText("Draft")).toBeInTheDocument();

    fireEvent.click(within(article).getByRole("button", { name: "Delete" }));
    const confirm = within(article).getByRole("group", { name: "Delete this comment?" });
    expect(within(confirm).getByRole("button", { name: "Keep" })).toHaveFocus();
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Contextual discussion" })).toBeNull());
    expect(await comments.list("view:system")).toEqual([]);
  });

  it("submits every waiting thread, then shows the agent's reply as it arrives, and resolves", async () => {
    await mount();
    newComment();
    await writeComment("What does the API cache?");
    fireEvent.click(await within(panel()).findByRole("button", { name: "Send queued comments (1)" }));
    const article = thread(/Whole diagram/);
    expect(await within(article).findByText("Sent")).toBeInTheDocument();
    await waitFor(() => expect(within(panel()).queryByRole("button", { name: /^Send queued comments/ })).toBeNull());
    expect(announcement()).toHaveTextContent("Sent 1 thread to the agent.");
    expect((await submitted()).map((t) => t.comments[0]!.body)).toEqual(["What does the API cache?"]);

    // The agent answers; the page hears of it on the stream and reads it.
    await agentAnswers("Sessions, for an hour.");
    expect(await within(article).findByText("Sessions, for an hour.")).toBeInTheDocument();
    expect(within(article).getByText("Answered")).toBeInTheDocument();
    expect(within(article).getByText("Agent")).toBeInTheDocument();
    // The agent's words are not the person's to change.
    expect(within(article).getAllByRole("button", { name: "Edit" })).toHaveLength(1);
    await waitFor(() => expect(announcement()).toHaveTextContent("The agent replied on Whole diagram."));

    fireEvent.click(within(article).getByRole("button", { name: "Resolve" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Contextual discussion" })).toBeNull());
    expect(screen.getByRole("button", { name: /^Notifications/ })).toHaveFocus();
  });

  it("says a thread changed after it was submitted, and counts it as waiting again", async () => {
    await mount();
    newComment();
    await writeComment("Original");
    fireEvent.click(await within(panel()).findByRole("button", { name: "Send queued comments (1)" }));
    const article = thread(/Whole diagram/);
    await within(article).findByText("Sent");
    fireEvent.click(within(article).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(article).getByRole("textbox", { name: "Edit your comment" }), {
      target: { value: "Revised" },
    });
    fireEvent.click(within(article).getByRole("button", { name: "Save" }));
    expect(await within(article).findByText("Changed after sending")).toBeInTheDocument();
    expect(await within(panel()).findByRole("button", { name: "Send queued comments (1)" })).toBeEnabled();
  });

  it("replies in a thread, and offers resolve rather than delete for a first comment with replies", async () => {
    await mount();
    newComment();
    await writeComment("Question");
    const article = thread(/Whole diagram/);
    fireEvent.click(within(article).getByRole("button", { name: "Reply" }));
    fireEvent.change(within(article).getByRole("textbox", { name: "Your reply" }), {
      target: { value: "And another" },
    });
    fireEvent.click(within(article).getByRole("button", { name: "Reply" }));
    expect(await within(article).findByText("And another", { selector: ".archer-comment-body" })).toBeInTheDocument();
    const [first, second] = within(article).getAllByRole("listitem");
    expect(within(first!).queryByRole("button", { name: "Delete" })).toBeNull();
    expect(within(first!).getByText(/resolve the thread to remove it/)).toBeInTheDocument();
    expect(within(second!).getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("shows an orphaned thread for what it was, and does not mark the canvas for it", async () => {
    await mount();
    fireEvent.contextMenu(document.querySelector('.react-flow__node[data-id="api"]')!);
    // A box's menu: Comment first, then Expand (ADR 0036 A9).
    fireEvent.click(await screen.findByRole("menuitem", { name: "Comment" }));
    await writeComment("About the API");
    await waitFor(() => expect(document.querySelectorAll(".archer-stage .archer-pin")).toHaveLength(1));
    // The agent takes the API out of the diagram: the thread on it is orphaned (the store finds its element gone).
    await project.agentWrite("system", ".archer/system.mmd", "flowchart LR\n  web[Web app] e3@--> db[(Database)]\n");
    const article = await within(panel()).findByRole("article", { name: /Node: API/ });
    expect(await within(article).findByText("Orphaned")).toBeInTheDocument();
    expect(within(article).getByText(/no longer in the diagram/)).toBeInTheDocument();
    // Nothing on the canvas is marked for it.
    await waitFor(() => expect(document.querySelectorAll(".react-flow__node.archer-node")).toHaveLength(2));
    await waitFor(() => expect(document.querySelector(".archer-stage .archer-pin")).toBeNull());
  });

  it("says what the server refused, in its words", async () => {
    await mount();
    newComment();
    const box = await within(panel()).findByRole("textbox", { name: "Comment" });
    fireEvent.change(box, { target: { value: "bell\u0007" } });
    fireEvent.click(within(panel()).getByRole("button", { name: "Add comment" }));
    expect(await within(panel()).findByRole("alert")).toHaveTextContent(
      "Could not add the comment: the comment holds a control character",
    );
    // What was typed is kept for the person to fix.
    expect(box).toHaveValue("bell\u0007");
  });

  it("says which comments files the server could not read on submit", async () => {
    await mount();
    writeFileSync(join(project.root, ".archer/broken.comments.json"), "not JSON");
    newComment();
    await writeComment("x");
    fireEvent.click(await within(panel()).findByRole("button", { name: "Send queued comments (1)" }));
    expect(await within(panel()).findByRole("alert")).toHaveTextContent(/\.archer\/broken\.comments\.json is not JSON/);
  });

  it("reads everything again when the stream comes back", async () => {
    const { source } = await mount();
    source.hold(true); // a change made while the stream was down: the page hears nothing of it
    await comments.draft("view:system", "Written elsewhere");
    await act(async () => void (await new Promise((done) => setTimeout(done, 200))));
    expect(within(inbox()).queryByText("Written elsewhere")).toBeNull();
    source.hold(false);
    act(() => source.onopen?.(new Event("open")));
    expect(await within(inbox()).findByText("Written elsewhere")).toBeInTheDocument();
  });
});

describe("notes", () => {
  it("lists project notes by title and file name without opening the note reader", async () => {
    await mount();
    const files = await filesTable();
    const auth = await within(files).findByRole("button", { name: "Auth" });
    expect(auth.closest("[data-browser-row]")).toHaveTextContent("auth.md");
    expect(screen.queryByRole("article", { name: "Reading Auth" })).toBeNull();
    expect(await within(files).findByRole("button", { name: "Elsewhere" })).toBeVisible();
  });

  it("reads a note when it is opened, as Markdown and never as HTML", async () => {
    await mount();
    const reader = await openNote();
    const body = await within(reader).findByRole("document", { name: "Note: Auth" });
    await waitFor(() => expect(body.querySelectorAll("li")).toHaveLength(2));
    // Its leading "# Auth" repeats the title the reader already shows as the page's h1 (G6).
    expect(body.querySelector("h2.archer-note-h1")).toBeNull();
    expect(body.querySelector("script")).toBeNull();
    expect(body.textContent).toContain("<script>window.pwned = 1</script>");
  });

  it("keeps a selection in the note when the note's threads reload unchanged", async () => {
    const { source } = await mount();
    const reader = await openNote();
    const body = await within(reader).findByRole("document", { name: "Note: Auth" });
    await waitFor(() => expect(body.querySelector("p")).not.toBeNull());
    const text = body.querySelector("p")!.firstChild as Text;
    const start = text.data.indexOf("expire after a week");
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + "expire after a week".length);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    act(() => void document.dispatchEvent(new Event("selectionchange")));

    act(() => source.emit("comments", { target: "note:notes/auth.md" }));
    await act(async () => void (await new Promise((done) => setTimeout(done, 100))));

    expect(text.isConnected).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Comment on selection" }));
    expect(
      screen.getByText("Passage: “expire after a week”", { selector: ".primary-floating-context" }),
    ).toBeInTheDocument();
  });

  it("comments on a passage selected in the note, and marks it", async () => {
    await mount();
    const reader = await openNote();
    const body = await within(reader).findByRole("document", { name: "Note: Auth" });
    await waitFor(() => expect(body.querySelector("p")).not.toBeNull());
    expect(screen.queryByRole("button", { name: "Comment on selection" })).toBeNull();

    const text = body.querySelector("p")!.firstChild as Text;
    const start = text.data.indexOf("expire after a week");
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + "expire after a week".length);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    act(() => void document.dispatchEvent(new Event("selectionchange")));

    const commentOnSelection = screen.getByRole("button", { name: "Comment on selection" });
    expect(commentOnSelection).toBeEnabled();
    fireEvent.click(commentOnSelection);
    expect(
      screen.getByText("Passage: “expire after a week”", { selector: ".primary-floating-context" }),
    ).toBeInTheDocument();
    await writeComment("Is a week too long?");

    const [saved] = await comments.list("note:notes/auth.md");
    expect(saved?.anchor).toEqual({
      kind: "passage",
      quote: "expire after a week",
      prefix: "Tokens expire after an hour. Refresh tokens ".slice(-32),
      suffix: ".",
    });
    await waitFor(() => expect(body.querySelector("mark.archer-passage")?.textContent).toBe("expire after a week"));
    expect(within(reader).getByRole("button", { name: "Open discussion on this passage" })).toBeInTheDocument();
    const discussion = await within(reader).findByRole("group", { name: "Discussion on expire after a week" });
    expect(within(discussion).getByText("Is a week too long?")).toBeInTheDocument();
    // A note's draft is waiting like any other.
    expect(await within(inbox()).findByRole("button", { name: "Send queued comments (1)" })).toBeEnabled();
  });

  it("says when a passage is no longer in the note", async () => {
    await mount();
    await comments.draft("note:notes/auth.md", "Gone?", {
      kind: "passage",
      quote: "expire after a week",
      prefix: "Tokens expire after an hour. Refresh tokens ".slice(-32),
      suffix: ".",
    });
    // The person rewrites the note without those words (the service takes a passage only where it is).
    writeFileSync(
      join(project.root, ".archer/notes/auth.md"),
      "---\ndiagrams: [../system.mmd]\n---\n# Auth\n\nTokens expire after an hour.\n",
    );
    const reader = await openNote();
    fireEvent.click(await within(reader).findByRole("button", { name: "Open discussion on “expire after a week”" }));
    const discussion = await within(reader).findByRole("group", { name: "Discussion on expire after a week" });
    expect(await within(discussion).findByText("Orphaned")).toBeInTheDocument();
    expect(within(discussion).getByText(/no longer in the note/)).toBeInTheDocument();
  });

  it("comments on the whole note", async () => {
    await mount();
    const reader = await openNote();
    const body = await within(reader).findByRole("document", { name: "Note: Auth" });
    // The document landmark appears before its Markdown placement effect finishes.
    await waitFor(() => expect(body.querySelector("p")).toHaveTextContent("Tokens expire after an hour."));
    body.focus();
    fireEvent.keyDown(body, { key: "F10", shiftKey: true });
    fireEvent.click(screen.getByRole("menuitem", { name: "Comment on note" }));
    expect(screen.getByText("Whole note", { selector: ".primary-floating-context" })).toBeInTheDocument();
    await writeComment("Needs a diagram of the refresh path.");
    expect((await comments.list("note:notes/auth.md"))[0]?.anchor).toEqual({ kind: "view" });
  });
});

describe("the chat bubble on a note", () => {
  const box = (): HTMLElement => screen.getByRole("textbox", { name: "Message to the agent" });
  it("C on a note opens the chat about the note, not a composer", async () => {
    await mountClosed();
    const reader = await openNote();
    await within(reader).findByRole("document", { name: "Note: Auth" });
    fireEvent.keyDown(window, { key: "c" });
    expect(await screen.findByRole("dialog", { name: /Chat with the agent\s+Auth/ })).toBeInTheDocument();
    expect(screen.getByRole("log")).toHaveTextContent("about this note");
    expect(screen.queryByRole("region", { name: "Contextual discussion" })).toBeNull();
  });
  it("switching documents closes the chat of the one left and keeps its draft for the return", async () => {
    await mountClosed();
    const reader = await openNote();
    await within(reader).findByRole("document", { name: "Note: Auth" });
    fireEvent.keyDown(window, { key: "c" });
    fireEvent.change(await screen.findByRole("textbox", { name: "Message to the agent" }), {
      target: { value: "half a thought" },
    });
    // Out to the project page: no chat there (nothing to talk about), and no draft lost.
    fireEvent.click(screen.getByRole("button", { name: "Archer contents" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Chat with the agent/ })).toBeNull());
    await openNote();
    fireEvent.click(await screen.findByRole("button", { name: /^Chat with the agent about Auth/ }));
    expect(box()).toHaveValue("half a thought");
  });
});
