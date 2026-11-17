// @vitest-environment jsdom
//
// WCAG 2.2 SC 1.4.1 (ADR 0030, "Text equivalent" and "Group numbers"):
//
//   - the Highlights legend can list each group's members by name, collapsed
//     by default; a member is a button that takes the reader to it on the canvas;
//   - one reader setting, Group numbers (Auto / On / Off, kept per browser),
//     adds the group's number to the legend and the canvas. Auto is off unless
//     the system asks for more contrast or forces its colours.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import { SequenceCanvas } from "../src/diagrams/SequenceCanvas";
import { parseEmphasis, type Emphasis } from "../src/emphasis/contract";
import { setGroupNumbersPreference } from "../src/emphasis/group-numbers";
import { computeLayout, type LayoutResult } from "../src/layout/elk-adapter";
import { computeSequenceLayout } from "../src/layout/sequence-layout";
import { projectEnvelope } from "../src/diagrams/projection";
import { loadValidFixture } from "./fixtures";

let graph: LayoutResult;

beforeAll(async () => {
  const projection = projectEnvelope(loadValidFixture("minimal-data-flow.json"));
  if (!projection.ok || projection.type !== "graph")
    throw new Error("the data-flow fixture did not project to a graph view");
  graph = await computeLayout(projection.view);
});

