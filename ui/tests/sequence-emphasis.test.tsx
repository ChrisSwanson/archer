// @vitest-environment jsdom
//
// Agent emphasis on the sequence canvas.
//
// The SAME vocabulary and the same surface the graph canvas has: a participant
// is emphasised as a node and a message as an edge, the legend, the isolation
// and the reduced-motion rule are the graph's own, and only the drawing is
// this notation's. So these tests hold the two rules the graph's hold --
// TWO DISTINCT VOICES (emphasis never takes the place of the reader's
// selection or their keyboard ring) and COLOUR IS NEVER THE ONLY CHANNEL --
// against the real `SequenceCanvas`.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import { travelSeconds } from "../src/emphasis/EmphasisChevrons";
import {
  FIT_GUTTER_PX,
  SequenceCanvas,
  fitPanZoom,
  framePanZoom,
  sequenceFitPadding,
} from "../src/diagrams/SequenceCanvas";
import { computeSequenceLayout, type SequenceLayoutResult } from "../src/layout/sequence-layout";
import { projectEnvelope } from "../src/diagrams/projection";
import { DIMMED_OPACITY, FOCUSED_OPACITY } from "../src/diagrams/focus-style";
import {
  EMPHASIS_PALETTES,
  EMPHASIS_SPEEDS,
  EMPHASIS_STATES,
  parseEmphasis,
  type Emphasis,
} from "../src/emphasis/contract";
import { loadValidFixture } from "./fixtures";
import { installReducedMotion } from "./match-media";
import { declarationsOf, readStylesheet, rulesOf } from "./stylesheet";

/**
 * `minimal-sequence.json`: participants `client`, `server`, `db`; messages
 * `msg-0` (client to server) to `msg-4`, the last two inside fragment `frag-0`.
 */
function sequenceLayout(): SequenceLayoutResult {
  const projection = projectEnvelope(loadValidFixture("minimal-sequence.json"));
  if (!projection.ok || projection.type !== "sequence") {
    throw new Error("minimal-sequence.json did not project to a sequence view");
  }
  return computeSequenceLayout(projection.view);
}

const layout = sequenceLayout();

beforeEach(() => {
  installReducedMotion(false);
});

afterEach(cleanup);

function emphasis(...groups: readonly Record<string, unknown>[]): Emphasis {
  const parsed = parseEmphasis({ id: "login", viewId: "login-flow", title: "The login path", groups });
  expect(parsed, "the fixture is not a readable emphasis").toBeDefined();
  return parsed!;
}

type Extra = {
  selection?: { nodeIds?: readonly string[]; edgeIds?: readonly string[] };
  focus?: { participantIds?: string[]; messageIds?: string[] };
};

function draw(value: Emphasis | null, extra: Extra = {}): HTMLElement {
  return render(
    <SequenceCanvas
      layout={layout}
      emphasis={value}
      selection={extra.selection}
      focus={extra.focus}
      onNodeClick={vi.fn()}
      onEdgeClick={vi.fn()}
    />,
  ).container;
}

/** The drawn group of one participant or message: the element the classes sit on. */
function target(container: HTMLElement, channel: "participants" | "messages", id: string): Element {
  const found = [...container.querySelectorAll(`g[data-seq-channel="${channel}"]`)].find(
    (element) => element.getAttribute("data-seq-id") === id,
  );
  expect(found, `${channel} ${id}`).toBeDefined();
  return found!;
}

const participant = (container: HTMLElement, id: string): Element => target(container, "participants", id);
const message = (container: HTMLElement, id: string): Element => target(container, "messages", id);
const lifeline = (container: HTMLElement, id: string): Element => {
  const found = container.querySelector(`.archer-seq-lifeline[data-seq-lifeline="${id}"]`);
  expect(found, `lifeline of ${id}`).not.toBeNull();
  return found!;
};
const classesOf = (element: Element): string[] => [...element.classList];

describe("the graph canvas hands a sequence view its emphasis", () => {
  it("draws the emphasis `DiagramCanvas` was given, on the sequence canvas", () => {
    const { container } = render(
      <DiagramCanvas
        state={{ status: "sequence-ready", sequenceLayout: layout }}
        emphasis={emphasis({ id: "here", style: "highlight", palette: "violet", nodes: ["server"] })}
      />,
    );

    expect(classesOf(participant(container, "server"))).toContain("archer-emph");
    expect(screen.getByRole("region", { name: "Highlights" })).toBeDefined();
  });
});

