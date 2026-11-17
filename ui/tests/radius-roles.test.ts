// Corners by role (redesign slice 8; review D, "Geometry lacks shared role tokens"): every chrome corner is one of a
// few named roles -- a mark, a control, a card, a dialog, a pill, a cluster concentric with its tiles -- and the
// diagram's cards and panels are theirs. A notation's own outline (a C4 component's square corner, a state's or a
// rounded node's 16px that the layout ends wires on, a cylinder's ellipse) is geometry the export repeats, not a role,
// so it keeps its number.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { declarationsOf, readStylesheet, rulesOf, tokensOf } from "./stylesheet";

const SRC = resolve(__dirname, "..", "src");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return name.endsWith(".css") ? [path] : [];
  });

/** Outlines that are a notation's geometry, mirrored by the export painter or the layout. */
const GEOMETRY =
  /archer-c4-|archer-figure-|archer-state-|archer-shape-(?!rectangle)|archer-er-|archer-seq-|archer-journey-(?!section\b)|archer-node-hexagon|archer-node-diamond|cylinder|archer-state-mark/;

const ROLE = /^var\(--radius-[a-z-]+\)$/;
const isRoleValue = (value: string): boolean =>
  value
    .split("/")
    .flatMap((part) => part.trim().split(/\s+(?![^(]*\))/))
    .every((part) => part === "0" || part === "50%" || ROLE.test(part));

describe("corners", () => {
  it("are named roles on the root", () => {
    const tokens = tokensOf(readStylesheet(), ":root");
    expect(Object.fromEntries([...tokens].filter(([name]) => name.startsWith("--radius-")))).toEqual({
      "--radius-mark": "4px",
      "--radius-control": "6px",
      "--radius-card": "8px",
      "--radius-dialog": "12px",
      "--radius-pill": "999px",
      "--radius-cluster": "calc(var(--radius-control) + var(--icon-group-inset))",
      "--radius-node": "12px",
      "--radius-panel": "16px",
    });
  });

  it("are set by role in every stylesheet, but a notation's own outline", () => {
    const off: string[] = [];
    for (const file of files(SRC)) {
      const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const rule of rulesOf(css))
        for (const [property, value] of declarationsOf(rule.body)) {
          if (!/^border(-[a-z]+)*-radius$/.test(property)) continue;
          if (rule.selectors.every((selector) => GEOMETRY.test(selector))) continue;
          if (!isRoleValue(value))
            off.push(`${file.slice(SRC.length + 1)}: ${rule.selectors.join(", ")} { ${property}: ${value} }`);
        }
    }
    expect(off).toEqual([]);
  });

  it("round a diagram's card less than the panel round it", () => {
    const css = readStylesheet();
    const radius = (selector: string) =>
      declarationsOf(rulesOf(css).find((rule) => rule.selectors.includes(selector))!.body).find(
        ([property]) => property === "border-radius",
      )?.[1];
    expect(radius(".archer-node")).toBe("var(--radius-node)");
    expect(radius(".react-flow__node.archer-group:not(.archer-element-group)")).toBe("var(--radius-panel)");
  });
});
