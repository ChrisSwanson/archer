// @vitest-environment jsdom
//
// What the page tells a reader about commenting and moving between diagrams:
// the `?` sheet's Commenting and Diagrams sections, and the side panel's
// hints, which must name gestures the reader's own pointer has.
//
// The real `App` over the real service, as `comments-app.test.tsx` mounts it.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
import { resetApplicationUpdate } from "../src/app/application-update";
import { openFile } from "./support/primary-navigation";
import { COMMENTING_SECTION, DIAGRAMS_SECTION } from "../src/app/HelpOverlay";
import { MockEventSource, mountAgentPresented, restoreLocation } from "./app-harness";
import { installViewport, type Viewport } from "./match-media";
import { pageOnService, SERVICE_HOME, SYSTEM_MMD, viewEntry, type PageOnService } from "./support/page-on-service";
import { startTsProject, type TsProject } from "./support/ts-service";

/** The project: the system diagram (and another, when asked), and a note on the system. */
const files = (another = false): Record<string, string> => ({
  "archer.toml": `version = 1\n\n${viewEntry("system", "The system")}${another ? viewEntry("another", "Another") : ""}`,
  ".archer/system.mmd": SYSTEM_MMD,
  ...(another ? { ".archer/another.mmd": SYSTEM_MMD } : {}),
  ".archer/notes/auth.md": "---\ndiagrams: [../system.mmd]\n---\n# Auth\n\nTokens expire after an hour.\n",
});

let service: TsProject;
let project: TsProject | undefined;
let page: PageOnService | undefined;

beforeAll(async () => {
  service = await startTsProject({ files: SERVICE_HOME, commentSubmission: "queued" });
}, 30_000);
afterAll(async () => {
  await service?.stop();
});

async function mount(viewport: Viewport, options: { another?: boolean } = {}): Promise<void> {
  project = await service.attachProject(files(options.another));
  await project.present("system");
  page = await pageOnService(project, { path: "/" });
  installViewport(viewport);
  render(<App />);
  await waitFor(() => expect(document.querySelectorAll(".react-flow__node.archer-node")).toHaveLength(3));
}

const DESKTOP: Viewport = { width: 1440, coarse: false };
const PHONE: Viewport = { width: 390, coarse: true };

beforeEach(() => {
  MockEventSource.instances = [];
});

afterEach(async () => {
  cleanup();
  await page?.close();
  restoreLocation();
  resetApplicationUpdate();
  vi.unstubAllGlobals();
  await project?.stop();
  project = undefined;
  page = undefined;
});

const panel = (): HTMLElement => screen.getByRole("region", { name: "Project Review" });
const sheet = (): HTMLElement => screen.getByRole("dialog", { name: "Keyboard & Pointer" });
const sections = (): string[] =>
  within(sheet())
    .getAllByRole("heading", { level: 3 })
    .map((h) => h.textContent ?? "");
const rowsOf = (name: string): string[] => {
  const heading = within(sheet()).getByRole("heading", { level: 3, name });
  return [...heading.parentElement!.querySelectorAll("dt")].map((dt) => dt.textContent ?? "");
};

