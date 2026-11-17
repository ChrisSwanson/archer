// The Diagram Key's colour rows (DESIGN.md, "Diagram palette", "The Key"): one row per kind family and
// authored category present in the drawing (groups no longer colour themselves: owner, 2026-11-12), each with its real sample and its
// members. The owner's home rig is the reference drawing (`fixtures/palette/home-rig.mmd`).
import { describe, expect, it } from "vitest";
import { FAMILIES, FAMILY_TOKENS } from "../src/diagrams/palette";
import { paletteKeyRows } from "../src/diagrams/palette-key";
import { HOME_RIG, viewOf } from "./fixtures/palette/home-rig";

describe("the Key's colour rows", () => {
  it("lists each kind and category present, in a stable order, and nothing else: no row for plain structure", async () => {
    const rows = paletteKeyRows(await viewOf(HOME_RIG));
    expect(rows.map((row) => [row.type, row.name])).toEqual([
      ["kind", "Person"],
      ["category", "sandbox"],
      ["category", "gpu"],
    ]);
    const [person, sandbox, gpu] = rows;
    expect(person!.family).toBe("violet");
    expect(gpu!.family).toBe("teal");
    // The sandbox's orange stroke is rust (owner, 2026-11-12), and its dash is said.
    expect(sandbox!.family).toBe("rust");
    expect(sandbox!.dashed).toBe(true);
    expect(sandbox!.detail).toMatch(/dashed/i);
    expect(gpu!.dashed).toBe(false);
    for (const row of rows) expect(row.family === undefined || FAMILIES.includes(row.family)).toBe(true);
  });

  it("names each row's members: a category's panels and the cards that sit directly in them", async () => {
    const rows = paletteKeyRows(await viewOf(HOME_RIG));
    const members = (name: string): string[] =>
      rows.find((row) => row.name === name)!.members.map((m) => `${m.channel}:${m.label}`);
    expect(members("Person")).toEqual(["node:You"]);
    expect(members("gpu")).toEqual([
      "group:GPU 1: RTX PRO 5000, 72 GB",
      "group:GPU 2: RTX PRO 4000, 24 GB",
      "node:Chat Model Server",
      "node:Farm Model Server",
      "node:Helper Model Server",
    ]);
    expect(members("sandbox")).toEqual(["node:Staging VM, Walled Off"]);
  });

  it("samples from the tokens its members are drawn in: a node's fill and border, a group's panel", async () => {
    const rows = paletteKeyRows(await viewOf(HOME_RIG));
    const by = (name: string) => rows.find((row) => row.name === name)!;
    expect(by("Person").swatch).toEqual({
      sample: "node",
      fill: FAMILY_TOKENS.violet.fill,
      border: FAMILY_TOKENS.violet.border,
      dashed: false,
    });
    // Every gpu member is a panel or a card inside one, so the sample is the panel they are seen in.
    expect(by("gpu").swatch).toEqual({
      sample: "group",
      fill: FAMILY_TOKENS.teal.panel,
      border: FAMILY_TOKENS.teal.border,
      dashed: false,
    });
    expect(by("sandbox").swatch).toEqual({
      sample: "node",
      fill: FAMILY_TOKENS.rust.fill,
      border: FAMILY_TOKENS.rust.border,
      dashed: true,
    });
  });

  it("keys a closed box of the nested view by its group's own colour, and plain structure not at all", async () => {
    const view = await viewOf(HOME_RIG);
    // The Kubernetes cluster closed: its frame and insides are one box inside the home server.
    const nested = {
      ...view,
      groups: view.groups.filter((g) => !["k8s", "gpu1", "gpu2"].includes(g.id)),
      nodes: [
        ...view.nodes.filter((n) => n.groupId !== "k8s" && n.groupId !== "gpu1" && n.groupId !== "gpu2"),
        {
          id: "k8s",
          label: "Kubernetes Cluster, Single Node",
          shape: undefined,
          classes: [],
          groupId: "server",
          folded: { groupId: "k8s", element: false },
        },
      ],
    };
    const rows = paletteKeyRows(nested);
    expect(rows.map((row) => row.name)).toEqual(["Person", "sandbox"]);
    // A closed gpu panel keeps its category, so it stays in that row.
    const gpuClosed = paletteKeyRows({
      ...view,
      groups: view.groups.filter((g) => g.id !== "gpu1"),
      nodes: [
        ...view.nodes.filter((n) => n.groupId !== "gpu1"),
        { id: "gpu1", label: "GPU 1", classes: ["gpu"], groupId: "server", folded: { groupId: "gpu1" } },
      ],
    });
    expect(gpuClosed.find((row) => row.name === "gpu")!.members.map((m) => m.label)).toContain("GPU 1");
    // A plain box closed at the top level has no colour, so no row.
    const top = paletteKeyRows({
      nodes: [{ id: "box", label: "Box", classes: [], groupId: undefined, folded: { groupId: "box" } }],
      groups: [],
    });
    expect(top).toEqual([]);
  });

  it("lists nothing for a drawing without colour", async () => {
    expect(paletteKeyRows(await viewOf("flowchart LR\n  a[A]\n  b[B]\n  a a_b@--> b\n"))).toEqual([]);
  });

  it("orders rows by where each is first worn in the source, never by family or name; a plain subgraph has no row", async () => {
    const rows = paletteKeyRows(
      await viewOf(`flowchart LR
  db[(Orders)]:::database
  p[Pat]:::person
  s[Shop]:::system
  subgraph zed["Zed"]
    a[A]
  end
  subgraph alpha["Alpha"]
    b[B]
  end
  c[C]:::zeta
  d[D]:::alpha
  classDef zeta fill:#e8f7ea,stroke:#4a8256
  classDef alpha fill:#ffecf6,stroke:#985d7f
`),
    );
    expect(rows.map((row) => row.name)).toEqual(["Database", "Person", "System", "zeta", "alpha"]);
  });
});
