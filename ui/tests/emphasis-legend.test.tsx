// @vitest-environment jsdom
//
// The legend (ADR 0030): a normal chart legend. One row per group -- swatch,
// title, one line of why -- and the whole row is a button that toggles the
// group. One / All when there are several; All only when no two groups share a
// part, and then the view opens on All. Groups that share parts open one at a
// time with a note naming what they share. A group that is off is simply not
// drawn: nothing is dimmed.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import { layoutBounds } from "../src/diagrams/viewport-fit";
import { computeLayout, type LayoutResult } from "../src/layout/elk-adapter";
import { projectEnvelope } from "../src/diagrams/projection";
import { parseEmphasis, type Emphasis } from "../src/emphasis/contract";
import { loadValidFixture } from "./fixtures";
import { installReducedMotion } from "./match-media";

let layout: LayoutResult;

beforeAll(async () => {
  const projection = projectEnvelope(loadValidFixture("minimal-data-flow.json"));
  if (!projection.ok || projection.type !== "graph") {
    throw new Error("the data-flow fixture did not project to a graph view");
  }
  layout = await computeLayout(projection.view);
});

beforeEach(() => {
  installReducedMotion(false);
});

afterEach(cleanup);

function emphasis(...groups: readonly Record<string, unknown>[]): Emphasis {
  const parsed = parseEmphasis({
    id: "the-path",
    viewId: "minimal-data-flow",
    title: "The write path",
    groups,
  });
  expect(parsed, "the fixture is not a readable emphasis").toBeDefined();
  return parsed!;
}

const TWO_GROUPS = [
  {
    id: "write",
    style: "flow",
    speed: "slow",
    label: "The write path",
    description: "Source in, envelope out.",
    nodes: ["web"],
    edges: ["request"],
  },
  { id: "next", style: "highlight", label: "Cache (proposed)", nodes: ["api"] },
] as const;
const OVERLAPPING = [
  { id: "first", style: "highlight", label: "Front door", nodes: ["web", "api"] },
  { id: "second", style: "highlight", label: "Back office", nodes: ["api"], edges: ["request"] },
] as const;

function draw(value: Emphasis | null): HTMLElement {
  return render(<DiagramCanvas state={{ status: "ready", layout }} emphasis={value} />).container;
}

const legend = (): HTMLElement => screen.getByRole("region", { name: "Highlights" });
const rows = (): HTMLElement[] => within(legend()).getAllByRole("listitem");
const row = (index: number): HTMLElement => within(rows()[index]!).getByRole("button");
const modeButton = (name: "One" | "All"): HTMLElement =>
  within(legend()).getByRole("button", { name: new RegExp(`^${name}$`) });
const nodeOf = (container: HTMLElement, id: string): HTMLElement =>
  container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;

