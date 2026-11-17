// @vitest-environment jsdom
//
// Round 1 (UI/UX) fixes, pass 8, batch F30.
// R6-claude-07: a Fit (`1`) is queued only while a drawing is opening, and it belongs to that drawing. The page
// names what it opens (`fitOpens`): nothing (`null`) queues nothing; moving on to another drawing drops it; a
// canvas the page has moved on from (`FitDrawing`) neither fits nor takes the Fit. The V7 rule (round1-f27) holds.
// R6-claude-09: keyboard focus moving on in the page folds a rail the pointer opened, so it covers nothing focused.
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HOVER_INTENT_MS, WorkspaceNavigation } from "../src/app/WorkspaceNavigation";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FitDrawing, fitOpens, resetFitQueue, useCanvasShortcuts, useFitQueue } from "../src/diagrams/canvas-shortcuts";

const press = (key = "1"): void => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
};
/** A canvas showing `drawing` (or outside any page that names one), ready or still framing. */
const canvas = (fit: () => void, ready: boolean, drawing?: string) =>
  renderHook(({ ready }) => useCanvasShortcuts({ onFitView: fit, enabled: true, ready }), {
    initialProps: { ready },
    wrapper: ({ children }: { children: ReactNode }) => (
      <FitDrawing.Provider value={drawing}>{children}</FitDrawing.Provider>
    ),
  });
const page = () => renderHook(() => useFitQueue(true));

afterEach(() => {
  cleanup();
  resetFitQueue();
  vi.useRealTimers();
});

describe("R6-claude-07: a queued Fit belongs to the drawing that was opening", () => {
  it("(a) 1 on a page that opens no drawing (the project page) is not carried into the diagram opened next", () => {
    page();
    fitOpens(null);
    press();
    fitOpens("alpha");
    const fit = vi.fn();
    canvas(fit, false, "alpha").rerender({ ready: true });
    expect(fit).not.toHaveBeenCalled();
  });

  it("(b) 1 while A opens, then ]: B is not fitted", () => {
    page();
    fitOpens("alpha");
    press();
    fitOpens("beta");
    const fit = vi.fn();
    canvas(fit, false, "beta").rerender({ ready: true });
    expect(fit).not.toHaveBeenCalled();
  });

  it("(c) ] then 1: the outgoing drawing does not fit; the incoming one does, once", () => {
    page();
    fitOpens("alpha");
    const outgoing = vi.fn();
    const alpha = canvas(outgoing, true, "alpha");
    fitOpens("beta");
    press();
    expect(outgoing).not.toHaveBeenCalled();
    alpha.unmount();
    const incoming = vi.fn();
    canvas(incoming, false, "beta").rerender({ ready: true });
    expect(incoming).toHaveBeenCalledTimes(1);
  });

  it("an outgoing drawing that frames again does not take the incoming one's Fit", () => {
    page();
    fitOpens("alpha");
    const outgoing = vi.fn();
    canvas(outgoing, true, "alpha");
    fitOpens("beta");
    press();
    // Something re-runs the outgoing canvas' take (a re-render, a lifted hold): it is still not its Fit.
    const again = canvas(outgoing, false, "alpha");
    again.rerender({ ready: true });
    expect(outgoing).not.toHaveBeenCalled();
  });

  it("a compile-error diagram: a Fit pressed on it does not linger for the diagram opened next", () => {
    page();
    fitOpens("broken");
    press();
    // It never compiled: nothing will be drawn.
    fitOpens(null);
    press();
    fitOpens("beta");
    const fit = vi.fn();
    canvas(fit, false, "beta").rerender({ ready: true });
    expect(fit).not.toHaveBeenCalled();
  });

  it("an open slower than any fixed wait still fits once it is framed (O59: a 3 s life dropped it under load)", () => {
    vi.useFakeTimers();
    page();
    fitOpens("alpha");
    press();
    vi.advanceTimersByTime(30_000);
    const fit = vi.fn();
    canvas(fit, false, "alpha").rerender({ ready: true });
    expect(fit).toHaveBeenCalledTimes(1);
  });

  it("V7-1 kept: 1 before any drawing is named (a page still loading) goes to the first one presented", () => {
    page();
    press();
    fitOpens("alpha");
    const fit = vi.fn();
    const drawing = canvas(fit, false, "alpha");
    expect(fit).not.toHaveBeenCalled();
    drawing.rerender({ ready: true });
    expect(fit).toHaveBeenCalledTimes(1);
  });

  it("V7-1 kept: 1 while the named diagram opens fits it once it is framed", () => {
    page();
    fitOpens("alpha");
    press();
    const fit = vi.fn();
    canvas(fit, false, "alpha").rerender({ ready: true });
    expect(fit).toHaveBeenCalledTimes(1);
  });

  it("a canvas that takes the key leaves nothing queued, whichever listener runs first", () => {
    fitOpens("alpha");
    const fit = vi.fn();
    canvas(fit, true, "alpha");
    page(); // the page's listener after the canvas'
    press();
    expect(fit).toHaveBeenCalledTimes(1);
    const next = vi.fn();
    canvas(next, false, "alpha").rerender({ ready: true });
    expect(next).not.toHaveBeenCalled();
  });
});