/** A window whose system preferences say only what `asks` lists. */
function installSystem(asks: readonly string[] = []): void {
  window.matchMedia = ((query: string) => ({
    media: query,
    matches: asks.some((ask) => query.includes(ask)),
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  installSystem();
  window.localStorage.clear();
  act(() => setGroupNumbersPreference("auto"));
  window.localStorage.clear();
});
afterEach(cleanup);

function emphasis(viewId: string, ...groups: readonly Record<string, unknown>[]): Emphasis {
  const parsed = parseEmphasis({ id: "e", viewId, title: "", groups });
  expect(parsed, "the fixture is not a readable emphasis").toBeDefined();
  return parsed!;
}

const TWO = [
  { id: "pay", style: "highlight", label: "payment", nodes: ["web"], edges: ["request"] },
  { id: "mail", style: "highlight", label: "email", nodes: ["api"] },
] as const;

const drawGraph = (value: Emphasis) =>
  render(
    <DiagramCanvas
      state={{ status: "ready", layout: graph }}
      emphasis={value}
      onNodeClick={vi.fn()}
      onEdgeClick={vi.fn()}
    />,
  ).container;
const legend = (): HTMLElement => screen.getByRole("region", { name: "Highlights" });
const surface = (container: HTMLElement): HTMLElement => container.querySelector<HTMLElement>(".archer-emph-surface")!;

describe("the legend lists each group's members by name", () => {
  it("is collapsed by default, behind one button that says whether it is open", () => {
    drawGraph(emphasis("minimal-data-flow", ...TWO));
    const toggle = within(legend()).getByRole("button", { name: "Members" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const list = document.getElementById(toggle.getAttribute("aria-controls")!);
    expect(list, "aria-controls names an element that exists").not.toBeNull();
    expect(list!.hidden).toBe(true);
  });

  it("opens to each group's number, label and members, nodes then lines, by their names", () => {
    drawGraph(emphasis("minimal-data-flow", ...TWO));
    fireEvent.click(within(legend()).getByRole("button", { name: "Members" }));
    expect(within(legend()).getByRole("button", { name: "Members" }).getAttribute("aria-expanded")).toBe("true");
    const first = within(legend()).getByRole("list", { name: "Highlight 1: payment" });
    expect(
      within(first)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Web", "Web → API"]);
    const second = within(legend()).getByRole("list", { name: "Highlight 2: email" });
    expect(
      within(second)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["API"]);
    expect(within(legend()).getByRole("heading", { level: 3, name: "Highlight 1: payment" })).toBeDefined();
  });

  it("takes the reader to a member on the canvas: focus moves to it", () => {
    const container = drawGraph(emphasis("minimal-data-flow", ...TWO));
    fireEvent.click(within(legend()).getByRole("button", { name: "Members" }));
    fireEvent.click(
      within(within(legend()).getByRole("list", { name: "Highlight 2: email" })).getByRole("button", { name: "API" }),
    );
    const api = [...container.querySelectorAll<HTMLElement>(".react-flow__node")].find(
      (node) => node.dataset.id === "api",
    );
    expect(document.activeElement).toBe(api);
  });

  it("takes the reader to a participant on the sequence canvas", () => {
    const projection = projectEnvelope(loadValidFixture("minimal-sequence.json"));
    if (!projection.ok || projection.type !== "sequence") throw new Error("not a sequence");
    const { container } = render(
      <SequenceCanvas
        layout={computeSequenceLayout(projection.view)}
        emphasis={emphasis("login-flow", {
          id: "l",
          style: "highlight",
          label: "sign in",
          nodes: ["db"],
          edges: ["msg-1"],
        })}
        onNodeClick={vi.fn()}
        onEdgeClick={vi.fn()}
      />,
    );
    fireEvent.click(within(legend()).getByRole("button", { name: "Members" }));
    const members = within(within(legend()).getByRole("list", { name: "Highlight 1: sign in" })).getAllByRole("button");
    expect(members).toHaveLength(2);
    fireEvent.click(members[0]!);
    expect(document.activeElement?.getAttribute("data-seq-id")).toBe("db");
    expect(container.contains(document.activeElement)).toBe(true);
  });
});

describe("Group numbers: the one non-colour cue, by the reader's choice", () => {
  it("is off by default: no class on the surface, no number in the legend", () => {
    const container = drawGraph(emphasis("minimal-data-flow", ...TWO));
    const select = within(legend()).getByRole("combobox", { name: "Group numbers" }) as HTMLSelectElement;
    expect(select.value).toBe("auto");
    expect(surface(container).classList).not.toContain("archer-emph-numbered");
    expect(legend().querySelector(".archer-emph-legend-num")).toBeNull();
  });

  it("On numbers the groups, in the legend and on the surface, and is remembered", () => {
    const container = drawGraph(emphasis("minimal-data-flow", ...TWO));
    fireEvent.change(within(legend()).getByRole("combobox", { name: "Group numbers" }), { target: { value: "on" } });
    expect(surface(container).classList).toContain("archer-emph-numbered");
    expect([...legend().querySelectorAll(".archer-emph-legend-num")].map((number) => number.textContent)).toEqual([
      "1",
      "2",
    ]);
    expect(window.localStorage.getItem("archer.group-numbers")).toBe("on");
  });

  it.each([["prefers-contrast: more"], ["forced-colors: active"]])(
    "Auto numbers the groups when the system asks for %s",
    (ask) => {
      installSystem([ask]);
      const container = drawGraph(emphasis("minimal-data-flow", ...TWO));
      expect(surface(container).classList).toContain("archer-emph-numbered");
    },
  );

  it("Off wins over the system", () => {
    installSystem(["prefers-contrast: more"]);
    act(() => setGroupNumbersPreference("off"));
    const container = drawGraph(emphasis("minimal-data-flow", ...TWO));
    expect(surface(container).classList).not.toContain("archer-emph-numbered");
  });

  it("numbers a sequence's participants and messages with their group's number", () => {
    act(() => setGroupNumbersPreference("on"));
    const projection = projectEnvelope(loadValidFixture("minimal-sequence.json"));
    if (!projection.ok || projection.type !== "sequence") throw new Error("not a sequence");
    const { container } = render(
      <SequenceCanvas
        layout={computeSequenceLayout(projection.view)}
        emphasis={emphasis(
          "login-flow",
          { id: "a", style: "highlight", label: "one", nodes: ["client"] },
          { id: "b", style: "highlight", label: "two", nodes: ["db"], edges: ["msg-1"] },
        )}
        onNodeClick={vi.fn()}
        onEdgeClick={vi.fn()}
      />,
    );
    const markers = [...container.querySelectorAll(".archer-emph-marker")]
      .map((marker) => marker.getAttribute("data-slot"))
      .sort();
    expect(markers).toEqual(["1", "2", "2"]);
    for (const marker of container.querySelectorAll(".archer-emph-marker"))
      expect(marker.getAttribute("aria-hidden")).toBe("true");
  });

  it("draws no marker at all while numbers are off, so the quiet default is unchanged", () => {
    const projection = projectEnvelope(loadValidFixture("minimal-sequence.json"));
    if (!projection.ok || projection.type !== "sequence") throw new Error("not a sequence");
    const { container } = render(
      <SequenceCanvas
        layout={computeSequenceLayout(projection.view)}
        emphasis={emphasis("login-flow", {
          id: "b",
          style: "highlight",
          label: "two",
          nodes: ["db"],
          edges: ["msg-1"],
        })}
        onNodeClick={vi.fn()}
        onEdgeClick={vi.fn()}
      />,
    );
    expect(container.querySelector(".archer-emph-marker")).toBeNull();
  });
});

describe("a member with a blank label", () => {
  it("is named by its id, never an empty button", () => {
    const blank = {
      direction: "lr",
      nodes: [
        { id: "a", label: " ", shape: "rect", classes: [], x: 0, y: 0, width: 80, height: 40 },
        { id: "b", label: "Bank", shape: "rect", classes: [], x: 200, y: 0, width: 80, height: 40 },
      ],
      edges: [
        {
          id: "e1",
          source: "a",
          target: "b",
          points: [
            { x: 80, y: 20 },
            { x: 200, y: 20 },
          ],
        },
      ],
      groups: [],
    } as unknown as LayoutResult;
    render(
      <DiagramCanvas
        state={{ status: "ready", layout: blank }}
        emphasis={emphasis("v", { id: "g", style: "highlight", label: "g", nodes: ["a"], edges: ["e1"] })}
        onNodeClick={vi.fn()}
      />,
    );
    fireEvent.click(within(legend()).getByRole("button", { name: "Members" }));
    const buttons = within(within(legend()).getByRole("list", { name: "Highlight 1: g" })).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["a", "a → Bank"]);
  });
});
