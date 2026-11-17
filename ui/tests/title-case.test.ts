// DESIGN.md "Titles": a title (page, panel, dialog, section or table heading) is in Title Case;
// buttons, menu items, labels, tooltips and messages stay in sentence case. This reads every
// heading element in ui/src whose text is a literal, plus the titles that reach a heading through a
// constant, and fails on a sentence-case title such as "Diagram key".
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(import.meta.dirname, "../src");
/** Words a title keeps lower case unless first or last: articles, short conjunctions and prepositions. */
const MINOR = new Set([
  "a",
  "an",
  "the",
  "and",
  "but",
  "or",
  "nor",
  "for",
  "so",
  "yet",
  "as",
  "at",
  "by",
  "in",
  "of",
  "off",
  "on",
  "per",
  "to",
  "up",
  "via",
  "with",
  "from",
  "into",
  "onto",
  "over",
]);

/** The words of `title` that should start with a capital and do not. */
function lowerCaseWords(title: string): string[] {
  const words = title.split(/\s+/).filter(Boolean);
  return words.filter((word, i) => {
    if (!/^[a-z]/.test(word)) return false; // capitalised, a symbol, a number, or code
    if (/[./]/.test(word)) return false; // a file or path name such as archer.toml
    const edge = i === 0 || i === words.length - 1;
    return edge || !MINOR.has(word.replace(/[^a-z]/g, ""));
  });
}

function sources(dir: string, pattern = /\.tsx$/): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path, pattern) : pattern.test(entry.name) ? [path] : [];
  });
}

type Found = { file: string; text: string };
/** A question or a sentence ending in a full stop is not a title. */
const titleLike = (text: string): boolean => text !== "" && !/[?.]$/.test(text);

/**
 * The string literals an expression can show: `a ? "New Diagram" : "Project Overview"`. Literals that
 * are only compared (`family === 'er'`) or are lookup keys (`.get("viewId")`) are not shown.
 */
