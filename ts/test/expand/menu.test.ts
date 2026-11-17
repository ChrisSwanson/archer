// GET api/expand-menu's answer (ADR 0036 §11–§13, A5, A9, A13, O3, O6, O7, O11), built from views
// compiled by the production compiler.
import { describe, expect, test } from "vitest";
import { mergeProjectModel, type ModelInputView } from "../../src/project-model/merge.ts";
import { expandMenu, type ExpandMenu, type ExpandSources } from "../../src/expand/menu.ts";
import {
  decodeExpansions,
  encodeExpansions,
  EXPLORATION_LIMITS,
  framePartOf,
  framePartId,
  frameIdOf,
  frameSourceOf,
  shareableExpansions,
  withExpandParam,
  type Expansion,
} from "../../../shared/explorations.mts";
import { checkAgainst } from "../mermaid/support/schema.ts";
import { view } from "../project-model/support.ts";

function sources(views: readonly ModelInputView[]): ExpandSources {
  const model = mergeProjectModel(views);
  return {
    model,
    generation: 7,
    envelope: (id) => views.find((v) => v.id === id)?.envelope ?? null,
    title: (id) => views.find((v) => v.id === id)?.title ?? id,
  };
}

function menu(
  s: ExpandSources,
  base: string,
  element: string,
  expand: readonly Expansion[] = [],
  limits = EXPLORATION_LIMITS,
): ExpandMenu {
  const answer = expandMenu(s, base, element, expand, limits);
  if ("status" in answer) throw new Error(answer.message);
  return answer;
}

const CONTEXT = `C4Context
Person(user, "Shopper")
System(shop, "Shop")
System_Ext(pay, "Payments")
Rel(user, shop, "buys from")
Rel(shop, pay, "charges")
`;

const CONTAINERS = `C4Container
Person(user, "Shopper")
System_Boundary(shop, "Shop") {
  Container(web, "Web", "React")
  Container(api, "API", "Node")
  ContainerDb(db, "Orders DB", "Postgres")
}
System_Ext(mail, "Mail")
Rel(user, web, "uses")
Rel(web, api, "calls")
Rel(api, db, "reads")
Rel(api, mail, "sends")
`;

const DEPLOY = `flowchart LR
  api[API]:::container
  queue[Jobs]:::container
  worker[Worker]:::container
  api e1@--> queue
  queue e2@--> worker
`;

const CHECKOUT = `sequenceDiagram
participant user as Shopper
participant shop as Shop
user->>shop: pays
`;

async function shopProject() {
  return [
    await view("context", CONTEXT, { title: "Context" }),
    await view("containers", CONTAINERS, { title: "Containers" }),
    await view("deploy", DEPLOY, { title: "Deploy" }),
    await view("checkout", CHECKOUT, { title: "Checkout" }),
  ];
}

