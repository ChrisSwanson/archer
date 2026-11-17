// Three panel roles, told apart on the page and in the export (redesign slice 5, after the home rig): the OUTER boundary
// (clear, a 2px dark outline, its caption top right in the darkest caption ink), a STRUCTURAL panel inside it (pale
// slate, a quieter 1.5px outline, its caption top left in a quieter slate) and a FAMILY panel (tinted, a 1.5px outline
// in the family's border and caption in its ink). Panels round at 16px; cards at 12px, inside them.
import { describe, expect, it } from "vitest";
import { paintGraph } from "../src/export/svg";
import type { LayoutResult } from "../src/layout/elk-layout";
import { contrastRatio, parseColour } from "./contrast";
import { declarationsOf, readStylesheet, rulesOf, tokensOf } from "./stylesheet";

const CSS = readStylesheet();
const declared = (selector: string): Map<string, string> =>
  new Map(
    rulesOf(CSS)
      .filter((rule) => rule.selectors.includes(selector))
      .flatMap((rule) => declarationsOf(rule.body)),
  );

function block(selector: string): Map<string, string> {
  const start = CSS.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = CSS.slice(CSS.indexOf("{", start) + 1, CSS.indexOf("}", start)).replace(/\/\*[\s\S]*?\*\//g, "");
  const tokens = new Map<string, string>();
  for (const declaration of body.split(";")) {
    const match = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/s.exec(declaration);
    if (match !== null) tokens.set(match[1]!, match[2]!);
  }
  return tokens;
}
const THEMES = {
  light: block(':root[data-theme="light"]'),
  dark: block(':root,\n:root[data-theme="dark"]'),
} as const;

describe("on the page", () => {
  it("rounds a card at 12px and a panel at 16px", () => {
    // Through the diagram's corner roles (slice 8): --radius-node 12px, --radius-panel 16px.
    expect(declared(".archer-node").get("border-radius")).toBe("var(--radius-node)");
    expect(declared(".archer-node.archer-shape-rectangle").get("border-radius")).toBe("var(--radius-node)");
    expect(declared(".react-flow__node.archer-group:not(.archer-element-group)").get("border-radius")).toBe(
      "var(--radius-panel)",
    );
    const root = tokensOf(CSS, ":root");
    expect([root.get("--radius-node"), root.get("--radius-panel")]).toEqual(["12px", "16px"]);
  });

  it("draws the outer boundary 2px, and a structural or family panel inside it 1.5px", () => {
    expect(declared(".react-flow__node.archer-group:not(.archer-element-group)").get("border")).toBe(
      "var(--line-boundary) solid var(--group-border)",
    );
    expect(declared(".react-flow__node.archer-group.archer-group-nested").get("border-width")).toBe(
      "var(--line-panel)",
    );
    for (const family of ["violet", "teal", "green", "plum", "rust", "red"])
      expect(declared(`.react-flow__node.archer-group.archer-family-${family}`).get("border-width"), family).toBe(
        "var(--line-panel)",
      );
  });

  it("captions a structural panel in a quieter slate that still reads at 4.5:1 on its step, in both themes", () => {
    expect(declared(".archer-group.archer-group-nested").get("--group-caption")).toBe("var(--group-caption-alt)");
    for (const [theme, tokens] of Object.entries(THEMES)) {
      const ink = parseColour(tokens.get("--group-caption-alt")!).rgb;
      const outer = parseColour(tokens.get("--group-caption")!).rgb;
      const panel = parseColour(tokens.get("--group-bg-alt")!).rgb;
      expect(contrastRatio(ink, panel), theme).toBeGreaterThanOrEqual(4.5);
      // Quieter than the outer boundary's caption on the same ground.
      expect(contrastRatio(ink, panel), theme).toBeLessThan(contrastRatio(outer, panel));
    }
  });
});

describe("in the export", () => {
  const layout: LayoutResult = {
    nodes: [
      { id: "a", label: "A", x: 60, y: 120, width: 180, height: 60, shape: "rectangle", classes: [], groupId: "inner" },
      { id: "b", label: "B", x: 300, y: 120, width: 180, height: 60, shape: "rectangle", classes: [], groupId: "gpu" },
    ],
    edges: [],
    groups: [
      { id: "outer", label: "Server", parentId: undefined, x: 0, y: 0, width: 600, height: 300 },
      { id: "inner", label: "Farm", parentId: "outer", x: 20, y: 60, width: 250, height: 200 },
      { id: "gpu", label: "GPU", parentId: "outer", x: 280, y: 60, width: 250, height: 200, classes: ["gpu"] },
    ],
    categories: [{ name: "gpu", fill: "#ecfdf5", stroke: "#0f766e" }],
    width: 600,
    height: 300,
  };
  const svg = paintGraph(layout).content;
  const panel = (id: string): string => new RegExp(`data-element-id="${id}"[^>]*><rect [^>]*>`).exec(svg)![0];

  it("draws the three roles as the page does", () => {
    expect(panel("outer")).toMatch(/rx="16"/);
    expect(panel("outer")).toMatch(/stroke-width="2"/);
    expect(panel("inner")).toMatch(/stroke-width="1.5"/);
    expect(panel("inner")).toMatch(/stroke="var\(--group-border-alt\)"/);
    expect(panel("gpu")).toMatch(/stroke-width="1.5"/);
    expect(svg).toMatch(/<g fill="var\(--group-caption-alt\)" stroke="none"><text[^>]*>Farm</);
  });

  it("rounds a card at 12px", () => {
    expect(svg).toMatch(/data-element-id="a"[\s\S]*?<rect x="0" y="0" width="180" height="60" rx="12" ry="12"/);
  });
});
