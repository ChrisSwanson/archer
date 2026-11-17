// Every ported golden fixture compiles, with no error, to exactly its .json
// model, and that model conforms to the envelope schema.

import { describe, expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import { checkAgainst } from "./support/schema.ts";
import { FIXTURE_FAMILIES, listFixtureFiles, loadFixtures } from "./support/fixtures.ts";

const fixtures = loadFixtures();

test("the fixture set is the one ported from the repository's golden fixtures", () => {
  expect(fixtures.map((fixture) => fixture.name)).toEqual([
    "flowchart/groups",
    "flowchart/labels",
    "flowchart/minimal",
    "flowchart/shapes",
    "flowchart/widened",
    "sequence/full",
    "sequence/minimal",
    "sequence/names",
    "sequence/text",
    "sequence/widened",
    "state/minimal",
    "state/widened",
    "er/minimal",
    "er/widened",
    "c4/minimal",
    "c4/nested",
    "c4/widened",
    "architecture/minimal",
    "architecture/widened",
    "journey/minimal",
    "journey/widened",
  ]);
});

test.each(FIXTURE_FAMILIES)("every %s .mmd has a .json and every .json an .mmd", (family) => {
  const files = listFixtureFiles(family);
  const stems = (extension: string) =>
    files.filter((file) => file.endsWith(extension)).map((file) => file.slice(0, -extension.length));
  expect(stems(".mmd")).toEqual(stems(".json"));
});

describe.each(fixtures)("$name", ({ source, expected }) => {
  test("compiles to its golden model", async () => {
    const result = await compile(source);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(result.model).toEqual(expected);
  });

  test("its golden model conforms to the envelope schema", () => {
    expect(checkAgainst("DiagramModel", expected)).toEqual([]);
  });
});