describe("the diagrams that open or draw the element (§11)", () => {
  test("a source that opens the element offers its inside; the piece is a valid model in its own notation (O3)", async () => {
    const answer = menu(sources(await shopProject()), "context", "shop");
    expect(answer.element).toMatchObject({ id: "shop", name: "Shop", conflicting: false });
    const opens = answer.diagrams.items.find((d) => d.source === "containers")!;
    expect(opens).toMatchObject({
      relation: "opens",
      title: "Containers",
      family: "c4",
      onCanvas: false,
      adds: { boxes: 3, wires: 3 },
    });
    expect(opens.piece).toMatchObject({
      source: "containers",
      family: "c4",
      touches: "shop",
      opens: true,
      boxes: 3,
      truncated: false,
    });
    const model = opens.piece!.model as {
      elements: { id: string; boundaryId: unknown }[];
      boundaries: unknown[];
      relationships: { source: string; target: string }[];
    };
    expect(model.elements.map((e) => e.id)).toEqual(["web", "api", "db"]);
    expect(model.boundaries).toEqual([]);
    expect(model.elements.every((e) => e.boundaryId === null)).toBe(true);
    // Inside wires are the model's; the wire to a box already drawn (user, on the base) attaches to it (O6).
    expect(model.relationships.map((r) => [r.source, r.target])).toEqual([
      ["web", "api"],
      ["api", "db"],
    ]);
    expect(opens.piece!.attach.map((a) => [a.from, a.to])).toEqual([["user", "web"]]);
    expect(checkAgainst("DiagramModel", opens.piece!.model)).toEqual([]);
  });

  test("a source that draws it as a box offers its neighbours there, wired back to it; a sequence is offered on its own", async () => {
    const answer = menu(sources(await shopProject()), "containers", "api");
    const deploy = answer.diagrams.items.find((d) => d.source === "deploy")!;
    expect(deploy).toMatchObject({ relation: "draws", family: "flowchart", adds: { boxes: 1, wires: 1 } });
    expect((deploy.piece!.model as { nodes: { id: string }[] }).nodes.map((n) => n.id)).toEqual(["queue"]);
    expect(deploy.piece!.attach).toEqual([
      expect.objectContaining({ key: "e1", from: "api", to: "queue", direction: "forward" }),
    ]);
    expect(checkAgainst("DiagramModel", deploy.piece!.model)).toEqual([]);

    const onShop = menu(sources(await shopProject()), "context", "shop");
    const checkout = onShop.diagrams.items.find((d) => d.source === "checkout")!;
    expect(checkout).toMatchObject({ family: "sequence", piece: null, omitted: "own" });
    // Order: opensIn, then drawnIn, then what opens on its own.
    expect(onShop.diagrams.items.map((d) => d.source)).toEqual(["containers", "checkout"]);
  });

  test("an element already on the canvas is drawn once (O6), and a wire the canvas has is not drawn again", async () => {
    const views = await shopProject();
    // On the containers view shop is drawn (its boundary): context's user→shop adds a wire to it, no box.
    const answer = menu(sources(views), "containers", "user");
    const context = answer.diagrams.items.find((d) => d.source === "context")!;
    expect(context).toMatchObject({ adds: { boxes: 0, wires: 1 } });
    expect((context.piece!.model as { elements: unknown[] }).elements).toEqual([]);
    expect(context.piece!.attach.map((a) => [a.from, a.to])).toEqual([["user", "shop"]]);
    // On context, user→shop is drawn already: containers' user→web is offered, user→shop never twice.
    const onContext = menu(sources(views), "context", "user");
    expect(onContext.diagrams.items.find((d) => d.source === "containers")!.piece!.attach.map((a) => a.to)).toEqual([
      "web",
    ]);
  });

  test("an id that is no element answers an empty menu, not an error", async () => {
    const answer = menu(sources(await shopProject()), "deploy", "nowhere");
    expect(answer).toMatchObject({ element: null, diagrams: { items: [], total: 0 }, neighbours: { items: [] } });
  });

  test("the base view's revision and the model generation ride with the answer; the caps are echoed (A13)", async () => {
    const answer = menu(sources(await shopProject()), "context", "shop");
    expect(answer).toMatchObject({
      schemaVersion: 1,
      viewId: "context",
      revision: expect.stringMatching(/^sha256:/),
      modelGeneration: 7,
      limits: EXPLORATION_LIMITS,
    });
    expect(answer.remaining).toEqual({ sources: 5, boxes: 60, wires: 120 });
  });

  test("an unknown base view is refused", async () => {
    expect(expandMenu(sources(await shopProject()), "missing", "shop", [])).toMatchObject({
      status: 404,
      code: "diagram_not_found",
    });
  });
});

