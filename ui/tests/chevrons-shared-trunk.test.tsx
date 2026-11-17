// @vitest-environment jsdom
//
// Lines that share a trunk draw its direction once. Rendered review, 2026-11-13: in the QoS walkthrough the four
// lines out of "Service Level?" each carried their own chevrons over the same stretch, which stacked on one another.
// Each lit line's chevrons travel only the part no other lit line of its group already draws.
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import { computeLayout, type LayoutResult } from "../src/layout/elk-adapter";
import { parseEmphasis, type Emphasis } from "../src/emphasis/contract";
import { CHEVRON_REACH, ownStretch, routeLength } from "../src/emphasis/EmphasisChevrons";
import { installReducedMotion } from "./match-media";
import { cornersOf } from "../src/layout/route-simplify";
import { viewOf } from "./support/nest-strategies";

const FAN = ["assign_concorde", "assign_first", "assign_business", "assign_coach"];
let layout: LayoutResult;
beforeAll(async () => {
  layout = await computeLayout(await viewOf("examples/rfc-1149-ipoac/.archer/diagrams/qos-queues.mmd"));
});
afterEach(() => {
  cleanup();
  localStorage.removeItem("archer.flow-animation");
});

function lit(): Emphasis {
  return parseEmphasis({
    id: "e",
    viewId: "qos-queues",
    title: "E",
    groups: [{ id: "g", palette: "teal", style: "flow", edges: FAN }],
  })!;
}

async function drawn(value: Emphasis): Promise<HTMLElement> {
  const { container } = render(<DiagramCanvas state={{ status: "ready", layout }} emphasis={value} />);
  await waitFor(() => expect(container.querySelectorAll(".archer-emph-chevrons").length).toBeGreaterThan(0));
  return container;
}

describe("the stretch of a line its own chevrons travel", () => {
  const stem = [
    { x: 0, y: 0 },
    { x: 0, y: 40 },
  ];
  it("is all of it when nothing else is drawn there", () => {
    const route = [...stem, { x: 100, y: 40 }, { x: 100, y: 100 }];
    expect(ownStretch(route, [])).toEqual({ from: 0, to: routeLength(route) });
  });
  it("leaves out the start another drawn line already covers", () => {
    const longer = [...stem, { x: 200, y: 40 }, { x: 200, y: 100 }];
    const route = [...stem, { x: 100, y: 40 }, { x: 100, y: 100 }];
    const own = ownStretch(route, [longer]);
    // Stem (40) and bus to the branch (100) are drawn by the longer line; the drop (60) is this line's own.
    expect(own.from).toBeGreaterThanOrEqual(138);
    expect(own.from).toBeLessThanOrEqual(142);
    expect(own.to).toBeCloseTo(200, 0);
  });
  it("is empty for a line wholly under another", () => {
    const own = ownStretch(stem, [[...stem, { x: 0, y: 80 }]]);
    expect(own.to - own.from).toBeLessThanOrEqual(2);
  });
});

describe("a lit fan-out's chevrons", () => {
  it("never sit on one another when still", async () => {
    localStorage.setItem("archer.flow-animation", "off");
    const container = await drawn(lit());
    const at = [...container.querySelectorAll(".archer-emph-chevron")].map((chevron) => {
      const [, x, y] = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(chevron.getAttribute("transform") ?? "")!.map(Number);
      return { x: x!, y: y!, edge: chevron.closest(".archer-emph-chevrons")!.getAttribute("data-edge") };
    });
    expect(at.length).toBeGreaterThanOrEqual(FAN.length);
    for (let i = 0; i < at.length; i += 1)
      for (let j = i + 1; j < at.length; j += 1) {
        const d = Math.hypot(at[i]!.x - at[j]!.x, at[i]!.y - at[j]!.y);
        expect(d, `${at[i]!.edge} and ${at[j]!.edge}`).toBeGreaterThanOrEqual(2 * CHEVRON_REACH);
      }
  });

  it("moving, travel the shared trunk once: the others start where they leave it", async () => {
    installReducedMotion(false);
    const container = await drawn(lit());
    // The lines on the trunk: those that turn (a straight drop keeps its own line and its own chevrons).
    const onTrunk = FAN.filter((id) => cornersOf(layout.edges.find((edge) => edge.id === id)!.points).length > 2);
    expect(onTrunk.length).toBeGreaterThanOrEqual(2);
    const starts = onTrunk.map((id) => {
      const motions = [...container.querySelectorAll(`.archer-emph-chevrons[data-edge="${id}"] animateMotion`)];
      return motions.map((m) => m.getAttribute("keyPoints"));
    });
    // One line keeps the whole route; every other starts part way along its own.
    expect(starts.filter((points) => points.every((p) => p === null))).toHaveLength(1);
    for (const points of starts.filter((list) => list.some((p) => p !== null)))
      for (const p of points) expect(Number(p!.split(";")[0])).toBeGreaterThan(0);
  });
});
