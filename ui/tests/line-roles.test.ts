// Structural lines by role (redesign slice 8; review D, "Structural line roles are implicit"): the chrome's hairline
// and its strong line, a small mark's line, and the diagram's card, boundary, panel, selection and emphasis weights.
// Every border width under ui/src names one. (Focus outlines and SVG stroke weights are their own systems: the focus
// ring, and edge weight by notation.)
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

describe("lines", () => {
  it("are named roles on the root", () => {
    const tokens = tokensOf(readStylesheet(), ":root");
    expect(Object.fromEntries([...tokens].filter(([name]) => name.startsWith("--line-")))).toEqual({
      "--line-chrome": "1px",
      "--line-chrome-strong": "2px",
      "--line-mark": "1.5px",
      "--line-node": "1.5px",
      "--line-node-strong": "2px",
      "--line-boundary": "2px",
      "--line-panel": "1.5px",
      "--line-selected": "2.5px",
      "--line-emphasis": "3px",
    });
  });

  it("draw a Key's panel sample in the panel's line, a node sample in the node's (the sample is what members wear)", () => {
    const css = readStylesheet();
    const width = (selector: string) =>
      declarationsOf(
        rulesOf(css).find((rule) => rule.selectors.includes(selector) && /border-width/.test(rule.body))!.body,
      ).find(([property]) => property === "border-width")?.[1];
    expect(width('.archer-key-swatch[data-sample="group"]')).toBe("var(--line-panel)");
    expect(width(".archer-key-swatch")).toBe("var(--line-node)");
    expect(
      width(
        ".react-flow__node.archer-group.archer-group-nested, .react-flow__node.archer-group.archer-family-violet".split(
          ", ",
        )[1]!,
      ),
    ).toBe("var(--line-panel)");
  });

  it("are set by role in every stylesheet", () => {
    const off: string[] = [];
    for (const file of files(SRC)) {
      const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const rule of rulesOf(css))
        for (const [property, value] of declarationsOf(rule.body)) {
          if (!/^border(-(top|right|bottom|left|inline|block)(-(start|end))?)?(-width)?$/.test(property)) continue;
          if (/\d(\.\d+)?px/.test(value))
            off.push(`${file.slice(SRC.length + 1)}: ${rule.selectors.join(", ")} { ${property}: ${value} }`);
        }
    }
    expect(off).toEqual([]);
  });
});
