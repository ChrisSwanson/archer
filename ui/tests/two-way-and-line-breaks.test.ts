// Two-way arrows and label line breaks, from the envelope to the export and
// thumbnail painter: a `bidirectional` edge or message has an arrowhead at
// each end, and a label's `\n` starts a new drawn line wherever it is laid out.
import { describe, expect, it } from "vitest";
import { projectEnvelope } from "../src/diagrams/projection";
import { arrowsOf } from "../src/diagrams/figures";
import { wrap } from "../src/layout/graph-metrics";
import { wrapText } from "../src/layout/text-measure";
import { paintExport } from "../src/export/painter";
import { toXFlowEdges } from "../src/diagrams/xflow-adapter";
import type { LayoutResult } from "../src/layout/elk-adapter";

const REVISION = `sha256:${"0".repeat(63)}1`;
const flowchart = (edge: Record<string, unknown>, label = "Client") => ({
  schemaVersion: 2,
  view: { id: "flow", kind: "freeform", title: "Flow" },
  revision: REVISION,
  model: {
    type: "freeform-graph",
    direction: "lr",
    nodes: [
      { id: "a", label, shape: "rectangle" },
      { id: "b", label: "API", shape: "rectangle" },
    ],
    edges: [{ id: "e1", source: "a", target: "b", ...edge }],
    groups: [],
  },
});
const sequence = (message: Record<string, unknown>) => ({
  schemaVersion: 2,
  view: { id: "seq", kind: "sequence", title: "Seq" },
  revision: REVISION,
  model: {
    type: "sequence-trace",
    participants: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
    events: [{ type: "message", id: "msg-0", from: "a", to: "b", kind: "sync", label: "hi", ...message }],
  },
});

describe("two-way arrows", () => {
  it("projects a flowchart edge's bidirectional and draws an arrowhead at each end", async () => {
    const projected = projectEnvelope(flowchart({ bidirectional: true }));
    expect(projected.ok).toBe(true);
    if (!projected.ok || projected.type !== "graph") return;
    expect(projected.view.edges[0]?.bidirectional).toBe(true);
    expect(arrowsOf(projected.view.edges[0]?.figure, projected.view.edges[0]?.bidirectional)).toEqual({
      start: true,
      end: true,
    });
    const painted = await paintExport({ envelope: flowchart({ bidirectional: true }), mode: "diagram" } as never);
    expect(painted.content).toContain('marker-start="url(#export-edge-0-start)"');
    expect(painted.content).toContain('marker-end="url(#export-edge-0-end)"');
  });

  it("gives the live canvas edge a start marker too", () => {
    const node = (id: string, y: number) => ({
      id,
      x: 0,
      y,
      width: 180,
      height: 60,
      label: id,
      shape: undefined,
      classes: [],
      groupId: undefined,
    });
    const layout = (bidirectional: boolean): LayoutResult => ({
      nodes: [node("a", 0), node("b", 100)],
      edges: [
        {
          id: "e1",
          source: "a",
          target: "b",
          label: undefined,
          points: [],
          labelAnchor: undefined,
          ...(bidirectional ? { bidirectional } : {}),
        },
      ],
      groups: [],
      width: 180,
      height: 160,
    });
    expect(toXFlowEdges(layout(true))[0]).toHaveProperty("markerStart");
    expect(toXFlowEdges(layout(false))[0]).not.toHaveProperty("markerStart");
  });

  it("draws a one-way edge with its one arrowhead", async () => {
    const painted = await paintExport({ envelope: flowchart({}), mode: "diagram" } as never);
    expect(painted.content).not.toContain("marker-start");
    expect(painted.content).toContain("marker-end");
  });

  it("draws a two-way message with an arrowhead at each end", async () => {
    const heads = (content: string) => content.match(/data-export-arrow="true"/g)?.length ?? 0;
    expect(
      heads((await paintExport({ envelope: sequence({ bidirectional: true }), mode: "diagram" } as never)).content),
    ).toBe(2);
    expect(heads((await paintExport({ envelope: sequence({}), mode: "diagram" } as never)).content)).toBe(1);
  });
});

describe("label line breaks", () => {
  it("start a new line in both wrappers, and short lines are not joined", () => {
    expect(wrap("Web app\nEU", 400, 14, true, "fira")).toEqual(["Web app", "EU"]);
    expect(wrapText("one\ntwo", 400, 12, 4)).toEqual(["one", "two"]);
    expect(wrapText("a\nb\nc", 400, 12, 2)).toHaveLength(2);
  });

  it("are drawn as separate rows by the painter", async () => {
    const painted = await paintExport({
      envelope: flowchart({ label: "reads\nwrites" }, "Web\nEU"),
      mode: "diagram",
    } as never);
    // A node's break starts its description (DESIGN.md, Diagram palette: Node text, owner 2026-11-11): the
    // title's row and the description's are separate rows, in their own weights.
    expect(painted.content).toMatch(/font-weight="700"><tspan[^>]*>Web<\/tspan><\/text>/);
    expect(painted.content).toMatch(/font-weight="400"><tspan[^>]*>EU<\/tspan><\/text>/);
    expect(painted.content).toMatch(/<tspan[^>]*>reads<\/tspan><tspan[^>]*>writes<\/tspan>/);
  });
});
