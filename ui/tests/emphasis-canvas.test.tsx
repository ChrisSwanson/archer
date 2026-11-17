// @vitest-environment jsdom
//
// Emphasis on the canvas.
//
// TWO DISTINCT VOICES is the rule these tests exist to hold. The user's
// selection is a steady glow that never moves; agent emphasis always moves or
// carries a non-accent hue, and always adds a ring of its own. You must never
// have to wonder who pointed at what, so the two are asserted to be separate
// classes -- never the same treatment reached by two paths.
//
// The second rule is that COLOUR IS NEVER THE ONLY CHANNEL. Style, ring and
// dash pattern carry the same meaning, which is what makes emphasis survive
// greyscale, colour-vision deficiency, and `prefers-reduced-motion`.
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
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

/** An emphasis over the data-flow fixture: nodes `web`/`api`, edge `request`. */
function emphasis(...groups: readonly Record<string, unknown>[]): Emphasis {
  const parsed = parseEmphasis({
    id: "the-path",
    viewId: "minimal-data-flow",
    title: "The path",
    groups,
  });
  expect(parsed, "the fixture is not a readable emphasis").toBeDefined();
  return parsed!;
}

function draw(
  value: Emphasis | null,
  selection?: { nodeIds?: readonly string[]; edgeIds?: readonly string[] },
): HTMLElement {
  return render(<DiagramCanvas state={{ status: "ready", layout }} emphasis={value} selection={selection} />).container;
}

const nodeEl = (container: HTMLElement, id: string): HTMLElement => {
  const found = container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
  expect(found, `node ${id}`).not.toBeNull();
  return found!;
};

async function edgeEl(container: HTMLElement, id: string): Promise<Element> {
  // React Flow only mounts edges once it has measured their nodes.
  await waitFor(() => {
    expect(container.querySelector(`.react-flow__edge[data-id="${id}"]`)).not.toBeNull();
  });
  return container.querySelector(`.react-flow__edge[data-id="${id}"]`)!;
}

describe("each style renders its own treatment", () => {
  it("marks a highlight group's node as emphasised, in that style", () => {
    const container = draw(emphasis({ id: "here", style: "highlight", palette: "violet", nodes: ["web"] }));

    const web = nodeEl(container, "web");
    expect(web.classList.contains("archer-emph")).toBe(true);
    expect(web.classList.contains("archer-emph-style-highlight")).toBe(true);
    expect(web.classList.contains("archer-emph-style-flow")).toBe(false);
  });

  it("sends moving arrows along a flow group's edge", async () => {
    const container = draw(emphasis({ id: "path", style: "flow", palette: "teal", edges: ["request"] }));

    const edge = await edgeEl(container, "request");
    expect(edge.classList.contains("archer-emph-style-flow")).toBe(true);
    // The packet is what carries direction and pace: a still line cannot say
    // which way the data goes.
    const packet = edge.querySelector(".archer-emph-chevrons");
    expect(packet, "a flow edge drew no moving arrows").not.toBeNull();
    expect(packet!.querySelectorAll("animateMotion").length).toBeGreaterThan(0);
  });

  it("sends no moving arrows along a highlight group's edge", async () => {
    const container = draw(emphasis({ id: "here", style: "highlight", palette: "teal", edges: ["request"] }));

    const edge = await edgeEl(container, "request");
    expect(edge.classList.contains("archer-emph-style-highlight")).toBe(true);
    expect(edge.querySelector(".archer-emph-chevrons")).toBeNull();
  });

  it("carries the group's pace into the packet's timing", async () => {
    const container = draw(emphasis({ id: "slow", style: "flow", palette: "teal", speed: "slow", edges: ["request"] }));

    const edge = await edgeEl(container, "request");
    // "This hop is the expensive one" is a claim about the system, so the pace
    // has to be visible rather than a constant the viewer cannot read.
    const seconds = Number.parseFloat(edge.querySelector("animateMotion")?.getAttribute("dur") ?? "0");
    const path = edge.querySelector("path.react-flow__edge-path") as SVGPathElement;
    // Slow is 50px of route a second; the arrows never lap faster than 1.2s.
    expect(seconds).toBeGreaterThanOrEqual(1.2);
    expect(path).not.toBeNull();
    expect(edge.classList.contains("archer-emph-speed-slow")).toBe(true);
  });

  it("leaves an element in no group unmarked", () => {
    const container = draw(emphasis({ id: "here", style: "highlight", palette: "teal", nodes: ["web"] }));

    expect(nodeEl(container, "api").className).not.toMatch(/archer-emph/);
  });

  it("draws nothing when there is no emphasis", () => {
    const container = draw(null);

    expect(container.querySelector(".archer-emph")).toBeNull();
    expect(container.querySelector(".archer-emph-chevrons")).toBeNull();
  });
});

