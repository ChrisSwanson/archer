// @vitest-environment jsdom
// The sidebar (projects-and-search.md): project names and recent files, Search,
// Tools and the shortcuts; no paths and no file tree. Its rail mechanics --
// hover reveals labels, a clicked section holds until an outside press, Escape
// returns to the trigger -- are kept from before the redesign.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOVER_INTENT_MS, WorkspaceNavigation } from "../src/app/WorkspaceNavigation";
import type { RecentItem } from "../src/app/recents";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const RECENTS: RecentItem[] = [
  { slug: "", projectName: "Sample", kind: "view", id: "system", title: "System context", at: 3 },
  { slug: "", projectName: "Sample", kind: "note", id: "notes/decisions/storage.md", title: "Storage decision", at: 2 },
  { slug: "other", projectName: "Other", kind: "view", id: "flow", title: "Checkout flow", at: 1 },
];

type Props = ComponentProps<typeof WorkspaceNavigation>;

function props(overrides: Partial<Props> = {}): Props {
  return {
    workspace: "Sample",
    currentSlug: null,
    place: null,
    searchOpen: false,
    recents: RECENTS,
    onContents: vi.fn(),
    onSearch: vi.fn(),
    onOpenProject: vi.fn(),
    onOpenRecent: vi.fn(),
    onHelp: vi.fn(),
    drawer: false,
    onDrawer: vi.fn(),
    ...overrides,
  };
}

function setup(overrides: Partial<Props> = {}) {
  const given = props(overrides);
  return { ...given, ...render(<WorkspaceNavigation {...given} />) };
}

const mouse = (type: string, init: MouseEventInit = {}): MouseEvent => {
  const event = new MouseEvent(type, { bubbles: true, ...init });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  return event;
};

/** A real mouse moving over `element` at (x, y). */
const moveTo = (element: Element, x: number, y: number): void => {
  fireEvent(element, mouse("pointermove", { clientX: x, clientY: y }));
};
/** A pointer that comes in from the page and rests on the rail long enough to mean it (fake timers). */
const rest = (rail: Element): void => {
  moveTo(document.body, 700, 450);
  moveTo(rail, 24, 300);
  act(() => vi.advanceTimersByTime(HOVER_INTENT_MS));
};

