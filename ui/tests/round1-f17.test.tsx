// @vitest-environment jsdom
// Round 1 (UI/UX) pass 5, batch F17: diagram fit and key. Each test names its row in the pass's fix list
// (fixes5.md) and the finding it answers. The fit itself (O4) and the nest toggle's reveal (R4-claude-08) are
// geometry, so they are proved in a browser: `browser-ts/round1-f17.e2e.ts`.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect, useState, type JSX } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiagramSidePanel } from "../src/app/diagram-panel";
import { DockSideGlyph, PopOutGlyph } from "../src/diagrams/ControlGlyphs";
import { DiagramCanvas, readingOf } from "../src/diagrams/DiagramCanvas";
import { DiagramKey, type KeyModel } from "../src/diagrams/DiagramKey";
import type { Walk, WalkStep } from "../src/walkthroughs/contract";
import { installViewport } from "./match-media";
import { computeLayout } from "../src/layout/elk-adapter";
import { containersView } from "./graph-samples";

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete (window as { matchMedia?: unknown }).matchMedia;
});

const journey: KeyModel = {
  type: "journey",
  view: {
    notation: "journey",
    title: "J",
    actors: ["Reader"],
    sections: [{ id: "s", label: "Stage", tasks: [{ id: "t", label: "Task", score: 4, actors: ["Reader"] }] }],
  },
} as never;

describe("O5: the key's pop-out and dock-back are a pair on the icon scale", () => {
  it("floating, its dock control draws the dock-to-side glyph, not a download arrow", () => {
    render(
      <div>
        <DiagramKey model={journey} placement="floating" onDock={vi.fn()} />
      </div>,
    );
    const dock = screen.getByRole("button", { name: "Dock diagram key" });
    expect(dock.innerHTML).toBe(renderToStaticMarkup(<DockSideGlyph />));
  });

  it("in the panel, its pop-out control draws the pop-out glyph", () => {
    render(
      <div>
        <DiagramKey model={journey} placement="panel" onPopOut={vi.fn()} />
      </div>,
    );
    const out = screen.getByRole("button", { name: "Pop out diagram key" });
    expect(out.innerHTML).toBe(renderToStaticMarkup(<PopOutGlyph />));
  });

  it("both are drawn at --icon (20px) with the 1.5 line, inside the scale's 4.5–19.5 box", () => {
    for (const glyph of [<PopOutGlyph key="o" />, <DockSideGlyph key="d" />]) {
      const host = document.createElement("div");
      host.innerHTML = renderToStaticMarkup(glyph);
      const svg = host.querySelector("svg")!;
      expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(svg.getAttribute("width")).toBe("20");
      expect(svg.getAttribute("stroke-width")).toBe("1.5");
      const numbers = [...host.innerHTML.matchAll(/(?:d|x|y|width|height)="([^"]+)"/g)]
        .flatMap((m) => m[1]!.match(/-?\d+(?:\.\d+)?/g) ?? [])
        .map(Number);
      // Absolute coordinates only appear in M/L/h/v/rect values here; none leaves the 24-unit box.
      for (const n of numbers) expect(Math.abs(n)).toBeLessThanOrEqual(24);
    }
    // The dock glyph draws the side panel it docks into: a frame with a divider, not a tray under an arrow.
    const dock = document.createElement("div");
    dock.innerHTML = renderToStaticMarkup(<DockSideGlyph />);
    expect(dock.querySelector("rect")).not.toBeNull();
  });
});

