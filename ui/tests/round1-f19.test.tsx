// @vitest-environment jsdom
// Round 1 (UI/UX) pass 5, batch F19: app focus and editor leftovers. Each test names its row in the round's fifth
// fixes list and the finding it answers. The browser halves are in browser-ts/round1-f19.e2e.ts.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { PANEL_WIDTH, PanelDivider } from "../src/app/PanelDivider";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("R4-claude S4: a click on the panel divider keeps focus on the divider", () => {
  function Divider() {
    const [width, setWidth] = useState<number>(PANEL_WIDTH.initial);
    return (
      <div>
        <button type="button">Before</button>
        <PanelDivider width={width} onChange={setWidth} />
      </div>
    );
  }

  it("a click step leaves focus on the divider, where the arrow keys go on resizing", () => {
    render(<Divider />);
    const before = screen.getByRole("button", { name: "Before" });
    before.focus();
    const bar = screen.getByRole("separator", { name: "Resize diagram panel" });
    fireEvent.pointerDown(bar, { clientX: 500, clientY: 300, pointerId: 1, button: 0 });
    fireEvent.pointerUp(bar, { clientX: 500, clientY: 300, pointerId: 1, button: 0 });
    expect(bar).toHaveAttribute("aria-valuenow", "480");
    expect(document.activeElement).toBe(bar);
    fireEvent.keyDown(bar, { key: "ArrowLeft" });
    expect(bar).toHaveAttribute("aria-valuenow", "504");
  });

  it("so does a drag", () => {
    render(<Divider />);
    const bar = screen.getByRole("separator", { name: "Resize diagram panel" });
    fireEvent.pointerDown(bar, { clientX: 600, clientY: 300, pointerId: 1, button: 0 });
    fireEvent.pointerMove(bar, { clientX: 560, clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(bar, { clientX: 560, clientY: 300, pointerId: 1 });
    expect(document.activeElement).toBe(bar);
  });
});
