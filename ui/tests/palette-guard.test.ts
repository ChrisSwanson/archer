// There is exactly ONE theme token set, and every surface uses it.
//
// This guard exists because that invariant already broke once, silently:
// `SequenceCanvas` grew its own `COLORS` object holding a LIGHT slate palette
// while the graph canvas was dark, so the two canvases disagreed with each
// other and the sequence one was barely legible on its own background. Nothing
// prevented it, and nothing noticed. A per-component palette is not a style
// choice, it is drift.
//
// So: a raw colour may appear only in the token-definition blocks of
// `src/styles.css`. Everywhere else in `src/` -- components, adapters, CSS
// rules -- refers to `var(--token)`. A canvas that needs a colour role the set
// does not have ADDS A TOKEN, defined for both themes, rather than a local
// constant.
//
// The failure messages name file, line and literal on purpose: the next person
// to trip this should get a fix, not a puzzle.
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = "src";
const STYLESHEET = "src/styles.css";

/**
 * The rules allowed to contain raw colours: the token definitions themselves.
 *
 * Anything else in the stylesheet is a consumer and must go through `var()`,
 * which is what keeps a second palette from taking root inside the one file
 * where colours are legal.
 */
const TOKEN_BLOCK_SELECTORS = [':root[data-theme="dark"]', ':root[data-theme="light"]', ":root:not([data-theme])"];

/**
 * Tokens that are the same in every scheme: the type ramp
 * (`--type-*`). Declared once, in a bare `:root` block of their own at the top
 * of the stylesheet, and owed nowhere else -- a colour scheme has no say in
 * how big the text is.
 */
// The type scale and the two font families, the icon scale, the corner and line roles (redesign slice 8) and shared
// layout measures; table selection overrides its declared minimum width per instance rather than per colour scheme.
const SCHEME_FREE =
  /^--(?:type-|font-(?:sans|mono)$|icon(?:-|$)|radius-|line-|primary-bar-bottom$|primary-review-width$|archer-table-min-width$|note-emphasis-clearance$|legend-pad$|legend-row-gap$)/;

/** The scheme-free tokens the stylesheet declares, in its bare `:root` blocks. */
function schemeFreeTokens(css: string): Set<string> {
  const names = new Set<string>();
  for (const block of css.matchAll(/(?:^|\n):root\s*\{([^}]*)\}/g)) {
    for (const match of block[1].matchAll(/(--[\w-]+)\s*:/g)) {
      if (SCHEME_FREE.test(match[1])) names.add(match[1]);
    }
  }
  // Geometry variables are scoped to the canvas and shared by both themes.
  // They are not palette values; inspect their production declarations rather
  // than requiring a duplicate in each colour scheme.
  for (const block of css.matchAll(/\.archer-stage, \.archer-mcp-stage\s*\{([^}]*)\}/g)) {
    for (const match of block[1].matchAll(
      /(--(?:diagram-key-(?:height|inset)|emphasis-legend-limit|toolbar-clear|stack-base|stage-below))\s*:\s*(\d+(?:px|%))\s*;/g,
    ))
      names.add(match[1]);
  }
  return names;
}

/**
 * Literals that legitimately cannot be tokenised.
 *
 * Each entry needs a one-line justification. Keep this as close to empty as
 * possible -- an entry here is a hole in the guard, not a convenience.
 */
const EXEMPTIONS: ReadonlyArray<{ file: string; literal: string; why: string }> = [
  // (empty -- nothing in src/ currently needs one)
];

const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g;

/** Blank comments in place, preserving length and line breaks so reported
 *  positions stay true. A colour named in prose is documentation. */
function blankComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, lead: string) => lead + " ".repeat(match.length - lead.length));
}

