import { afterEach, expect, test } from "vitest";
import { findProject, historicalRegistry } from "../../src/project/project.ts";
import { MAX_DESCRIPTION_CHARS } from "../../src/project/describe.ts";
import { removeTempDirs, tempDir } from "./support.ts";

afterEach(removeTempDirs);

test("project descriptions load as optional trimmed metadata without losing registry settings", () => {
  const text =
    'version=1\nname="Example"\ndescription="  Shared project context.  "\nfolder="knowledge"\n[service]\nname="example"\n[discovery]\nroots=[]\n[[views]]\nid="flow"\nkind="freeform"\ntitle="Flow"\nsource="knowledge/flow.mmd"\n';
  const expected = {
    name: "Example",
    description: "Shared project context.",
    folderSetting: "knowledge",
    serviceName: "example",
    discovery: { roots: [] },
    views: [{ id: "flow", kind: "freeform", title: "Flow", source: "flow.mmd" }],
    problems: [],
  };
  expect(findProject(tempDir({ "archer.toml": text }))).toMatchObject(expected);
  expect(historicalRegistry(text, "/project")).toMatchObject(expected);
});

test.each([undefined, "", "   "])("empty or absent description %s remains absent", (description) => {
  const text = `version=1\n${description === undefined ? "" : `description=${JSON.stringify(description)}\n`}`;
  expect(findProject(tempDir({ "archer.toml": text }))).not.toHaveProperty("description");
});

test("description limit counts Unicode code points and refuses oversized text", () => {
  const text = "🚀".repeat(MAX_DESCRIPTION_CHARS);
  expect(findProject(tempDir({ "archer.toml": `version=1\ndescription="${text}"\n` }))).toHaveProperty(
    "description",
    text,
  );
  expect(() => findProject(tempDir({ "archer.toml": `version=1\ndescription="${text}a"\n` }))).toThrow(
    /description.*500/,
  );
});

test.each(["1", "true"])("description rejects wrong type %s", (value) => {
  expect(() => findProject(tempDir({ "archer.toml": `version=1\ndescription=${value}\n` }))).toThrow(
    /description.*quoted/,
  );
});

test.each(["[]", "{}"])("description rejects unsupported TOML composite %s", (value) => {
  expect(() => findProject(tempDir({ "archer.toml": `version=1\ndescription=${value}\n` }))).toThrow(/cannot be used/);
});

test("adding description does not accept unrelated manifest settings", () => {
  expect(() => findProject(tempDir({ "archer.toml": 'version=1\ndescription="Context"\nunknown="bad"\n' }))).toThrow(
    /unknown project setting/,
  );
});
