// A page that receives a model type it does not draw says WHICH, by name,
// rather than reciting the schema's complaints about fields it has never
// heard of. The page the Rust server embeds is this page; it never receives
// the newer types, but a page older than its server can.
import { describe, expect, it } from "vitest";
import { DRAWN_MODEL_TYPES, projectEnvelope } from "../src/diagrams/projection";

const envelope = (model: Record<string, unknown>) => ({
  schemaVersion: 2,
  view: { id: "v", kind: "freeform", title: "V" },
  revision: `sha256:${"c".repeat(64)}`,
  model,
});

describe("a model type this page does not draw", () => {
  it("is refused with one error that names the type", () => {
    const projection = projectEnvelope(envelope({ type: "mindmap", root: { id: "a" } }));
    expect(projection).toEqual({
      ok: false,
      errors: [
        {
          code: "unknown_model_type",
          message:
            'This page cannot draw a diagram of type "mindmap". It may be older than the server that sent it; reload the page.',
        },
      ],
    });
  });

  it("is every type the schema does not list, and none it does", () => {
    for (const type of DRAWN_MODEL_TYPES) {
      const projection = projectEnvelope(envelope({ type }));
      // Refused for its missing fields, not for its type.
      expect(projection.ok ? [] : projection.errors.map((e) => e.code)).not.toContain("unknown_model_type");
    }
  });
});
