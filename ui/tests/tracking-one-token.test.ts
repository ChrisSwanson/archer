// Sans text is set on one tracking, `--type-tracking` (DESIGN, Typography): the root sets it once through
// `:where(*)`, and the only other value is the monospace stack's 0, written as the token so it still reaches
// every element of a code run. No rule sets its own `letter-spacing` (review, 2026-11-12: -0.01 to 0.08em
// overrides had crept in, most of them on uppercase eyebrows).
//
// And the side panel names its parts with headings, not eyebrows: the mode, the explore groups and the
// walkthrough groups are Title Case text on the ramp, not re-cased to capitals.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { rulesOf } from "./stylesheet";

const SRC = resolve(process.cwd(), "src");

const stylesheets = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return stylesheets(path);
    return name.endsWith(".css") ? [path] : [];
  });

const read = (path: string): string =>
  readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));

const declarations = (body: string, property: string): string[] =>
  [...body.matchAll(new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*([^;]+)`, "g"))].map((m) => m[1].trim());

describe("tracking", () => {
  const sheets = stylesheets(SRC).map((path) => ({ name: relative(SRC, path), rules: rulesOf(read(path)) }));

  it("is set only from the token, once, at no specificity", () => {
    const own: string[] = [];
    for (const { name, rules } of sheets)
      for (const rule of rules)
        for (const value of declarations(rule.body, "letter-spacing"))
          if (!(value === "var(--type-tracking)" && rule.selectors.join(",") === ":where(*)"))
            own.push(`${name}: ${rule.selectors.join(", ")} { letter-spacing: ${value} }`);
    expect(own).toEqual([]);
  });

  it("has two values: the root's 0.04em, and 0 for the monospace stack", () => {
    const odd: string[] = [];
    for (const { name, rules } of sheets)
      for (const rule of rules)
        for (const value of declarations(rule.body, "--type-tracking")) {
          const root = rule.selectors.join(",") === ":root" && value === "0.04em";
          const mono = value === "0" && /font-family\s*:\s*var\(--font-mono\)/.test(rule.body);
          if (!root && !mono) odd.push(`${name}: ${rule.selectors.join(", ")} { --type-tracking: ${value} }`);
        }
    expect(odd).toEqual([]);
  });
});

describe("the side panel's headings", () => {
  const panel = rulesOf(read(join(SRC, "app/diagram-panel.css")));
  const walk = rulesOf(read(join(SRC, "walkthroughs/walkthroughs.css")));
  const HEADINGS = [".archer-panel-mode", ".archer-panel-explore h3", ".archer-walk h3", ".archer-walk h2"];

  it.each(HEADINGS)("%s is not re-cased to capitals", (selector) => {
    const rules = [...panel, ...walk].filter((rule) => rule.selectors.includes(selector));
    expect(rules.length, selector).toBeGreaterThan(0);
    for (const rule of rules) expect(declarations(rule.body, "text-transform"), selector).toEqual([]);
  });
});
