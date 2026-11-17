// Membership in the Key is also in each member's accessible name (DESIGN.md, "The Key"): a reader who
// cannot see the colour hears the row it belongs to, in the Key's own words.
import { describe, expect, it } from "vitest";
import { membershipOf, paletteKeyRows } from "../src/diagrams/palette-key";
import { toXFlowNodes } from "../src/diagrams/xflow-adapter";
import { computeLayout } from "../src/layout/elk-adapter";
import { HOME_RIG, viewOf } from "./fixtures/palette/home-rig";

describe("membership in accessible names", () => {
  it("phrases each member's row as the Key names it, where its name does not already say it", async () => {
    const view = await viewOf(HOME_RIG);
    const membership = membershipOf(paletteKeyRows(view), view);
    // Plain structure is in no row (owner, 2026-11-12): its name says its group, and nothing more.
    expect(membership.has("node:core")).toBe(false);
    expect(membership.get("node:farmModel")).toBe("Model server on a GPU");
    expect(membership.get("group:gpu1")).toBe("Model server on a GPU");
    expect(membership.get("node:staging")).toBe("Walled-off sandbox, dashed outline");
    expect(membership.has("node:vpn")).toBe(false);
    // A kind is the node's own word and glyph, kept out of its name (node-shapes.test.tsx).
    expect(membership.has("node:you")).toBe(false);
    // "…, in The Home Server" already says the group, for the group itself and what sits directly in it.
    expect(membership.has("group:server")).toBe(false);
    expect(membership.has("group:farm")).toBe(false);
    expect(membership.has("node:upkeep")).toBe(false);
  });

  it("is said in each canvas node's accessible name", async () => {
    const layout = await computeLayout(await viewOf(HOME_RIG));
    const names = new Map(toXFlowNodes(layout).map((node) => [node.id, node.ariaLabel ?? ""]));
    expect(names.get("farmModel")).toMatch(/, Model server on a GPU$/);
    expect(names.get("staging")).toMatch(/, Walled-off sandbox, dashed outline$/);
    expect(names.get("core")).not.toMatch(/ group$|category/);
    expect(names.get("vpn")).not.toMatch(/kind|group|category/);
  });
});
