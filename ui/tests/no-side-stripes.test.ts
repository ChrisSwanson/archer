// No coloured side-stripe accents (Impeccable's detector, redesign slice 8): a thick left edge or an inset left bar
// in a status colour reads as decoration and as colour alone. Each status says itself another way -- a full border,
// a background tint, an icon or words -- so it survives greyscale without a stripe. A note's blockquote keeps its
// neutral quote rule: that is typography, not a status.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "src");
function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return name.endsWith(".css") ? [path] : [];
  });
}

/** Every rule body in a stylesheet with the selector it belongs to (flat; at-rule wrappers are skipped). */
function rules(css: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g))
    out.push({ selector: match[1]!.trim(), body: match[2]! });
  return out;
}

const STRIPE = [
  /border-left\s*:\s*[2-9](?:\.\d+)?px/,
  /border-left-width\s*:\s*[2-9](?:\.\d+)?px/,
  /border-inline-start(?:-width)?\s*:\s*[2-9]/,
  /inset\s+[1-9](?:\.\d+)?px\s+0(?:px)?\s+0/,
];

describe("side stripes", () => {
  it("are not used as an accent anywhere in the page's stylesheets", () => {
    const found: string[] = [];
    for (const file of cssFiles(SRC))
      for (const { selector, body } of rules(readFileSync(file, "utf8"))) {
        if (selector.endsWith("blockquote")) continue;
        if (STRIPE.some((pattern) => pattern.test(body))) found.push(`${file.slice(SRC.length + 1)}: ${selector}`);
      }
    expect(found).toEqual([]);
  });

  it("are taken off the editor's diagnostics, which CodeMirror draws with one by default", () => {
    const css = readFileSync(join(SRC, "source-editor", "source-editor.css"), "utf8");
    expect(css).toMatch(/\.cm-diagnostic \{[^}]*border-left:\s*0/);
  });
});
