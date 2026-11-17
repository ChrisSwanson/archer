// F. Emphasis beside family colours (ADR 0030, amended 2026-11-11; DESIGN.md, Diagram palette). Teal and
// violet families sit close to two of the agent's emphasis hues (and rust and red near its coral), so a diagram drawn in family colours numbers
// its emphasis groups by default -- on the canvas (the reader's Auto) and in exports -- and the reader's
// own On or Off still decides.
import { describe, expect, it } from "vitest";
import { usesFamilyColours } from "../src/diagrams/palette";
import { groupsNumbered } from "../src/emphasis/group-numbers";
import { paintExport } from "../src/export/painter";
import { loadModelEnvelope } from "./fixtures";

describe("group numbers beside family colours", () => {
  it("Auto numbers the groups when the drawing uses family colours, as it does when the system asks", () => {
    expect(groupsNumbered("auto", false, false)).toBe(false);
    expect(groupsNumbered("auto", true, false)).toBe(true);
    expect(groupsNumbered("auto", false, true)).toBe(true);
    // The reader's own choice wins either way.
    expect(groupsNumbered("off", true, true)).toBe(false);
    expect(groupsNumbered("on", false, false)).toBe(true);
  });

  it("knows a drawing in family colours from a neutral one", () => {
    const plain = { nodes: [{ classes: [] as string[], groupId: undefined }], groups: [] };
    expect(usesFamilyColours(plain)).toBe(false);
    expect(usesFamilyColours({ ...plain, nodes: [{ classes: ["person"], groupId: undefined }] })).toBe(true);
    // A plain group is neutral structure (owner, 2026-11-12); a classed one is a family panel.
    expect(usesFamilyColours({ ...plain, groups: [{ id: "g", parentId: undefined }] })).toBe(false);
    expect(
      usesFamilyColours({
        ...plain,
        groups: [{ id: "g", parentId: undefined, classes: ["gpu"] }],
        categories: [{ name: "gpu", fill: "#ecfdf5", stroke: "#0f766e" }],
      }),
    ).toBe(true);
  });

  it("numbers the groups in an export of a drawing in family colours, without being asked", async () => {
    const envelope = loadModelEnvelope("c4", "widened", "shop");
    const presentation = {
      emphases: [
        {
          id: "mark",
          viewId: "shop",
          groups: [
            {
              id: "pay",
              label: "Payment path",
              style: "highlight",
              palette: "teal",
              state: "existing",
              nodes: ["customer"],
              edges: [],
            },
          ],
        },
      ],
    };
    const painted = await paintExport({ envelope, mode: "presentation", presentation } as never);
    // The export's own marker (`emphasisMarkerSvg`), at the emphasised element.
    expect(painted.content).toContain('class="export-emph-marker"');
  });
});