describe("the ? sheet says how to comment", () => {
  it("has a Commenting section naming every way in, and what happens to a comment", async () => {
    await mount(DESKTOP);
    act(() => void fireEvent.keyDown(window, { key: "?" }));

    expect(sections()).toContain("Commenting");
    expect(rowsOf("Commenting")).toEqual(COMMENTING_SECTION.keys.map(([key]) => key));
    const text = within(sheet()).getByRole("heading", { level: 3, name: "Commenting" }).parentElement!.textContent!;
    expect(text).toMatch(/Right-click/);
    expect(text).toMatch(/New comment/);
    expect(text).toMatch(/Send queued comments/);
    // Sent at once by default; queued only when archer.toml says so (decided 2026-10-29).
    expect(text).toMatch(/goes to the agent at once/);
    expect(text).toMatch(/comment_submission = "queued"/);
    expect(text).not.toMatch(/Nothing reaches the agent yet/);
    expect(text).toMatch(/pin/);
    expect(text).toMatch(/your own comments/i);
  });

  it("leaves it out where the server takes no comments", async () => {
    // The service always takes comments: a server that names no capabilities is the stub harness's.
    installViewport(DESKTOP);
    vi.stubGlobal("EventSource", MockEventSource);
    await mountAgentPresented(<App />);
    act(() => void fireEvent.keyDown(window, { key: "?" }));
    expect(sections()).not.toContain("Commenting");
  });

  it("names the keys between diagrams when there is more than one", async () => {
    await mount(DESKTOP, { another: true });
    act(() => void fireEvent.keyDown(window, { key: "?" }));
    expect(rowsOf("Diagrams")).toEqual(DIAGRAMS_SECTION.keys.map(([key]) => key));
    // [ and ] here; / and G are Search's, which works with one diagram or many.
    expect(rowsOf("Diagrams")).toEqual(["[", "]"]);
    expect(rowsOf("Search")).toEqual(["/", "G"]);
  });

  it("does not offer to switch diagrams when there is only one", async () => {
    await mount(DESKTOP);
    act(() => void fireEvent.keyDown(window, { key: "?" }));
    expect(sections()).not.toContain("Diagrams");
  });
});

describe("the side panel's hints follow the reader's pointer", () => {
  it("says press C or right-click to a mouse and keyboard", async () => {
    await mount(DESKTOP);
    // Collapsed to its rail beside the drawing until something is opened in it.
    fireEvent.click(screen.getByRole("button", { name: /^Notifications/ }));
    // The inbox says "Loading discussions…" until its read answers (O302).
    const hint = await within(panel()).findByText(/No discussions/);
    expect(hint).toHaveTextContent(/press C/);
    expect(hint).toHaveTextContent(/right-click/);
  });

  it("names no key and no right-click on a touch screen", async () => {
    await mount(PHONE);
    // The panel starts closed on a phone; opening it is the toggle in the bar.
    fireEvent.click(screen.getByRole("button", { name: /^Notifications/ }));
    // The inbox says "Loading discussions…" until its read answers (O302).
    const hint = await within(panel()).findByText(/No discussions/);
    expect(hint).not.toHaveTextContent(/press C/i);
    expect(hint).not.toHaveTextContent(/right-click/i);
    expect(hint).toHaveTextContent(/New comment/);
    expect(within(panel()).getByRole("button", { name: "New comment" })).not.toHaveAttribute(
      "title",
      expect.stringContaining("(C)"),
    );
  });

  it("offers a keyboard whole-note action without static selection controls", async () => {
    await mount(DESKTOP);
    // Diagram rendering and review capabilities arrive independently. Wait for
    // the commenting controls before exercising the note keyboard action.
    await screen.findByRole("button", { name: /^Notifications/ });
    await openFile("Auth");
    const note = await screen.findByRole("article", { name: "Reading Auth" });
    const body = await within(note).findByRole("document", { name: "Note: Auth" });
    expect(screen.queryByRole("button", { name: "Comment on selection" })).toBeNull();
    // The note's text loads after its frame; the action needs it.
    await waitFor(() => expect(body).toHaveTextContent("Tokens expire after an hour."));
    fireEvent.keyDown(body, { key: "F10", shiftKey: true });
    expect(screen.getByRole("menuitem", { name: "Comment on note" })).toHaveFocus();
  });
});

describe("controls a phone reader taps", () => {
  it("name the panel toggle in words when it shows only an icon", async () => {
    await mount(PHONE);
    const toggle = screen.getByRole("button", { name: /^Notifications/ });
    // The compact bell retains its accessible name and tooltip at phone widths.
    expect(toggle).toHaveAccessibleName("Notifications");
    expect(toggle).toHaveAttribute("aria-controls", "archer-review");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).not.toBeNull();
  });
});
