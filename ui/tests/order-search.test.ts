// Written order, unless another start draws the diagram better on every measure (owner, 2026-11-15; `order-search.ts`).
import { describe, expect, it } from "vitest";
import { computeLayout } from "../src/layout/elk-adapter";
import { dominates, layoutQuality, seededOrder } from "../src/layout/order-search";
import { routeMetrics, viewOfSource } from "./route-metrics";

// The owner's Data Sources screenshot, reduced: two frames list their boxes in opposite orders.
const CROSSED = [
  "flowchart LR",
  "  subgraph sdk[Embeddable Rust SDK]",
  "    adapters[Provider Registry]",
  "    pricing[Pricing Library]",
  "    traces[Trace Library]",
  "  end",
  "  subgraph data[Data Sources]",
  "    localTraces[Local Trace Files]",
  "    rateCatalog[Versioned Rate Catalog]",
  "    upstream[Provider APIs And CLIs]",
  "  end",
  "  adapters fetch@-->|Reads provider data| upstream",
  "  pricing catalog@-->|Loads catalog| rateCatalog",
  "  traces trace@-->|Optionally reads| localTraces",
].join("\n");

// The same frames written in matching order: nothing to fix, so drawn exactly as written.
const MATCHED = CROSSED.replace(
  "    localTraces[Local Trace Files]\n    rateCatalog[Versioned Rate Catalog]\n    upstream[Provider APIs And CLIs]",
  "    upstream[Provider APIs And CLIs]\n    rateCatalog[Versioned Rate Catalog]\n    localTraces[Local Trace Files]",
);

describe("order search", () => {
  it("draws three one-to-one lines between frames straight, though the frames list them in opposite orders", async () => {
    const layout = await computeLayout(await viewOfSource(CROSSED, "order-search-crossed"));
    const metrics = routeMetrics(layout);
    expect(metrics.crossings).toBe(0);
    for (const id of ["fetch", "catalog", "trace"]) expect(metrics.edges.find((e) => e.id === id)!.bends, id).toBe(0);
  });

  it("gives the same diagram the same drawing every time", async () => {
    const view = await viewOfSource(CROSSED, "order-search-again");
    const a = await computeLayout(view);
    const b = await computeLayout({ ...view });
    expect(b.nodes.map((n) => [n.id, n.x, n.y])).toEqual(a.nodes.map((n) => [n.id, n.x, n.y]));
    expect(
      seededOrder(
        {
          elements: [
            { id: "a", kind: "node" },
            { id: "b", kind: "node" },
            { id: "c", kind: "node" },
          ],
          edges: ["x", "y"],
        },
        3,
      ),
    ).toEqual(
      seededOrder(
        {
          elements: [
            { id: "a", kind: "node" },
            { id: "b", kind: "node" },
            { id: "c", kind: "node" },
          ],
          edges: ["x", "y"],
        },
        3,
      ),
    );
  });

  it("keeps the written order when it has nothing to fix", async () => {
    const layout = await computeLayout(await viewOfSource(MATCHED, "order-search-matched"));
    const top = (id: string) => layout.nodes.find((n) => n.id === id)!.y;
    expect(top("upstream")).toBeLessThan(top("rateCatalog"));
    expect(top("rateCatalog")).toBeLessThan(top("localTraces"));
    expect(layoutQuality(layout).crossings).toBe(0);
  });

  it("only takes a drawing that is better on every measure", () => {
    const base = { corners: 10, crossings: 2, bentPairs: 1, collisions: 0, width: 1000, height: 500 };
    expect(dominates({ ...base, corners: 8 }, base)).toBe(true);
    expect(dominates({ ...base, corners: 8, crossings: 3 }, base)).toBe(false);
    expect(dominates({ ...base, corners: 8, collisions: 1 }, base)).toBe(false);
    expect(dominates({ ...base, corners: 8, width: 1100 }, base)).toBe(false);
    expect(dominates({ ...base }, base)).toBe(false);
  });
});