function shownLiterals(expression: string): string[] {
  const shown = expression.replace(/[=!]==?\s*(["'])[^"'\n]*\1/g, "").replace(/\.get\(\s*(["'])[^"'\n]*\1\s*\)/g, "");
  return [...shown.matchAll(/(["'])([^"'\n]+)\1/g)].map((m) => m[2]!);
}

/** `export const HIGHLIGHTS = "Highlights";` anywhere in ui/src, by name. */
function stringConstants(): Map<string, string> {
  const constants = new Map<string, string>();
  for (const path of sources(SRC, /\.tsx?$/)) {
    for (const m of readFileSync(path, "utf8").matchAll(
      /\bconst ([A-Z][A-Z0-9_]*)\s*(?::\s*string\s*)?=\s*"([^"\n]+)"/g,
    ))
      constants.set(m[1]!, m[2]!);
  }
  return constants;
}

/**
 * Every heading whose text the source fixes: literal text (`<h2>Diagram Key</h2>`, also through a heading
 * component such as WalkList's `<Heading>`), the literals a heading expression can show
 * (`<h2>{sourceOnly ? 'Source Editing' : 'Diagram'}</h2>`) and an upper-case constant it names (`{HIGHLIGHTS}`).
 */
function literalHeadings(): Found[] {
  const found: Found[] = [];
  const constants = stringConstants();
  for (const path of sources(SRC)) {
    const file = relative(SRC, path);
    const text = readFileSync(path, "utf8");
    for (const m of text.matchAll(/<(h[1-6]|Heading)\b[^>]*>([^<]+)<\/\1>/g)) {
      const body = m[2]!;
      const parts = body.includes("{")
        ? [...body.matchAll(/\{([^{}]*)\}/g)].flatMap((e) => {
            const constant = /^\s*([A-Z][A-Z0-9_]*)\s*$/.exec(e[1]!)?.[1];
            return constant === undefined
              ? shownLiterals(e[1]!)
              : constants.has(constant)
                ? [constants.get(constant)!]
                : [];
          })
        : [body];
      for (const part of parts) {
        const heading = part.replace(/&amp;/g, "&").trim();
        if (titleLike(heading)) found.push({ file, text: heading });
      }
    }
  }
  return found;
}

/** Help sections (`{ section: "Chat with the Agent", keys: [...] }`) are the `?` dialog's `h3`s. */
function helpSections(): Found[] {
  return sources(SRC, /\.tsx?$/).flatMap((path) =>
    [...readFileSync(path, "utf8").matchAll(/\bsection:\s*"([^"\n]+)"/g)].map((m) => ({
      file: relative(SRC, path),
      text: m[1]!,
    })),
  );
}

/** The literals a page identity's `title` can show: the document bar's `h1` (`identity={{title: ...}}`). */
function identityTitles(): Found[] {
  const found: Found[] = [];
  for (const path of sources(SRC)) {
    const text = readFileSync(path, "utf8");
    for (const m of text.matchAll(/identity=\{\{\s*title:([\s\S]{0,4000})/g)) {
      // The title runs to the first top-level comma (the next identity field), across lines.
      let depth = 0,
        end = 0;
      for (const ch of m[1]!) {
        if ("([{".includes(ch)) depth++;
        else if (")]}".includes(ch)) {
          if (depth === 0) break;
          depth--;
        } else if (ch === "," && depth === 0) break;
        end++;
      }
      for (const t of shownLiterals(m[1]!.slice(0, end)))
        if (titleLike(t)) found.push({ file: relative(SRC, path), text: t });
    }
  }
  return found;
}

/** Titles that reach a heading or a region name through a string, not as literal heading text. */
const INDIRECT: readonly (readonly [string, string])[] = [
  ["diagrams/DiagramKey.tsx", "Diagram Key"],
  ["app/diagram-panel.tsx", "Diagram Key"],
  ["comments/ReviewPanel.tsx", "Notes and Comments"],
  ["comments/ReviewPanel.tsx", "Comments on This Diagram"],
  ["authoring/AuthoringWorkspace.tsx", "Source Editing"],
  ["app/SourcePanel.tsx", "Mermaid Source"],
];

describe("titles are in Title Case", () => {
  it("knows a sentence-case title from a Title Case one", () => {
    expect(lowerCaseWords("Diagram key")).toEqual(["key"]);
    expect(lowerCaseWords("Comments on this diagram")).toEqual(["this", "diagram"]);
    expect(lowerCaseWords("Diagram Key")).toEqual([]);
    expect(lowerCaseWords("Keyboard & Pointer")).toEqual([]);
    expect(lowerCaseWords("Notes and Comments")).toEqual([]);
    expect(shownLiterals(`a.get("viewId") ?? "New diagram" : k === 'er' ? 'Entities' : "Project overview"`)).toEqual([
      "New diagram",
      "Entities",
      "Project overview",
    ]);
  });

  it("every literal heading in the page", () => {
    const headings = literalHeadings();
    expect(headings.length).toBeGreaterThan(20);
    expect(headings.filter((h) => lowerCaseWords(h.text).length > 0)).toEqual([]);
  });

  it("every Help section title", () => {
    const sections = helpSections();
    expect(sections.length).toBeGreaterThan(8);
    expect(sections.filter((s) => lowerCaseWords(s.text).length > 0)).toEqual([]);
  });

  it("every page identity title", () => {
    const titles = identityTitles();
    expect(titles.map((t) => t.text)).toEqual(expect.arrayContaining(["Projects", "Archer"]));
    expect(titles.filter((t) => lowerCaseWords(t.text).length > 0)).toEqual([]);
  });

  it.each(INDIRECT)("%s names %s", (file, title) => {
    expect(lowerCaseWords(title)).toEqual([]);
    expect(readFileSync(join(SRC, file), "utf8")).toContain(title);
  });
});
