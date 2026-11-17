// A node says three things at once, and holding DOM focus must not silence one.
//
// Since ADR 0030 agent emphasis is the node's BORDER colour and nothing else:
// selection keeps the accent fill and glow (`box-shadow`), the keyboard ring is
// an inset `box-shadow`, and emphasis wins the border colour. Selection's
// border is a shorthand `!important` and React Flow resets focus styles, so
// the border colour is exactly the kind of property a heavier selector can take
// back -- which is why this resolves the cascade across BOTH stylesheets, every
// rule that can match the node in a given state, ranked the way a browser ranks
// them (`!important`, then specificity, then order). jsdom cannot be asked
// instead -- its `getComputedStyle` does not rank by specificity. The two sheets
// are bundled in an order nothing pins, so every answer has to hold in both.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const OURS = read("src/styles.css");
const REACT_FLOW = read(createRequire(import.meta.url).resolve("@xyflow/react/dist/style.css"));

type Element = {
  readonly classes: ReadonlySet<string>;
  readonly pseudo: ReadonlySet<string>;
};
type Specificity = readonly [ids: number, classes: number, elements: number];
type Declaration = {
  readonly value: string;
  readonly important: boolean;
  readonly specificity: Specificity;
  readonly order: number;
  readonly selector: string;
};

/** Split on `separator` wherever it is not inside parentheses. */
function splitOutside(text: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (depth === 0 && separator.test(ch)) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

const TOKEN = /\.[\w-]+|#[\w-]+|::?[\w-]+(?:\([^()]*\))?|\[[^\]]*\]|\*|[a-zA-Z][\w-]*/g;

/** Whether one compound selector matches, and what it weighs if it does. */
function compound(selector: string, element: Element): Specificity | null {
  let ids = 0;
  let classes = 0;
  let elements = 0;
  for (const token of selector.match(TOKEN) ?? []) {
    if (token.startsWith(".")) {
      if (!element.classes.has(token.slice(1))) return null;
      classes += 1;
    } else if (token.startsWith("#")) {
      // The node element carries no id.
      return null;
    } else if (token.startsWith(":not(")) {
      const inner = splitOutside(token.slice(5, -1), /,/);
      if (inner.some((part) => compound(part, element) !== null)) return null;
      // `:not()` weighs what its heaviest argument weighs.
      const weights = inner.map((part) => weigh(part));
      ids += Math.max(...weights.map((weight) => weight[0]));
      classes += Math.max(...weights.map((weight) => weight[1]));
      elements += Math.max(...weights.map((weight) => weight[2]));
    } else if (token.startsWith("::")) {
      // A pseudo-element is another box, not this one.
      return null;
    } else if (token.startsWith(":")) {
      if (!element.pseudo.has(token.slice(1))) return null;
      classes += 1;
    } else if (token.startsWith("[")) {
      return null;
    } else if (token !== "*") {
      if (token !== "div") return null;
      elements += 1;
    }
  }
  return [ids, classes, elements];
}

/** What a compound weighs whether or not it matches (for `:not()` arguments). */
function weigh(selector: string): Specificity {
  const tokens = selector.match(TOKEN) ?? [];
  return [
    tokens.filter((token) => token.startsWith("#")).length,
    tokens.filter((token) => token.startsWith(".") || token.startsWith("[") || /^:[^:]/.test(token)).length,
    tokens.filter((token) => /^[a-zA-Z]/.test(token)).length,
  ];
}

/**
 * Whether a whole selector can match the node element.
 *
 * Only the last compound is tested against the element. Ancestors are assumed
 * to match -- the pessimistic reading, since it lets in every rule that could
 * apply under some ancestor -- and are weighed as written.
 */
function matches(selector: string, element: Element): Specificity | null {
  const compounds = splitOutside(selector, /[\s>+~]/);
  const subject = compound(compounds[compounds.length - 1], element);
  if (subject === null) return null;
  return compounds
    .slice(0, -1)
    .map(weigh)
    .reduce<Specificity>((sum, weight) => [sum[0] + weight[0], sum[1] + weight[1], sum[2] + weight[2]], subject);
}

/** The declaration that wins `property` on `element`, with the sheets in this order. */
function winner(sheets: readonly string[], element: Element, property: string): Declaration | undefined {
  const found: Declaration[] = [];
  let order = 0;
  for (const sheet of sheets) {
    for (const [, selectors, body] of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      order += 1;
      for (const declaration of body.split(";")) {
        const colon = declaration.indexOf(":");
        if (colon === -1 || declaration.slice(0, colon).trim() !== property) continue;
        const raw = declaration.slice(colon + 1).trim();
        for (const selector of splitOutside(selectors, /,/)) {
          const specificity = matches(selector, element);
          if (specificity === null) continue;
          found.push({
            value: raw.replace(/\s*!important$/, ""),
            important: /!important$/.test(raw),
            specificity,
            order,
            selector,
          });
        }
      }
    }
  }
  const rank = (d: Declaration): number[] => [d.important ? 1 : 0, ...d.specificity, d.order];
  return found.sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    const at = ra.findIndex((value, index) => value !== rb[index]);
    return at === -1 ? 0 : rb[at] - ra[at];
  })[0];
}

