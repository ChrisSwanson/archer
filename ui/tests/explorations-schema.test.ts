// The Expand menu's captured answers (ts/src/expand/menu.ts, written by the service's own code: ui/tests/fixtures/expand)
// against schema/explorations.v1.schema.json, under AJV 2020 strict, with the frozen envelope schema beside it.
import { readFileSync, readdirSync } from "node:fs";
import { expect, test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import envelope from "../../schema/diagram-envelope.schema.json";
import explorations from "../../schema/explorations.v1.schema.json";

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema({ ...envelope, $id: "diagram-envelope.schema.json" });
const menu = ajv.compile({
  ...explorations,
  $id: "explorations.v1.schema.json",
  oneOf: undefined,
  $ref: "#/$defs/ExpandMenu",
});

const dir = new URL("./fixtures/expand/", import.meta.url);
test.each(readdirSync(dir).filter((name) => name.startsWith("menu-")))("captured %s is an ExpandMenu", (name) => {
  const ok = menu(JSON.parse(readFileSync(new URL(name, dir), "utf8")));
  expect(menu.errors ?? []).toEqual([]);
  expect(ok).toBe(true);
});

// Slice 8 (P35–P37): routes 2 and 3 and the agent's report, captured from the service (ts/src/expand/exploration.ts).
// `menu` registered the schema under its $id; the other definitions are reached through it.
const exploration = ajv.compile({ $ref: "explorations.v1.schema.json#/$defs/Exploration" });
const report = ajv.compile({ $ref: "explorations.v1.schema.json#/$defs/ExplorationReport" });
test.each(readdirSync(dir).filter((name) => name.startsWith("exploration-") || name.startsWith("report-")))(
  "captured %s conforms",
  (name) => {
    const check = name.startsWith("report-") ? report : exploration;
    const ok = check(JSON.parse(readFileSync(new URL(name, dir), "utf8")));
    expect(check.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  },
);

test("the whole schema compiles strict", () => {
  expect(() =>
    new Ajv2020({ strict: true })
      .addSchema({ ...envelope, $id: "diagram-envelope.schema.json" })
      .compile({ ...explorations, $id: "explorations.v1.schema.json" }),
  ).not.toThrow();
});
