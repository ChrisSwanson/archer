// The TOML Archer reads in archer.toml: top-level keys, [tables] and
// [[arrays of tables]] holding strings, integers and booleans. Anything else
// is refused with its line, never misread.
import { expect, test } from "vitest";
import { parseToml, TomlError } from "../../src/project/toml.ts";

test("preserves prototype-named keys as ordinary own fields for schema validation", () => {
  const doc = parseToml('version = 1\n[service]\n__proto__ = "forbidden"\n');
  const service = doc["service"] as Record<string, unknown>;
  expect(Object.hasOwn(service, "__proto__")).toBe(true);
  expect(service["__proto__"]).toBe("forbidden");
  const table = parseToml('[__proto__]\nname = "ordinary"\n');
  expect(Object.hasOwn(table, "__proto__")).toBe(true);
});

test("reads top-level keys and arrays of tables", () => {
  const doc = parseToml(
    [
      "# a comment",
      "version = 1",
      'folder = ".archer" # trailing comment',
      "",
      "[[views]]",
      'id = "auth"',
      "title = 'Auth # flow'",
      "[[views]]",
      '"id" = "two"',
      "pinned = true",
      "[other]",
      "x = -3",
    ].join("\n"),
  );
  expect(doc).toEqual({
    version: 1,
    folder: ".archer",
    views: [
      { id: "auth", title: "Auth # flow" },
      { id: "two", pinned: true },
    ],
    other: { x: -3 },
  });
});

test("decodes basic-string escapes", () => {
  expect(parseToml('a = "q\\"b\\\\s\\t\\u00e9\\U0001F600"')).toEqual({ a: 'q"b\\s\té😀' });
});

test("accepts CRLF line endings and a byte-order mark", () => {
  expect(parseToml('﻿version = 1\r\nfolder = "x"\r\n')).toEqual({ version: 1, folder: "x" });
});

test.each([
  ["a = [1, 2]", 1, /array/],
  ['a = """x"""', 1, /multi-line/],
  ["a = { b = 1 }", 1, /inline table/],
  ["a.b = 1", 1, /dotted/],
  ["version = 1\nversion = 2", 2, /twice/],
  ['a = "open', 1, /string/],
  ["a = 1.5", 1, /value/],
  ["just words", 1, /key = value/],
  ["[[views]]\nid = 1\n[views]", 3, /views/],
  ['a = "x" junk', 1, /after/],
  ['a = "\\q"', 1, /escape/],
])("refuses %j at line %i", (text, line, message) => {
  let caught: unknown;
  try {
    parseToml(text);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TomlError);
  expect((caught as TomlError).line).toBe(line);
  expect((caught as TomlError).message).toMatch(message);
});
