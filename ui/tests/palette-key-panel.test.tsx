// @vitest-environment jsdom
// The Diagram Key panel's colour rows for the owner's home rig (DESIGN.md, "The Key"): one row per kind and
// category present (plain structure is neutral and has none: owner, 2026-11-12), each with its real sample, a Members disclosure, and the
// kind's notation glyph kept; the voices note (blue is yours, amber the agent's) stays.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DiagramKey } from "../src/diagrams/DiagramKey";
import { PersonGlyph } from "../src/diagrams/FigureGlyphs";
import { FAMILY_TOKENS } from "../src/diagrams/palette";
import { HOME_RIG, viewOf } from "./fixtures/palette/home-rig";

afterEach(cleanup);

async function homeRigKey(): Promise<HTMLElement> {
  const view = await viewOf(HOME_RIG);
  render(<DiagramKey model={{ type: "graph", view }} placement="sheet" />);
  return screen.getByRole("group", { name: "Colours" });
}
const rowsOf = (colours: HTMLElement): HTMLElement[] => [
  ...colours.querySelectorAll<HTMLElement>(".archer-key-palette-row"),
];
const rowNamed = (colours: HTMLElement, label: string): HTMLElement =>
  rowsOf(colours).find((row) => row.querySelector(".archer-key-palette-name")?.textContent === label)!;

describe("the Key's colour rows, on the page", () => {
  it("shows one row per coloured thing in the drawing, in order, each named", async () => {
    const colours = await homeRigKey();
    expect(rowsOf(colours).map((row) => row.querySelector(".archer-key-palette-name")?.textContent)).toEqual([
      "Person",
      "Walled-off sandbox",
      "Model server on a GPU",
    ]);
    expect(rowNamed(colours, "Walled-off sandbox").textContent).toMatch(/dashed outline/);
  });

  it("draws each sample in its members' tokens", async () => {
    const colours = await homeRigKey();
    const swatch = (label: string): HTMLElement => rowNamed(colours, label).querySelector(".archer-key-swatch")!;
    expect(swatch("Person").style.backgroundColor).toBe(FAMILY_TOKENS.violet.fill);
    expect(swatch("Person").style.borderColor).toBe(FAMILY_TOKENS.violet.border);
    expect(swatch("Person").dataset.sample).toBe("node");
    // Every gpu member is a panel or a light card in one: the sample is the panel.
    expect(swatch("Model server on a GPU").style.backgroundColor).toBe(FAMILY_TOKENS.teal.panel);
    expect(swatch("Model server on a GPU").style.borderColor).toBe(FAMILY_TOKENS.teal.border);
    expect(swatch("Model server on a GPU").dataset.sample).toBe("group");
    expect(swatch("Walled-off sandbox").style.backgroundColor).toBe(FAMILY_TOKENS.rust.fill);
    expect(swatch("Walled-off sandbox").style.borderStyle).toBe("dashed");
    expect(swatch("Model server on a GPU").style.borderStyle).toBe("solid");
    for (const el of colours.querySelectorAll(".archer-key-swatch"))
      expect(el.getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps the kind's glyph and the voices note, and does not say Person twice", async () => {
    const colours = await homeRigKey();
    const person = rowNamed(colours, "Person");
    const reference = render(<PersonGlyph size={24} />).container.querySelector("svg")!;
    expect(person.querySelector("svg")?.innerHTML).toBe(reference.innerHTML);
    expect(screen.getAllByText("Person")).toHaveLength(1);
    expect(person.textContent).toMatch(/The source marks this node as a person\./);
    expect(screen.getByText(/Blue marks your selection and comments\. Amber marks the agent's replies\./)).toBeTruthy();
  });

  it("names each row's members behind a Members disclosure", async () => {
    const colours = await homeRigKey();
    // A native disclosure, closed until asked.
    const disclosure = rowNamed(colours, "Model server on a GPU").querySelector("details")!;
    const summary = disclosure.querySelector("summary")!;
    expect(summary.textContent).toBe("Members of Model server on a GPU");
    expect(disclosure.open).toBe(false);
    fireEvent.click(summary);
    expect(disclosure.open).toBe(true);
    // Written only once open. jsdom opens <details> on a click but does not fire `toggle`, which a browser
    // does (palette-key.e2e.ts covers the real one): send it as the browser would.
    fireEvent(disclosure, new Event("toggle"));
    const members = await waitFor(() => disclosure.querySelector("ul")!);
    expect(
      within(members)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "GPU 1: RTX PRO 5000, 72 GB (group)",
      "GPU 2: RTX PRO 4000, 24 GB (group)",
      "Chat Model Server",
      "Farm Model Server",
      "Helper Model Server",
    ]);
  });
});
