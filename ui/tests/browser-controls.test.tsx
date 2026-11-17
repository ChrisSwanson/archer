// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserControls } from "../src/app/BrowserControls";

afterEach(cleanup);
const filterContent = (
  <label>
    Only notes
    <input type="checkbox" />
  </label>
);

it("opens one filter dialog with the existing filter controls and result count", () => {
  render(<BrowserControls filterContent={filterContent} filterCount={2} resultCount={7} />);
  const launcher = screen.getByRole("button", { name: "Filters (2)" });
  fireEvent.click(launcher);
  const dialog = screen.getByRole("dialog", { name: "Project Filters" });
  expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(within(dialog).getByRole("checkbox", { name: "Only notes" })).toBeInTheDocument();
  expect(within(dialog).queryByText("Show 7 files")).toBeNull();
  expect(within(dialog).queryByRole("button", { name: "Done" })).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close filters" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(launcher).toHaveFocus();
});

it("offers the filters alone: the Card Details panel went with the cards", () => {
  render(<BrowserControls filterContent={filterContent} filterCount={0} resultCount={1} />);
  fireEvent.click(screen.getByRole("button", { name: "Filters" }));
  const dialog = screen.getByRole("dialog", { name: "Project Filters" });
  expect(within(dialog).queryByRole("button", { name: "Card Details" })).toBeNull();
  expect(within(dialog).getByRole("checkbox", { name: "Only notes" })).toBeInTheDocument();
});

it("traps focus, stops Escape before the page, and restores background state and launcher focus", () => {
  const backgroundEscape = vi.fn();
  window.addEventListener("keydown", backgroundEscape);
  try {
    const { container } = render(<BrowserControls filterContent={filterContent} filterCount={0} resultCount={0} />);
    const launcher = screen.getByRole("button", { name: "Filters" });
    fireEvent.click(launcher);
    const dialog = screen.getByRole("dialog");
    expect(container).toHaveAttribute("inert");
    expect(document.body.style.overflow).toBe("hidden");
    const first = within(dialog).getByRole("button", { name: "Close filters" });
    const last = within(dialog).getByRole("checkbox", { name: "Only notes" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    backgroundEscape.mockClear();
    fireEvent.keyDown(first, { key: "Escape" });
    expect(backgroundEscape).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(container).not.toHaveAttribute("inert");
    expect(document.body.style.overflow).not.toBe("hidden");
    expect(launcher).toHaveFocus();
  } finally {
    window.removeEventListener("keydown", backgroundEscape);
  }
});

it("closes on the backdrop, without treating a click inside as dismissal", () => {
  render(<BrowserControls filterContent={filterContent} filterCount={0} resultCount={2} />);
  const launcher = screen.getByRole("button", { name: "Filters" });
  fireEvent.click(launcher);
  const dialog = screen.getByRole("dialog");
  fireEvent.click(dialog);
  expect(dialog).toBeInTheDocument();
  fireEvent.click(dialog.closest(".archer-browser-overlay")!);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(launcher).toHaveFocus();
});

it.each(["/__impeccable/live.js", "/__impeccable/live.js?token=live-review"])(
  "keeps the live feedback host usable with %s while isolating the app",
  (src) => {
    const script = document.createElement("script");
    script.src = src;
    document.head.append(script);
    const helper = document.createElement("div");
    helper.id = "impeccable-live-root";
    helper.attachShadow({ mode: "open" });
    document.body.append(helper);
    const annotation = document.createElement("div");
    annotation.id = "impeccable-live-annot";
    document.body.append(annotation);
    try {
      const { container } = render(<BrowserControls filterContent={filterContent} filterCount={0} resultCount={1} />);
      fireEvent.click(screen.getByRole("button", { name: "Filters" }));
      expect(container).toHaveAttribute("inert");
      expect(helper).not.toHaveAttribute("inert");
      expect(annotation).not.toHaveAttribute("inert");
    } finally {
      annotation.remove();
      helper.remove();
      script.remove();
    }
  },
);

it.each([
  "https://foreign.example/__impeccable/live.js?token=live-review",
  "/assets/live.js",
  "/live.js",
  "/__impeccable/live.js.old",
  "/__impeccable/live.js?redirect=foreign",
  "/__impeccable/live.js#stale",
])("isolates helper-shaped elements when %s is not the canonical live script", (src) => {
  const script = document.createElement("script");
  script.src = src;
  document.head.append(script);
  const helper = document.createElement("div");
  helper.id = "impeccable-live-annot";
  document.body.append(helper);
  try {
    render(<BrowserControls filterContent={filterContent} filterCount={0} resultCount={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(helper).toHaveAttribute("inert");
  } finally {
    helper.remove();
    script.remove();
  }
});

it("isolates a stale feedback host when the live helper is absent", () => {
  const helper = document.createElement("div");
  helper.id = "impeccable-live-root";
  helper.attachShadow({ mode: "open" });
  document.body.append(helper);
  const annotation = document.createElement("div");
  annotation.id = "impeccable-live-annot";
  document.body.append(annotation);
  try {
    render(<BrowserControls filterContent={filterContent} filterCount={0} resultCount={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(helper).toHaveAttribute("inert");
    expect(annotation).toHaveAttribute("inert");
  } finally {
    annotation.remove();
    helper.remove();
  }
});