describe("neighbours not drawn here (§11)", () => {
  test("a model relationship this canvas lacks is offered inside a frame named for the diagram that draws it", async () => {
    const answer = menu(sources(await shopProject()), "context", "shop");
    // shop's model relationships: user (drawn), pay (drawn). Nothing to offer from the model here.
    expect(answer.neighbours.items).toEqual([]);
    const onApi = menu(sources(await shopProject()), "deploy", "api");
    const names = onApi.neighbours.items.map((n) => [n.element, n.via, n.direction]);
    expect(names).toEqual([
      ["db", "containers", "forward"],
      ["mail", "containers", "forward"],
      ["web", "containers", "reverse"],
    ]);
    const db = onApi.neighbours.items[0]!;
    expect((db.piece!.model as { elements: { id: string }[] }).elements.map((e) => e.id)).toEqual(["db"]);
    expect(db.piece!.attach.map((a) => [a.from, a.to])).toEqual([["api", "db"]]);
  });
});

describe("what a source may be (A5, A9, O11)", () => {
  test("a proposed view is offered, flagged; a based-on copy never is", async () => {
    const views = [
      ...(await shopProject()),
      await view("plan", "flowchart LR\n  api[API]:::container\n  cache[Cache]:::container\n  api e1@--> cache\n", {
        title: "Plan",
        embedded: true,
        status: "proposed",
      }),
      await view("copy", "flowchart LR\n  api[API]:::container\n  extra[Extra]:::container\n  api e1@--> extra\n", {
        title: "Copy",
        embedded: true,
        basedOn: "deploy@sha256:0",
      }),
    ];
    const answer = menu(sources(views), "containers", "api");
    expect(answer.diagrams.items.find((d) => d.source === "plan")).toMatchObject({ proposed: true });
    expect(answer.diagrams.items.some((d) => d.source === "copy")).toBe(false);
  });

  test("an expand entry naming a source outside the inventory, a copy or the base is dropped with its reason", async () => {
    const answer = menu(sources(await shopProject()), "context", "shop", [
      { element: "shop", source: "elsewhere" },
      { element: "shop", source: "context" },
      { element: "shop", source: "checkout" },
      { element: "ghost", source: "containers" },
    ]);
    expect(answer.canvas).toEqual([]);
    expect(answer.dropped.map((d) => d.reason)).toEqual([
      "source_unknown",
      "source_is_base",
      "source_not_frame",
      "element_not_on_canvas",
    ]);
  });
});

describe("the canvas named by expand (O7, A13)", () => {
  test("an entry already on the canvas is not offered again; one from a source with a frame grows it", async () => {
    const answer = menu(sources(await shopProject()), "context", "shop", [{ element: "shop", source: "containers" }]);
    expect(answer.canvas).toEqual([{ element: "shop", source: "containers" }]);
    expect(answer.diagrams.items.some((d) => d.source === "containers")).toBe(false);
    expect(answer.remaining).toEqual({ sources: 4, boxes: 57, wires: 117 });
    // api is on the canvas now, from the containers frame: deploy draws it, and grows nothing that is there.
    const onApi = menu(sources(await shopProject()), "context", "api", [{ element: "shop", source: "containers" }]);
    expect(onApi.diagrams.items.map((d) => [d.source, d.relation, d.onCanvas])).toEqual([
      ["containers", "draws", true],
      ["deploy", "draws", false],
    ]);
    expect(onApi.diagrams.items[0]!.adds).toEqual({ boxes: 1, wires: 1 });
    expect(onApi.neighbours.items.map((n) => [n.element, n.via, n.onCanvas])).toEqual([
      ["mail", "containers", true],
      ["queue", "deploy", false],
    ]);
  });

  test("past the limit an entry carries omitted: limit and no piece", async () => {
    const tight = { ...EXPLORATION_LIMITS, maxAddedBoxes: 2 };
    const answer = menu(sources(await shopProject()), "context", "shop", [], tight);
    expect(answer.diagrams.items.find((d) => d.source === "containers")).toMatchObject({
      piece: null,
      omitted: "limit",
      adds: { boxes: 3 },
    });
    const one = { ...EXPLORATION_LIMITS, maxAddedSources: 1 };
    const full = menu(
      sources(await shopProject()),
      "context",
      "shop",
      [{ element: "shop", source: "containers" }],
      one,
    );
    const api = menu(sources(await shopProject()), "context", "api", [{ element: "shop", source: "containers" }], one);
    expect(full.remaining.sources).toBe(0);
    expect(api.diagrams.items.find((d) => d.source === "deploy")).toMatchObject({ omitted: "limit" });
  });

  test("a piece past maxPieceBoxes is cut and says so", async () => {
    const answer = menu(sources(await shopProject()), "context", "shop", [], {
      ...EXPLORATION_LIMITS,
      maxPieceBoxes: 2,
    });
    expect(answer.diagrams.items[0]!.piece).toMatchObject({ boxes: 2, truncated: true, total: { boxes: 3 } });
  });

  test("past maxResponseBytes pieces go from the last entry backwards, each marked omitted: bytes", async () => {
    const whole = menu(sources(await shopProject()), "deploy", "api");
    const size = Buffer.byteLength(JSON.stringify(whole));
    const cut = menu(sources(await shopProject()), "deploy", "api", [], {
      ...EXPLORATION_LIMITS,
      maxResponseBytes: size - 50,
    });
    expect(cut.bytesTruncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(cut))).toBeLessThanOrEqual(size - 50);
    expect(cut.neighbours.items.at(-1)).toMatchObject({ piece: null, omitted: "bytes" });
  });
});

