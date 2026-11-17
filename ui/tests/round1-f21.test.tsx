// @vitest-environment jsdom
// Round 1 (UI/UX) fixes, pass 6, batch F21: the shell. Each test names its row in the pass's fix list and the
// finding it answers.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebShell, WORKSPACE_ACTIONS } from "../src/app/WebShell";
import { SourceDocumentPage } from "../src/app/SourceDocumentPage";
import { forgetProjectCatalogs } from "../src/app/project-directory";

const navigation = {
  workspace: "Archer",
  currentSlug: null,
  place: null,
  searchOpen: false,
  recents: [],
  onContents: vi.fn(),
  onSearch: vi.fn(),
  onOpenProject: vi.fn(),
  onOpenRecent: vi.fn(),
};
const help = { controller: { open: false, hide: vi.fn(), toggle: vi.fn() }, view: "none" as const };
const css = (path: string): string => readFileSync(resolve(__dirname, "../src", path), "utf8");

/** Each element with `data-box="x y w h"` is drawn there, later ones on top; `elementFromPoint` finds the topmost. */
function layout(): void {
  const boxOf = (element: Element): DOMRect | null => {
    const box = element.getAttribute("data-box");
    if (box === null) return null;
    const [x, y, w, h] = box.split(" ").map(Number) as [number, number, number, number];
    return { x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h, toJSON: () => ({}) } as DOMRect;
  };
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    for (let at: Element | null = this; at !== null; at = at.parentElement) {
      const box = boxOf(at);
      if (box !== null) return box;
    }
    return { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0, toJSON: () => ({}) } as DOMRect;
  });
  document.elementFromPoint = (x: number, y: number): Element | null => {
    const boxes = [...document.querySelectorAll("[data-box]")].reverse();
    return (
      boxes.find((element) => {
        const box = boxOf(element)!;
        return x >= box.left && x < box.right && y >= box.top && y < box.bottom;
      }) ?? null
    );
  };
}
const frame = async (): Promise<void> => {
  await act(async () => {
    await new Promise((done) => requestAnimationFrame(() => done(undefined)));
  });
};

beforeEach(() => {
  window.innerWidth = 390;
  window.innerHeight = 844;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  forgetProjectCatalogs();
});

/** A phone page: canvas controls and the Highlights chip low on the right, the Chat button over them, and the chat. */
function phonePage(chat: "sheet" | "float" | null): ReactElement {
  return (
    <WebShell
      context={{ kind: "service", actions: WORKSPACE_ACTIONS }}
      navigation={navigation}
      identity={{ title: "Page" }}
      help={help}
    >
      <div data-box="0 0 390 844">
        <button type="button" data-box="10 60 60 30">
          Edit
        </button>
        <button type="button" data-box="16 600 44 44">
          Zoom in
        </button>
        <button type="button" data-box="200 700 100 44">
          Highlights
        </button>
        <div className="react-flow__renderer">
          <button type="button" data-box="150 500 100 40">
            Storefront
          </button>
        </div>
        <button type="button" className="archer-chat-fab" aria-controls="archer-chat-panel" data-box="320 760 56 56">
          Chat
        </button>
      </div>
      {chat === null ? null : (
        <section
          id="archer-chat-panel"
          className="archer-chat"
          data-mode={chat}
          role="dialog"
          aria-label="Chat"
          style={{ position: "fixed" }}
          data-box="0 400 390 444"
        >
          <button type="button" data-box="330 410 44 44">
            Collapse chat
          </button>
          <textarea aria-label="Message" data-box="10 760 300 60" />
        </section>
      )}
    </WebShell>
  );
}

it("F21 row 1 / R5-claude-01: on a phone, what the Chat sheet lies over cannot take focus; the sheet stays usable", async () => {
  layout();
  const { rerender } = render(phonePage("sheet"));
  await frame();
  for (const name of ["Zoom in", "Highlights", "Chat"])
    expect(screen.getByRole("button", { name, hidden: true })).toHaveAttribute("inert");
  // Above the sheet, in it, and the drawing (which the canvas brings into the clear itself) stay usable.
  expect(screen.getByRole("button", { name: "Edit" })).not.toHaveAttribute("inert");
  expect(screen.getByRole("button", { name: "Storefront" })).not.toHaveAttribute("inert");
  expect(screen.getByRole("button", { name: "Collapse chat" })).not.toHaveAttribute("inert");
  expect(screen.getByRole("textbox", { name: "Message" })).not.toHaveAttribute("inert");
  rerender(phonePage(null));
  await frame();
  for (const name of ["Zoom in", "Highlights", "Chat"])
    expect(screen.getByRole("button", { name })).not.toHaveAttribute("inert");
});

it("F21 row 1: closed with focus in it, the Chat sheet gives focus back to the Chat button, which is no longer inert", async () => {
  layout();
  const { rerender } = render(phonePage("sheet"));
  await frame();
  screen.getByRole("textbox", { name: "Message" }).focus();
  rerender(phonePage(null));
  // The chat's own refocus (ChatBubble) runs while the button is still inert, and a browser drops it; the shell
  // gives focus back once the button is usable again, as it does for the review.
  await frame();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Chat" }));
});

it("F21 row 1: the desktop's floating chat window is not a cover; what it lies beside stays usable", async () => {
  layout();
  render(phonePage("float"));
  await frame();
  for (const name of ["Zoom in", "Highlights", "Chat"])
    expect(screen.getByRole("button", { name })).not.toHaveAttribute("inert");
});

it("F21 row 1: the canvas treats the Chat sheet as an inerting cover too, as WebShell does", () => {
  const cover = /const INERTING_COVER =\s*"([^"]*)"/.exec(css("diagrams/DiagramCanvas.tsx"))?.[1] ?? "";
  expect(cover).toContain(".archer-chat[data-mode='sheet']");
});

it("F21 row 2 / R5-02 / R5-claude-06: the zero-projects heading takes the display token, not the browser's 1.5em", () => {
  expect(css("app/ProjectPages.css")).toMatch(/\.archer-search-empty h2 \{[^}]*font-size: var\(--type-display\)/);
});

it("F21 row 3 / R5-claude-08: a missing file's breadcrumb names the project by its name, not its slug", async () => {
  window.history.replaceState(null, "", "/projects/pageturner/documents/docs/gone.md");
  const catalog = { schemaVersion: 1, projects: [{ slug: "pageturner", name: "Pageturner", views: [], notes: [] }] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      String(url).includes("api/browser-projects")
        ? {
            ok: true,
            status: 200,
            headers: new Headers(),
            text: async () => JSON.stringify(catalog),
            json: async () => catalog,
          }
        : { ok: false, status: 404, json: async () => ({}) },
    ),
  );
  render(<SourceDocumentPage projectSlug="pageturner" path="docs/gone.md" missing="moved" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("moved or deleted");
  const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
  expect(await within(trail).findByRole("button", { name: "Pageturner" })).toBeInTheDocument();
  expect(within(trail).queryByRole("button", { name: "pageturner" })).toBeNull();
});
