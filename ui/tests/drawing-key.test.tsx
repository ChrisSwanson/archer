// @vitest-environment jsdom
// The drawing's own legend (DESIGN.md, "The Key"; owner, 2026-11-12): a compact key in the drawing, one row per
// colour the drawing uses, its real sample and a short human label -- the author's meaning
// (`%% archer-key <class>: <meaning>`), else the class name as written; a kind keeps its word. The canvas and the
// export draws it beside the drawing (the canvas's in-drawing legend was removed, owner 2026-11-12: the sidebar
// Diagram Key says the same).
import { cleanup } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { DrawingKeyRows, drawingKeyLayout } from "../src/diagrams/drawing-key";
import { membershipOf, paletteKeyRows } from "../src/diagrams/palette-key";
import { paletteKeySvg } from "../src/export/palette-key-svg";
import { computeLayout } from "../src/layout/elk-adapter";
import { HOME_RIG, SHIP_LOOP, viewOf } from "./fixtures/palette/home-rig";

afterEach(cleanup);

describe("a category's label", () => {
  it("is the author's meaning, and the row keeps the class name", async () => {
    const rows = paletteKeyRows(await viewOf(HOME_RIG));
    expect(rows.map((row) => [row.name, row.label])).toEqual([
      ["Person", "Person"],
      ["sandbox", "Walled-off sandbox"],
      ["gpu", "Model server on a GPU"],
    ]);
    // The detail still says which class it is, in words (review, 2026-11-12: not a bare "Category gpu").
    expect(rows.find((row) => row.name === "gpu")!.detail).toBe("Marked gpu in the source");
    expect(rows.find((row) => row.name === "sandbox")!.detail).toBe("Marked sandbox in the source, dashed outline");
  });

  it("is the owner's loop in its own words", async () => {
    const rows = paletteKeyRows(await viewOf(SHIP_LOOP));
    // In the order each is first worn in the source (owner, 2026-11-12): "You decide" first, as in the reference.
    expect(rows.map((row) => row.label)).toEqual(["You decide", "The AI's work", "Dropped", "Changes the real server"]);
  });

  it("is the class name exactly as written when the author says nothing", async () => {
    const source =
      "flowchart LR\n  a[A]:::GPU_box\n  b[B]\n  a e1@--> b\n  classDef GPU_box fill:#ecfdf5,stroke:#0f766e\n";
    const view = await viewOf(source);
    const rows = paletteKeyRows(view);
    expect([rows[0]!.label, rows[0]!.detail]).toEqual(["GPU_box", "Marked in the source"]);
    // A bare class name is said as a category in its members' names.
    expect(membershipOf(rows, view).get("node:a")).toBe("GPU_box category");
  });

  it("is what each member's accessible name says", async () => {
    const view = await viewOf(HOME_RIG);
    const membership = membershipOf(paletteKeyRows(view), view);
    expect(membership.get("node:farmModel")).toBe("Model server on a GPU");
    expect(membership.get("node:staging")).toBe("Walled-off sandbox, dashed outline");
  });
});

describe("the drawing's legend", () => {
  it("lays out one row per colour, each a sample beside its label, sized from the labels", async () => {
    const rows = paletteKeyRows(await viewOf(HOME_RIG));
    const laid = drawingKeyLayout(rows);
    expect(laid.rows.map((row) => row.lines)).toEqual([["Person"], ["Walled-off sandbox"], ["Model server on a GPU"]]);
    expect(laid.rows.map((row) => row.y)).toEqual([...laid.rows.map((row) => row.y)].sort((a, b) => a - b));
    expect(laid.width).toBeGreaterThan(laid.rows[1]!.textX);
    expect(laid.width).toBeLessThan(260);
    expect(laid.height).toBeGreaterThan(3 * 16);
  });

  it("draws nothing for a drawing without colour", async () => {
    const layout = await computeLayout(await viewOf("flowchart LR\n  a[A]\n  b[B]\n  a e1@--> b\n"));
    expect(paletteKeySvg(layout, 0, 0)).toBeUndefined();
  });

  it("draws each sample at its members' line role: a panel's 1.5px, a node's 1.5px (as the sidebar Key does)", async () => {
    const rows = paletteKeyRows(await viewOf(HOME_RIG));
    const probe = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    probe.innerHTML = renderToStaticMarkup(<DrawingKeyRows rows={rows} />);
    const width = (row: string) => probe.querySelector(`[data-key-row="${row}"] rect`)!.getAttribute("stroke-width");
    expect(width("category:gpu")).toBe("1.5");
    expect(width("category:sandbox")).toBe("1.5");
  });

  it("is what the export draws: each row's sample in its members' paint, dashed where they are", async () => {
    const layout = await computeLayout(await viewOf(SHIP_LOOP));
    const rows = paletteKeyRows(layout);
    const markup = renderToStaticMarkup(<DrawingKeyRows rows={rows} />);
    const exported = paletteKeySvg(layout, 0, 0)!.svg;
    expect(exported).toBe(`<g data-export-palette-key="true" transform="translate(0 0)">${markup}</g>`);
    const probe = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    probe.innerHTML = markup;
    expect([...probe.querySelectorAll("[data-key-row]")].map((row) => row.getAttribute("data-key-row"))).toEqual([
      "category:you",
      "category:ai",
      "category:gone",
      "category:real",
    ]);
    expect(probe.querySelector('[data-key-row="category:real"] rect')!.getAttribute("fill")).toBe(
      "var(--family-red-fill)",
    );
  });
});