describe("readings (A3, O2)", () => {
  test("a conflicting element lists one entry per reading", async () => {
    const views = [
      await view(
        "runtime",
        'C4Container\nContainer(store, "Store")\nContainer(api, "API")\nRel(api, store, "reads")\n',
        { title: "Runtime" },
      ),
      await view(
        "page",
        'C4Component\nComponent(store, "Store")\nComponent(view, "View")\nRel(view, store, "reads")\n',
        { title: "Page" },
      ),
      await view("third", "flowchart LR\n  store[Store]:::container\n  log[Log]:::container\n  store e1@--> log\n", {
        title: "Third",
      }),
    ];
    const answer = menu(sources(views), "third", "store");
    expect(answer.element!.conflicting).toBe(true);
    expect(answer.element!.readings.map((r) => [r.kind, r.views])).toEqual([
      ["component", ["page"]],
      ["container", ["runtime", "third"]],
    ]);
    const byReading = answer.diagrams.items.map((d) => [d.source, answer.element!.readings[d.reading]!.kind]);
    expect(byReading).toEqual([
      ["page", "component"],
      ["runtime", "container"],
    ]);
  });
});

describe("the expand parameter (provisional encoding, ticket 11b)", () => {
  test("round-trips view ids with / and #, and refuses what is malformed or too long", () => {
    const list = [
      { element: "api", source: "notes/arch.md#runtime" },
      { element: "db", source: "diagrams/a/b" },
    ];
    const text = encodeExpansions(list);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeExpansions(text)).toEqual({ ok: true, expansions: list });
    expect(decodeExpansions(null)).toEqual({ ok: true, expansions: [] });
    expect(decodeExpansions("!!")).toMatchObject({ ok: false, code: "invalid_expand" });
    expect(decodeExpansions(encodeExpansions([]).concat("A".repeat(5000)))).toMatchObject({
      ok: false,
      code: "expand_param_too_long",
    });
    expect(
      decodeExpansions(encodeExpansions(Array.from({ length: 30 }, (_, i) => ({ element: `e${i}`, source: "s" })))),
    ).toMatchObject({ ok: false, code: "expand_param_too_long" });
  });

  // codex-12-03 (O255): every writer checks the decoder's own limits before it accepts an addition or emits a link.
  test("a list is shareable at 24 entries and 4,096 characters, and not one entry or one byte past", () => {
    const entries = (n: number): Expansion[] =>
      Array.from({ length: n }, (_, i) => ({ element: `e${i}`, source: "s" }));
    expect(shareableExpansions(entries(24))).toMatchObject({ ok: true });
    expect(shareableExpansions(entries(25))).toMatchObject({ ok: false, reason: "too_many" });
    // Five long entries, the last one's element sized so the JSON is 3,072 bytes: 4,096 base64url characters.
    const sized = (extra: number): Expansion[] => {
      const list = Array.from({ length: 5 }, (_, i) => ({
        element: "e".repeat(100),
        source: `notes/${i}`.padEnd(500, "s"),
      }));
      const bytes = JSON.stringify(list.map((e) => [e.element, e.source])).length;
      list[4] = { ...list[4]!, element: "e".repeat(100 - (bytes - 3072) + extra) };
      return list;
    };
    const at = shareableExpansions(sized(0));
    expect(at.ok && at.param.length).toBe(4096);
    expect(decodeExpansions(at.ok ? at.param : null)).toMatchObject({ ok: true });
    const past = shareableExpansions(sized(1));
    expect(past).toMatchObject({ ok: false, reason: "too_long" });
    expect(decodeExpansions(encodeExpansions(sized(1)))).toMatchObject({ ok: false, code: "expand_param_too_long" });
    expect(decodeExpansions("A".repeat(4097))).toMatchObject({ ok: false, code: "expand_param_too_long" });
    // A name past the decoder's own length is not shareable either.
    expect(shareableExpansions([{ element: "e".repeat(257), source: "s" }])).toMatchObject({
      ok: false,
      reason: "too_long",
    });
  });

  test("Copy link's address: the list when it is shareable, else the view alone and why", () => {
    const ok = withExpandParam("https://h/p/x.mmd?zoom=1&expand=old", [{ element: "a", source: "s" }]);
    expect(ok).toMatchObject({ shared: true });
    expect(decodeExpansions(new URL(ok.href).searchParams.get("expand"))).toEqual({
      ok: true,
      expansions: [{ element: "a", source: "s" }],
    });
    const bare = withExpandParam(
      "https://h/p/x.mmd?zoom=1&expand=old",
      Array.from({ length: 25 }, (_, i) => ({ element: `e${i}`, source: "s" })),
    );
    expect(bare).toMatchObject({ shared: false, problem: expect.stringMatching(/24/) });
    expect(new URL(bare.href).searchParams.has("expand")).toBe(false);
    expect(new URL(bare.href).searchParams.get("zoom")).toBe("1");
  });

  test("past 24 additions an entry is offered but refused: the reader's report and link could not carry it", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `n${String(i).padStart(2, "0")}`);
    const star = `flowchart LR\n  a[A]:::container\n${ids.map((id) => `  ${id}[${id}]:::container\n`).join("")}${ids.map((id) => `  a w${id}@--> ${id}\n`).join("")}`;
    const s = sources([await view("base", "flowchart LR\n  a[A]:::container\n"), await view("star", star)]);
    const kept: Expansion[] = ids.slice(0, 24).map((id) => ({ element: "a", source: "star", neighbour: id }));
    const answer = menu(s, "base", "a", kept);
    expect(answer.canvas).toHaveLength(24);
    expect(answer.remaining).toMatchObject({ sources: 4, boxes: 36 });
    expect(answer.neighbours.items.map((n) => [n.element, n.piece, n.omitted])).toEqual([["n24", null, "limit"]]);
    expect(answer.diagrams.items.find((d) => d.source === "star")).toMatchObject({ piece: null, omitted: "limit" });
  });

  test("canvas ids of frame parts name their source and local id, whatever the view id holds", () => {
    expect(framePartOf(framePartId("notes/a~b.md#x", "web"))).toEqual({ source: "notes/a~b.md#x", id: "web" });
    expect(framePartOf("web")).toBeNull();
    expect(frameSourceOf(frameIdOf("notes/a.md#x"))).toBe("notes/a.md#x");
    expect(frameSourceOf(framePartId("s", "web"))).toBeNull();
  });
});