function sourceFiles(dir: string, extensions: RegExp): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(resolve(process.cwd(), dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path, extensions));
    } else if (extensions.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

/*
 * THIS FILE HAS TO BE CHEAP. It scans the whole of `src/`, and the stylesheet
 * is thousands of lines, so anything that walks the source once per match is
 * quadratic. It used to be: a token block was found with one regular
 * expression per selector that rescanned the stylesheet from every line start
 * (about 1.2s each, nine of them), and every `var()` reference had its line
 * number worked out by slicing and splitting the file up to it. Three tests
 * took 3 to 4 seconds each on an idle machine, against vitest's 5-second
 * limit, and timed out on a loaded one -- 7.7s and 6.6s in the first run of
 * the suite under load on 2026-10-01. A test that fails only when the machine
 * is busy is what "the UI gate flakes" looks like from outside (plan section
 * 12.2, row U6). So: each file is read once, the stylesheet's rules are found
 * in one pass, and a line number is a binary search.
 */
const READ = new Map<string, string>();
function read(file: string): string {
  let source = READ.get(file);
  if (source === undefined) {
    source = readFileSync(resolve(process.cwd(), file), "utf8");
    READ.set(file, source);
  }
  return source;
}

const LINE_STARTS = new Map<string, number[]>();
/** The 1-based line `index` falls on. `source` is looked up by identity, so pass the string that was scanned. */
function lineOf(source: string, index: number): number {
  let starts = LINE_STARTS.get(source);
  if (starts === undefined) {
    starts = [0];
    for (let at = source.indexOf("\n"); at !== -1; at = source.indexOf("\n", at + 1)) {
      starts.push(at + 1);
    }
    LINE_STARTS.set(source, starts);
  }
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= index) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

type Block = { readonly prelude: string; readonly start: number; readonly end: number };
const BLOCKS = new Map<string, Block[]>();
/** Every `prelude { body }` in the stylesheet, innermost only, found in one pass. */
function blocksOf(css: string): Block[] {
  let blocks = BLOCKS.get(css);
  if (blocks === undefined) {
    blocks = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].map((match) => ({
      prelude: match[1],
      start: match.index,
      end: match.index + match[0].length,
    }));
    BLOCKS.set(css, blocks);
  }
  return blocks;
}

/** Character ranges of the token-definition rules, which may hold literals. */
function tokenBlockRanges(css: string, selectors: readonly string[] = TOKEN_BLOCK_SELECTORS): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const selector of selectors) {
    // The first rule whose selector list names this selector, as before.
    const block = blocksOf(css).find((candidate) => candidate.prelude.includes(selector));
    expect(block, `a token block for ${selector}`).toBeDefined();
    ranges.push([block!.start, block!.end]);
  }
  return ranges;
}

const SCANNABLE = new Map<string, string>();
/** A source file with its comments blanked, read and blanked once. */
function scannableOf(file: string): string {
  let scannable = SCANNABLE.get(file);
  if (scannable === undefined) {
    scannable = blankComments(read(file));
    SCANNABLE.set(file, scannable);
  }
  return scannable;
}

function isExempt(file: string, literal: string): boolean {
  return EXEMPTIONS.some((e) => e.file === file && e.literal === literal);
}

// Layout measures a component sets inline (FolderTree.tsx's column template and
// row indent): geometry, not palette, so owed to neither theme -- provided the
// owner still declares them, and the CSS reads them only for layout.
const INLINE_GEOMETRY: Readonly<Record<string, { owner: string; usage: RegExp }>> = {
  "--archer-tree-columns": {
    owner: "src/app/FolderTree.tsx",
    usage: /^\s*grid-template-columns:\s*var\(--archer-tree-columns\);\s*$/,
  },
  "--archer-tree-indent": {
    owner: "src/app/FolderTree.tsx",
    usage: /padding-inline-start:\s*calc\(var\(--archer-tree-indent,\s*0px\)\s*\+\s*\d+px\);/,
  },
  // The nested view (ADR 0029): an entering child's stagger.
  "--nest-delay": {
    owner: "src/diagrams/DiagramCanvas.tsx",
    usage: /^\s*animation-delay:\s*var\(--nest-delay,\s*0ms\);\s*$/,
  },
  // The phone's open dock sheet (stage-dock.tsx): the canvas toolbar sits just above it.
  "--archer-dock-sheet-height": {
    owner: "src/app/stage-dock.tsx",
    usage: /^\s*bottom:\s*calc\(var\(--archer-dock-sheet-height,\s*0px\)\s*\+\s*\d+px\);\s*$/,
  },
  // The camera's zoom (DiagramCanvas.tsx `ZoomVar`): the edge More's touch area divides by it (round 1, R5-03).
  "--archer-canvas-zoom": {
    owner: "src/diagrams/DiagramCanvas.tsx",
    usage: /^\s*(?:width|height):\s*calc\(var\(--icon-touch\)\s*\/\s*var\(--archer-canvas-zoom,\s*1\)\);\s*$/,
  },
};

