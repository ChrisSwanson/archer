// @vitest-environment jsdom
//
// WCAG 2.2 SC 1.4.1 (ADR 0030, "Text equivalent"): the group an element is in
// is not said by its colour alone. Every emphasised element on every canvas
// carries its group in its accessible name -- "Payment service, in highlight
// 1: payment" -- and an element in no group, or in a group the reader has
// turned off, says nothing extra.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import { SequenceCanvas } from "../src/diagrams/SequenceCanvas";
import { toXFlowEdges } from "../src/diagrams/xflow-adapter";
import { assignEmphasis, emphasisMembership, parseEmphasis, type Emphasis } from "../src/emphasis/contract";
import { computeLayout, type LayoutResult } from "../src/layout/elk-adapter";
import { computeSequenceLayout } from "../src/layout/sequence-layout";
import { projectEnvelope } from "../src/diagrams/projection";
import { loadValidFixture } from "./fixtures";
import { installReducedMotion } from "./match-media";

let graph: LayoutResult;

beforeAll(async () => {
  const projection = projectEnvelope(loadValidFixture("minimal-data-flow.json"));
  if (!projection.ok || projection.type !== "graph")
    throw new Error("the data-flow fixture did not project to a graph view");
  graph = await computeLayout(projection.view);
});

beforeEach(() => installReducedMotion(false));
afterEach(cleanup);

function emphasis(viewId: string, ...groups: readonly Record<string, unknown>[]): Emphasis {
  const parsed = parseEmphasis({ id: "e", viewId, title: "", groups });
  expect(parsed, "the fixture is not a readable emphasis").toBeDefined();
  return parsed!;
}

describe("the contract states membership as words", () => {
  it("numbers a group by its position and names it by its label", () => {
    const value = emphasis(
      "v",
      { id: "pay", style: "highlight", label: "payment", nodes: ["a"], edges: ["e1"] },
      { id: "mail", style: "flow", label: "email", nodes: ["b"] },
    );
    const assigned = assignEmphasis(value);
    expect(assigned.nodes.get("a")).toMatchObject({ slot: 1, label: "payment" });
    expect(assigned.edges.get("e1")).toMatchObject({ slot: 1, label: "payment" });
    expect(assigned.nodes.get("b")).toMatchObject({ slot: 2, label: "email" });
    expect(emphasisMembership(assigned.nodes.get("b"))).toBe(", in highlight 2: email");
    expect(emphasisMembership(undefined)).toBe("");
  });

  it("keeps a group's number when an earlier group is turned off", () => {
    const value = emphasis(
      "v",
      { id: "pay", style: "highlight", label: "payment", nodes: ["a"] },
      { id: "mail", style: "highlight", label: "email", nodes: ["b"] },
    );
    const second = assignEmphasis({ ...value, groups: value.groups.slice(1) });
    expect(second.nodes.get("b")).toMatchObject({ slot: 2, label: "email" });
  });
});

describe("the graph canvas names each emphasised element's group", () => {
  const draw = (value: Emphasis | null) =>
    render(
      <DiagramCanvas
        state={{ status: "ready", layout: graph }}
        emphasis={value}
        onNodeClick={vi.fn()}
        onEdgeClick={vi.fn()}
      />,
    ).container;
  const named = (container: HTMLElement, selector: string, id: string): string | null =>
    [...container.querySelectorAll<HTMLElement>(selector)]
      .find((element) => element.dataset.id === id)
      ?.getAttribute("aria-label") ?? null;

  it("adds the group to a node's and an edge's name, and nothing to anything else", () => {
    const container = draw(
      emphasis("minimal-data-flow", {
        id: "w",
        style: "highlight",
        label: "payment",
        nodes: ["web"],
        edges: ["request"],
      }),
    );
    const web = named(container, ".react-flow__node", "web");
    expect(web).toMatch(/, in highlight 1: payment$/);
    // jsdom measures nothing, so React Flow draws no edges here: the adapter's own name is what it would carry.
    const assigned = {
      assignments: assignEmphasis(
        emphasis("minimal-data-flow", { id: "w", style: "highlight", label: "payment", edges: ["request"] }),
      ),
      isolated: null,
    };
    expect(
      toXFlowEdges(graph, undefined, undefined, assigned).find((edge) => edge.id === "request")?.ariaLabel,
    ).toMatch(/, in highlight 1: payment$/);
    expect(named(container, ".react-flow__node", "api")).not.toMatch(/highlight/);
  });

  it("drops the words when the reader turns the group off", () => {
    const container = draw(
      emphasis("minimal-data-flow", { id: "w", style: "highlight", label: "payment", nodes: ["web"] }),
    );
    const legend = screen.getByRole("region", { name: "Highlights" });
    fireEvent.click(within(legend).getByRole("button", { name: /payment/ }));
    expect(named(container, ".react-flow__node", "web")).not.toMatch(/highlight/);
  });
});

describe("the sequence canvas names each emphasised participant's and message's group", () => {
  it("adds the group to the name of a participant and a message", () => {
    const projection = projectEnvelope(loadValidFixture("minimal-sequence.json"));
    if (!projection.ok || projection.type !== "sequence") throw new Error("not a sequence");
    const layout = computeSequenceLayout(projection.view);
    const { container } = render(
      <SequenceCanvas
        layout={layout}
        emphasis={emphasis("login-flow", {
          id: "l",
          style: "highlight",
          label: "sign in",
          nodes: ["server"],
          edges: ["msg-1"],
        })}
        onNodeClick={vi.fn()}
        onEdgeClick={vi.fn()}
      />,
    );
    const label = (channel: string, id: string) =>
      [...container.querySelectorAll(`g[data-seq-channel="${channel}"]`)]
        .find((element) => element.getAttribute("data-seq-id") === id)
        ?.getAttribute("aria-label");
    expect(label("participants", "server")).toMatch(/, in highlight 1: sign in$/);
    expect(label("messages", "msg-1")).toMatch(/, in highlight 1: sign in$/);
    expect(label("participants", "client")).not.toMatch(/highlight/);
  });
});
