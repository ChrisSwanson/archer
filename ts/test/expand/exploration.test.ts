// An exploration (ADR 0036 §13–§14, A10, A11): present_diagram's expand checked whole against one snapshot
// (every refusal named), the frames one read returns, and the agent's report with frame selections.
import { describe, expect, test } from "vitest";
import { mergeProjectModel, type ModelInputView } from "../../src/project-model/merge.ts";
import {
  expandIssues,
  explorationOf,
  replayOn,
  reportOf,
  type CommentPin,
  type ExplorationSources,
} from "../../src/expand/exploration.ts";
import { expandMenu } from "../../src/expand/menu.ts";
import {
  EXPLORATION_LIMITS,
  decodeExpansions,
  encodeExpansions,
  type Expansion,
} from "../../../shared/explorations.mts";
import { view } from "../project-model/support.ts";

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

async function project(extra: ModelInputView[] = []): Promise<ModelInputView[]> {
  return [
    await view("context", CONTEXT, { title: "Context" }),
    await view("containers", CONTAINERS, { title: "Containers" }),
    await view("deploy", DEPLOY, { title: "Deploy" }),
    await view("checkout", CHECKOUT, { title: "Checkout" }),
    ...extra,
  ];
}

function sources(
  views: readonly ModelInputView[],
  pins: (source: string, ids: ReadonlySet<string>) => CommentPin[] = () => [],
): ExplorationSources {
  return {
    model: mergeProjectModel(views),
    generation: 3,
    envelope: (id) => views.find((v) => v.id === id)?.envelope ?? null,
    title: (id) => views.find((v) => v.id === id)?.title ?? id,
    pins,
  };
}

const SHOP: Expansion = { element: "shop", source: "containers" };
const API: Expansion = { element: "api", source: "deploy" };

describe("present_diagram's expand is checked whole (A11)", () => {
  test("a list that holds has no issues: entries apply in order, an element from an earlier frame included", async () => {
    expect(expandIssues(sources(await project()), "context", [SHOP, API])).toEqual([]);
  });

  test("every refusal is named, each with its index, and one call reports them all", async () => {
    const uncompiled: ModelInputView = { ...(await view("broken", DEPLOY, { title: "Broken" })), envelope: null };
    const copy = await view(
      "copy",
      "flowchart LR\n  shop[Shop]:::system\n  extra[Extra]:::container\n  shop e1@--> extra\n",
      { title: "Copy", embedded: true, basedOn: "deploy@sha256:0" },
    );
    const s = sources(await project([uncompiled, copy]));
    const issues = expandIssues(s, "context", [
      { element: "ghost", source: "containers" }, // no diagram draws it
      API, // api is not on the canvas yet: containers comes later
      { element: "user", source: "deploy" }, // deploy neither draws nor opens user
      { element: "shop", source: "context" }, // the base as its own source
      { element: "shop", source: "checkout" }, // a sequence cannot be a frame
      { element: "shop", source: "broken" }, // never compiled
      { element: "shop", source: "elsewhere" }, // not in this project
      { element: "shop", source: "copy" }, // a based-on: copy
      SHOP,
      SHOP, // the same pair twice
    ]);
    expect(issues.map((i) => [i.index, i.reason])).toEqual([
      [0, "element_unknown"],
      [1, "element_not_on_canvas"],
      [2, "source_unrelated"],
      [3, "source_is_base"],
      [4, "source_not_frame"],
      [5, "source_uncompiled"],
      [6, "source_unknown"],
      [7, "source_is_copy"],
      [9, "duplicate"],
    ]);
    for (const i of issues) expect(i.problem.length).toBeGreaterThan(10);
    expect(issues[2]!.problem).toBe("'deploy' neither draws nor opens 'user'");
  });

  test("the limit, the list's length and an entry that adds nothing are refusals too", async () => {
    const s = sources(await project());
    expect(
      expandIssues(s, "context", [SHOP], { ...EXPLORATION_LIMITS, maxAddedBoxes: 2 }).map((i) => i.reason),
    ).toEqual(["limit_passed"]);
    expect(
      expandIssues(s, "context", [SHOP, API], { ...EXPLORATION_LIMITS, maxExpansions: 1 }).map((i) => [
        i.index,
        i.reason,
      ]),
    ).toEqual([[1, "too_many"]]);
    // api's neighbour in containers that deploy does not already add: none once both frames are there.
    expect(expandIssues(s, "context", [SHOP, { element: "web", source: "containers" }]).map((i) => i.reason)).toEqual([
      "nothing_to_add",
    ]);
  });
});

