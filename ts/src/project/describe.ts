// What a diagram or note is about, in a sentence or two, for the project page
// and the search page (the projects-and-search design).
//
// Declared first, then derived:
//
// - a NOTE declares it in its front matter, `description: ...`; failing that,
//   it is the first paragraph of prose after the front matter and the title;
// - a DIAGRAM declares it in a `%% description: ...` comment before its
//   header (a Mermaid comment, so the file stays plain Mermaid and the
//   description moves with it); failing that, it is the other `%%` comment
//   lines before the header.
//
// A derived description is cut to DESCRIPTION_CHARS at a word; a declared one
// is cut only at MAX_DESCRIPTION_CHARS. Every scan is linear in the text: a
// file in the Archer folder is untrusted.
import MarkdownIt from "markdown-it";
import { readConfined } from "./confined-fs.ts";
import { MAX_SOURCE_BYTES } from "../mermaid/limits.ts";
import { splitFrontMatter } from "./inventory.ts";

// HTML is recognized only to omit its blocks; descriptions never render it.
const markdown = new MarkdownIt({ html: true, linkify: false, typographer: false });

/** Where a description came from: the note's front matter, the diagram's `%% description:` line, or the text. */
export type DescriptionSource = "frontmatter" | "comment" | "derived";

export interface Description<From extends DescriptionSource = DescriptionSource> {
  readonly description: string;
  readonly descriptionFrom: From;
}

/** A derived description is about this long. */
export const DESCRIPTION_CHARS = 160;
/** A declared description longer than this is cut. */
export const MAX_DESCRIPTION_CHARS = 500;
/** Only the start of a file is read for its description. */
const SCAN_LINES = 200;
/** ...and of a paragraph, only this many characters. */
const SCAN_CHARS = 4 * MAX_DESCRIPTION_CHARS;

const DECLARED = /^description\s*:\s*/i;

/** `text` with runs of whitespace as one space, cut to `limit` characters at a word, with an ellipsis when cut. */
export function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  if (chars.length <= limit) return flat;
  const cut = chars.slice(0, limit - 1).join("");
  const space = cut.lastIndexOf(" ");
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/** A diagram's description, or null when it has none. */
export function diagramDescription(source: string): Description<"comment" | "derived"> | null {
  const comments: string[] = [];
  const lines = source.replace(/^﻿/, "").split(/\r?\n/, SCAN_LINES);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (!trimmed.startsWith("%%")) break; // the header: the comments before it are all there are
    if (trimmed.startsWith("%%{")) continue; // an init directive, not prose
    const text = trimmed.slice(2).trim();
    if (/^archer-[\w-]*\s*:/i.test(text)) continue; // Archer's own line (`%% archer-id:` names an embedded diagram)
    if (DECLARED.test(text)) {
      const declared = clip(text.replace(DECLARED, ""), MAX_DESCRIPTION_CHARS);
      if (declared !== "") return { description: declared, descriptionFrom: "comment" };
      continue;
    }
    if (text !== "") comments.push(text.slice(0, SCAN_CHARS));
  }
  const derived = clip(comments.join(" "), DESCRIPTION_CHARS);
  return derived === "" ? null : { description: derived, descriptionFrom: "derived" };
}

/** A note's description, or null when it has none. */
export function noteDescription(text: string): Description<"frontmatter" | "derived"> | null {
  const { fields, body } = splitFrontMatter(text);
  const declared = fields.description === undefined ? "" : clip(fields.description, MAX_DESCRIPTION_CHARS);
  if (declared !== "") return { description: declared, descriptionFrom: "frontmatter" };
  const derived = clip(firstParagraph(body), DESCRIPTION_CHARS);
  return derived === "" ? null : { description: derived, descriptionFrom: "derived" };
}

/** The first prose paragraph in a project README, whether it precedes headings or follows them. */
export function projectDescription(source: string): string | undefined {
  return noteDescription(source.replace(/^\uFEFF/, ""))?.description;
}

/** Read only a bounded regular README at the real project root; symlinks and invalid UTF-8 are omitted. */
export function readProjectDescription(root: string): string | undefined {
  try {
    // The confined seam (G6): a regular file with one name, no link, read from its descriptor.
    const bytes = readConfined(root, ["README.md"], { shown: "README.md", limit: MAX_SOURCE_BYTES });
    return projectDescription(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

/** The first prose paragraph, using the same Markdown grammar as notes and their fences. */
function firstParagraph(source: string): string {
  // Bound both the number of lines and the parser's input before tokenizing.
  const prefix = source
    .slice(0, SCAN_LINES * SCAN_CHARS)
    .split(/\r?\n/, SCAN_LINES)
    .map((line) => line.slice(0, SCAN_CHARS))
    .join("\n");
  const tokens = markdown.parse(prefix, {});
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]?.type !== "paragraph_open") continue;
    const inline = tokens[i + 1];
    if (inline?.type !== "inline") continue;
    const words = (inline.children ?? [])
      .map((token) =>
        token.type === "text" || token.type === "code_inline"
          ? token.content
          : token.type === "softbreak" || token.type === "hardbreak"
            ? " "
            : "",
      )
      .join("");
    if (words.trim() !== "") return words.slice(0, SCAN_CHARS);
  }
  return "";
}