function isInlineGeometry(file: string, source: string, index: number, token: string): boolean {
  const rule = INLINE_GEOMETRY[token];
  if (rule === undefined || !scannableOf(rule.owner).includes(`"${token}"`)) return false;
  const end = source.indexOf("\n", index);
  return (
    file.endsWith(".css") &&
    rule.usage.test(source.slice(source.lastIndexOf("\n", index) + 1, end === -1 ? source.length : end))
  );
}

describe("one token set, used everywhere", () => {
  it("keeps every raw colour inside the token definitions", () => {
    const offenders: string[] = [];

    const css = read(STYLESHEET);
    const scannableCss = scannableOf(STYLESHEET);
    const allowed = tokenBlockRanges(scannableCss);
    for (const match of scannableCss.matchAll(COLOUR_LITERAL)) {
      const index = match.index;
      if (allowed.some(([start, end]) => index >= start && index < end)) continue;
      if (isExempt(STYLESHEET, match[0])) continue;
      const line = lineOf(scannableCss, index);
      offenders.push(
        `${STYLESHEET}:${line}: raw colour ${match[0]} outside the token blocks -- ` +
          `define a token and use var(--token)`,
      );
    }

    for (const file of sourceFiles(SRC, /\.(tsx?|css)$/)) {
      if (file === STYLESHEET) continue;
      const scannable = scannableOf(file);
      for (const match of scannable.matchAll(COLOUR_LITERAL)) {
        if (isExempt(file, match[0])) continue;
        const line = lineOf(scannable, match.index);
        const text = scannable.split("\n")[line - 1]?.trim() ?? "";
        offenders.push(
          `${file}:${line}: raw colour ${match[0]} in "${text}" -- ` +
            `use var(--token); add a token to ${STYLESHEET} if no role fits`,
        );
      }
    }

    expect(offenders, `\n${offenders.join("\n")}\n`).toEqual([]);
  });

  it("defines every token that is referenced, in BOTH themes", () => {
    // The other half of "one token set": a reference that resolves in one
    // theme and not the other is the same drift arriving from the other side.
    // An undefined `var()` also fails silently -- the property is simply
    // dropped -- so nothing on screen says the token was a typo.
    const css = read(STYLESHEET);
    const scannableCss = scannableOf(STYLESHEET);
    const [darkRange, lightRange] = tokenBlockRanges(scannableCss);

    function definedIn([start, end]: [number, number]): Set<string> {
      const names = new Set<string>();
      for (const match of scannableCss.slice(start, end).matchAll(/(--[\w-]+)\s*:/g)) {
        names.add(match[1]);
      }
      return names;
    }
    const dark = definedIn(darkRange);
    const light = definedIn(lightRange);
    const schemeFree = schemeFreeTokens(scannableCss);

    const missing: string[] = [];
    for (const file of sourceFiles(SRC, /\.(tsx?|css)$/)) {
      const scannable = scannableOf(file);
      for (const match of scannable.matchAll(/var\(\s*(--[\w-]+)/g)) {
        const token = match[1];
        if (isInlineGeometry(file, scannable, match.index, token)) continue;
        if (schemeFree.has(token)) continue;
        if (dark.has(token) && light.has(token)) continue;
        const line = lineOf(scannable, match.index);
        if (!dark.has(token)) missing.push(`${file}:${line}: ${token} is not defined for dark`);
        if (!light.has(token)) missing.push(`${file}:${line}: ${token} is not defined for light`);
      }
    }

    expect(missing, `\n${missing.join("\n")}\n`).toEqual([]);
  });

  it("has one design: no second token set keyed to a design, and no design-private tokens", () => {
    // The Line map design kept its own token blocks and `--lm-*` tokens until
    // the designs merged (phase 3b). A second set is a second palette.
    const css = read(STYLESHEET);
    expect(css).not.toMatch(/data-design/);
    expect(css).not.toMatch(/--lm-[\w-]+\s*:/);
  });

  it("has no unjustified exemptions", () => {
    for (const exemption of EXEMPTIONS) {
      expect(exemption.why.length, `${exemption.file} ${exemption.literal}`).toBeGreaterThan(20);
    }
  });

  it("does not exempt colour consumers through the inline layout rules", () => {
    for (const token of Object.keys(INLINE_GEOMETRY)) {
      const source = `color: var(${token});`;
      expect(isInlineGeometry("src/app/FolderTree.css", source, source.indexOf("var("), token)).toBe(false);
    }
  });
});
