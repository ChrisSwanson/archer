import { beforeAll, describe, expect, it } from "vitest";
import { API_ROUTES } from "../../shared/api-routes.mts";
import type { PlaygroundProject } from "../../shared/playground-snapshot.mts";
import {
  classifyStaticRequest,
  STATIC_ROUTE_POLICY,
  validateStaticSelection,
  validateStaticPosition,
} from "../src/playground/route-policy";
import { exampleSnapshot } from "./support/playground-snapshot";
import { elementsOf, type DiagramEnvelope, type PointModel } from "../../ts/src/model/index.ts";
import { parseInventory } from "../src/app/inventory";
import { parseWalkthroughs } from "../src/walkthroughs/parse";

let project: PlaygroundProject;
beforeAll(() => {
  project = exampleSnapshot().projects[0]!;
}, 30000);

describe("static route policy", () => {
  it("explicitly classifies every production route and no invented routes", () => {
    expect(Object.keys(STATIC_ROUTE_POLICY).sort()).toEqual(API_ROUTES.map((route) => route.id).sort());
  });
  it.each([
    ["GET", ["api", "diagrams"], "diagrams", "snapshot"],
    ["GET", ["api", "notes", "content"], "notes-content", "snapshot"],
    ["POST", ["api", "comments"], "comments-create", "local"],
    ["PATCH", ["api", "comments", "t1", "c1"], "comments-edit", "local"],
    ["POST", ["api", "selection"], "selection", "local"],
    ["POST", ["api", "walkthrough-position"], "walkthrough-position", "local"],
    ["GET", ["api", "authoring"], "authoring-status", "local"],
    ["GET", ["api", "connection"], "connection", "unavailable"],
    ["GET", ["api", "events"], "events", "unavailable"],
    ["POST", ["api", "comments", "submit"], "comments-submit", "unavailable"],
    ["GET", ["api", "listeners"], "listeners", "unavailable"],
    ["GET", ["api", "search"], "search", "unavailable"],
    ["GET", ["api", "browser-search"], "browser-search", "unavailable"],
    ["GET", ["api", "expand-menu"], "expand-menu", "unavailable"],
    ["GET", ["api", "walkthroughs", "old"], "walkthroughs-old", "unavailable"],
    ["POST", ["api", "authoring", "edit"], "authoring-edit", "unavailable"],
  ] as const)("%s %j is explicitly %s/%s", (method, segments, id, policy) => {
    expect(classifyStaticRequest(method, segments)).toMatchObject({ id, policy });
  });
  it("rejects unknown paths, methods and malformed parameters without network fallback", () => {
    expect(classifyStaticRequest("POST", ["api", "diagrams"])).toBeNull();
    expect(classifyStaticRequest("GET", ["api", "invented"])).toBeNull();
    expect(classifyStaticRequest("DELETE", ["api", "comments", "t1", "c1", "extra"])).toBeNull();
    expect(classifyStaticRequest("GET", ["api", "diagrams", "%"])).toBeNull();
    expect(classifyStaticRequest("GET", ["api", "diagrams"], "service")).toBeNull();
    expect(classifyStaticRequest("GET", ["api", "projects"], "service")).toMatchObject({ policy: "snapshot" });
  });
});

function diagram() {
  const view = parseInventory(project.responses["api/diagrams"])![0]!;
  const envelope = project.responses[`api/diagrams/${encodeURIComponent(view.id)}`] as DiagramEnvelope;
  return { view, envelope };
}
describe("local write validation against production snapshots", () => {
  it("reuses production selection validation and resolves forged labels from the immutable model", () => {
    const { view, envelope } = diagram();
    const node = elementsOf(envelope.model as PointModel).nodes[0]!;
    const selected = {
      schemaVersion: 1,
      viewId: view.id,
      revision: envelope.revision,
      presentationId: `reader:${view.id}`,
      selectionRevision: 1,
      nodes: [{ id: node.id, label: "Forged" }],
      edges: [],
    };
    expect(validateStaticSelection(selected, project)).toMatchObject({
      ok: true,
      selection: { nodes: [{ id: node.id, label: node.label }] },
    });
    expect(validateStaticSelection({ ...selected, revision: `sha256:${"0".repeat(64)}` }, project)).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(validateStaticSelection({ ...selected, nodes: [{ id: "absent" }] }, project)).toMatchObject({
      ok: false,
      status: 422,
    });
    expect(validateStaticSelection({ ...selected, nodes: [{ id: node.id }, { id: node.id }] }, project)).toMatchObject({
      ok: false,
      status: 422,
    });
    expect(validateStaticSelection(null, project)).toMatchObject({ ok: false, status: 422 });
  });
  it("validates walkthrough position shapes with the shared production parser and registered view inventory", () => {
    const { view } = diagram();
    const walkEntry = Object.values(project.responses)
      .map((value) => parseWalkthroughsQuietly(value))
      .find((value) => value?.walks.length);
    expect(walkEntry).toBeDefined();
    const position = { viewId: walkEntry!.viewId, id: walkEntry!.walks[0]!.id, step: 1 };
    expect(validateStaticPosition(position, project)).toMatchObject({ ok: true, position });
    expect(validateStaticPosition({ viewId: view.id, id: null }, project)).toMatchObject({
      ok: true,
      position: { viewId: view.id, id: null },
    });
    for (const invalid of [
      null,
      {},
      { ...position, viewId: "absent" },
      { ...position, step: 0 },
      { ...position, step: 21 },
      { ...position, id: "not an id" },
    ])
      expect(validateStaticPosition(invalid, project)).toMatchObject({
        ok: false,
        status: 422,
        code: "invalid_walkthrough_position",
      });
  });
});
function parseWalkthroughsQuietly(value: unknown) {
  return value && typeof value === "object" && "walkthroughs" in value ? parseWalkthroughs(value) : undefined;
}

it("never throws on bounded arbitrary local-write payloads and vocabulary mutations", () => {
  const { view, envelope } = diagram();
  const values: unknown[] = [null, true, false, 0, -1, 1.5, "", "x", [], {}, { id: null }, { viewId: view.id }];
  const fields = ["viewId", "id", "step", "schemaVersion", "revision", "presentationId", "nodes", "edges"];
  for (let index = 0; index < 256; index++) {
    const value = { [fields[index % fields.length]!]: values[(index * 7) % values.length] };
    const selection = validateStaticSelection(value, project);
    expect(selection.ok).toBe(false);
    const position = validateStaticPosition(value, project);
    if (position.ok) {
      expect(position.position.viewId).toBe(view.id);
      if (position.position.id !== null) expect(Number.isSafeInteger(position.position.step)).toBe(true);
    } else expect(position.status).toBe(422);
  }
  for (const delta of values) {
    expect(
      validateStaticSelection(
        {
          schemaVersion: 1,
          viewId: view.id,
          revision: envelope.revision,
          presentationId: `reader:${view.id}`,
          nodes: delta,
          edges: [],
        },
        project,
      ),
    ).toHaveProperty("ok");
    expect(validateStaticPosition({ viewId: view.id, id: "walk", step: delta }, project)).toHaveProperty("ok");
  }
});
