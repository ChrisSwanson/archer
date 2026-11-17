// One design (phase 3b): the stylesheet has no rule keyed to another design, and embeds one face.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("one design, and nothing keyed to another", () => {
  const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

  it("has no rule scoped to a design", () => {
    expect(css).not.toMatch(/data-design/);
  });

  it("embeds one face, Fira Sans, and no other", () => {
    expect(css).not.toMatch(/Lexend/);
    expect(css).not.toMatch(/"Inter"/);
    const main = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8");
    expect(main).toContain("./theme/current-font.css");
    expect(main).not.toContain("line-map");
  });
});
