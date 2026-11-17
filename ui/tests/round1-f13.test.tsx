// @vitest-environment jsdom
/**
 * Round 1 (UI/UX) pass 4, batch F13: canvas and comments. Each block names its row in the pass's fix list
 * and the finding it answers; every one failed before its fix. Row 1 (sequence focus under the phone review
 * sheet) needs a laid-out page: `browser-ts/round1-f13.e2e.ts`.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CanvasTools } from "../src/diagrams/CanvasTools";
import { PinBadge, PinRow, SvgPinRow } from "../src/diagrams/CommentPins";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import { computeLayout, type LayoutResult } from "../src/layout/elk-adapter";
import { containersView } from "./graph-samples";

afterEach(cleanup);

describe("row 2, F46 / R3-04: a zoom button at its limit keeps focus", () => {
  let layout: LayoutResult;
  beforeAll(async () => {
    layout = await computeLayout(containersView());
  });

  it("says it is at the limit with aria-disabled, stays focusable, and does nothing", async () => {
    render(<DiagramCanvas state={{ status: "ready", layout }} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const zoomIn = screen.getByRole("button", { name: "Zoom in" });
    zoomIn.focus();
    for (let press = 0; press < 30 && zoomIn.getAttribute("aria-disabled") !== "true"; press++) {
      await act(async () => {
        fireEvent.click(zoomIn);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(zoomIn).toHaveAttribute("aria-disabled", "true");
    // Native `disabled` drops the focus of the reader pressing it to the page.
    expect(zoomIn).not.toBeDisabled();
    expect(zoomIn).toHaveFocus();
    const transform = document.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform;
    await act(async () => {
      fireEvent.click(zoomIn);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform).toBe(transform);
  });
});

describe("row 3, F49 / R3-07, H2 T01 / T18 / R3-08: the tools launcher", () => {
  it("is named with the export and compare tasks' own words", () => {
    render(
      <CanvasTools>
        <button type="button">Export diagram</button>
      </CanvasTools>,
    );
    const trigger = screen.getByRole("button", { name: /export/i });
    expect(trigger.getAttribute("aria-label")).toMatch(/compare/i);
    expect(trigger.getAttribute("title")).toMatch(/export.*compare/i);
  });

  it("is a disclosure: opening it leaves focus on it, aria-expanded true, and Tab goes on into the actions", () => {
    render(
      <CanvasTools>
        <button type="button">Compare revisions</button>
        <button type="button">Export diagram</button>
      </CanvasTools>,
    );
    const trigger = screen.getByRole("button", { name: "Export, compare and more" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const actions = screen.getByRole("group", { name: "Export, compare and more" });
    expect(trigger.getAttribute("aria-controls")).toBe(actions.id);
    // Tab order: the actions come straight after the button.
    expect(
      trigger.compareDocumentPosition(screen.getByRole("button", { name: "Compare revisions" })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });
});

describe("row 4, F52 / R3-09, D7: a comment pin is a named control", () => {
  const pin = { threadId: "t-1", number: 2, state: "sent" as const };

  it("on a node: a focusable button named by its thread, which Enter and Space press", () => {
    const clicked = vi.fn();
    const outer = vi.fn();
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: a test probe that records the events reaching the pin's container.
      <div onClick={clicked} onKeyDown={outer}>
        <PinRow pins={[pin]} />
      </div>,
    );
    const button = screen.getByRole("button", { name: "Comment 2: sent. Open it." });
    expect(button.tabIndex).toBe(0);
    expect(button.closest("[aria-hidden='true']")).toBeNull();
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.keyDown(button, { key: " " });
    expect(clicked).toHaveBeenCalledTimes(2);
    // The element under it (a node) is not activated by the same key.
    expect(outer).not.toHaveBeenCalled();
  });

  it("on a sequence diagram too", () => {
    const clicked = vi.fn();
    render(
      // biome-ignore lint/a11y: a test probe that records the clicks reaching the pins' drawing.
      <svg onClick={clicked}>
        <SvgPinRow pins={[pin]} x={100} y={20} />
      </svg>,
    );
    const button = screen.getByRole("button", { name: "Comment 2: sent. Open it." });
    expect(button.getAttribute("tabindex")).toBe("0");
    expect(button.closest("[aria-hidden='true']")).toBeNull();
    fireEvent.keyDown(button, { key: "Enter" });
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("but not inside another control, nor on the panel's card", () => {
    render(
      <>
        <button type="button">
          <PinBadge pin={pin} title="2 comments on this step" />
        </button>
        <PinBadge pin={pin} interactive={false} />
      </>,
    );
    expect(screen.queryByRole("button", { name: /Comment 2/ })).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});

// Row 5, R3-16 (the caption's More mark on the icon scale) is superseded: the mark is gone, its detail drawn
// inline on the plate (decided 2026-10-31; `edge-detail-inline.e2e.ts`, `c4-diagram.test.tsx`).
