// @vitest-environment jsdom
// Round 1 (UI/UX) fixes, pass 5, batch F18: overlays, panels, phone menu. Each test names its row in the
// pass's fix list and the finding it answers.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, render, screen } from "@testing-library/react";
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

/**
 * A small layout for jsdom: each element with `data-box="x y w h"` is drawn there, later ones on top, and
 * `elementFromPoint` answers with the topmost box under the point.
 */
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
  window.innerWidth = 1500;
  window.innerHeight = 900;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  forgetProjectCatalogs();
});

for (const [id, className] of [
  ["archer-accuracy-panel", "archer-artifact-wrapper"],
  ["archer-export-panel", "archer-artifact-wrapper"],
  ["archer-comparison-panel", "archer-comparison-panel"],
] as const) {
  it(`R4-01 / R4-claude-07: what the ${id} lies over cannot take focus, and is given back when it closes`, async () => {
    layout();
    const page = (open: boolean) => (
      <WebShell
        context={{ kind: "service", actions: WORKSPACE_ACTIONS }}
        navigation={navigation}
        identity={{ title: "Page" }}
        help={help}
      >
        <div data-box="0 0 1500 900">
          <button type="button" data-box="1400 120 60 30">
            Edit
          </button>
          <button type="button" data-box="1200 160 80 30">
            Highlights
          </button>
          <button type="button" data-box="200 160 60 30">
            Beside
          </button>
          <div className="react-flow__renderer">
            <button type="button" data-box="1250 300 100 40">
              Storefront
            </button>
          </div>
        </div>
        {open ? (
          <div id={id} className={className} style={{ position: "fixed" }} data-box="1036 80 448 300">
            <section>
              <button type="button" data-box="1400 100 60 40">
                Close
              </button>
            </section>
          </div>
        ) : null}
      </WebShell>
    );
    const { rerender } = render(page(true));
    await frame();
    expect(screen.getByRole("button", { name: "Edit", hidden: true })).toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: "Highlights", hidden: true })).toHaveAttribute("inert");
    // Beside the panel, in it, and the drawing (which the canvas reveals itself) stay usable.
    expect(screen.getByRole("button", { name: "Beside" })).not.toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: "Close" })).not.toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: "Storefront" })).not.toHaveAttribute("inert");
    rerender(page(false));
    await frame();
    expect(screen.getByRole("button", { name: "Edit" })).not.toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: "Highlights" })).not.toHaveAttribute("inert");
  });
}

it("R4-01: on a phone the accuracy and export panels sit beside the canvas's tool column, as Compare does", () => {
  const phone =
    /@media \(max-width: 560px\) \{([^}]*\{[^}]*\})*[^}]*\}/.exec(css("export/export-controls.css"))?.[0] ?? "";
  expect(phone).toMatch(
    /\.archer-artifact-wrapper \{[^}]*left: calc\(15px \+ var\(--icon-touch\) \+ 2 \* var\(--icon-group-inset\) \+ 2px \+ \.5rem\)/,
  );
  expect(phone).toMatch(/\.archer-artifact-wrapper \{[^}]*width: auto/);
});

it("R4-05: the phone menu's tooltip says what is behind it: settings and help (H2 T10/T16); its name stays Menu (F58/F60)", () => {
  render(
    <WebShell
      context={{ kind: "service", actions: WORKSPACE_ACTIONS }}
      navigation={navigation}
      identity={{ title: "Page" }}
      help={help}
    >
      Content
    </WebShell>,
  );
  const menu = screen.getByRole("button", { name: "Menu" });
  expect(menu).toHaveAttribute("title", "Projects, settings and help");
  expect(menu).toHaveAccessibleDescription("Projects, settings and help");
  expect(menu.textContent).toBe("");
});

it("D18: a missing document's page does not say Read-only (a shown one does: source-document-page.test.tsx)", async () => {
  window.history.replaceState(null, "", "/projects/example-12345678/-/repo/docs/gone.md");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
  );
  render(<SourceDocumentPage projectSlug="example-12345678" path="docs/gone.md" missing="moved" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("moved or deleted");
  expect(screen.queryByText("Read-only")).toBeNull();
});

it("R4-06 / R4-claude-06: the accuracy and export heading is the title token, not 18px", () => {
  expect(css("export/export-controls.css")).toMatch(
    /\.archer-artifact-header h2 \{[^}]*font-size: var\(--type-title\)/,
  );
});

it("R4-04 / R4-claude-02: the panels' secondary controls reach 44px on a coarse pointer", () => {
  const walk = css("walkthroughs/walkthroughs.css");
  const coarse = [...walk.matchAll(/@media \(pointer: coarse\) \{([\s\S]*?)\n\}/g)].map((match) => match[1]).join("\n");
  expect(coarse).toMatch(/\.archer-walk-icon[^{]*\{[^}]*width: var\(--icon-touch\)[^}]*height: var\(--icon-touch\)/);
  expect(coarse).toMatch(/\.archer-walk-tabs button[^{]*\{[^}]*min-height: var\(--icon-touch\)/);
  expect(coarse).toMatch(/\.archer-walk-pick[^{]*\{[^}]*min-height: var\(--icon-touch\)/);
  expect(css("export/export-controls.css")).toMatch(
    /@media \(pointer: coarse\) \{[^{]*\.archer-artifact-panel :is\(button, select\)[^{]*\{[^}]*min-height: var\(--icon-touch\)/,
  );
  expect(css("styles.css")).toMatch(/\.archer-emph-legend-mode button \{\s*min-width: var\(--icon-touch\);/);
});

it("R4-claude-01 / -03: the walkthrough's picker and meta fit the panel, and step labels size to their text", () => {
  const walk = css("walkthroughs/walkthroughs.css");
  expect(walk).toMatch(/\.archer-walk-top \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  expect(walk).toMatch(/\.archer-walk-body \{[^}]*grid-template-columns: max-content minmax\(0, 1fr\)/);
});
