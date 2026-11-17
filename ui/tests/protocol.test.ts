import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateEnvelope } from "../src/protocol/validate";

const fixturePath = fileURLToPath(new URL("../../fixtures/protocol/valid/minimal-architecture.json", import.meta.url));
const invalidFixtureDirectory = fileURLToPath(new URL("../../fixtures/protocol/invalid", import.meta.url));
const validFixtureDirectory = fileURLToPath(new URL("../../fixtures/protocol/valid", import.meta.url));

describe("normalized protocol", () => {
  it("accepts the same reviewed fixture as Rust", () => {
    const fixture: unknown = JSON.parse(readFileSync(fixturePath, "utf8"));
    expect(validateEnvelope(fixture)).toEqual({ ok: true, value: fixture });
  });

  it("accepts every shared valid fixture", () => {
    for (const filename of readdirSync(validFixtureDirectory)) {
      const fixture: unknown = JSON.parse(readFileSync(`${validFixtureDirectory}/${filename}`, "utf8"));
      expect(validateEnvelope(fixture), filename).toMatchObject({ ok: true });
    }
  });

  it.each([1, 3])("rejects schema version %d", (version) => {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
    expect(fixture.schemaVersion).toBe(2);
    fixture.schemaVersion = version;
    const result = validateEnvelope(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.instancePath === "/schemaVersion")).toBe(true);
    }
  });

  it("rejects dangling edge references after structural validation", () => {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      model: { edges: unknown[] };
    };
    fixture.model.edges.push({ id: "broken", source: "web", target: "missing" });
    const result = validateEnvelope(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.keyword === "dangling_edge_target")).toBe(true);
    }
  });

  it("rejects incompatible view kinds and model types", () => {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      view: { kind: string };
    };
    fixture.view.kind = "freeform";
    const result = validateEnvelope(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.keyword === "kind_model_mismatch")).toBe(true);
    }
  });

  it("rejects every shared invalid fixture", () => {
    for (const filename of readdirSync(invalidFixtureDirectory)) {
      const fixture: unknown = JSON.parse(readFileSync(`${invalidFixtureDirectory}/${filename}`, "utf8"));
      expect(validateEnvelope(fixture), filename).toMatchObject({ ok: false });
    }
  });

  // The kind/model fixtures are only meaningful if they are rejected *because*
  // of the cross-check. A validator that read `model.type` in isolation would
  // still reject some of them for unrelated reasons and look correct.
  it.each(["data-flow-kind-with-freeform-model.json", "c4-container-kind-with-sequence-model.json"])(
    "rejects %s for the kind/model cross-check specifically",
    (filename) => {
      const fixture: unknown = JSON.parse(readFileSync(`${invalidFixtureDirectory}/${filename}`, "utf8"));
      const result = validateEnvelope(fixture);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.map((error) => error.keyword)).toContain("kind_model_mismatch");
      }
    },
  );
});