describe("the sidebar", () => {
  it("17 (wave 2 review): a pointer crossing the rail on its way to the drawing's tools does not open it", () => {
    vi.useFakeTimers();
    setup();
    const rail = screen.getByRole("complementary");
    moveTo(document.body, 700, 700);
    moveTo(rail, 24, 700);
    act(() => vi.advanceTimersByTime(HOVER_INTENT_MS / 2));
    expect(rail, "crossing, it stays a rail and covers nothing").toHaveAttribute("data-expanded", "false");
    fireEvent.pointerLeave(rail, { pointerType: "mouse" });
    moveTo(document.body, 90, 700);
    act(() => vi.advanceTimersByTime(HOVER_INTENT_MS * 4));
    expect(rail).toHaveAttribute("data-expanded", "false");
    // One that stays does.
    moveTo(rail, 24, 690);
    act(() => vi.advanceTimersByTime(HOVER_INTENT_MS));
    expect(rail).toHaveAttribute("data-expanded", "true");
  });

  it("17 (wave 2 review): a parked pointer the rail arrives under, or the browser's synthetic move at the same spot, does not open it", () => {
    vi.useFakeTimers();
    setup();
    const rail = screen.getByRole("complementary");
    moveTo(document.body, 0, 0);
    fireEvent(rail, mouse("pointerenter"));
    moveTo(rail, 0, 0);
    moveTo(rail, 0, 0);
    act(() => vi.advanceTimersByTime(HOVER_INTENT_MS * 4));
    expect(rail).toHaveAttribute("data-expanded", "false");
  });

  it("keeps a Projects folder glyph in its permanent heading while the rail is collapsed", () => {
    setup();
    const heading = screen.getByRole("heading", { name: "Projects", level: 2 });
    expect(screen.getByRole("complementary")).toHaveAttribute("data-expanded", "false");
    expect(heading.querySelector("svg")).not.toBeNull();
    expect(heading.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
  it("uses one Projects tree with Overview, every project destination and the five most recent files", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              schemaVersion: 1,
              projects: [
                { slug: "sample", name: "Sample", views: [], notes: [] },
                { slug: "other", name: "Other", views: [], notes: [] },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const recents: RecentItem[] = [
      { slug: "other", projectName: "Other", kind: "project", id: "", title: "Other", at: 12 },
      ...Array.from(
        { length: 6 },
        (_, i): RecentItem => ({
          slug: i % 2 === 0 ? "sample" : "other",
          projectName: i % 2 === 0 ? "Sample" : "Other",
          kind: i % 2 === 0 ? "note" : "view",
          id: `file-${i}`,
          title: `File ${i}`,
          at: 11 - i,
        }),
      ),
    ];
    const { onContents, onOpenProject } = setup({ currentSlug: "sample", activeProjectSlug: "sample", recents });

    expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
    fireEvent(screen.getByRole("complementary"), mouse("pointermove"));
    expect(screen.getByRole("heading", { name: "Projects", level: 2 })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Projects" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Tools" })).toBeNull();
    expect(screen.getByRole("button", { name: "Overview" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    expect(onContents).toHaveBeenCalledOnce();

    fireEvent(screen.getByRole("complementary"), mouse("pointermove"));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Other/ })).toBeVisible());
    const sample = screen.getByRole("button", { name: /^Sample/ });
    const other = screen.getByRole("button", { name: /^Other/ });
    expect(within(sample).getByRole("img", { name: "Active project" })).toBeVisible();
    expect(within(other).queryByRole("img", { name: "Active project" })).toBeNull();
    fireEvent.click(sample);
    expect(onOpenProject).toHaveBeenCalledWith("sample");
    fireEvent(screen.getByRole("complementary"), mouse("pointermove"));
    fireEvent.click(screen.getByRole("button", { name: /^Other/ }));
    expect(onOpenProject).toHaveBeenCalledWith("other");

    fireEvent(screen.getByRole("complementary"), mouse("pointermove"));
    const recent = screen.getByRole("navigation", { name: "Recent" });
    expect(
      within(recent)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["File 0, note", "File 1, diagram", "File 2, note", "File 3, diagram", "File 4, note"]);
    expect(within(recent).getByRole("button", { name: "File 1, diagram, Other" })).toHaveAttribute(
      "title",
      "file-1 · Other",
    );
  });

  it("drops the page's own slug once the catalog shows it is no project", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              schemaVersion: 1,
              projects: [{ slug: "real", name: "Real", views: [], notes: [] }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    setup({ workspace: "This project", currentSlug: "missing-project", activeProjectSlug: "missing-project" });
    const projects = screen.getByRole("navigation", { name: "Projects" });
    await waitFor(() => expect(within(projects).getByRole("button", { name: /^Real/ })).toBeInTheDocument());
    expect(within(projects).queryByRole("button", { name: /This project/ })).toBeNull();
  });

  it("lists the projects by name and the recent files, with no paths or tree", () => {
    setup();
    const projects = screen.getByRole("navigation", { name: "Projects" });
    expect(within(projects).getByRole("button", { name: "Sample" })).toHaveTextContent("Sample");
    const recent = screen.getByRole("navigation", { name: "Recent" });
    expect(
      within(recent)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["System context, diagram", "Storage decision, note", "Checkout flow, diagram"]);
    expect(within(recent).getByRole("button", { name: "Checkout flow, diagram, Other" })).toHaveTextContent(
      "Checkout flow",
    );
    // Names only: no file names, folders or a tree.
    expect(screen.queryByText(/\.mmd|\.md|decisions/)).toBeNull();
    expect(document.querySelector("details")).toBeNull();
  });

  it("shows at most five recent items", () => {
    const many = Array.from(
      { length: 9 },
      (_, i): RecentItem => ({
        slug: "",
        projectName: "Sample",
        kind: "view",
        id: `v${i}`,
        title: `View ${i}`,
        at: 9 - i,
      }),
    );
    setup({ recents: many });
    expect(within(screen.getByRole("navigation", { name: "Recent" })).getAllByRole("button")).toHaveLength(5);
  });

  it("opens the overview, this project's page and a recent item, and closes behind them", () => {
    const { onContents, onOpenProject, onOpenRecent } = setup();
    const rail = screen.getByRole("complementary");
    fireEvent(rail, mouse("pointermove"));
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    expect(onContents).toHaveBeenCalledOnce();
    expect(rail).toHaveAttribute("data-expanded", "false");
    fireEvent(rail, mouse("pointermove"));
    fireEvent.click(screen.getByRole("button", { name: /^Sample/ }));
    expect(onOpenProject).toHaveBeenCalledWith("");
    expect(rail).toHaveAttribute("data-expanded", "false");
    fireEvent(rail, mouse("pointermove"));
    fireEvent.click(screen.getByRole("button", { name: /^Checkout flow/ }));
    expect(onOpenRecent).toHaveBeenCalledWith(RECENTS[2]);
  });

  it("marks where the reader is in Recent", () => {
    setup({ place: { slug: "", kind: "view", id: "system" } });
    expect(screen.getByRole("button", { name: /^System context/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: /^Sample/ })).not.toHaveAttribute("aria-current");
  });

  it("says what Recent is for before anything was opened", () => {
    setup({ recents: [] });
    expect(
      within(screen.getByRole("navigation", { name: "Recent" })).getByText("The files you open appear here."),
    ).toBeVisible();
  });

  it("offers an explicit project-catalog retry without referring to a Projects button", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            projects: [{ slug: "recovered", name: "Recovered", views: [], notes: [] }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetch);
    setup({ currentSlug: "retry-project" });

    expect(await screen.findByRole("status")).toHaveTextContent("Other projects could not be listed.");
    expect(screen.getByRole("status")).not.toHaveTextContent(/reopen Projects/i);
    fireEvent.click(screen.getByRole("button", { name: "Reload projects" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Recovered" })).toBeVisible());
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reveals the permanent Projects hierarchy on hover and collapses on pointer departure", () => {
    vi.useFakeTimers();
    setup();
    const rail = screen.getByRole("complementary");
    rest(rail);
    expect(rail).toHaveAttribute("data-expanded", "true");
    expect(screen.getByRole("heading", { name: "Projects", level: 2 })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "Projects" })).toBeVisible();
    fireEvent.pointerLeave(rail, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(200));
    expect(rail).toHaveAttribute("data-expanded", "false");
  });

  it("does not expand on a stationary layout arrival, only on real mouse movement", () => {
    vi.useFakeTimers();
    setup();
    const rail = screen.getByRole("complementary");
    fireEvent(rail, mouse("pointerover", { relatedTarget: document.body }));
    expect(rail).toHaveAttribute("data-expanded", "false");
    rest(rail);
    expect(rail).toHaveAttribute("data-expanded", "true");
  });

  it("returns Escape to the collapsed rail's first control", () => {
    vi.useFakeTimers();
    setup();
    const rail = screen.getByRole("complementary");
    rest(rail);
    const recent = screen.getByRole("button", { name: /^Storage decision/ });
    recent.focus();
    fireEvent.keyDown(recent, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Archer contents" })).toHaveFocus();
    expect(rail).toHaveAttribute("data-expanded", "false");
    moveTo(rail, 30, 310);
    act(() => vi.advanceTimersByTime(HOVER_INTENT_MS));
    expect(rail).toHaveAttribute("data-expanded", "false");
    fireEvent.pointerLeave(rail, { pointerType: "mouse" });
    fireEvent(rail, mouse("pointerenter"));
    rest(rail);
    expect(rail).toHaveAttribute("data-expanded", "true");
  });

  it("does not include the retired Tools section", () => {
    setup();
    expect(screen.queryByRole("button", { name: "Tools" })).toBeNull();
    expect(screen.queryByText("Export diagram")).toBeNull();
  });

  it("keeps notification controls outside the sidebar", () => {
    setup();
    expect(screen.queryByRole("button", { name: /Notifications/ })).toBeNull();
  });

  it("as a drawer, takes the focus when it opens, and closes on Escape and on its scrim", () => {
    const onDrawer = vi.fn();
    const { rerender } = setup({ drawer: true, onDrawer });
    expect(screen.getByRole("button", { name: "Archer contents" })).toHaveFocus();
    expect(screen.getByRole("complementary")).toHaveAttribute("data-drawer", "true");
    fireEvent.keyDown(screen.getByRole("button", { name: "Archer contents" }), { key: "Escape" });
    expect(onDrawer).toHaveBeenCalledWith(false);
    onDrawer.mockClear();
    rerender(<WorkspaceNavigation {...props({ drawer: true, onDrawer })} />);
    fireEvent.click(document.querySelector(".primary-scrim")!);
    expect(onDrawer).toHaveBeenCalledWith(false);
  });
});
