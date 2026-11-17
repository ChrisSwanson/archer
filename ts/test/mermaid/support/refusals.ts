// A table of sources the profile refuses, each with every error it gives (as
// `code@line:column`, in report order), words its first error must say, and
// whether applying the hints fixes it. Shared by the per-type diagnostics
// tests of the state, ER, C4, architecture and journey profiles.

import { expect, test } from "vitest";
import { compile } from "../../../src/mermaid/index.ts";
import { applyHints, errorsOf, located } from "./compile-helpers.ts";

export interface Refusal {
  name: string;
  source: string;
  errors: string[];
  says?: string;
  hint?: string;
  fixedByHints?: boolean;
}

export function refusals(table: readonly Refusal[]): void {
  test.each(table)("$name", async ({ source, errors, says, hint, fixedByHints }) => {
    const result = await compile(source);
    expect(result.model).toBeNull();
    const found = errorsOf(result.diagnostics);
    expect(located(found)).toEqual(errors);
    if (says !== undefined) expect(found[0]?.message).toContain(says);
    if (hint !== undefined) expect(found[0]?.hint).toBe(hint);
    if (fixedByHints) {
      const fixed = await compile(applyHints(source, found));
      expect(errorsOf(fixed.diagnostics)).toEqual([]);
    }
  });
}
