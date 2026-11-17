// The owner's favourite reference, "the loop" (`fixtures/palette/ship-loop.mmd`), as an acceptance drawing for the
// diagram palette (DESIGN.md, "Diagram palette"; owner, 2026-11-12): "you decide" is an authored blue, drawn in violet
// because blue is the reader's; "the AI's work" is the slate neutral; "changes the real server" is the solid dark red
// with white words; "Dropped" is the quiet neutral, a step lighter and receding -- told apart from the AI's work.
import { describe, expect, it } from "vitest";
import { indexCategories, nodePalette } from "../src/diagrams/palette";
import { paletteKeyRows } from "../src/diagrams/palette-key";
import { toXFlowNodes } from "../src/diagrams/xflow-adapter";
import { paintNode } from "../src/export/svg";
import { computeLayout } from "../src/layout/elk-adapter";
import { SHIP_LOOP, viewOf } from "./fixtures/palette/home-rig";

describe("the owner's loop", () => {
  it("draws you decide violet, the AI's work slate, the real server solid red and Dropped quiet", async () => {
    const view = await viewOf(SHIP_LOOP);
    const categories = indexCategories(view.categories);
    const palette = (id: string) => nodePalette(view.nodes.find((node) => node.id === id)!, categories);
    expect(palette("ask")).toEqual({ family: "violet", category: "you" });
    expect(palette("plan")).toEqual({ category: "ai" });
    expect(palette("ship")).toEqual({ family: "red", category: "real" });
    expect(palette("dropped")).toEqual({ category: "gone", quiet: true });
  });

  it("keys four rows, each sampled in its members' paint, the two neutrals apart", async () => {
    const rows = paletteKeyRows(await viewOf(SHIP_LOOP));
    const by = (name: string) => rows.find((row) => row.name === name)!;
    expect(rows.map((row) => row.name)).toEqual(["you", "ai", "gone", "real"]);
    expect(by("ai").swatch).toMatchObject({ fill: "var(--node-bg)", border: "var(--node-border)" });
    expect(by("gone").swatch).toMatchObject({ fill: "var(--node-quiet-bg)", border: "var(--node-quiet-border)" });
    expect(by("real").swatch).toMatchObject({ fill: "var(--family-red-fill)" });
    expect(by("you").swatch).toMatchObject({ fill: "var(--family-violet-fill)" });
  });

  it("draws the same on the page and in the export", async () => {
    const layout = await computeLayout(await viewOf(SHIP_LOOP));
    const classes = new Map(toXFlowNodes(layout).map((n) => [n.id, n.className ?? ""]));
    expect(classes.get("ask")).toContain("archer-family-violet");
    expect(classes.get("ship")).toContain("archer-family-red");
    expect(classes.get("plan")).not.toMatch(/archer-family-|archer-neutral-quiet/);
    expect(classes.get("dropped")).toContain("archer-neutral-quiet");
    const painted = (id: string) => paintNode(layout.nodes.find((node) => node.id === id)!, layout);
    expect(painted("dropped")).toContain('fill="var(--node-quiet-bg)"');
    expect(painted("dropped")).toContain('stroke="var(--node-quiet-border)"');
    expect(painted("dropped")).toMatch(/<g fill="var\(--node-quiet-text\)" stroke="none">/);
    expect(painted("ship")).toMatch(/<g fill="var\(--family-red-text\)" stroke="none">/);
  });
});
