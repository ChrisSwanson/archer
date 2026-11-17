// The repository's own AGENTS.md Archer block keeps the rule `archer init` writes for every
// project: read the docs before changing what they describe, and offer to update stale ones.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { pointerSection } from "../../src/project/init.ts";

const rule = (text: string) => /Use them as reference documentation[\s\S]*?\.\n/.exec(text)?.[0];

test("the repository's Archer block states init's reference-documentation rule", () => {
  const agents = readFileSync(new URL("../../../AGENTS.md", import.meta.url), "utf8");
  expect(rule(pointerSection(".archer"))).toMatch(/offer to update the ones it makes stale/);
  expect(rule(agents)).toBe(rule(pointerSection(".archer")));
});