describe("the frames of an exploration in one read (routes 2 and 3)", () => {
  test("each added entry carries its piece; frames are one per source, with pins on their parts", async () => {
    const pins = (source: string, ids: ReadonlySet<string>): CommentPin[] =>
      source === "containers" && ids.has("api") ? [{ kind: "node", id: "api", open: 2 }] : [];
    const answer = explorationOf(
      sources(await project(), pins),
      "context",
      [SHOP, API, { element: "shop", source: "elsewhere" }],
      { kind: "link" },
    )!;
    expect(answer).toMatchObject({
      schemaVersion: 1,
      viewId: "context",
      origin: "link",
      modelGeneration: 3,
      counts: { sources: 2 },
    });
    expect(answer.expansions.items.map((i) => [i.element, i.source, i.status, i.frame ?? i.reason])).toEqual([
      ["shop", "containers", "added", 0],
      ["api", "deploy", "added", 1],
      ["shop", "elsewhere", "dropped", "source_unknown"],
    ]);
    expect(answer.expansions.items[0]!.piece).toMatchObject({
      source: "containers",
      touches: "shop",
      opens: true,
      boxes: 3,
    });
    expect(answer.frames.map((f) => [f.source, f.title, f.touches, f.boxes])).toEqual([
      ["containers", "Containers", ["shop"], 3],
      ["deploy", "Deploy", ["api"], 1],
    ]);
    expect(answer.frames[0]!.pins).toEqual([{ kind: "node", id: "api", open: 2 }]);
    expect(answer.generation).toBeUndefined();
  });

  test("a presented exploration carries its id, generation and notices", async () => {
    const answer = explorationOf(sources(await project()), "context", [SHOP], {
      kind: "presentation",
      presentationId: "present-0123456789ab",
      generation: 4,
      notices: ["Deploy was removed, so its frame is gone"],
    })!;
    expect(answer).toMatchObject({
      origin: "presentation",
      presentationId: "present-0123456789ab",
      generation: 4,
      notices: ["Deploy was removed, so its frame is gone"],
    });
  });

  test("an unknown base is null", async () => {
    expect(explorationOf(sources(await project()), "nope", [SHOP], { kind: "link" })).toBeNull();
  });
});

describe("the agent's report (A10)", () => {
  test("frames by source and element; frame selections resolved against the source, never the page's labels", async () => {
    const s = sources(await project());
    const at = replayOn(s, "context", [SHOP, API])!;
    const report = reportOf(s, "reader", "context", at.replayed, {
      selection: [
        { source: "containers", kind: "node", id: "api" },
        { source: "containers", kind: "node", id: "api" },
        { source: "deploy", kind: "edge", id: "e1" },
        { source: "containers", kind: "node", id: "user" }, // on the base, not in the frame
        { source: "elsewhere", kind: "node", id: "x" },
      ],
    });
    expect(report.frames).toEqual([
      { source: "containers", title: "Containers", touches: ["shop"], boxes: 3 },
      { source: "deploy", title: "Deploy", touches: ["api"], boxes: 1 },
    ]);
    expect(report.selection).toEqual([
      { source: "containers", kind: "node", id: "api", label: "API" },
      { source: "deploy", kind: "edge", id: "e1" },
    ]);
    expect(report.expand).toEqual([SHOP, API]);
  });
});

