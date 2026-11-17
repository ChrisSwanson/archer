// @vitest-environment jsdom
// One word for emphasis on the page (G17): "Highlights", and never a raw id.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { DataflowChips } from "../src/app/DataflowChips";
import { parseEmphasis, type Emphasis } from "../src/emphasis/contract";

afterEach(cleanup);
const make = (raw: Record<string, unknown>): Emphasis => parseEmphasis({ viewId: "v", ...raw })!;

it("names the row Highlights and each chip by its title, its first group, never its id", () => {
  const titled = make({
    id: "checkout-path",
    title: "Checkout path",
    groups: [{ id: "a", style: "highlight", label: "Card", nodes: ["web"] }],
  });
  const untitled = make({
    id: "e-7f3a",
    groups: [{ id: "b", style: "highlight", label: "Background work", nodes: ["api"] }],
  });
  render(<DataflowChips emphases={[titled, untitled]} activeId={null} onSelect={() => undefined} />);
  const row = screen.getByRole("group", { name: "Highlights" });
  expect(row.textContent).toContain("Highlights");
  expect(row.textContent).not.toMatch(/Dataflows|e-7f3a/);
  expect(screen.getByRole("button", { name: "Checkout path" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Background work" })).toBeDefined();
});
