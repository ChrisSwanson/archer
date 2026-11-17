// Reading `src/styles.css` as text, for the tests that assert on a DESIGN.
//
// Text rather than jsdom's CSSOM for the reason `canvas-theme.test.tsx` gives:
// jsdom resolves no `var()` and drops declarations it does not recognise, so a
// rendered value proves nothing. `canvas-theme.test.tsx` keeps its own copy of
// the token parser on purpose -- it pins the Current design and is left alone.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const STYLESHEET = "src/styles.css";

/** The stylesheet with comments blanked in place, so offsets and lines stay true. */
export function readStylesheet(): string {
  return readFileSync(resolve(process.cwd(), STYLESHEET), "utf8").replace(/\/\*[\s\S]*?\*\//g, (block) =>
    block.replace(/[^\n]/g, " "),
  );
}

export type Rule = {
  /** The selector list as written, whitespace collapsed. */
  readonly selectors: readonly string[];
  readonly body: string;
  /** Offset of the rule's first selector in the stylesheet. */
  readonly index: number;
};

/**
 * Every style rule, including those nested one level inside an at-rule.
 *
 * At-rule preludes (`@media ...`, `@keyframes ...`) are not rules themselves;
 * keyframe stops (`0%`, `50%`) are reported with those as their selectors and
 * are easy to tell apart, since none starts with a letter, `.` or `:`.
 */
export function rulesOf(css: string): Rule[] {
  const rules: Rule[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const prelude = match[1];
    // A nested rule's prelude arrives clean: the regex cannot match across the
    // at-rule's own `{`, so it starts after it. What is left to drop is a flat
    // at-rule such as `@font-face`.
    if (prelude.trim().startsWith("@")) continue;
    const selectors = splitSelectors(prelude);
    rules.push({ selectors, body: match[2], index: match.index + (prelude.length - prelude.trimStart().length) });
  }
  return rules;
}

/** A selector list split on its top-level commas: `:not(.a, .b)` is one selector. */
export function splitSelectors(list: string): string[] {
  const selectors: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of list) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      selectors.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  selectors.push(current);
  return selectors.map((selector) => selector.replace(/\s+/g, " ").trim()).filter((selector) => selector.length > 0);
}

/** The declarations of one rule body, in order. */
export function declarationsOf(body: string): Array<readonly [property: string, value: string]> {
  const found: Array<readonly [string, string]> = [];
  for (const declaration of body.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    const property = declaration.slice(0, colon).trim();
    if (property.length === 0) continue;
    found.push([
      property,
      declaration
        .slice(colon + 1)
        .replace(/\s+/g, " ")
        .trim(),
    ]);
  }
  return found;
}

/**
 * A declared value with a root token followed to what it names: `var(--type-canvas-kind)` is `11px`. Anything that is
 * not a single `var(--name)` comes back as written.
 */
export function throughTokens(css: string, value: string): string {
  const root = tokensOf(css, ":root");
  let resolved = value;
  for (let hops = 0; hops < 4; hops += 1) {
    const token = /^var\((--[\w-]+)\)$/.exec(resolved.trim());
    if (token === null) break;
    const next = root.get(token[1]!);
    if (next === undefined) break;
    resolved = next;
  }
  return resolved;
}

/** The custom properties declared by the first rule one of whose selectors is exactly `selector`. */
export function tokensOf(css: string, selector: string): Map<string, string> {
  const rule = rulesOf(css).find((candidate) => candidate.selectors.includes(selector));
  const declared = new Map<string, string>();
  if (rule === undefined) return declared;
  for (const [property, value] of declarationsOf(rule.body)) {
    if (property.startsWith("--")) declared.set(property, value);
  }
  return declared;
}
