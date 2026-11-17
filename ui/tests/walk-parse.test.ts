// The walkthroughs route as the page reads it, against the real service (slice 1's fixture), and
// the parser's atomic-per-walkthrough rule against hand-made payloads.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseWalkthroughs } from "../src/walkthroughs/parse";
import { startTsProject, type TsProject } from "./support/ts-service";
import { walkthroughFiles } from "./support/walkthrough-project";

let server: TsProject;
let wire: unknown;
beforeAll(async () => {
  server = await startTsProject({ files: walkthroughFiles() });
  wire = await (await server.fetch("api/walkthroughs?viewId=containers", { redirect: "follow" })).json();
}, 60_000);
afterAll(async () => {
  await server?.stop();
});

describe("the service's answer", () => {
  it("reads whole: four walkthroughs, steps numbered as written, statuses folded in", () => {
    const read = parseWalkthroughs(wire);
    expect(read?.viewId).toBe("containers");
    expect(read?.walks.map((w) => [w.id, w.steps.length])).toEqual([
      ["checkout-and-payment", 8],
      ["declined-card", 5],
      ["order-shipped", 6],
      ["pay-with-card-form", 4],
    ]);
    const checkout = read!.walks[0]!;
    expect(checkout.steps[4]).toMatchObject({
      title: "Pay on the hosted page",
      kind: "does",
      edges: [],
      messages: [{ from: "customer", to: "payments" }],
    });
    expect(checkout.steps[1]!.edges[0]).toMatchObject({ id: "web--api", source: "web", target: "api" });
    expect(read!.walks[2]!.open).toEqual(["pageturner"]);
  });
});

const goodStep = {
  id: "ask",
  title: "Ask",
  kind: "sends",
  what: "A request.",
  edges: [{ id: "a--b", source: "a", target: "b" }],
};
const good = { id: "w", title: "W", modelRevision: "sha256:1", steps: [goodStep] };
const payload = (walkthroughs: unknown[], resolution?: unknown[]) => ({
  schemaVersion: 1,
  viewId: "v",
  walkthroughs,
  resolution: resolution ?? null,
  deadCode: [],
});

describe("atomic", () => {
  it("leaves out a walkthrough with any unreadable step, and keeps the rest", () => {
    const bad = { ...good, id: "bad", steps: [goodStep, { title: "x", kind: "teleports", what: "y" }] };
    expect(parseWalkthroughs(payload([bad, good]))?.walks.map((w) => w.id)).toEqual(["w"]);
  });

  it("reads nothing from another schema version, or a payload without the list", () => {
    expect(parseWalkthroughs({ ...payload([good]), schemaVersion: 2 })).toBeUndefined();
    expect(parseWalkthroughs({ schemaVersion: 1, viewId: "v" })).toBeUndefined();
    expect(parseWalkthroughs(null)).toBeUndefined();
  });

  it("takes each step's status from its resolution, by id, and lists the out-of-date step numbers", () => {
    const two = { ...good, steps: [goodStep, goodStep] };
    const resolution = [
      { id: "w", status: "partly-out-of-date", steps: [{ status: "current" }, { status: "out-of-date" }] },
    ];
    const read = parseWalkthroughs(payload([two], resolution))!.walks[0]!;
    expect([read.status, read.steps.map((s) => s.status), read.outOfDate]).toEqual([
      "partly-out-of-date",
      ["current", "out-of-date"],
      [2],
    ]);
  });

  it("treats a view that has never compiled (no resolution) as nothing known to be wrong", () => {
    expect(parseWalkthroughs(payload([good]))!.walks[0]).toMatchObject({ status: "current", outOfDate: [] });
  });

  it("carries the unsupported reason", () => {
    expect(parseWalkthroughs({ ...payload([]), unsupported: "graph diagrams only" })).toMatchObject({
      walks: [],
      unsupported: "graph diagrams only",
    });
  });
});

describe("what an out-of-date step used to point at", () => {
  it("names the references that no longer resolve: boxes by stored label, lines as from → to", () => {
    const stepWith = {
      id: "pay",
      title: "Pay",
      kind: "sends",
      what: "x",
      nodes: [
        { kind: "node", id: "browser", label: "Browser" },
        { kind: "node", id: "c", label: "Cart" },
      ],
      edges: [
        { id: "a--b", source: "a", target: "b", label: "Calls" },
        { id: "c--d", source: "c", target: "d" },
      ],
    };
    const resolution = [
      {
        id: "w",
        status: "partly-out-of-date",
        steps: [
          {
            status: "out-of-date",
            nodes: [{ status: "out-of-date" }, { status: "current" }],
            edges: [{ status: "current" }, { status: "out-of-date" }],
            messages: [],
          },
        ],
      },
    ];
    const read = parseWalkthroughs(payload([{ ...good, steps: [stepWith] }], resolution))!.walks[0]!;
    expect(read.steps[0]!.missing).toEqual(["Browser", "Cart → d"]);
  });

  it("is empty for a step that still resolves", () => {
    expect(parseWalkthroughs(payload([good]))!.walks[0]!.steps[0]!.missing).toEqual([]);
  });
});

describe("the related note (J10-F1)", () => {
  it("keeps a walkthrough's folder-relative note, and drops one that is not a string", () => {
    expect(parseWalkthroughs(payload([{ ...good, note: "notes/0001-hosted-payment-page.md" }]))?.walks[0]?.note).toBe(
      "notes/0001-hosted-payment-page.md",
    );
    expect(parseWalkthroughs(payload([{ ...good, note: 7 }]))?.walks[0]?.note).toBeUndefined();
    expect(parseWalkthroughs(payload([good]))?.walks[0]?.note).toBeUndefined();
  });
});
