// What selection, emphasis and comments anchor to in each model: every ID the
// model holds is a node or a link of elementsOf, with nothing invented, for
// every model type the compiler emits beyond the flowchart's and sequence's.

import { expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import { elementsOf, type PointModel } from "../../src/model/index.ts";
import { loadFixtures } from "./support/fixtures.ts";

/** Every `id` anywhere in the model, by a walk that knows no model type. */
function idsIn(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) idsIn(item, into);
  else if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record["id"] === "string") into.push(record["id"]);
    for (const [key, item] of Object.entries(record)) if (key !== "id") idsIn(item, into);
  }
  return into;
}

const fixtures = loadFixtures().filter((fixture) => !/^(sequence|flowchart)\//.test(fixture.name));

test.each(fixtures)("$name: every ID is a node or a link, and every link joins nodes", async ({ source }) => {
  const { model } = await compile(source);
  expect(model).not.toBeNull();
  const { nodes, links } = elementsOf(model as PointModel);
  const named = [...nodes.map((n) => n.id), ...links.map((l) => l.id)];
  expect(named.sort()).toEqual(idsIn(model).sort());
  const ids = new Set(nodes.map((n) => n.id));
  for (const link of links) expect(ids.has(link.source) && ids.has(link.target), link.id).toBe(true);
});