describe("L-ui: the canvas's loading message", () => {
  it("is a busy status, so assistive technology and tools can tell the canvas is loading", () => {
    render(<DiagramCanvas state={{ status: "loading" }} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading...");
    expect(status).toHaveAttribute("aria-busy", "true");
  });

  it("the empty canvas's sentence is not a busy status", () => {
    render(<DiagramCanvas state={{ status: "empty" }} />);
    expect(screen.getByText("No diagram selected")).not.toHaveAttribute("aria-busy");
  });
});

describe("R4-claude F30: Escape in a walkthrough with nothing focused", () => {
  const step = (title: string): WalkStep => ({
    id: title.toLowerCase(),
    title,
    kind: "sends",
    what: title,
    code: [],
    nodes: [],
    edges: [],
    messages: [],
    status: "current",
  });
  const walk: Walk = {
    id: "checkout",
    title: "Checkout",
    modelRevision: "sha256:now",
    open: [],
    status: "current",
    outOfDate: [],
    writtenAt: "2026-08-12T10:00:00Z",
    steps: ["One", "Two"].map(step),
  };

  /** The panel in a stage whose Escape ends the walkthrough from anywhere on the page, as App's does. */
  function Stage(): JSX.Element {
    const [mode, setMode] = useState<"walkthrough" | "explore">("walkthrough");
    useEffect(() => {
      const key = (event: KeyboardEvent): void => {
        if (event.key === "Escape") setMode("explore");
      };
      document.addEventListener("keydown", key);
      return () => document.removeEventListener("keydown", key);
    }, []);
    const modes = {
      mode,
      enter: vi.fn(),
      exit: vi.fn(),
      press: vi.fn(),
      saved: () => null,
      highlightsOffered: false,
      leftFrom: null,
    } as const;
    return (
      <DiagramSidePanel
        modes={modes as never}
        switcher={{ highlights: vi.fn(), walkthroughs: vi.fn() }}
        walks={[walk]}
        highlightCount={0}
        walkthrough={mode === "walkthrough" ? <button type="button">Next step</button> : null}
        walkLabel="Walkthrough"
        keyModel={null}
      >
        <div />
      </DiagramSidePanel>
    );
  }

  it("ends it and puts focus on Walkthroughs, not the page body", () => {
    installViewport({ width: 1500, coarse: false });
    render(<Stage />);
    expect(screen.getByRole("button", { name: /^Walkthroughs/ })).toHaveAttribute("aria-pressed", "true");
    // A press on the drawing: nothing has focus.
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: "Escape" });
    const walks = screen.getByRole("button", { name: /^Walkthroughs/ });
    expect(walks).toHaveAttribute("aria-pressed", "false");
    expect(walks).toHaveFocus();
  });

  it("a walkthrough the agent ends while nothing is focused leaves focus where it was", () => {
    installViewport({ width: 1500, coarse: false });
    function AgentEnds(): JSX.Element {
      const [mode, setMode] = useState<"walkthrough" | "explore">("walkthrough");
      const modes = {
        mode,
        enter: vi.fn(),
        exit: vi.fn(),
        press: vi.fn(),
        saved: () => null,
        highlightsOffered: false,
        leftFrom: null,
      } as const;
      return (
        <>
          <button type="button" data-testid="agent" onClick={() => setMode("explore")} />
          <DiagramSidePanel
            modes={modes as never}
            switcher={{ highlights: vi.fn(), walkthroughs: vi.fn() }}
            walks={[walk]}
            highlightCount={0}
            walkthrough={mode === "walkthrough" ? <p>steps</p> : null}
            walkLabel="Walkthrough"
            keyModel={null}
          >
            <div />
          </DiagramSidePanel>
        </>
      );
    }
    render(<AgentEnds />);
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.click(within(document.body).getByTestId("agent"));
    expect(document.activeElement).toBe(document.body);
  });
});

describe("O4, AM-R1-02: Fit shows everything", () => {
  /** The containers diagram in a canvas the size the 1000px window leaves beside the docked key. */
  let floor = 0;
  async function besideTheKey(): Promise<HTMLElement> {
    const layout = await computeLayout(containersView());
    floor = readingOf(layout).min;
    const { container } = render(<DiagramCanvas state={{ status: "ready", layout }} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const flow = container.querySelector<HTMLElement>(".react-flow__renderer")!;
    Object.defineProperty(flow, "offsetWidth", { configurable: true, value: 585 });
    Object.defineProperty(flow, "offsetHeight", { configurable: true, value: 695 });
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return container;
  }
  const zoomOf = (container: HTMLElement): number =>
    Number(
      /scale\(([-\d.e]+)\)/.exec(container.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform)![1],
    );

  it("the opening keeps the readable floor and the cue says what is left", async () => {
    const container = await besideTheKey();
    expect(zoomOf(container)).toBeCloseTo(floor, 6);
    expect(container.querySelector(".archer-offscreen-cue")).not.toBeNull();
  });

  it.each([
    ["the Fit view control", "button"],
    ["its key, 1", "key"],
  ] as const)("%s shows all of it: no cue says more is left", async (_name, how) => {
    const container = await besideTheKey();
    if (how === "button") fireEvent.click(screen.getByRole("button", { name: "Fit view" }));
    else fireEvent.keyDown(window, { key: "1" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    // Below where the type floor stopped it (11px of the 12px the opening holds).
    expect(zoomOf(container)).toBeLessThan((floor * 11) / 12);
    expect(container.querySelector(".archer-offscreen-cue")).toBeNull();
  });
});