describe("the legend states what is emphasised", () => {
  it("heads an untitled emphasis Highlights, the page's one word for it, never its id", () => {
    const untitled = parseEmphasis({ id: "e-7f3a", viewId: "minimal-data-flow", groups: [TWO_GROUPS[1]] })!;
    draw(untitled);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Highlights");
    expect(legend().textContent).not.toMatch(/In focus|e-7f3a/);
  });

  it("gives every group a row, in the order the agent sent them, with its title and one line", () => {
    draw(emphasis(...TWO_GROUPS));
    expect(rows()).toHaveLength(2);
    expect(rows()[0].textContent).toBe("The write pathSource in, envelope out.");
    expect(rows()[1].textContent).toBe("Cache (proposed)");
  });

  it("says no style words and no counts: the swatch and the title carry the row", () => {
    draw(emphasis(...TWO_GROUPS));
    // The rows, the One / All control and the settings; the member list names groups "Highlight N" on purpose.
    const words = [...legend().children]
      .filter((child) => !child.classList.contains("archer-emph-legend-members"))
      .map((child) => child.textContent)
      .join("");
    expect(words).not.toMatch(/Teal|Violet|Flow ·|Highlight|\d+ nodes?|\d+ edges?/);
  });

  it("carries each row's slot as a class, never as a colour", () => {
    draw(emphasis(...TWO_GROUPS));
    expect(rows()[0].classList.contains("archer-emph-palette-teal")).toBe(true);
    expect(rows()[1].classList.contains("archer-emph-palette-violet")).toBe(true);
    expect(rows()[1].getAttribute("style") ?? "").not.toMatch(/#|rgb|hsl/);
  });

  it("names the emphasis, so several are told apart when one replaces another", () => {
    draw(emphasis(...TWO_GROUPS));
    expect(legend().textContent).toContain("The write path");
  });

  it("shows no legend when nothing is emphasised, or for a cleared emphasis", () => {
    draw(null);
    expect(screen.queryByRole("region", { name: "Highlights" })).toBeNull();
    cleanup();
    draw(emphasis());
    expect(screen.queryByRole("region", { name: "Highlights" })).toBeNull();
  });

  it("offers no One / All for a single group", () => {
    draw(emphasis(TWO_GROUPS[0]));
    expect(within(legend()).queryByRole("button", { name: /^All$/ })).toBeNull();
  });
});

describe("groups that share nothing open on All", () => {
  it("starts with every row on and every group drawn", () => {
    const container = draw(emphasis(...TWO_GROUPS));
    expect(modeButton("All")).toHaveAttribute("aria-pressed", "true");
    expect(modeButton("All")).not.toBeDisabled();
    expect([row(0), row(1)].map((each) => each.getAttribute("aria-pressed"))).toEqual(["true", "true"]);
    expect(nodeOf(container, "web").classList.contains("archer-emph")).toBe(true);
    expect(nodeOf(container, "api").classList.contains("archer-emph")).toBe(true);
  });

  // Owner, 2026-11-12: while a highlight is shown, what it does not name steps back -- so a group turned off leaves
  // its node quiet like any other non-member while the other group shows (it used to be left at full strength).
  it("toggles a row off and on with a plain tap, drawing nothing for it while off and quieting it as a non-member", () => {
    const container = draw(emphasis(...TWO_GROUPS));
    fireEvent.click(row(1));
    expect(row(1)).toHaveAttribute("aria-pressed", "false");
    expect(nodeOf(container, "api").className).not.toMatch(/archer-emph/);
    expect(nodeOf(container, "api").classList.contains("archer-dimmed")).toBe(true);
    expect(nodeOf(container, "web").classList.contains("archer-emph")).toBe(true);
    fireEvent.click(row(1));
    expect(row(1)).toHaveAttribute("aria-pressed", "true");
    expect(nodeOf(container, "api").classList.contains("archer-emph")).toBe(true);
  });

  it("keeps each group's colour when another is turned off", () => {
    const container = draw(emphasis(...TWO_GROUPS));
    fireEvent.click(row(0));
    expect(nodeOf(container, "api").classList.contains("archer-emph-palette-violet")).toBe(true);
  });

  it("switches to One, keeping the first group that was on", () => {
    const container = draw(emphasis(...TWO_GROUPS));
    fireEvent.click(modeButton("One"));
    expect([row(0), row(1)].map((each) => each.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    fireEvent.click(row(1));
    expect([row(0), row(1)].map((each) => each.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
    expect(nodeOf(container, "web").className).not.toMatch(/archer-emph/);
    fireEvent.click(row(1));
    expect(row(1)).toHaveAttribute("aria-pressed", "false");
  });
});

describe("groups that share parts open one at a time", () => {
  it("starts on One with group 1, All disabled, and a note naming what they share", () => {
    const container = draw(emphasis(...OVERLAPPING));
    expect(modeButton("One")).toHaveAttribute("aria-pressed", "true");
    expect(modeButton("All")).toBeDisabled();
    expect([row(0), row(1)].map((each) => each.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    expect(legend().textContent).toContain("These share API, so they show one at a time.");
    expect(nodeOf(container, "api").classList.contains("archer-emph-palette-teal")).toBe(true);
  });

  it("never shows two overlapping groups at once", () => {
    const container = draw(emphasis(...OVERLAPPING));
    fireEvent.click(modeButton("All"));
    fireEvent.click(row(1));
    expect([row(0), row(1)].map((each) => each.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
    expect(nodeOf(container, "api").classList.contains("archer-emph-palette-violet")).toBe(true);
    expect(nodeOf(container, "web").className).not.toMatch(/archer-emph/);
  });

  it("drops to One when a republish makes All-on groups overlap", () => {
    const { container, rerender } = render(
      <DiagramCanvas state={{ status: "ready", layout }} emphasis={emphasis(...TWO_GROUPS)} />,
    );
    expect(modeButton("All")).toHaveAttribute("aria-pressed", "true");
    rerender(
      <DiagramCanvas
        state={{ status: "ready", layout }}
        emphasis={emphasis(TWO_GROUPS[0], { ...TWO_GROUPS[1], nodes: ["web"] })}
      />,
    );
    expect(modeButton("One")).toHaveAttribute("aria-pressed", "true");
    expect([row(0), row(1)].map((each) => each.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    expect(nodeOf(container, "web").classList.contains("archer-emph-palette-teal")).toBe(true);
  });
});

describe("the agent's emphasis and the host's focus", () => {
  // The agent pointed at something the host's focus set leaves out, and the
  // screen has to show it (ADR 0005, `xflow-adapter.dimmedBy`).
  it("draws an emphasised node at full opacity outside the focus set", () => {
    const { container } = render(
      <DiagramCanvas
        state={{ status: "ready", layout, focus: { nodeIds: ["web"] } }}
        emphasis={emphasis(TWO_GROUPS[1])}
      />,
    );
    const api = nodeOf(container, "api");
    expect(api.classList.contains("archer-emph")).toBe(true);
    expect(api.style.opacity).toBe("1");
  });
});

describe("fit reserves the legend's corner", () => {
  // The legend's own box, from `styles.css`: up to 300px wide, 14px in, at the bottom left beside the toolbar.
  const CANVAS = { width: 1440, height: 800 };
  const LEGEND_RIGHT_EDGE = 314;

  /** Mounts at a real size and reports where the framed box lands on screen. */
  async function framed(
    value: Emphasis | null,
    focus?: { nodeIds: string[] },
  ): Promise<{ left: number; right: number; bottom: number }> {
    const { container } = render(
      <DiagramCanvas
        state={{
          status: "ready",
          layout,
          focus,
          viewport: { mode: focus ? "fit-focus" : "fit-all", key: 1 },
        }}
        emphasis={value}
      />,
    );
    // jsdom lays nothing out; give the element React Flow measures a box.
    const measured = container.querySelector<HTMLElement>(".react-flow__renderer")!;
    Object.defineProperty(measured, "offsetWidth", { configurable: true, value: CANVAS.width });
    Object.defineProperty(measured, "offsetHeight", { configurable: true, value: CANVAS.height });
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const transform = container.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform;
    const match = /translate\(([-\d.e]+)px,\s*([-\d.e]+)px\)\s*scale\(([-\d.e]+)\)/.exec(transform);
    expect(match, `unreadable transform ${transform}`).not.toBeNull();
    const [x, y, zoom] = [Number(match![1]), Number(match![2]), Number(match![3])];
    const bounds = layoutBounds(layout, focus?.nodeIds)!;
    return {
      left: bounds.x * zoom + x,
      right: (bounds.x + bounds.width) * zoom + x,
      bottom: (bounds.y + bounds.height) * zoom + y,
    };
  }

  it("frames the graph clear of the corner the legend occupies", async () => {
    const drawn = await framed(emphasis(...TWO_GROUPS));

    expect(drawn.left).toBeGreaterThanOrEqual(LEGEND_RIGHT_EDGE);
    // Reserved on the legend's side, and by more than the other side gets:
    // this is the corner the panel rests in.
    expect(drawn.left).toBeGreaterThan(CANVAS.width - drawn.right);
  });

  it("reserves the corner for a focused fit as well as a whole-graph one", async () => {
    const drawn = await framed(emphasis(...TWO_GROUPS), { nodeIds: ["web"] });

    // Still framing the focus set -- `drawn` is the focused node's box -- and
    // still keeping it out from under the legend.
    expect(drawn.left).toBeGreaterThanOrEqual(LEGEND_RIGHT_EDGE);
  });

  it("reserves nothing when there is no legend to collide with", async () => {
    const drawn = await framed(null);

    // Centred in the whole canvas: the same room on both sides.
    expect(CANVAS.width - drawn.right).toBeCloseTo(drawn.left, 3);
  });

  it("does not move the drawing when a dataflow is turned off or on, while the view has emphasis sets", async () => {
    const at = (value: Emphasis | null) => (
      <DiagramCanvas
        state={{ status: "ready", layout, viewport: { mode: "fit-all", key: 1 } }}
        emphasis={value}
        reserveLegendRoom
      />
    );
    const { container, rerender } = render(at(emphasis(...TWO_GROUPS)));
    const measured = container.querySelector<HTMLElement>(".react-flow__renderer")!;
    Object.defineProperty(measured, "offsetWidth", { configurable: true, value: CANVAS.width });
    Object.defineProperty(measured, "offsetHeight", { configurable: true, value: CANVAS.height });
    const settle = () =>
      act(async () => {
        window.dispatchEvent(new Event("resize"));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    const transform = () => container.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform;
    await settle();
    const withLegend = transform();

    rerender(at(null));
    await settle();
    expect(screen.queryByRole("region", { name: "Highlights" })).toBeNull();
    expect(transform()).toBe(withLegend);

    rerender(at(emphasis(...TWO_GROUPS)));
    await settle();
    expect(transform()).toBe(withLegend);
  });

  it("keeps the legend inside the canvas, which is why the fit has to", () => {
    const container = draw(emphasis(...TWO_GROUPS));

    // Anchored against the canvas surface, not the page: a legend outside it
    // would collide with nothing and need no reservation at all.
    expect(container.querySelector(".archer-emph-surface .archer-emph-legend")).not.toBeNull();
  });
});

describe("the reader's choice across republishes (C6 review)", () => {
  it("is reconciled against what the reader last saw, not an older choice", () => {
    const disjoint = emphasis(...TWO_GROUPS);
    const overlapping = emphasis(TWO_GROUPS[0], { ...TWO_GROUPS[1], nodes: ["web"] });
    const { rerender } = render(<DiagramCanvas state={{ status: "ready", layout }} emphasis={disjoint} />);
    expect(modeButton("All")).toHaveAttribute("aria-pressed", "true");
    rerender(<DiagramCanvas state={{ status: "ready", layout }} emphasis={overlapping} />);
    expect(modeButton("One")).toHaveAttribute("aria-pressed", "true");
    rerender(<DiagramCanvas state={{ status: "ready", layout }} emphasis={emphasis(...TWO_GROUPS)} />);
    // Disjoint again: the reader is still on One, as they were left.
    expect(modeButton("One")).toHaveAttribute("aria-pressed", "true");
  });
});