// codex-12-04 (O256): one answer keeps to maxResponseBytes, and what does not fit is refused alike by every reader.
describe("an exploration keeps to its byte budget (P43)", () => {
  const BASE = "flowchart LR\n  a[A]:::container\n";
  /** A source drawing a beside `boxes` boxes of its own and `wires` parallel wires to them, every label `chars` long. */
  const wide = (id: string, boxes: number, wires: number, chars = 500): string =>
    `flowchart LR\n  a[A]:::container\n${Array.from({ length: boxes }, (_, i) => `  ${id}${i}["${"X".repeat(chars)}"]:::container\n`).join("")}` +
    Array.from({ length: wires }, (_, i) => `  a e${i}@-->|"${"Y".repeat(chars)}"| ${id}${i % boxes}\n`).join("");
  const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));
  const project = async (sizes: Record<string, [number, number]>) =>
    sources([
      await view("base", BASE, { title: "Base" }),
      ...(await Promise.all(Object.entries(sizes).map(([id, [b, w]]) => view(id, wide(id, b, w), { title: id })))),
    ]);

  test("a piece larger than one answer holds is refused by the menu, the replay, a present and the report", async () => {
    const s = await project({ big: [40, 120] });
    const big: Expansion = { element: "a", source: "big" };
    const answer = explorationOf(s, "base", [big], { kind: "link" })!;
    expect(bytes(answer)).toBeLessThanOrEqual(EXPLORATION_LIMITS.maxResponseBytes);
    expect(answer.expansions.items.map((i) => [i.status, i.reason])).toEqual([["dropped", "limit_passed"]]);
    const m = expandMenu(s, "base", "a", []);
    if ("status" in m) throw new Error(m.message);
    expect(m.diagrams.items.find((d) => d.source === "big")).toMatchObject({ piece: null, omitted: "limit" });
    expect(expandIssues(s, "base", [big]).map((i) => i.reason)).toEqual(["limit_passed"]);
    expect(reportOf(s, "reader", "base", replayOn(s, "base", [big])!.replayed, {}).dropped).toEqual([
      { ...big, reason: "limit_passed" },
    ]);
  });

  test("two pieces that each fit but not together: the second is refused alike, the answer under the cap", async () => {
    const s = await project({ one: [10, 40], two: [10, 40] });
    const one: Expansion = { element: "a", source: "one" },
      two: Expansion = { element: "a", source: "two" };
    const alone = explorationOf(s, "base", [two], { kind: "link" })!;
    expect(alone.expansions.items[0]!.status).toBe("added");
    const both = explorationOf(s, "base", [one, two], { kind: "link" })!;
    expect(both.expansions.items.map((i) => [i.source, i.status, i.reason])).toEqual([
      ["one", "added", undefined],
      ["two", "dropped", "limit_passed"],
    ]);
    expect(bytes(both)).toBeLessThanOrEqual(EXPLORATION_LIMITS.maxResponseBytes);
    // The menu over the first says the same of the second, before anyone adds it.
    const m = expandMenu(s, "base", "a", [one]);
    if ("status" in m) throw new Error(m.message);
    expect(m.diagrams.items.find((d) => d.source === "two")).toMatchObject({ piece: null, omitted: "limit" });
    expect(expandIssues(s, "base", [one, two]).map((i) => [i.index, i.reason])).toEqual([[1, "limit_passed"]]);
  });

  test("comment pins fill only the room left, and the answer says when some were left out", async () => {
    const views = [
      await view("base", BASE, { title: "Base" }),
      await view("one", wide("one", 10, 28), { title: "one" }),
    ];
    const pins = (_source: string, ids: ReadonlySet<string>): CommentPin[] =>
      [...ids].flatMap((id) =>
        Array.from({ length: 40 }, () => ({
          kind: "edge" as const,
          id,
          open: 3,
          latestPostAt: "2026-11-04T00:00:00.000Z",
        })),
      );
    const answer = explorationOf(sources(views, pins), "base", [{ element: "a", source: "one" }], { kind: "link" })!;
    expect(answer.expansions.items[0]!.status).toBe("added");
    expect(bytes(answer)).toBeLessThanOrEqual(EXPLORATION_LIMITS.maxResponseBytes);
    expect(answer.pinsTruncated).toBe(true);
    expect(answer.frames[0]!.pins.length).toBeGreaterThan(0);
    const few = explorationOf(
      sources(views, () => [{ kind: "node", id: "one1", open: 1 }]),
      "base",
      [{ element: "a", source: "one" }],
      { kind: "link" },
    )!;
    expect(few.pinsTruncated).toBeUndefined();
  });
});

