import { expect, test } from "vitest";
import { sourcePreviewEnvelope } from "../src/app/source-document-paint";
import { loadValidFixture } from "./fixtures";
test("preview adapter validates production models without assigning service identities", () => {
  const fixture = loadValidFixture("minimal-freeform.json") as { model: unknown; revision: string };
  expect(sourcePreviewEnvelope(fixture, "Example")).toMatchObject({
    schemaVersion: 2,
    model: fixture.model,
    revision: fixture.revision,
    view: { id: "document-preview", title: "Example" },
  });
  for (const value of [
    null,
    [],
    {},
    { model: { type: "sequence-trace" }, revision: fixture.revision },
    { model: fixture.model, revision: "wrong" },
  ])
    expect(sourcePreviewEnvelope(value, "Example")).toBeNull();
});
