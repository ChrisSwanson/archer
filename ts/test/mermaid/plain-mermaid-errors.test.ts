// Plain Mermaid that the profile cannot read, pasted from elsewhere: each is
// reported where it is written, with a message that names the fix, rather
// than as Mermaid's own parser complaint.

import { describe, expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import { errorsOf, located } from "./support/compile-helpers.ts";

const F = (body: string) => `flowchart LR\n${body}\n`;

async function errors(source: string) {
  return errorsOf((await compile(source)).diagnostics);
}

describe("flowchart", () => {
  test("`end` as a node ID is named as a reserved word, with another ID to use", async () => {
    const found = await errors(F("  a[A]\n  a e1@--> end\n  end[Finish]"));
    expect(located(found)).toEqual(["invalid_id@3:12", "invalid_id@4:3"]);
    for (const diagnostic of found) {
      expect(diagnostic.message).toContain("`end` is a reserved word");
      expect(diagnostic.message).toContain("another ID");
    }
  });

  test("a reserved word Mermaid reads as an ID is not refused", async () => {
    expect(await errors(F("  a[A]\n  endpoint[End]\n  a e1@--> endpoint"))).toEqual([]);
  });
});