// codex-12-01 (O254): a neighbour entry adds one neighbour; the list it leaves must replay as that, on every reader.
describe("a neighbour entry replays as chosen (P41)", () => {
  const BASE = "flowchart LR\n  a[A]:::container\n";
  const STAR = "flowchart LR\n  a[A]:::container\n  b[B]:::container\n  c[C]:::container\n  a ab@--> b\n  a ac@--> c\n";
  const star = async () =>
    sources([await view("base", BASE, { title: "Base" }), await view("star", STAR, { title: "Star" })]);
  const nodes = (piece: { model: unknown } | undefined): string[] =>
    ((piece?.model as { nodes?: { id: string }[] } | undefined)?.nodes ?? []).map((n) => n.id);
  const pick = (m: ReturnType<typeof expandMenu>, id: string) => {
    if ("status" in m) throw new Error(m.message);
    return m.neighbours.items.find((n) => n.element === id)!;
  };

  test("two neighbour clicks round-trip through the link, the exploration and the agent's report", async () => {
    const s = await star();
    const first = pick(expandMenu(s, "base", "a", []), "b");
    expect(nodes(first.piece!)).toEqual(["b"]);
    const b: Expansion = { element: "a", source: "star", neighbour: "b" };
    const second = pick(expandMenu(s, "base", "a", [b]), "c");
    expect(nodes(second.piece!)).toEqual(["c"]);
    const c: Expansion = { element: "a", source: "star", neighbour: "c" };
    // The link the page copies decodes to the same list, neighbour and all.
    expect(decodeExpansions(encodeExpansions([b, c]))).toEqual({ ok: true, expansions: [b, c] });
    const answer = explorationOf(s, "base", [b, c], { kind: "link" })!;
    expect(answer.expansions.items.map((i) => [i.neighbour, i.status, nodes(i.piece)])).toEqual([
      ["b", "added", ["b"]],
      ["c", "added", ["c"]],
    ]);
    expect(answer.expansions.items[0]!.piece).toEqual(first.piece);
    expect(answer.expansions.items[1]!.piece).toEqual(second.piece);
    const report = reportOf(s, "reader", "base", replayOn(s, "base", [b, c])!.replayed, {});
    expect(report.expand).toEqual([b, c]);
    expect(report.frames).toEqual([{ source: "star", title: "Star", touches: ["a"], boxes: 2 }]);
    expect(expandIssues(s, "base", [b, c])).toEqual([]);
    // The same neighbour twice is the duplicate; the whole-source pair still means the whole cut.
    expect(expandIssues(s, "base", [b, b]).map((i) => [i.index, i.reason])).toEqual([[1, "duplicate"]]);
    expect(
      nodes(explorationOf(s, "base", [{ element: "a", source: "star" }], { kind: "link" })!.expansions.items[0]!.piece),
    ).toEqual(["b", "c"]);
  });

  test("at the limit the second neighbour is refused alike by the menu and the replay", async () => {
    const s = await star();
    const one = { ...EXPLORATION_LIMITS, maxAddedBoxes: 1 };
    const b: Expansion = { element: "a", source: "star", neighbour: "b" };
    expect(pick(expandMenu(s, "base", "a", [], one), "b").piece).not.toBeNull();
    expect(pick(expandMenu(s, "base", "a", [b], one), "c")).toMatchObject({ piece: null, omitted: "limit" });
    const answer = explorationOf(
      s,
      "base",
      [b, { element: "a", source: "star", neighbour: "c" }],
      { kind: "link" },
      one,
    )!;
    expect(answer.expansions.items.map((i) => [i.neighbour, i.status, i.reason ?? nodes(i.piece)])).toEqual([
      ["b", "added", ["b"]],
      ["c", "dropped", "limit_passed"],
    ]);
  });

  test("a neighbour the source does not link to the element adds nothing", async () => {
    const s = await star();
    expect(
      expandIssues(s, "base", [{ element: "a", source: "star", neighbour: "ghost" }]).map((i) => i.reason),
    ).toEqual(["nothing_to_add"]);
  });
});
