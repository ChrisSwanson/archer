import { expect, test } from "vitest";
import { validate, type Schema } from "../../src/application/arguments.ts";
import { OPERATIONS } from "../../src/application/tools.ts";

test("shared input validation enforces nullable string schemas", () => {
  const schema = {
    type: "object",
    properties: { active: { type: ["string", "null"], minLength: 1, maxLength: 200 } },
    additionalProperties: false,
  } as unknown as Schema;
  for (const active of [null, "held"]) expect(validate(schema, { active }).empty).toBe(true);
  for (const active of [false, {}, [], 7, ""]) expect(validate(schema, { active }).empty).toBe(false);
});
test("export discovery describes its nullable emphasis identifier completely", () => {
  expect(OPERATIONS.find((op) => op.name === "export_diagram")!.inputSchema.properties!.activeEmphasisId).toMatchObject(
    { type: ["string", "null"], minLength: 1, maxLength: 200 },
  );
});

test("export discovery accepts only booleans for the optional notice-caption switch", () => {
  const schema = OPERATIONS.find((op) => op.name === "export_diagram")!.inputSchema;
  for (const noticeCaption of [true, false])
    expect(validate(schema, { viewId: "flow", noticeCaption }).empty).toBe(true);
  for (const noticeCaption of [null, "true", 1, {}])
    expect(validate(schema, { viewId: "flow", noticeCaption }).empty).toBe(false);
});