describe("each group takes the slot its position gives it (ADR 0030)", () => {
  // Every group claims amber on the wire, as an older service's agent might
  // have: the page draws position, never the name.
  const three = () =>
    emphasis(
      { id: "g0", style: "highlight", palette: "coral", nodes: ["web"] },
      { id: "g1", style: "highlight", palette: "coral", nodes: ["api"] },
      { id: "g2", style: "highlight", palette: "coral", edges: ["request"] },
    );
  const slots = (element: Element) => [...element.classList].filter((name) => name.startsWith("archer-emph-palette-"));

  it("draws groups 1, 2 and 3 as teal, violet and coral", async () => {
    const container = draw(three());
    expect(slots(nodeEl(container, "web"))).toEqual(["archer-emph-palette-teal"]);
    expect(slots(nodeEl(container, "api"))).toEqual(["archer-emph-palette-violet"]);
    expect(slots(await edgeEl(container, "request"))).toEqual(["archer-emph-palette-coral"]);
    // The agent picked nothing visual. Nothing it sent may reach a CSS property.
    expect(nodeEl(container, "web").getAttribute("style") ?? "").not.toMatch(/#|rgb|hsl/);
  });
});

describe("proposed is said in the label, never drawn (ADR 0030)", () => {
  it("puts no state class on a group the wire still calls proposed", async () => {
    const container = draw(
      emphasis({ id: "next", style: "flow", palette: "coral", state: "proposed", nodes: ["web"], edges: ["request"] }),
    );
    for (const element of [nodeEl(container, "web"), await edgeEl(container, "request")]) {
      expect([...element.classList].filter((name) => name.startsWith("archer-emph-state-"))).toEqual([]);
      expect(element.classList.contains("archer-emph")).toBe(true);
    }
  });
});

/**
 * The user's selection and the agent's emphasis must never be reachable as the
 * same treatment. Asserted on classes rather than on rendered colour: the
 * accent is a hue of its own now (`canvas-theme.test.tsx` holds it off the
 * palette), but hue is the weakest channel -- what separates the voices for
 * every reader is that emphasis moves and carries a ring of its own, and
 * selection does neither.
 */
describe("two distinct voices", () => {
  it("keeps a selected node and an emphasised node in different classes", () => {
    const container = draw(emphasis({ id: "g", style: "highlight", palette: "teal", nodes: ["web"] }), {
      nodeIds: ["api"],
    });

    const web = nodeEl(container, "web");
    const api = nodeEl(container, "api");

    expect(web.classList.contains("archer-emph")).toBe(true);
    expect(web.classList.contains("selected")).toBe(false);
    expect(api.classList.contains("selected")).toBe(true);
    expect(api.className).not.toMatch(/archer-emph/);
  });

  it("says both things at once about one node, without merging them", () => {
    const container = draw(emphasis({ id: "g", style: "highlight", palette: "teal", nodes: ["web"] }), {
      nodeIds: ["web"],
    });

    const web = nodeEl(container, "web");
    expect(web.classList.contains("selected")).toBe(true);
    expect(web.classList.contains("archer-emph")).toBe(true);
  });
});

/**
 * Motion is never the only channel.
 *
 * With animation off, the group must still be readable as a group: the ring,
 * the palette class and the dash pattern carry the whole message, and the
 * packet stops travelling rather than disappearing along with the claim that
 * this edge is part of the path.
 */
describe("reduced motion", () => {
  // Flow animation is On by default; Auto is the choice that follows the browser.
  beforeEach(() => {
    installReducedMotion(true);
    localStorage.setItem("archer.flow-animation", "auto");
  });
  afterEach(() => localStorage.removeItem("archer.flow-animation"));

  it("moves by default even when the browser asks for less motion", async () => {
    localStorage.removeItem("archer.flow-animation");
    const container = draw(emphasis({ id: "path", style: "flow", palette: "teal", edges: ["request"] }));
    const edge = await edgeEl(container, "request");
    await waitFor(() => expect(edge.querySelector("animateMotion")).not.toBeNull());
    expect((container.querySelector('select[aria-label="Flow animation"]') as HTMLSelectElement).value).toBe("on");
  });

  it("lets the reader explicitly animate flow without changing the browser preference", async () => {
    const container = draw(emphasis({ id: "path", style: "flow", palette: "teal", edges: ["request"] }));
    const control = container.querySelector('select[aria-label="Flow animation"]');
    expect(control, "the reader needs a site-level flow animation choice").not.toBeNull();
    fireEvent.change(control!, { target: { value: "on" } });
    await waitFor(() => expect(container.querySelector("animateMotion")).not.toBeNull());
    expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    fireEvent.change(control!, { target: { value: "auto" } });
    await waitFor(() => expect(container.querySelector("animateMotion")).toBeNull());
  });

  it("parks the moving arrows, and moves them again when the motion preference changes", async () => {
    const setReducedMotion = installReducedMotion(true);
    const container = draw(
      emphasis(
        { id: "path", style: "flow", palette: "teal", edges: ["request"] },
        { id: "point", style: "highlight", palette: "violet", nodes: ["web"] },
      ),
    );
    const edge = await edgeEl(container, "request");
    expect(edge.querySelectorAll(".archer-emph-chevron")).toHaveLength(2);
    expect(edge.querySelector("animateMotion")).toBeNull();
    act(() => setReducedMotion(false));
    await waitFor(() => expect(edge.querySelector("animateMotion")).not.toBeNull());
  });

  it("marks the canvas as static so nothing animates", () => {
    const container = draw(emphasis({ id: "g", style: "flow", palette: "teal", edges: ["request"] }));

    expect(container.querySelector(".archer-emph-static")).not.toBeNull();
  });

  it("stops the packet travelling but keeps the edge in its group", async () => {
    const container = draw(emphasis({ id: "g", style: "flow", palette: "coral", edges: ["request"] }));

    const edge = await edgeEl(container, "request");
    const packet = edge.querySelector(".archer-emph-chevrons");
    expect(packet, "the edge lost its arrows entirely").not.toBeNull();
    expect(packet!.querySelectorAll("animateMotion")).toHaveLength(0);
    // Group membership survives: the class and the palette still say so.
    expect(edge.classList.contains("archer-emph")).toBe(true);
    expect(edge.classList.contains("archer-emph-palette-teal")).toBe(true);
  });

  it("keeps an emphasised node's group membership with the glow switched off", () => {
    const container = draw(emphasis({ id: "g", style: "highlight", palette: "violet", nodes: ["web"] }));

    const web = nodeEl(container, "web");
    expect(web.classList.contains("archer-emph")).toBe(true);
    expect(web.classList.contains("archer-emph-palette-teal")).toBe(true);
  });
});
