// The Rust 0.3.0 golden fixtures, unchanged, are Archer's old syntax. Each is
// refused only with `legacy_syntax` diagnostics, and replacing each refused
// line by its hint, as an agent would, gives a source that compiles to the
// fixture's golden model: the rewrites the diagnostics show are complete and
// correct. The edge-ID-first form (`e1@a --> b`) has no hint since 0.15, so
// fixtures that use it are not among these.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import { applyHints, errorsOf } from "./support/compile-helpers.ts";

const RUST_FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const PORTED = fileURLToPath(new URL("../fixtures/", import.meta.url));

const cases = ["flowchart", "sequence"].flatMap((family) =>
  readdirSync(`${RUST_FIXTURES}${family}`)
    .filter((file) => file.endsWith(".mmd"))
    .map((file) => ({
      name: `${family}/${file}`,
      source: readFileSync(`${RUST_FIXTURES}${family}/${file}`, "utf8"),
      expected: JSON.parse(readFileSync(`${PORTED}${family}/${file.replace(".mmd", ".json")}`, "utf8")) as unknown,
    }))
    .filter(({ source }) => !/^\s*[A-Za-z_][\w-]*@[A-Za-z_]/m.test(source)),
);

/** `names.mmd` renames its keyword participants; the rename the hint offers is `actor1`, not the port's `actors`. */
function renamedAsHinted(model: unknown): unknown {
  return JSON.parse(JSON.stringify(model).replace(/"(actor|note|rect|box)(es|s)"/g, '"$11"'));
}

test.each(cases)("$name: refused only as old syntax, and its hints migrate it", async ({ name, source, expected }) => {
  // A report lists at most 20 problems, so a file with more takes more than
  // one round, as it would for an agent.
  let current = source;
  for (let round = 0; round < 5; round += 1) {
    const errors = errorsOf((await compile(current)).diagnostics);
    if (errors.length === 0) break;
    const actionable = errors.filter((diagnostic) => diagnostic.code !== "too_many_diagnostics");
    expect(actionable.map((diagnostic) => diagnostic.code)).toEqual(actionable.map(() => "legacy_syntax"));
    for (const diagnostic of actionable) expect(diagnostic.hint).toBeDefined();
    current = applyHints(current, actionable);
  }
  const after = await compile(current);
  expect(errorsOf(after.diagnostics)).toEqual([]);
  expect(after.model).toEqual(name === "sequence/names.mmd" ? renamedAsHinted(expected) : expected);
});

test("the old fixtures do need migrating", async () => {
  const refused = await Promise.all(cases.map(async ({ source }) => (await compile(source)).model === null));
  expect(refused.filter(Boolean).length).toBeGreaterThanOrEqual(4);
});
