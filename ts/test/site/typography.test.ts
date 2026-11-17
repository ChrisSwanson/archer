import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import MarkdownIt from "markdown-it";

const { JSDOM } = createRequire(import.meta.url)("jsdom");

it("wraps docs prose prettily while keeping code whitespace", () => {
  const markdown = new MarkdownIt();
  const document: Document = new JSDOM(
    `<div class="vp-doc">${markdown.render("A reading paragraph.\n\n- A reading list item.\n\n> A quotation.\n\n```text\n  verbatim\n```")}</div>`,
  ).window.document;
  const style = document.createElement("style");
  style.textContent = readFileSync(resolve(import.meta.dirname, "../../../site/.vitepress/theme/style.css"), "utf8");
  document.head.append(style);
  for (const prose of Array.from(document.querySelectorAll("p, li, blockquote")))
    expect(document.defaultView!.getComputedStyle(prose).getPropertyValue("text-wrap")).toBe("pretty");
  expect(document.defaultView!.getComputedStyle(document.querySelector("pre")!).whiteSpace).toBe("pre");
});
