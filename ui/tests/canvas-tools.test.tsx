// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CanvasTools } from "../src/diagrams/CanvasTools";

afterEach(cleanup);

it("renders nothing without available graph tools", () => {
  const { container } = render(<CanvasTools>{null}</CanvasTools>);
  expect(container).toBeEmptyDOMElement();
});

// The page builds its tools as a fragment whose every tool is conditional, with a spacer text node among them: on a
// host that offers none of them (the static Playground has no service to export, compare or check accuracy) the
// launcher opened an empty menu.
it("renders nothing when every tool is withheld and only whitespace is left", () => {
  const { container } = render(
    <CanvasTools>
      <>
        {" "}
        {false}
        {null}
        <>{"\n  "}</>
      </>
    </CanvasTools>,
  );
  expect(container).toBeEmptyDOMElement();
});

it("opens graph tools and closes with Escape while restoring its trigger", () => {
  render(
    <CanvasTools>
      <button type="button">Export</button>
    </CanvasTools>,
  );
  const trigger = screen.getByRole("button", { name: "Export, compare and more" });
  fireEvent.click(trigger);
  expect(screen.getByRole("group", { name: "Export, compare and more" })).toBeVisible();
  // A disclosure: focus stays on its button, which says it is open.
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  screen.getByRole("button", { name: "Export" }).focus();
  fireEvent.keyDown(screen.getByRole("group", { name: "Export, compare and more" }), { key: "Escape" });
  expect(screen.queryByRole("group", { name: "Export, compare and more" })).toBeNull();
  expect(trigger).toHaveFocus();
});

it("closes on an outside press without stealing focus from its target", () => {
  render(
    <>
      <CanvasTools>
        <button type="button">Compare</button>
      </CanvasTools>
      <button type="button">Elsewhere</button>
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Export, compare and more" }));
  const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
  elsewhere.focus();
  fireEvent.pointerDown(elsewhere);
  expect(screen.queryByRole("group", { name: "Export, compare and more" })).toBeNull();
  expect(elsewhere).toHaveFocus();
});

it("closes when Tab moves focus out of the disclosure", () => {
  render(
    <>
      <CanvasTools>
        <button type="button">Compare</button>
      </CanvasTools>
      <button type="button">After canvas</button>
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Export, compare and more" }));
  const tools = screen.getByRole("group", { name: "Export, compare and more" });
  const after = screen.getByRole("button", { name: "After canvas" });
  after.focus();
  fireEvent.blur(tools, { relatedTarget: after });
  expect(screen.queryByRole("group", { name: "Export, compare and more" })).toBeNull();
  expect(after).toHaveFocus();
});

it("closes after a tool is chosen and preserves the child handler", () => {
  const chosen = vi.fn();
  render(
    <CanvasTools>
      <button type="button" onClick={chosen}>
        Accuracy
      </button>
    </CanvasTools>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Export, compare and more" }));
  fireEvent.click(screen.getByRole("button", { name: "Accuracy" }));
  expect(chosen).toHaveBeenCalledOnce();
  expect(screen.queryByRole("group", { name: "Export, compare and more" })).toBeNull();
  expect(screen.getByRole("button", { name: "Export, compare and more" })).toHaveFocus();
});

// O242: while a diagram is laid out the launcher sits in the loading page's toolbar; the drawing's arrival replaces it
// with the canvas' own, in one commit. The menu and the focus in it move across; a launcher simply removed hands
// nothing to the next one mounted later.
function Swap({ drawn }: { drawn: boolean }) {
  const tools = (
    <button type="button" aria-label="Compare revisions">
      Compare
    </button>
  );
  return drawn ? (
    <div key="canvas">
      <CanvasTools>{tools}</CanvasTools>
    </div>
  ) : (
    <div key="loading">
      <CanvasTools>{tools}</CanvasTools>
    </div>
  );
}

it("keeps its menu open and its button focused when the drawing replaces the loading toolbar", () => {
  const { rerender } = render(<Swap drawn={false} />);
  const before = screen.getByRole("button", { name: "Export, compare and more" });
  before.focus();
  fireEvent.click(before);
  rerender(<Swap drawn />);
  const after = screen.getByRole("button", { name: "Export, compare and more" });
  expect(after).not.toBe(before);
  expect(after).toHaveAttribute("aria-expanded", "true");
  expect(after).toHaveFocus();
});

it("keeps focus on the action it was on when the drawing replaces the loading toolbar", () => {
  const { rerender } = render(<Swap drawn={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Export, compare and more" }));
  screen.getByRole("button", { name: "Compare revisions" }).focus();
  rerender(<Swap drawn />);
  expect(screen.getByRole("group", { name: "Export, compare and more" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Compare revisions" })).toHaveFocus();
});

it("hands nothing to a launcher mounted after the open one is gone", async () => {
  const { rerender } = render(<Swap drawn={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Export, compare and more" }));
  rerender(<></>);
  await Promise.resolve();
  rerender(<Swap drawn />);
  expect(screen.getByRole("button", { name: "Export, compare and more" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("group", { name: "Export, compare and more" })).toBeNull();
});
