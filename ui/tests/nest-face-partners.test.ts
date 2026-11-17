// An opened frame faces what its boxes connect to (owner, 2026-11-15).
//
// The nested view grows an opened box in place: its inside is laid out on its own, and the rest of the drawing keeps
// its place (ADR 0029). Laid out on its own, the inside kept the written order, which can be the reverse of what its
// boxes connect to next door: the owner's Data Sources frame crossed and bent three lines a reader could see should
// run straight. So the inside's boxes are ordered by where their outside partners are drawn (`facePartners`), and the
// frame's placement prefers the split that brings its boxes level with those partners.
import ELK from "elkjs/lib/elk.bundled.js";
import { describe, expect, it } from "vitest";
import { NestEngine } from "../src/nesting/nest-engine";
import { facePartners } from "../src/nesting/grow-in-place-v2";
import { nestView } from "../src/nesting/nest-view";
import { computeLayout } from "../src/layout/elk-adapter";
import { writtenOrder } from "../src/diagrams/source-order";
import { DEFAULT_TYPEFACE } from "../src/layout/text-measure";
import { routeMetrics, viewOfSource } from "./route-metrics";

// The owner's screenshot, reduced: the frames list their boxes in opposite orders.
const SOURCE = [
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

async function openInTurn(order: readonly string[]) {
  const full = await viewOfSource(SOURCE, "face-partners");
  const nest = new NestEngine({ kernel: new ELK() });
  const key = nest.open({ full, typeface: DEFAULT_TYPEFACE, revision: "test" });
  await nest.layout(key, []).complete;
  let open: string[] = [];
  let layout;
  for (const id of order) {
    const from = open;
    open = [...open, id];
    layout = await nest.layout(key, open, { from, toggled: id }).complete;
  }
  return layout!;
}

describe("an opened frame faces its partners", () => {
  for (const order of [
    ["sdk", "data"],
    ["data", "sdk"],
  ]) {
    it(`draws the three one-to-one lines straight, opened ${order.join(" then ")}`, async () => {
      const layout = await openInTurn(order);
      const metrics = routeMetrics(layout);
      expect(metrics.crossings).toBe(0);
      for (const id of ["fetch", "catalog", "trace"]) expect(metrics.edges.find((e) => e.id === id)!.bends, id).toBe(0);
    });
  }

  it("orders only the boxes the outside pulls on, and keeps the written order when it already faces them", async () => {
    const full = await viewOfSource(SOURCE, "face-partners");
    const after = nestView(full, ["sdk", "data"]).view;
    const drawn = await computeLayout(after);
    const childIds = new Set(["localTraces", "rateCatalog", "upstream"]);
    const inside = { ...after, nodes: after.nodes.filter((n) => childIds.has(n.id)), edges: [], groups: [] };
    // Provider Registry is drawn above Trace Library: the box that reads from it comes first.
    const y = (id: string) => drawn.nodes.find((n) => n.id === id)!.y;
    const faced = facePartners(inside, after, childIds, drawn, "lr");
    const order = writtenOrder(faced)
      .elements.filter((e) => childIds.has(e.id))
      .map((e) => e.id);
    const expected = ["upstream", "rateCatalog", "localTraces"].sort(
      (a, b) =>
        y({ upstream: "adapters", rateCatalog: "pricing", localTraces: "traces" }[a]!) -
        y({ upstream: "adapters", rateCatalog: "pricing", localTraces: "traces" }[b]!),
    );
    expect(order).toEqual(expected);
    // Asked again with the faced order, nothing changes.
    expect(facePartners(faced, after, childIds, drawn, "lr")).toBe(faced);
  });
});
