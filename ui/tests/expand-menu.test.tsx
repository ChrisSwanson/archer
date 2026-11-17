// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DetailsAndAdditions, ExpandMenu } from "../src/expand/ExpandUi";
import { readExpandMenu } from "../src/expand/pieces";
import type { MenuState } from "../src/expand/use-expand";
import { StageDockContext } from "../src/app/stage-dock";
import { installViewport } from "./match-media";

const answer = readExpandMenu(JSON.parse(readFileSync("tests/fixtures/expand/menu-context-shop.json", "utf8")))!;
const state: MenuState = {
  target: { canvasId: "shop", kind: "node", label: "Shop", x: 100, y: 100 },
  element: "shop",
  canComment: true,
  expand: true,
  inside: null,
  answer: { status: "ready", menu: answer },
  from: null,
};
const callbacks = () => ({
  busy: false,
  previewing: null,
  limitOf: () => null,
  onComment: vi.fn(),
  onInside: vi.fn(),
  onPreview: vi.fn(),
  onUnpreview: vi.fn(),
  onAdd: vi.fn(),
  onOpen: vi.fn(),
  onClose: vi.fn(),
  onDetails: vi.fn(),
  metadataOf: () => ({ type: "Diagram" }),
});
afterEach(() => {
  cleanup();
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe("element menu focus adapter", () => {
  test.each([false, true])("Tab (shift=%s) leaves without asking the owner to restore focus", (shiftKey) => {
    const props = callbacks();
    render(<ExpandMenu menu={state} {...props} />);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Tab", shiftKey });
    expect(props.onClose).toHaveBeenCalledExactlyOnceWith(false);
  });
  test("exactly one entry is tabbable, and it follows focus (a scrolling menu stays keyboard-reachable)", () => {
    render(<ExpandMenu menu={state} {...callbacks()} />);
    const tabbable = () => screen.getAllByRole("menuitem").filter((item) => item.tabIndex === 0);
    expect(tabbable()).toEqual([screen.getByRole("menuitem", { name: "Comment" })]);
    const destination = screen.getByRole("menuitem", { name: "Containers" });
    fireEvent.focus(destination);
    expect(tabbable()).toEqual([destination]);
  });
  test("Escape asks the owner to restore the invoking context", () => {
    const props = callbacks();
    render(<ExpandMenu menu={state} {...props} />);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledExactlyOnceWith(true);
  });
});

describe("navigation-first destinations", () => {
  test("one title activation opens the whole source once, without previewing or adding", () => {
    const props = callbacks();
    render(<ExpandMenu menu={state} {...props} />);
    const destination = screen.getByRole("menuitem", { name: "Containers" });
    fireEvent.focus(destination);
    fireEvent.pointerEnter(destination);
    fireEvent.click(destination);
    expect(props.onOpen).toHaveBeenCalledExactlyOnceWith("containers");
    expect(props.onAdd).not.toHaveBeenCalled();
    expect(props.onPreview).not.toHaveBeenCalled();
    expect(screen.getByRole("menu", { name: "Actions for Shop" })).toBeInTheDocument();
  });
  test("metadata is visible and described separately from the authored title, even when no piece is addable", () => {
    const props = {
      ...callbacks(),
      metadataOf: (source: string) => ({
        type: source === "checkout" ? "Sequence" : "Containers",
        description: "A full description for readers.",
      }),
    };
    render(<ExpandMenu menu={state} {...props} />);
    const destination = screen.getByRole("menuitem", { name: "Checkout" });
    expect(destination).toHaveAccessibleDescription("Sequence A full description for readers.");
    expect(destination).not.toHaveAttribute("aria-disabled");
    expect(destination).not.toHaveAttribute("title");
    expect(screen.getAllByText("A full description for readers.", { selector: "span" })[0]).toBeVisible();
  });
  test("Details and additions is a separate action, available for non-addable sources and Inside", () => {
    const props = { ...callbacks(), onDetails: vi.fn() };
    render(<ExpandMenu menu={{ ...state, inside: { count: 3 } }} {...props} />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Details and additions…" }));
    expect(props.onDetails).toHaveBeenCalledOnce();
    expect(props.onInside).not.toHaveBeenCalled();
  });
});

describe("explicit additions panel", () => {
  test("Inside comes first; full descriptions and Open remain when Add is refused", () => {
    const props = {
      ...callbacks(),
      metadataOf: () => ({ type: "Sequence", description: "Full source description, no hover needed." }),
    };
    render(<DetailsAndAdditions menu={{ ...state, inside: { count: 3 } }} {...props} />);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getAllByRole("button").find((b) => b.textContent === "Open inside")).toBeDefined();
    expect(screen.getByRole("button", { name: "Add to view: Checkout" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open full diagram: Checkout" })).toBeEnabled();
    expect(screen.getAllByText("Full source description, no hover needed.")[0]).toBeVisible();
  });
  test("the panel's close is a drawn icon button; docked in a sheet, the sheet's head names and closes it", () => {
    const props = callbacks();
    const panel = render(<DetailsAndAdditions menu={state} {...props} />);
    const close = screen.getByRole("button", { name: "Close Details and Additions" });
    expect(close.querySelector("svg")).not.toBeNull();
    expect(close.textContent).toBe("");
    fireEvent.click(close);
    expect(props.onClose).toHaveBeenCalledExactlyOnceWith(true);
    expect(screen.getByRole("heading", { name: "Details and Additions" })).toBeVisible();
    panel.unmount();
    installViewport({ width: 390, coarse: true });
    render(
      <StageDockContext.Provider value={{ host: document.body }}>
        <DetailsAndAdditions menu={state} {...callbacks()} />
      </StageDockContext.Provider>,
    );
    expect(screen.getByRole("region", { name: "Details and Additions" })).toBeVisible();
    // Kept for the outline (h2 above the sources' h3s), but not drawn: the sheet's head shows the name.
    expect(screen.getByRole("heading", { name: "Details and Additions" }).parentElement).toHaveAttribute("data-docked");
    expect(screen.queryByRole("button", { name: "Close Details and Additions" })).toBeNull();
  });
  test("Preview persists through blur and moving to Add; each action has its own button", () => {
    const props = callbacks();
    const mounted = render(<DetailsAndAdditions menu={state} {...props} />);
    const preview = screen.getByRole("button", { name: "Preview: Containers" });
    fireEvent.click(preview);
    expect(props.onPreview).toHaveBeenCalledExactlyOnceWith("d0:containers", answer.diagrams.items[0]);
    mounted.rerender(<DetailsAndAdditions menu={state} {...props} previewing="d0:containers" />);
    fireEvent.blur(preview);
    const add = screen.getByRole("button", { name: "Add to view: Containers" });
    fireEvent.focus(add);
    expect(props.onUnpreview).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Preview: Containers" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(add);
    expect(props.onAdd).toHaveBeenCalledExactlyOnceWith(answer.diagrams.items[0]);
  });
});

describe("menu extremes and preserved boundaries", () => {
  test("loading does not steal Comment focus when destinations arrive; arrows wrap and Home/End reveal destinations", () => {
    const props = callbacks();
    const mounted = render(<ExpandMenu menu={{ ...state, answer: { status: "loading" } }} {...props} />);
    const comment = screen.getByRole("menuitem", { name: "Comment" });
    expect(comment).toHaveFocus();
    mounted.rerender(<ExpandMenu menu={state} {...props} />);
    expect(comment).toHaveFocus();
    fireEvent.keyDown(comment, { key: "ArrowUp" });
    expect(screen.getByRole("menuitem", { name: "Details and additions…" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(comment).toHaveFocus();
    fireEvent.keyDown(comment, { key: "End" });
    expect(screen.getByRole("menuitem", { name: "Details and additions…" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(comment).toHaveFocus();
  });
  test("readers without comments get a focused navigable source; unavailable/error/empty stay honest", () => {
    const props = callbacks();
    const mounted = render(<ExpandMenu menu={{ ...state, canComment: false }} {...props} />);
    expect(screen.queryByRole("menuitem", { name: "Comment" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Containers" })).toHaveFocus();
    mounted.rerender(
      <ExpandMenu
        menu={{ ...state, answer: { status: "failed", message: "Read failed. Reload the page." } }}
        {...props}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Read failed");
    mounted.rerender(
      <ExpandMenu
        menu={{
          ...state,
          answer: { status: "ready", menu: { ...answer, diagrams: { items: [], total: 0, truncated: false } } },
        }}
        {...props}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("No other diagram draws Shop.");
    expect(screen.queryByRole("menuitem", { name: "Details and additions…" })).toBeNull();
  });
  test("Inside-only still opens details; no irrelevant navigation group", () => {
    render(<ExpandMenu menu={{ ...state, inside: { count: 3 }, answer: { status: "none" } }} {...callbacks()} />);
    expect(screen.getByRole("menuitem", { name: "Details and additions…" })).toBeVisible();
    expect(screen.queryByRole("group", { name: "Open Diagram" })).toBeNull();
  });
  test("conflicting readings retain distinct cuts in details, but one navigation destination", () => {
    const one = answer.diagrams.items[0]!;
    const menu: MenuState = {
      ...state,
      answer: {
        status: "ready",
        menu: {
          ...answer,
          element: {
            ...answer.element!,
            conflicting: true,
            readings: [
              { kind: "container", parent: "Runtime", views: [one.source] },
              { kind: "component", parent: "Page", views: [one.source] },
            ],
          },
          diagrams: { items: [one, { ...one, reading: 1 }], total: 2, truncated: false },
        },
      },
    };
    const mounted = render(<ExpandMenu menu={menu} {...callbacks()} />);
    expect(screen.getAllByRole("menuitem", { name: "Containers" })).toHaveLength(1);
    mounted.rerender(<DetailsAndAdditions menu={menu} {...callbacks()} />);
    expect(screen.getAllByRole("button", { name: "Add to view: Containers" })).toHaveLength(2);
    expect(screen.getByText(/container in Runtime/)).toBeVisible();
    expect(screen.getByText(/component in Page/)).toBeVisible();
  });
  test("neighbour-only sources keep their own full-diagram escape", () => {
    const captured = readExpandMenu(
      JSON.parse(readFileSync("tests/fixtures/expand/menu-context-api-grown.json", "utf8")),
    )!;
    const props = callbacks();
    const menu: MenuState = {
      ...state,
      answer: { status: "ready", menu: { ...captured, diagrams: { items: [], total: 0, truncated: false } } },
    };
    render(<DetailsAndAdditions menu={menu} {...props} />);
    const neighbour = captured.neighbours.items[0]!;
    fireEvent.click(
      screen.getByRole("button", { name: `Open full diagram: ${neighbour.name} · ${neighbour.viaTitle}` }),
    );
    expect(props.onOpen).toHaveBeenCalledExactlyOnceWith(neighbour.via);
  });
  test("twelve plus twelve entries retain exact truncation counts and authored Unicode titles", () => {
    const captured = readExpandMenu(
      JSON.parse(readFileSync("tests/fixtures/expand/menu-context-api-grown.json", "utf8")),
    )!;
    const diagrams = Array.from({ length: 12 }, (_, i) => ({
      ...answer.diagrams.items[0]!,
      source: `source${i}`,
      title: `שלום 😀 ${i} ${"Long ".repeat(40)}Ending`,
      proposed: true as const,
    }));
    const neighbours = Array.from({ length: 12 }, (_, i) => ({
      ...captured.neighbours.items[0]!,
      element: `n${i}`,
      name: `Neighbour ${i}`,
    }));
    const menu: MenuState = {
      ...state,
      answer: {
        status: "ready",
        menu: {
          ...answer,
          diagrams: { items: diagrams, total: 20, truncated: true },
          neighbours: { items: neighbours, total: 15, truncated: true },
        },
      },
    };
    const mounted = render(<ExpandMenu menu={menu} {...callbacks()} />);
    expect(screen.getAllByRole("menuitem")).toHaveLength(14);
    expect(screen.getByText("8 more not listed")).toBeVisible();
    expect(screen.getByRole("menuitem", { name: diagrams[11]!.title })).toHaveAccessibleDescription(
      "Diagram · Proposed",
    );
    mounted.rerender(<DetailsAndAdditions menu={menu} {...callbacks()} />);
    expect(screen.getAllByRole("button", { name: /^Open full diagram:/ })).toHaveLength(24);
    expect(screen.getByText("3 more not listed")).toBeVisible();
  });
});
