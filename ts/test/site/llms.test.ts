import { describe, expect, it } from "vitest";
import { renderLlms } from "../../../site/scripts/llms.mts";

const pages = [
  {
    path: "install",
    title: "Install Archer",
    summary: "Install from a verified GitHub Release with Node 22.18 or newer.",
    markdown:
      "---\ntitle: Install\n---\n<!-- Generated from docs/install.md -->\n# Install Archer\n\n[CLI](/generated/cli#setup)\n\n::: details Build from source\n```sh\nnpm ci\n```\n:::\n",
  },
  {
    path: "generated/cli",
    title: "CLI reference",
    summary: "Commands, options and examples from the installed CLI.",
    markdown: "# CLI reference\n\n## setup\n\n[Install](../install.md)\n\n```sh\narcher setup --mcp\n```\n",
  },
];

describe("machine-readable documentation", () => {
  it("indexes every admitted page with a canonical deployment URL and a one-line summary", () => {
    const { index, full } = renderLlms(pages, "/archer/");
    expect(index).toContain("# Archer");
    expect(index).toContain(
      "[Install Archer](https://chrisswanson.github.io/archer/install): Install from a verified GitHub Release",
    );
    expect(index).toContain("[CLI reference](https://chrisswanson.github.io/archer/generated/cli): Commands, options");
    expect(full).toContain("archer setup --mcp");
    expect(full).toContain("https://chrisswanson.github.io/archer/generated/cli#setup");
    expect(full).toContain("https://chrisswanson.github.io/archer/install");
    expect(full).toContain("npm ci");
    expect(full).toContain("Build from source");
    expect(full).not.toMatch(/Generated from|title: Install|:::|<script/);
    expect(renderLlms(pages, "/archer/")).toEqual({ index, full });
  });

  it("honors root and nested deployment bases", () => {
    expect(renderLlms(pages, "/").index).toContain("https://chrisswanson.github.io/install");
    expect(renderLlms(pages, "/docs/archer/").full).toContain(
      "https://chrisswanson.github.io/docs/archer/generated/cli#setup",
    );
  });

  it("refuses missing summaries and duplicate routes rather than publishing an incomplete index", () => {
    expect(() => renderLlms([{ ...pages[0]!, summary: "" }], "/")).toThrow(/summary/);
    expect(() => renderLlms([pages[0]!, pages[0]!], "/")).toThrow(/duplicate/);
  });
});

it("preserves Markdown-looking text inside code examples", () => {
  const result = renderLlms([{ ...pages[0]!, markdown: "# Example\n\n```md\n[Example](/usage)\n```\n" }], "/archer/");
  expect(result.full).toContain("[Example](/usage)");
});

it("keeps comments and presentation-like syntax in fenced source verbatim", () => {
  const code = "```md\n<!-- source comment -->\n::: details Example\n[Usage](/usage)\n:::\n```";
  const result = renderLlms([{ ...pages[0]!, markdown: `# Example\n\n${code}\n` }], "/archer/");
  expect(result.full).toContain(code);
});