/** The outline style in force: the longhand and the shorthand both set it. */
function outlineStyle(sheets: readonly string[], element: Element): { style: string; from: string } {
  const candidates = [winner(sheets, element, "outline"), winner(sheets, element, "outline-style")].filter(
    (found): found is Declaration => found !== undefined,
  );
  const rank = (d: Declaration): number[] => [d.important ? 1 : 0, ...d.specificity, d.order];
  const [top] = candidates.sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    const at = ra.findIndex((value, index) => value !== rb[index]);
    return at === -1 ? 0 : rb[at] - ra[at];
  });
  if (top === undefined) return { style: "none", from: "(no rule)" };
  const style = /\b(none|solid|dashed|dotted|double)\b/.exec(top.value)?.[1] ?? "none";
  return { style, from: top.selector };
}

const SHEET_ORDERS = [
  ["React Flow's stylesheet first", [REACT_FLOW, OURS]],
  ["our stylesheet first", [OURS, REACT_FLOW]],
] as const;

const DOM_FOCUS = [
  ["without DOM focus", []],
  ["under the pointer", ["hover"]],
  ["holding DOM focus after a click", ["focus"]],
  ["holding DOM focus from the keyboard", ["focus", "focus-visible"]],
] as const;

/** The classes React Flow and the adapter put on a selectable, emphasised node. */
const NODE = [
  "react-flow__node",
  "react-flow__node-archer",
  "nopan",
  "selectable",
  "archer-node",
  "archer-shape-rectangle",
];
const EMPHASISED = ["archer-emph", "archer-emph-palette-teal", "archer-emph-style-highlight"];

const USER_STATES = [
  ["neither selected nor keyboard-focused", []],
  ["selected", ["selected"]],
  ["keyboard-focused", ["archer-kbd-focus"]],
  ["selected and keyboard-focused", ["selected", "archer-kbd-focus"]],
] as const;

/** The border colour in force: the longhand and the `border` shorthand both set it. */
function borderColor(sheets: readonly string[], element: Element): { value: string; from: string } {
  const candidates = [winner(sheets, element, "border"), winner(sheets, element, "border-color")].filter(
    (found): found is Declaration => found !== undefined,
  );
  const rank = (d: Declaration): number[] => [d.important ? 1 : 0, ...d.specificity, d.order];
  const [top] = candidates.sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    const at = ra.findIndex((value, index) => value !== rb[index]);
    return at === -1 ? 0 : rb[at] - ra[at];
  });
  return top === undefined ? { value: "(none)", from: "(no rule)" } : { value: top.value, from: top.selector };
}

describe.each(SHEET_ORDERS)("with %s", (_order, sheets) => {
  describe.each(DOM_FOCUS)("a node %s", (_focus, pseudo) => {
    it.each(USER_STATES)("keeps its emphasis border colour when %s", (_state, user) => {
      const element = { classes: new Set([...NODE, ...EMPHASISED, ...user]), pseudo: new Set(pseudo) };
      const border = borderColor(sheets, element);
      expect(border.value, `the border colour is lost to \`${border.from}\``).toMatch(/var\(--emph-hue\)/);
    });

    it.each(USER_STATES)("draws nothing outside an emphasised node when %s", (_state, user) => {
      const element = { classes: new Set([...NODE, ...EMPHASISED, ...user]), pseudo: new Set(pseudo) };
      // No ring: emphasis is colour only.
      expect(outlineStyle(sheets, element).style).toBe("none");
      // No glow of its own: whatever shadow there is belongs to selection or the keyboard.
      const shadow = winner(sheets, element, "box-shadow");
      expect(shadow?.value ?? "none").not.toMatch(/emph-hue/);
      expect(winner(sheets, element, "animation")?.value ?? "none").not.toMatch(/emph/);
    });

    it("says all three at once: emphasised, selected and keyboard-focused", () => {
      const element = {
        classes: new Set([...NODE, ...EMPHASISED, "selected", "archer-kbd-focus"]),
        pseudo: new Set(pseudo),
      };
      // Emphasis: the border colour.
      expect(borderColor(sheets, element).value).toMatch(/var\(--emph-hue\)/);
      // The keyboard ring and the selection glow share the one `box-shadow`.
      const shadow = winner(sheets, element, "box-shadow")!;
      expect(shadow.important).toBe(true);
      expect(shadow.value).toMatch(/inset[^,]*var\(--kbd-focus\)/);
      expect(shadow.value).toMatch(/var\(--node-shadow-selected\)/);
      // Selection: the filled body.
      expect(winner(sheets, element, "background")!.value).toMatch(/var\(--accent-fill\)/);
    });

    it("still draws no outline on a node nobody emphasised", () => {
      // React Flow's and the UA's focus outline stay suppressed: the keyboard
      // ring is ours, and is the inset shadow.
      const element = { classes: new Set([...NODE, "archer-kbd-focus"]), pseudo: new Set(pseudo) };
      const outline = winner(sheets, element, "outline");
      if ((pseudo as readonly string[]).includes("focus")) expect(outline?.value).toBe("none");
      expect(outlineStyle(sheets, element).style).toBe("none");
    });

    it("leaves a selected node nobody emphasised its accent border", () => {
      const element = { classes: new Set([...NODE, "selected"]), pseudo: new Set(pseudo) };
      expect(borderColor(sheets, element).value).toMatch(/var\(--accent\)/);
    });
  });
});