describe("each style draws its own treatment, in this notation", () => {
  it("colours a highlighted participant's box border, and draws nothing round it or down its lifeline", () => {
    const container = draw(emphasis({ id: "here", style: "highlight", palette: "violet", nodes: ["server"] }));

    const server = participant(container, "server");
    expect(classesOf(server)).toEqual(
      expect.arrayContaining(["archer-emph", "archer-emph-style-highlight", "archer-emph-palette-teal"]),
    );
    // Colour only (ADR 0030): no ring, no glow, no lifeline band.
    expect(server.querySelector(".archer-seq-emph-ring, .archer-seq-emph-glow")).toBeNull();
    expect(container.querySelector(".archer-seq-emph-lifeline")).toBeNull();
  });

  it("colours a highlighted message's arrow, with no band, label wash or moving arrows", () => {
    const container = draw(emphasis({ id: "here", style: "highlight", palette: "coral", edges: ["msg-1"] }));

    const arrow = message(container, "msg-1");
    expect(classesOf(arrow)).toEqual(
      expect.arrayContaining(["archer-emph", "archer-emph-style-highlight", "archer-emph-palette-teal"]),
    );
    expect(arrow.querySelector(".archer-seq-emph-band, .archer-seq-emph-label")).toBeNull();
    expect(arrow.querySelector(".archer-emph-chevrons")).toBeNull();
  });

  describe("in the stylesheet", () => {
    const rules = rulesOf(readStylesheet());
    const declared = (selector: string): Map<string, string> =>
      new Map(rules.filter((rule) => rule.selectors.includes(selector)).flatMap((rule) => declarationsOf(rule.body)));

    it("colours the box border, the line and the arrowhead in the hue, and nothing else", () => {
      expect(declared(".archer-seq-participant.archer-emph .archer-seq-participant-box").get("stroke")).toBe(
        "var(--emph-hue)",
      );
      expect(declared(".archer-seq-message.archer-emph line").get("stroke")).toBe("var(--emph-hue)");
      expect(declared(".archer-seq-message.archer-emph polygon").get("fill")).toBe("var(--emph-hue)");
      const emphRules = rules.filter((rule) =>
        rule.selectors.some((selector) => selector.includes("archer-seq") && selector.includes("archer-emph")),
      );
      for (const rule of emphRules) {
        const body = new Map(declarationsOf(rule.body));
        for (const property of ["stroke-dasharray", "animation", "filter", "fill-opacity"]) {
          expect(body.has(property), `${rule.selectors.join(", ")} sets ${property}`).toBe(false);
        }
      }
    });

    it("keeps the hue on an emphasised arrowhead and participant border under the reader's selection", () => {
      expect(declared(".archer-seq-message.archer-emph.archer-seq-selected polygon").get("fill")).toBe(
        "var(--emph-hue)",
      );
      // An open arrowhead (async, reply) is a stroke: it keeps the hue too.
      expect(
        declared(".archer-seq-message.archer-emph.archer-seq-selected polyline.archer-seq-arrowhead").get("stroke"),
      ).toBe("var(--emph-hue)");
      expect(
        declared(".archer-seq-participant.archer-emph.archer-seq-selected .archer-seq-participant-box").get("stroke"),
      ).toBe("var(--emph-hue)");
    });
  });

  it("sends moving arrows along a flow message, from sender to receiver", () => {
    const container = draw(emphasis({ id: "path", style: "flow", palette: "teal", edges: ["msg-2"] }));

    const arrow = message(container, "msg-2");
    expect(classesOf(arrow)).toContain("archer-emph-style-flow");
    const packet = arrow.querySelector(".archer-emph-chevrons");
    expect(packet, "a flow message drew no packet").not.toBeNull();

    // The packet rides a path that exists and runs the way the message does.
    // `msg-2` is a reply drawn right-to-left, so a path built left-to-right
    // would animate the answer back into the database.
    const href = packet!.querySelector("mpath")?.getAttribute("href");
    expect(href).toMatch(/^#/);
    const route = container.querySelector(`[id="${href!.slice(1)}"]`);
    expect(route, `nothing in the canvas carries the id ${href}`).not.toBeNull();
    const placed = layout.messages.find((entry) => entry.id === "msg-2")!;
    expect(placed.toX).toBeLessThan(placed.fromX);
    expect(route!.getAttribute("d")).toBe(`M ${placed.fromX} ${placed.y} H ${placed.toX}`);
    // A flow message has no label halo: the packet is its mark.
    expect(arrow.querySelector(".archer-seq-emph-label")).toBeNull();
  });

  it.each(EMPHASIS_SPEEDS)("paces the moving arrows as the group's speed says: %s", (speed) => {
    const container = draw(emphasis({ id: "path", style: "flow", palette: "teal", speed, edges: ["msg-0"] }));

    const arrow = message(container, "msg-0");
    const placed = layout.messages.find((entry) => entry.id === "msg-0")!;
    expect(arrow.querySelector("animateMotion")?.getAttribute("dur")).toBe(
      `${travelSeconds(
        [
          { x: placed.fromX, y: placed.y },
          { x: placed.toX, y: placed.y },
        ],
        speed,
      ).toFixed(2)}s`,
    );
    expect(classesOf(arrow)).toContain(`archer-emph-speed-${speed}`);
  });

  it("staggers a flow by where each message sits in the conversation, not by how the agent listed them", () => {
    // Listed backwards. One journey reads top to bottom, so the first message
    // in the diagram leaves first whatever the payload's order was.
    const container = draw(
      emphasis({ id: "path", style: "flow", palette: "teal", speed: "fast", edges: ["msg-2", "msg-0", "msg-1"] }),
    );

    const begins = ["msg-0", "msg-1", "msg-2"].map((id) =>
      Number.parseFloat(message(container, id).querySelector("animateMotion")!.getAttribute("begin")!),
    );
    const periods = ["msg-0", "msg-1", "msg-2"].map((id) =>
      Number.parseFloat(message(container, id).querySelector("animateMotion")!.getAttribute("dur")!),
    );
    expect(begins[0]).toBeCloseTo(0, 1);
    expect(begins[1]).toBeCloseTo(-periods[1]! / 3, 1);
    expect(begins[2]).toBeCloseTo((-periods[2]! * 2) / 3, 1);
  });

  it("leaves what is in no group unmarked, and draws nothing with no emphasis", () => {
    const some = draw(
      emphasis({ id: "here", style: "highlight", palette: "teal", nodes: ["server"], edges: ["msg-0"] }),
    );
    expect(participant(some, "client").getAttribute("class")).not.toMatch(/archer-emph/);
    expect(message(some, "msg-1").getAttribute("class")).not.toMatch(/archer-emph/);
    cleanup();

    const none = draw(null);
    expect(none.querySelector(".archer-emph")).toBeNull();
    expect(none.querySelector(".archer-emph-chevrons")).toBeNull();
    expect(none.querySelector(".archer-emph-legend")).toBeNull();
  });

  it("never emphasises a fragment or a note, which carry no target of their own", () => {
    const container = draw(
      emphasis({ id: "all", style: "highlight", palette: "teal", nodes: ["client", "server", "db"], edges: ["msg-3"] }),
    );

    for (const selector of [".archer-seq-fragment", ".archer-seq-fragment-header", ".archer-seq-note"]) {
      for (const element of container.querySelectorAll(selector)) {
        expect(element.getAttribute("class")).not.toMatch(/archer-emph/);
      }
    }
  });
});

describe("the palette and the state reach a class, never a colour", () => {
  it.each(EMPHASIS_PALETTES)(
    "renders a lone group sent as %s in the first slot's class, on a participant and a message",
    (palette) => {
      const container = draw(emphasis({ id: "g", style: "highlight", palette, nodes: ["db"], edges: ["msg-0"] }));

      for (const element of [participant(container, "db"), message(container, "msg-0")]) {
        const palettes = classesOf(element).filter((name) => name.startsWith("archer-emph-palette-"));
        expect(palettes).toEqual(["archer-emph-palette-teal"]);
        // No colour is written onto the element: the class is the only route.
        for (const drawn of [element, ...element.querySelectorAll("*")]) {
          expect(drawn.getAttribute("style")).toBeNull();
          expect(drawn.getAttribute("stroke")).toBeNull();
          expect(drawn.getAttribute("fill") ?? "none").toBe("none");
        }
      }
    },
  );

  it.each(EMPHASIS_STATES)("draws no state class for a group the wire calls %s (ADR 0030)", (state) => {
    const container = draw(
      emphasis(
        { id: "boxes", style: "highlight", palette: "coral", state, nodes: ["db"], edges: ["msg-0"] },
        { id: "path", style: "flow", palette: "teal", state, edges: ["msg-1"] },
      ),
    );

    for (const element of [participant(container, "db"), message(container, "msg-0"), message(container, "msg-1")]) {
      expect(classesOf(element).filter((name) => name.startsWith("archer-emph-state-"))).toEqual([]);
    }
  });
});

describe("the legend is the graph's own, in this notation's words", () => {
  const twoGroups = (): Emphasis =>
    emphasis(
      { id: "path", style: "flow", palette: "teal", label: "Login", edges: ["msg-0", "msg-1", "msg-2"] },
      { id: "store", style: "highlight", palette: "coral", label: "The store", nodes: ["db"], edges: ["msg-3"] },
    );

  it("lists every group by its title, with no counts or style words", () => {
    draw(twoGroups());

    const legend = screen.getByRole("region", { name: "Highlights" });
    expect(legend.textContent).toContain("Login");
    expect(legend.textContent).toContain("The store");
    expect(legend.textContent).not.toMatch(/participants?|messages?|Teal ·|\bnodes?\b|\bedges?\b/);
  });

  it("turns a group off with a tap on its row, drawing nothing for it and dimming nothing", () => {
    const container = draw(twoGroups());
    const row = screen.getByText("The store").closest("button")!;
    expect(classesOf(participant(container, "db"))).toContain("archer-emph");

    fireEvent.click(row);

    expect(row.getAttribute("aria-pressed")).toBe("false");
    expect(classesOf(participant(container, "db"))).not.toContain("archer-emph");
    expect(container.querySelector(".archer-emph-isolating, .archer-emph-member")).toBeNull();
    expect(classesOf(message(container, "msg-0"))).toContain("archer-emph");
  });
});

describe("reduced motion parks the moving arrows rather than withdrawing them", () => {
  // Flow animation is On by default; Auto is the choice that follows the browser.
  beforeEach(() => localStorage.setItem("archer.flow-animation", "auto"));
  afterEach(() => localStorage.removeItem("archer.flow-animation"));

  it("draws still arrows along the message and says so on the surface (Auto)", () => {
    installReducedMotion(true);
    const container = draw(emphasis({ id: "path", style: "flow", palette: "teal", edges: ["msg-0"] }));

    expect(classesOf(container.querySelector(".archer-seq-surface")!)).toContain("archer-emph-static");
    const chevrons = message(container, "msg-0").querySelector(".archer-emph-chevrons");
    expect(chevrons, "the arrows are the claim, not only the animation").not.toBeNull();
    expect(chevrons!.querySelector("animateMotion")).toBeNull();
    const placed = layout.messages.find((entry) => entry.id === "msg-0")!;
    const xs = [...chevrons!.querySelectorAll(".archer-emph-chevron")].map((chevron) =>
      Number(/translate\(([-\d.]+) /.exec(chevron.getAttribute("transform") ?? "")![1]),
    );
    // On the arrow, in order along it; moved off the label's plate where it would cover them.
    const [low, high] = [Math.min(placed.fromX, placed.toX), Math.max(placed.fromX, placed.toX)];
    expect(xs).toHaveLength(2);
    for (const x of xs) expect(x).toBeGreaterThanOrEqual(low);
    for (const x of xs) expect(x).toBeLessThanOrEqual(high);
    expect(Math.sign(xs[1]! - xs[0]!)).toBe(Math.sign(placed.toX - placed.fromX));
  });

  it("moves when the viewer has not asked for less", () => {
    const container = draw(emphasis({ id: "path", style: "flow", palette: "teal", edges: ["msg-0"] }));

    expect(classesOf(container.querySelector(".archer-seq-surface")!)).not.toContain("archer-emph-static");
    expect(message(container, "msg-0").querySelectorAll("animateMotion").length).toBeGreaterThan(0);
  });
});

describe("emphasis, selection, the keyboard ring and focus dimming stay legible together", () => {
  it("keeps the reader's selection on an emphasised message, and adds to it", () => {
    const container = draw(emphasis({ id: "here", style: "highlight", palette: "coral", edges: ["msg-0"] }), {
      selection: { edgeIds: ["msg-0"] },
    });

    const arrow = message(container, "msg-0");
    expect(classesOf(arrow)).toEqual(expect.arrayContaining(["archer-seq-selected", "archer-emph"]));
    expect(arrow.querySelector(".archer-seq-message-plate")).not.toBeNull();
    expect(arrow.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the selection glow and the keyboard ring on an emphasised participant", () => {
    const container = draw(emphasis({ id: "here", style: "highlight", palette: "violet", nodes: ["server"] }), {
      selection: { nodeIds: ["server"] },
    });
    const server = participant(container, "server") as HTMLElement;

    act(() => server.focus());

    expect(server.querySelector(".archer-seq-participant-ring")).not.toBeNull();
    expect(server.querySelector(".archer-seq-participant-halo")).not.toBeNull();
    expect(classesOf(server)).toContain("archer-emph");
  });

  it("keeps the keyboard halo and the moving arrows on a selected, focused flow message", () => {
    const container = draw(emphasis({ id: "path", style: "flow", palette: "teal", edges: ["msg-0"] }), {
      selection: { edgeIds: ["msg-0"] },
    });
    const arrow = message(container, "msg-0") as HTMLElement;

    act(() => arrow.focus());

    expect(arrow.querySelector(".archer-seq-message-ring")).not.toBeNull();
    expect(arrow.querySelector(".archer-seq-message-plate")).not.toBeNull();
    expect(arrow.querySelector(".archer-emph-chevrons")).not.toBeNull();
  });

  it("never lets the host's focus dim what the agent is pointing at", () => {
    // Focus frames `client`; the agent points at `db` and `msg-1`, outside it.
    const container = draw(
      emphasis({ id: "here", style: "highlight", palette: "teal", nodes: ["db"], edges: ["msg-1"] }),
      { focus: { participantIds: ["client"] } },
    );
    const opacity = (element: Element): number => Number(element.getAttribute("opacity"));

    expect(opacity(participant(container, "db"))).toBe(FOCUSED_OPACITY);
    expect(opacity(lifeline(container, "db"))).toBe(FOCUSED_OPACITY);
    expect(opacity(message(container, "msg-1"))).toBe(FOCUSED_OPACITY);
    // Everything else outside the focus still dims, so the framing still reads.
    expect(opacity(participant(container, "server"))).toBe(DIMMED_OPACITY);
    expect(opacity(message(container, "msg-0"))).toBe(DIMMED_OPACITY);
  });
});

describe("a fit keeps clear of the legend's corner", () => {
  const canvas = { width: 1440, height: 900 };
  const wide = { width: 3000, height: 400 };
  const tall = { width: 400, height: 3000 };

  it("reserves nothing but the gutter when no legend is up", () => {
    expect(sequenceFitPadding(canvas, false)).toEqual({
      top: FIT_GUTTER_PX,
      right: FIT_GUTTER_PX,
      bottom: FIT_GUTTER_PX,
      left: FIT_GUTTER_PX,
    });
    expect(fitPanZoom(wide, canvas, sequenceFitPadding(canvas, false))).toEqual(fitPanZoom(wide, canvas));
  });

  it.each([
    ["a wide diagram starts after the legend's right edge", wide],
    ["a tall diagram stops short of the legend's top edge", tall],
  ])("%s", (_name, extent) => {
    const padding = sequenceFitPadding(canvas, true);
    expect(padding.left).toBeGreaterThan(300);
    expect(padding.bottom).toBeGreaterThan(FIT_GUTTER_PX);

    for (const fit of [fitPanZoom, framePanZoom]) {
      const framed = fit(extent, canvas, padding);
      expect(framed.x).toBeGreaterThanOrEqual(padding.left - 1e-9);
      expect(framed.y).toBeGreaterThanOrEqual(padding.top - 1e-9);
      // The whole-diagram fit starts after the reserved corner and ends above it.
      if (fit === fitPanZoom) {
        expect(framed.x + extent.width * framed.scale).toBeLessThanOrEqual(canvas.width - padding.right + 1e-9);
        expect(framed.y + extent.height * framed.scale).toBeLessThanOrEqual(canvas.height - padding.bottom + 1e-9);
      }
    }
  });

  it("caps the reservation on a narrow canvas instead of squeezing the diagram into a sliver", () => {
    const narrow = { width: 420, height: 700 };
    const padding = sequenceFitPadding(narrow, true);
    expect(narrow.width - padding.left - padding.right).toBeGreaterThan(narrow.width / 2);
  });
});
