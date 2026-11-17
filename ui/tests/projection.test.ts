import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { projectEnvelope } from "../src/diagrams/projection";

const validFixturePath = fileURLToPath(
  new URL("../../fixtures/protocol/valid/minimal-architecture.json", import.meta.url),
);

function loadFixture(): unknown {
  return JSON.parse(readFileSync(validFixturePath, "utf8"));
}

describe("projection", () => {
  it("projects a valid envelope into a view model", () => {
    const result = projectEnvelope(loadFixture());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.type).toBe("graph");
    if (result.type !== "graph") return;
    expect(result.view.viewId).toBe("system-context");
    expect(result.view.kind).toBe("c4-context");
    expect(result.view.title).toBe("System context");
    expect(result.view.modelType).toBe("architecture-graph");
    expect(result.view.nodes).toHaveLength(1);
    expect(result.view.nodes[0].id).toBe("web");
    expect(result.view.nodes[0].label).toBe("Web");
    expect(result.view.edges).toHaveLength(0);
    expect(result.view.groups).toHaveLength(0);
  });

  it("rejects unsupported schema versions", () => {
    const fixture = loadFixture() as Record<string, unknown>;
    fixture.schemaVersion = 99;
    const result = projectEnvelope(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("rejects dangling edge references", () => {
    const fixture = loadFixture() as {
      model: { edges: unknown[] };
    };
    fixture.model.edges.push({ id: "broken", source: "web", target: "ghost" });
    const result = projectEnvelope(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "dangling_edge_target")).toBe(true);
    }
  });

  it("produces deterministic output for the same input", () => {
    const fixture = loadFixture();
    const result1 = projectEnvelope(fixture);
    const result2 = projectEnvelope(fixture);
    expect(result1).toEqual(result2);
  });

  it("produces deterministic output regardless of input node order", () => {
    const fixture = loadFixture() as {
      model: { nodes: Array<{ id: string; label: string }> };
    };
    fixture.model.nodes = [{ id: "z-node", label: "Z" }, { id: "a-node", label: "A" }, ...fixture.model.nodes];
    const result1 = projectEnvelope(fixture);

    const reordered = JSON.parse(JSON.stringify(fixture)) as typeof fixture;
    reordered.model.nodes = [...reordered.model.nodes].reverse();
    const result2 = projectEnvelope(reordered);

    if (result1.ok && result1.type === "graph" && result2.ok && result2.type === "graph") {
      expect(result1.view.nodes.map((n) => n.id)).toEqual(result2.view.nodes.map((n) => n.id));
    }
  });

  it("projects nodes with shape and classes", () => {
    const fixture = loadFixture() as {
      model: { nodes: Array<Record<string, unknown>> };
    };
    fixture.model.nodes[0] = {
      ...fixture.model.nodes[0],
      shape: "rectangle",
      classes: ["system"],
    };
    const result = projectEnvelope(fixture);
    expect(result.ok).toBe(true);
    if (!result.ok || result.type !== "graph") return;
    expect(result.view.nodes[0].shape).toBe("rectangle");
    expect(result.view.nodes[0].classes).toEqual(["system"]);
  });

  it("projects groups and node-group assignment", () => {
    const fixture = loadFixture() as {
      model: {
        nodes: Array<Record<string, unknown>>;
        groups: Array<Record<string, unknown>>;
      };
    };
    fixture.model.groups = [{ id: "backend", label: "Backend" }];
    fixture.model.nodes[0] = { ...fixture.model.nodes[0], groupId: "backend" };
    const result = projectEnvelope(fixture);
    expect(result.ok).toBe(true);
    if (!result.ok || result.type !== "graph") return;
    expect(result.view.groups).toHaveLength(1);
    expect(result.view.groups[0].id).toBe("backend");
    expect(result.view.nodes[0].groupId).toBe("backend");
  });
});