describe("R6-claude-07: the page names what opens", () => {
  const app = readFileSync(resolve(process.cwd(), "src/app/App.tsx"), "utf8");
  it("every reader navigation drops a Fit for the place left; a diagram opened names itself", () => {
    expect(app).toMatch(/const readerNavigates = useCallback\(\(\) => \{[^}]*fitOpens\(null\)/);
    expect(app).toMatch(/fitOpens\(viewId\);/);
  });
  it("Back and Forward drop it too: with no clock on a queued Fit, only navigation ends it (O59)", () => {
    // The handler's body, to its closing line: O192 put a braced early return before the call.
    const body = /followHistoryRef\.current = \(\) => \{\n([\s\S]*?)\n {2}\};\n/.exec(app)?.[1] ?? "";
    expect(body).toMatch(/fitOpens\(null\)/);
  });
  it("the reading canvas says which drawing it shows", () => {
    expect(app).toMatch(
      /<FitDrawing\.Provider value=\{activeViewId \?\? undefined\}>\s*<DiagramCanvas\s+key=\{activeViewId \?\? "empty"\}/,
    );
  });
});

describe("R6-claude-09: a rail opened by the pointer folds when keyboard focus moves on in the page", () => {
  const mouse = (type: string, init: MouseEventInit = {}): MouseEvent => {
    const event = new MouseEvent(type, { bubbles: true, ...init });
    Object.defineProperty(event, "pointerType", { value: "mouse" });
    return event;
  };
  const moveTo = (element: Element, x: number, y: number): void => {
    fireEvent(element, mouse("pointermove", { clientX: x, clientY: y }));
  };
  function setup() {
    const zoomIn = document.body.appendChild(document.createElement("button"));
    zoomIn.textContent = "Zoom in";
    render(
      <WorkspaceNavigation
        workspace="Sample"
        currentSlug={null}
        place={null}
        searchOpen={false}
        recents={[]}
        onContents={vi.fn()}
        onSearch={vi.fn()}
        onOpenProject={vi.fn()}
        onOpenRecent={vi.fn()}
        onHelp={vi.fn()}
        drawer={false}
        onDrawer={vi.fn()}
      />,
    );
    const rail = screen.getByRole("complementary");
    // The pointer comes in from the page and rests on the rail: it opens.
    moveTo(document.body, 700, 450);
    moveTo(rail, 24, 300);
    act(() => vi.advanceTimersByTime(HOVER_INTENT_MS));
    expect(rail).toHaveAttribute("data-expanded", "true");
    return { rail, zoomIn };
  }
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("Tab to a canvas control under the open rail folds it, and the parked pointer does not reopen it", () => {
    vi.useFakeTimers();
    const { rail, zoomIn } = setup();
    fireEvent.keyDown(document.body, { key: "Tab" });
    act(() => {
      zoomIn.focus();
    });
    expect(rail).toHaveAttribute("data-expanded", "false");
    // The browser's own move under a parked pointer after the fold is not a reason to open again.
    moveTo(rail, 24, 300);
    act(() => vi.advanceTimersByTime(HOVER_INTENT_MS * 2));
    expect(rail).toHaveAttribute("data-expanded", "false");
    // Leaving and coming back is.
    fireEvent.pointerLeave(rail, { pointerType: "mouse" });
    fireEvent(rail, mouse("pointerenter"));
    moveTo(document.body, 700, 450);
    moveTo(rail, 30, 320);
    act(() => vi.advanceTimersByTime(HOVER_INTENT_MS));
    expect(rail).toHaveAttribute("data-expanded", "true");
  });

  it("focus moved by a click elsewhere (no key pressed) is the pointer's business: the press outside folds it as before", () => {
    vi.useFakeTimers();
    const { rail, zoomIn } = setup();
    fireEvent.pointerDown(rail, { pointerType: "mouse" });
    act(() => {
      zoomIn.focus();
    });
    // No keyboard: focus moving is not a fold by itself.
    expect(rail).toHaveAttribute("data-expanded", "true");
  });

  it("focus moving within the rail keeps it open", () => {
    vi.useFakeTimers();
    const { rail } = setup();
    fireEvent.keyDown(document.body, { key: "Tab" });
    act(() => {
      screen.getByRole("button", { name: "Archer contents" }).focus();
    });
    expect(rail).toHaveAttribute("data-expanded", "true");
  });
});
