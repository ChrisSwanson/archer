// Every diagram Archer accepts must render in Mermaid itself (ticket 05): each
// ported fixture, exactly as written, parses in the pinned `mermaid` with no
// preprocessing of Archer's, as the type it claims to be.

import { expect, test } from "vitest";
import { parseWithMermaid } from "../../src/mermaid/engine.ts";
import { loadFixtures, MERMAID_TYPES } from "./support/fixtures.ts";

const fixtures = loadFixtures();

test.each(fixtures)("$name parses in real Mermaid", async ({ name, source }) => {
  const outcome = await parseWithMermaid(source, (diagram) => diagram.type);
  const family = name.split("/")[0] as keyof typeof MERMAID_TYPES;
  expect(outcome).toEqual({ ok: true, value: MERMAID_TYPES[family] });
});

test("the conformance check can fail: an old Archer edge ID does not parse in Mermaid", async () => {
  const outcome = await parseWithMermaid("flowchart LR\n  a[A]\n  b[B]\n  e1@a --> b\n", (diagram) => diagram.type);
  expect(outcome.ok).toBe(false);
});
