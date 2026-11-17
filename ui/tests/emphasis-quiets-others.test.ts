// While a highlight is shown, what it does not name steps back (owner, 2026-11-12): a green highlight read badly over
// green Container boxes. Non-members -- nodes and group frames -- take the existing fade (shapes fade, words keep
// 4.5:1 in `--text-faded`); members keep their family colour and wear the emphasis. Canvas and export alike.
import { describe, expect, it } from "vitest";
import { assignEmphasis, type Emphasis } from "../src/emphasis/contract";
import { toXFlowEdges, toXFlowNodes, type EmphasisRender } from "../src/diagrams/xflow-adapter";
import { readStylesheet, rulesOf, declarationsOf } from "./stylesheet";
import { paintExport } from "../src/export/painter";
import type { LayoutResult } from "../src/layout/elk-layout";
import { loadModelEnvelope } from "./fixtures";

const layout: LayoutResult = {
  nodes: [
    {
      id: "web",
      x: 0,
      y: 0,
      width: 180,
      height: 60,
      label: "Web",
      shape: undefined,
      classes: ["container"],
      groupId: "shop",
    },
    {
      id: "api",
      x: 0,
      y: 100,
      width: 180,
      height: 60,
      label: "API",
      shape: undefined,
      classes: ["container"],
      groupId: "shop",
    },
    { id: "db", x: 0, y: 200, width: 180, height: 60, label: "DB", shape: undefined, classes: [], groupId: undefined },
  ],
  edges: [
    { id: "webApi", source: "web", target: "api", label: undefined, points: [], labelAnchor: undefined },
    { id: "apiDb", source: "api", target: "db", label: undefined, points: [], labelAnchor: undefined },
  ],
  groups: [{ id: "shop", label: "Shop", parentId: undefined, x: -20, y: -40, width: 220, height: 220 }],
  width: 400,
  height: 400,
};
const highlight = (nodes: string[]): Emphasis => ({
  id: "e",
  viewId: "v",
  title: "Payment path",
  groups: [
    {
      id: "g",
      style: "highlight",
      palette: "teal",
      state: "existing",
      speed: "normal",
      label: "Pay",
      description: "",
      nodes,
      edges: [],
    },
  ],
});
const shown = (nodes: string[]): EmphasisRender => ({ assignments: assignEmphasis(highlight(nodes)), isolated: null });
const classesOf = (render?: EmphasisRender) =>
  new Map(toXFlowNodes(layout, undefined, undefined, render).map((node) => [node.id, node.className ?? ""]));

describe("a highlight on the canvas", () => {
  it("quiets every node and group it does not name, and leaves its members in their colour", () => {
    const classes = classesOf(shown(["api"]));
    expect(classes.get("web")).toContain("archer-dimmed");
    expect(classes.get("db")).toContain("archer-dimmed");
    expect(classes.get("api")).not.toContain("archer-dimmed");
    // `shop` holds the member `api`, so it stays (next case).
    expect(classes.get("group:shop")).not.toContain("archer-emph-quiet");
  });

  it("keeps a frame that holds a member at full strength: it is the member's context", () => {
    expect(classesOf(shown(["db"])).get("group:shop")).toContain("archer-emph-quiet");
    expect(classesOf(shown(["web"])).get("group:shop")).not.toContain("archer-emph-quiet");
  });

  it("quiets nothing when no highlight is shown", () => {
    for (const [id, className] of classesOf()) expect(className, id).not.toMatch(/archer-dimmed|archer-emph-quiet/);
  });
});

describe("a highlight's connections on the canvas (owner, 2026-11-12: the fade was far too slight)", () => {
  const edgeClasses = (render?: EmphasisRender) =>
    new Map(toXFlowEdges(layout, undefined, undefined, render).map((edge) => [edge.id, edge.className ?? ""]));

  it("fades a connection that is not on the path", () => {
    const classes = edgeClasses(shown(["web", "api"]));
    expect(classes.get("apiDb")).toContain("archer-dimmed");
  });

  it("keeps a connection between two members, named or not", () => {
    expect(edgeClasses(shown(["web", "api"])).get("webApi")).not.toContain("archer-dimmed");
  });

  it("fades nothing when no highlight is shown", () => {
    for (const [id, className] of edgeClasses()) expect(className, id).not.toContain("archer-dimmed");
  });
});

describe("a quiet element's words", () => {
  // A clear step back, not a slight one: the faded ink is the quietest that keeps 4.5:1 on every ground (measured
  // over the faded box on the canvas, the plain panels and each family panel): light #5d6b7e (4.95:1 at worst),
  // dark #808b9b (4.64:1 at worst).
  const tokens = (selector: string) =>
    new Map(
      rulesOf(readStylesheet())
        .filter((rule) => rule.selectors.includes(selector))
        .flatMap((rule) => declarationsOf(rule.body)),
    );
  it("take the quietest ink that still reads at 4.5:1", () => {
    expect(tokens(':root[data-theme="light"]').get("--text-faded")).toBe("#5d6b7e");
    expect(tokens(":root").get("--text-faded")).toBe("#808b9b");
  });
});

describe("a highlight in the export", () => {
  it("fades what it does not name: their shapes, and their words to the faded ink", async () => {
    const envelope = loadModelEnvelope("c4", "widened", "shop");
    const presentation = { emphases: [{ ...highlight(["web"]), viewId: "shop" }] };
    const painted = await paintExport({ envelope, mode: "presentation", presentation } as never);
    expect(painted.content).toMatch(
      /\[data-element-channel="node"\]:not\(\[data-emphasis\]\):not\(\[data-emphasis-context\]\)>\.export-node-body>\*\{[^}]*fill-opacity:0\.25/,
    );
    expect(painted.content).toMatch(
      /\[data-element-channel="node"\]:not\(\[data-emphasis\]\):not\(\[data-emphasis-context\]\)>g\[fill\]\{fill:var\(--text-faded\)/,
    );
    // A line off the path fades too: its stroke and arrowheads at a quarter, its caption's words in the faded ink.
    expect(painted.content).toMatch(
      /\[data-element-channel="edge"\]:not\(\[data-emphasis\]\):not\(\[data-emphasis-context\]\)>\.export-edge-line\{stroke-opacity:0\.25/,
    );
    expect(painted.content).toMatch(
      /\[data-element-channel="edge"\]:not\(\[data-emphasis\]\):not\(\[data-emphasis-context\]\)>g\[font-style\]\{fill:var\(--text-faded\)/,
    );
    const plain = await paintExport({ envelope, mode: "diagram" } as never);
    expect(plain.content).not.toContain(":not([data-emphasis])");
    // `web` sits in the Web shop boundary, inside Shop Ltd: both are its context and stay; Operations steps back.
    const context = (id: string) =>
      new RegExp(`data-element-id="${id}" data-element-channel="node" data-emphasis-context="true"`).test(
        painted.content,
      );
    expect(context("shop")).toBe(true);
    expect(context("company")).toBe(true);
    expect(context("ops")).toBe(false);
  });
});
