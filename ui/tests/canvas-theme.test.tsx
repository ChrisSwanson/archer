// @vitest-environment jsdom
//
// What this file exists for
// -------------------------
// One change deleted rules from `src/styles.css` with the whole suite
// green, and the diagram silently reverted to React Flow's own dark theme
// (node #1e1e1e, edge stroke #3e3e3e -- about 1.8:1 against the canvas, below
// the 3:1 floor for a non-text graphic). Nothing else catches that: the
// adapter tests only see the object the adapter returns, and the render tests
// only look at opacity.
//
// The original version caught it by rendering the canvas and reading computed
// colours off the element, which worked precisely BECAUSE jsdom does not
// resolve `var()` -- a literal could only have come from Archer's stylesheet.
// Tokenising the palette removes that lever by design: every colour is now a
// `var()`, so every computed value in jsdom is empty and the assertions would
// pass against an empty stylesheet. Weakening them to "not empty" would keep
// the file green while testing nothing.
//
// So the contract moved rather than being deleted. It is now asserted against
// the stylesheet itself, read from disk:
//
//   1. Both palettes are defined, with the exact measured values. They began
//      as the pre-tokenisation dark palette and the light set validated in
//      docs/prototypes/emphasis; the one design (phase 3b) moved their
//      structural greys off a mint tint to a neutral slate of the SAME
//      luminance, so every contrast below held (`one-design.test.tsx`).
//   2. The Archer-owned rules still exist and still bind the canvas colours to
//      those tokens -- which is the actual regression: delete the
//      rules and React Flow's defaults take over again.
//   3. No component hardcodes a colour, because a literal in a component is
//      invisible to the theme and cannot follow it.
//
// What still needs a rendered canvas (React Flow's own `colorMode`, the
// classes our adapter applies) is asserted by rendering, below.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readdirSync } from "node:fs";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import { computeLayout, type LayoutResult } from "../src/layout/elk-adapter";
import type { ProjectedView } from "../src/diagrams/projection";
import {
  type Colour,
  type Rgb,
  VISIONS,
  compositeOver,
  contrastRatio,
  deltaE,
  parseColour,
  relativeLuminance,
  simulate,
} from "./contrast";

// Paths go through `process.cwd()` (the `ui/` project root under Vitest) for
// the same reason `tests/fixtures.ts` does -- `import.meta.url` is an
// `http://…/@fs/…` URL in jsdom. Reading rather than importing because Vite's
// CSS pipeline resolves a `?raw` import of a stylesheet to an empty string.
const CSS = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

/**
 * The palette, exactly as measured.
 *
 * Dark began as the palette Archer shipped and light as the set designed and
 * contrast-checked in `docs/prototypes/emphasis/common.css`. The Drafting
 * palette (picked 2026-10-08) warmed their structural greys a few
 * degrees and replaced the sky-blue accent with an ink blue; every floor was
 * re-measured, and the ones that matter are asserted below rather than
 * trusted (3:1 for node borders and edges per WCAG 1.4.11, 4.5:1 for the
 * 10-11px faint text). Check the numbers before changing one.
 *
 * The diagram palette (DESIGN.md, owner 2026-11-11) inked the lines: node borders and connections are
 * darker in light and brighter in dark, at 4.5:1 or more on the canvas (`diagram-palette.test.ts`).
 *
 * Cool slate (owner, 2026-11-12) replaced Drafting's warm greys across the platform, from the owner's
 * reference drawings: a white canvas in light, a cool near-black slate in dark, slate surfaces and borders.
 *
 * The exception in both is the reader's own voice -- the accent family, the
 * keyboard ring and the sequence-fragment neutrals -- which moved off the mint
 * it used to share with the `teal` emphasis hue. Those are measured, not
 * merely pinned: see "the reader's voice and the agent's are different
 * colours" below.
 */
const DARK: Readonly<Record<string, string>> = {
  "--bg": "#0f141b",
  "--surface": "#0b0f15",
  "--surface-2": "#18202a",
  "--panel": "rgb(11 15 21 / 93%)",
  "--border": "#273141",
  "--border-strong": "#384456",
  "--border-hover": "#6b7a90",
  "--node-bg": "#1b2430",
  "--node-border": "#8a9ab0",
  "--node-border-hover": "#cbd5e1",
  "--node-text": "#f1f5f9",
  "--edge": "#b4c0cd",
  "--edge-hover": "#dbe2ea",
  "--plate": "#141b24",
  "--plate-text": "#eef2f6",
  "--text": "#e6ebf1",
  "--text-dim": "#a3aebd",
  "--text-faint": "#8d99aa",
  "--accent": "#9db4ff",
  "--accent-fill": "#1f2b52",
  "--accent-on-fill": "#ffffff",
  "--accent-ink": "#101a3a",
  "--accent-quiet": "#a9b9e8",
  "--g1": "#63e6b2",
  "--g2": "#f2b544",
  "--g3": "#a57ae8",
  "--g4": "#ff8a7a",
  "--danger-border": "#5c3a34",
  "--danger-bg": "#1a1210",
  "--danger-text": "#ffb4a2",
  "--danger-strong": "#ff8a7a",
  "--kbd-focus": "#e6ebf1",
  "--scrim": "rgb(5 8 12 / 76%)",
  "--shadow-panel": "0 4px 14px rgb(0 0 0 / 24%)",
  "--shadow-modal": "0 24px 70px rgb(0 0 0 / 40%)",
  "--node-shadow-selected": "0 0 0 3px rgb(157 180 255 / 24%), 0 4px 14px rgb(0 0 0 / 30%)",
  "--fragment-bg": "rgb(230 235 241 / 5%)",
  "--fragment-border": "#737b88",
  "--fragment-text": "#a5abb5",
  "--activation-bg": "#2a303b",
  "--lifeline": "#64738a",
};

const LIGHT: Readonly<Record<string, string>> = {
  "--bg": "#ffffff",
  "--surface": "#f8fafc",
  "--surface-2": "#f1f5f9",
  "--panel": "rgb(248 250 252 / 95%)",
  "--border": "#e2e8f0",
  "--border-strong": "#cbd5e1",
  "--border-hover": "#7d8ba0",
  "--node-bg": "#f1f5f9",
  "--node-border": "#64748b",
  "--node-border-hover": "#334155",
  "--node-text": "#0f172a",
  "--edge": "#334155",
  "--edge-hover": "#1e293b",
  "--plate": "#f8fafc",
  "--plate-text": "#1e293b",
  "--text": "#0f172a",
  "--text-dim": "#475569",
  "--text-faint": "#5d6b7e",
  "--accent": "#2645a3",
  "--accent-fill": "#e1e6f6",
  "--accent-on-fill": "#13235a",
  "--accent-ink": "#ffffff",
  "--accent-quiet": "#2c4fb8",
  "--g1": "#0d8259",
  "--g2": "#8a5f05",
  "--g3": "#7e4fda",
  "--g4": "#ba3826",
  "--danger-border": "#e3b6ac",
  "--danger-bg": "#fdf2ef",
  "--danger-text": "#8a3620",
  "--danger-strong": "#b3452a",
  "--kbd-focus": "#0f172a",
  "--scrim": "rgb(15 23 42 / 45%)",
  "--shadow-panel": "0 2px 10px rgb(15 23 42 / 8%)",
  "--shadow-modal": "0 20px 56px rgb(15 23 42 / 20%)",
  "--node-shadow-selected": "0 0 0 2px rgb(38 69 163 / 26%), 0 2px 8px rgb(15 23 42 / 14%)",
  "--fragment-bg": "rgb(20 26 38 / 4%)",
  "--fragment-border": "#7d8592",
  "--fragment-text": "#4f5866",
  "--activation-bg": "#f1f5f9",
  "--lifeline": "#7d8ba0",
};

/**
 * Custom properties declared by the rule whose selector list contains
 * `selector`. Parsed from the raw text rather than through jsdom's CSSOM,
 * which drops declarations it does not recognise -- including, historically,
 * custom properties.
 */
function tokensOf(selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = new RegExp(`(^|[,{}])\\s*[^{}]*${escaped}[^{}]*\\{([^}]*)\\}`, "m").exec(CSS);
  if (rule === null) {
    return new Map();
  }
  const declared = new Map<string, string>();
  // Comments are stripped before splitting, not after: the prose in this
  // stylesheet contains semicolons, which would otherwise split a comment in
  // half and hide the declaration that follows it.
  for (const line of rule[2].replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
    const match = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/s.exec(line);
    if (match !== null) {
      declared.set(match[1], match[2].replace(/\s+/g, " "));
    }
  }
  return declared;
}

function expectPalette(selector: string, palette: Readonly<Record<string, string>>): void {
  const declared = tokensOf(selector);
  for (const [token, value] of Object.entries(palette)) {
    expect(declared.get(token), `${selector} { ${token} }`).toBe(value);
  }
}

describe("palette tokens", () => {
  it("defines the measured dark palette", () => {
    expectPalette(':root[data-theme="dark"]', DARK);
  });

  it("defines the measured light palette", () => {
    expectPalette(':root[data-theme="light"]', LIGHT);
  });

  it("resolves the OS-following default without JavaScript, so nothing flashes", () => {
    // Before `initTheme` stamps `data-theme`, only the stylesheet can get the
    // theme right. It has to carry the light case in a `prefers-color-scheme`
    // block scoped to a root that has not been stamped yet.
    const block = /@media\s*\(prefers-color-scheme:\s*light\)\s*\{([\s\S]*?\n\s*\})\s*\n\}/.exec(CSS);
    expect(block, "a prefers-color-scheme: light block").not.toBeNull();
    expect(block![1]).toMatch(/:root:not\(\[data-theme\]\)/);

    // ...and it must not drift from the explicit light block.
    const preJs = tokensOf(":root:not([data-theme])");
    for (const [token, value] of Object.entries(LIGHT)) {
      expect(preJs.get(token), `pre-JavaScript light { ${token} }`).toBe(value);
    }
  });

  it("keeps the scrim a darkening layer in both themes", () => {
    // A scrim derived from --bg works by accident in dark and inverts in
    // light, where it becomes a white veil that bleaches the backdrop away
    // instead of dimming it. It has to be its own token, dark-tinted in both.
    for (const selector of [':root[data-theme="dark"]', ':root[data-theme="light"]']) {
      const scrim = tokensOf(selector).get("--scrim") ?? "";
      expect(scrim, `${selector} --scrim`).not.toMatch(/var\(/);
      const channels = /rgb\(\s*(\d+)\s+(\d+)\s+(\d+)/.exec(scrim);
      expect(channels, `${selector} --scrim is an rgb() triple`).not.toBeNull();
      const brightest = Math.max(...channels!.slice(1, 4).map(Number));
      expect(brightest, `${selector} --scrim must darken`).toBeLessThan(64);
    }
  });

  it("draws on a white canvas, and fills the nodes in the tinted slate step", () => {
    // Owner, 2026-11-12, from the reference drawings: the canvas is white (Drafting's rule against a white canvas
    // is retired), the outermost group is a clear panel on it, and the nodes are the cool slate step -- not white,
    // so a card reads as a card on the white ground and inside a pale nested panel.
    const light = tokensOf(':root[data-theme="light"]');
    const lum = (token: string) => relativeLuminance(parseColour(light.get(token)!).rgb);
    expect(light.get("--bg")).toBe("#ffffff");
    expect(light.get("--group-bg")).toBe(light.get("--bg"));
    expect(lum("--node-bg")).toBeLessThan(lum("--bg"));
    expect(lum("--node-bg")).toBeLessThan(lum("--group-bg-alt"));
  });

  it("retunes the selection glow per theme instead of reusing one value", () => {
    // A wide soft blur reads as emission over a dark canvas and as a pale
    // smear over a white one, so the halo is a per-theme token, not shared.
    const dark = tokensOf(':root[data-theme="dark"]').get("--node-shadow-selected");
    const light = tokensOf(':root[data-theme="light"]').get("--node-shadow-selected");
    expect(dark).toBeTruthy();
    expect(light).toBeTruthy();
    expect(light).not.toBe(dark);
  });
});

const THEMES = [
  ["dark", ':root[data-theme="dark"]'],
  ["light", ':root[data-theme="light"]'],
] as const;

const EMPHASIS_HUES = ["--g1", "--g2", "--g3", "--g4"] as const;

describe("the reader's voice and the agent's are different colours", () => {
  // The accent and the `teal` emphasis hue used to be the same value in both
  // themes, so a selected node and a teal-emphasised one were told apart by
  // motion alone. The accent is the reader's (selection, the active tab and
  // chip, chrome focus); `--g1`..`--g4` are the agent's. They never share.
  function colour(theme: string, selector: string, token: string): Colour {
    const value = tokensOf(selector).get(token);
    expect(value, `${theme} ${token}`).toBeDefined();
    return parseColour(value!);
  }

  function opaque(theme: string, selector: string, token: string): Rgb {
    const parsed = colour(theme, selector, token);
    expect(parsed.alpha, `${theme} ${token} is opaque`).toBe(1);
    return parsed.rgb;
  }

  for (const [theme, selector] of THEMES) {
    it.each(EMPHASIS_HUES)(`keeps the ${theme} accent off the emphasis hue %s`, (hue) => {
      const declared = tokensOf(selector);
      expect(declared.get("--accent")).toBeDefined();
      expect(declared.get("--accent")).not.toBe(declared.get(hue));
    });

    it(`draws the ${theme} keyboard ring in the neutral text colour, not the accent`, () => {
      const declared = tokensOf(selector);
      expect(declared.get("--kbd-focus")).not.toBe(declared.get("--accent"));
      expect(declared.get("--kbd-focus")).toBe(declared.get("--text"));
    });

    it.each(EMPHASIS_HUES)(`keeps the ${theme} accent separable from %s with and without colour vision`, (hue) => {
      const accent = opaque(theme, selector, "--accent");
      const emphasis = opaque(theme, selector, hue);
      for (const vision of VISIONS) {
        // 10 is the palette's own tightest dark pair under dichromacy
        // (amber/coral, deuteranopia: 10.6), so the accent is held to the
        // standard the four hues already meet among themselves. Violet is
        // the pair that sits on this floor -- see the `--accent` comment.
        expect(
          deltaE(simulate(accent, vision), simulate(emphasis, vision)),
          `${theme} --accent vs ${hue} under ${vision}`,
        ).toBeGreaterThanOrEqual(10);
      }
    });

    // A PALETTE is a hue, and a hue cannot be told from another without colour.
    // What the four are held to instead is that they stay apart for a reader
    // who does not see red and green as different (plan section 12.2, row U4);
    // the legend's rows are what name a group without colour at all.
    //
    // ONE PAIR DOES NOT, and is recorded rather than hidden: in the light
    // scheme amber and coral are 2.7 apart for a deuteranope and 8.1 for a
    // protanope, against a floor of 10. The comment above took the dark
    // scheme's tightest pair (10.6) for the palette's. Current's token values
    // are pinned, so this is the owner's to change; until then two groups in
    // those two palettes are told apart by the legend, not on the canvas.
    // Listed exactly, so a third close pair fails here, and so does fixing
    // this one without taking it off the list.
    const KNOWN_CLOSE: Readonly<Record<string, readonly string[]>> = {
      dark: [],
      light: ["--g2 vs --g4 under deuteranopia: 2.7", "--g2 vs --g4 under protanopia: 8.1"],
    };
    it(`keeps the ${theme} emphasis hues apart from each other, with and without colour vision`, () => {
      const close: string[] = [];
      for (const [i, first] of EMPHASIS_HUES.entries()) {
        for (const second of EMPHASIS_HUES.slice(i + 1)) {
          for (const vision of VISIONS) {
            const apart = deltaE(
              simulate(opaque(theme, selector, first), vision),
              simulate(opaque(theme, selector, second), vision),
            );
            if (apart < 10) close.push(`${first} vs ${second} under ${vision}: ${apart.toFixed(1)}`);
          }
        }
      }
      expect(close).toEqual(KNOWN_CLOSE[theme]);
    });

    // [what is drawn, its token, what it is drawn on, the floor]. A backdrop
    // list is composited bottom-up, so a translucent fill is measured as the
    // colour it actually paints. The canvas is `--bg`; the app bar, the tab
    // strip and the chip row are `--surface`.
    const TEXT = 4.5;
    const MARK = 3;
    const floors: ReadonlyArray<readonly [string, string, readonly string[], number]> = [
      ["selected node label", "--accent-on-fill", ["--accent-fill"], TEXT],
      ["fragment chip label", "--accent-ink", ["--accent"], TEXT],
      ["fragment label", "--fragment-text", ["--bg", "--fragment-bg"], TEXT],
      ["secondary accent text on the bar", "--accent-quiet", ["--surface"], TEXT],
      ["secondary accent text on the canvas", "--accent-quiet", ["--bg"], TEXT],
      ["selected border against the node body", "--accent", ["--node-bg"], MARK],
      ["selected border against the canvas", "--accent", ["--bg"], MARK],
      ["selected border against its own fill", "--accent", ["--accent-fill"], MARK],
      ["tab underline against the bar", "--accent", ["--surface"], MARK],
      ["fragment chip against the fragment fill", "--accent", ["--bg", "--fragment-bg"], MARK],
      ["keyboard ring against the node body", "--kbd-focus", ["--node-bg"], MARK],
      ["keyboard ring against a selected fill", "--kbd-focus", ["--accent-fill"], MARK],
      ["keyboard halo against the canvas", "--kbd-focus", ["--bg"], MARK],
      ["fragment frame against the canvas", "--fragment-border", ["--bg"], MARK],
      ["fragment frame against its fill", "--fragment-border", ["--bg", "--fragment-bg"], MARK],
      ["activation outline against its bar", "--fragment-border", ["--activation-bg"], MARK],
      ["sequence lifeline against the canvas", "--lifeline", ["--bg"], MARK],
    ];

    it.each(floors)(`clears the ${theme} floor for the %s`, (_what, token, backdrop, floor) => {
      const [base, ...layers] = backdrop;
      let behind = opaque(theme, selector, base);
      for (const layer of layers) {
        behind = compositeOver(colour(theme, selector, layer), behind);
      }
      expect(contrastRatio(opaque(theme, selector, token), behind)).toBeGreaterThanOrEqual(floor);
    });

    it(`leaves no ${theme} fragment token carrying a hue of its own`, () => {
      // Fragments and activations used to be green derivatives of the old
      // accent: a second accent living only on the sequence canvas. They are
      // structure, so they are drawn from the theme's neutrals.
      for (const token of ["--fragment-bg", "--fragment-border", "--fragment-text", "--activation-bg"]) {
        const [r, g, b] = colour(theme, selector, token).rgb;
        expect(Math.max(r, g, b) - Math.min(r, g, b), `${theme} ${token} chroma`).toBeLessThan(24);
      }
    });
  }

  it("leaves nothing derived from the old mint accent by literal", () => {
    const declarations = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(declarations).not.toMatch(/99 230 178/);
    expect(declarations).not.toMatch(/13 130 89/);
  });
});

describe("the colour measurements themselves", () => {
  // The floors above are only as good as the ruler, so pin the ruler to
  // values that are known independently of this stylesheet.
  it("measures the WCAG reference contrasts", () => {
    expect(contrastRatio([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 5);
    // #767676 is the well-known lightest grey that still passes AA on white.
    expect(contrastRatio(parseColour("#767676").rgb, [255, 255, 255])).toBeCloseTo(4.54, 2);
  });

  it("composites an alpha fill before measuring it", () => {
    expect(compositeOver(parseColour("rgb(0 0 0 / 50%)"), [255, 255, 255])).toEqual([127.5, 127.5, 127.5]);
  });

  it("leaves a neutral grey neutral under every kind of vision", () => {
    for (const vision of VISIONS) {
      const [r, g, b] = simulate([128, 128, 128], vision);
      expect(Math.max(r, g, b) - Math.min(r, g, b), vision).toBeLessThan(0.5);
    }
  });

  it("collapses red and green together for a dichromat, and not otherwise", () => {
    const red: Rgb = [200, 60, 40];
    const green: Rgb = [110, 130, 40];
    const seen = deltaE(red, green);
    const lost = deltaE(simulate(red, "deuteranopia"), simulate(green, "deuteranopia"));
    expect(seen).toBeGreaterThan(30);
    expect(lost).toBeLessThan(seen / 3);
  });
});

describe("canvas rules bind to the palette", () => {
  // This is that regression itself: with these rules gone, React Flow's
  // own dark theme takes the canvas back over and the suite stays green.
  const required: ReadonlyArray<readonly [string, readonly string[]]> = [
    [".archer-node", ["--node-bg", "--node-border", "--node-text"]],
    [".archer-node.selected", ["--accent-fill", "--accent", "--node-shadow-selected"]],
    [".archer-node.selectable:hover:not(.selected)", ["--node-ring-hover"]],
    [".archer-node.selectable:hover:not(.selected):not(.archer-emph)", ["--node-border-hover"]],
    [".archer-edge .react-flow__edge-path", ["--edge"]],
    [".archer-edge.selectable:hover .react-flow__edge-path", ["--edge-hover"]],
    // Sequence diagrams draw from the SAME token set. They used to carry a
    // private light-slate palette on a dark canvas; there is one palette now.
    [".archer-seq-participant rect", ["--node-bg", "--node-border"]],
    [".archer-seq-participant text", ["--node-text"]],
    [".archer-seq-lifeline", ["--lifeline"]],
    [".archer-seq-message", ["--edge"]],
    [".archer-seq-message--reply", ["--text-faint"]],
    [".archer-seq-activation", ["--activation-bg", "--fragment-border"]],
  ];

  for (const [selector, tokens] of required) {
    it(`styles ${selector} from ${tokens.join(", ")}`, () => {
      // A rule may declare a selector LIST, and a selector may be a prefix of
      // a descendant selector (`.archer-seq-message` styling `… line`), so
      // gather the bodies of every rule that styles this selector rather than
      // insisting on one whose selector text matches exactly.
      const bodies: string[] = [];
      for (const rule of CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        const styles = rule[1]
          .split(",")
          .some((part) => part.trim() === selector || part.trim().startsWith(`${selector} `));
        if (styles) bodies.push(rule[2]);
      }
      expect(bodies.length, `a rule styling ${selector}`).toBeGreaterThan(0);
      const declared = bodies.join("\n");
      for (const token of tokens) {
        expect(declared, `${selector} should use ${token}`).toContain(`var(${token})`);
      }
    });
  }
});

describe("components carry no colours of their own", () => {
  function sourceFiles(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(resolve(process.cwd(), dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        found.push(...sourceFiles(path));
      } else if (/\.tsx?$/.test(entry.name)) {
        found.push(path);
      }
    }
    return found;
  }

  it("keeps every colour literal in the stylesheet, where a theme can reach it", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles("src")) {
      // Comments are blanked, not removed, so reported line numbers stay
      // true. A colour named in prose is documentation, not a literal.
      const contents = readFileSync(resolve(process.cwd(), file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
        .replace(/\/\/[^\n]*/g, "");
      contents.split("\n").forEach((line, index) => {
        // A hex colour, or a functional colour notation. `var(--token)` is the
        // whole point and is not a literal.
        if (/#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?|oklch|color-mix)\(/.test(line)) {
          offenders.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

const labelledView: ProjectedView = {
  viewId: "test-view",
  kind: "c4-context",
  title: "Test",
  revision: "1",
  modelType: "architecture-graph",
  nodes: [
    { id: "a", label: "A", shape: undefined, classes: [], groupId: undefined },
    { id: "b", label: "B", shape: undefined, classes: [], groupId: undefined },
  ],
  edges: [{ id: "e1", source: "a", target: "b", label: "calls" }],
  groups: [],
};

let layout: LayoutResult;

beforeAll(async () => {
  layout = await computeLayout(labelledView);
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
});

describe("the rendered canvas follows the applied theme", () => {
  function renderCanvas(): HTMLElement {
    return render(<DiagramCanvas state={{ status: "ready", layout }} />).container;
  }

  for (const theme of ["light", "dark"] as const) {
    it(`tells React Flow the theme is ${theme}, rather than assuming one`, () => {
      document.documentElement.setAttribute("data-theme", theme);
      const wrapper = renderCanvas().querySelector('[data-testid="rf__wrapper"]');
      expect(wrapper).not.toBeNull();
      // React Flow styles its own controls and background from this class.
      expect(wrapper!.classList.contains(theme)).toBe(true);
    });
  }

  // Carried over from the pre-tokenisation version of this file: these are
  // contracts jsdom can still check, because neither is a colour.
  it("draws the node border inside the box ELK sized", () => {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.append(style);
    try {
      const node = renderCanvas().querySelector<HTMLElement>('.react-flow__node[data-id="a"]');
      // The adapter sets width/height as the ELK box, so a border drawn
      // outside it makes every node overflow its computed slot.
      expect(getComputedStyle(node!).boxSizing).toBe("border-box");
    } finally {
      style.remove();
    }
  });

  it("marks edges selectable so the hover and selected rules can match", async () => {
    const container = renderCanvas();
    fireEvent.click(container.querySelector<HTMLButtonElement>('button[aria-label="Select mode"]')!);
    await waitFor(() => {
      expect(container.querySelector('.react-flow__edge[data-id="e1"]')).not.toBeNull();
    });

    // `.archer-edge.selectable:hover` in styles.css is inert unless React Flow
    // adds this class, which it only does for edges the adapter marks
    // selectable. (Selection's accent asks only for `.selected`: R6-claude-02.)
    const edge = container.querySelector('.react-flow__edge[data-id="e1"]');
    expect(edge!.classList.contains("selectable")).toBe(true);
  });

  it("breaks the line round the edge caption in the colour of what is behind it, with no plate", async () => {
    const container = renderCanvas();
    await waitFor(() => {
      expect(container.querySelector(".react-flow__edgelabel-renderer > div")).not.toBeNull();
    });

    // The caption is an HTML element in React Flow's edge-label layer, not an
    // SVG <text> inside the edge: it sits on the routed polyline, and the gap
    // round its words covers the stroke running underneath in the colour of the
    // ground -- here the canvas (treatment A, owner 2026-11-12: no plate). jsdom
    // cannot resolve the tokens, so assert the binding rather than the colour.
    const label = container.querySelector<HTMLElement>(".react-flow__edgelabel-renderer > div");
    expect(label!.style.background).toBe("var(--bg)");
    // Its ink is the stylesheet's `.archer-edge-label` (light, italic), from the ground's ink; fading still sets
    // its own colour inline.
    expect(label!.style.color).toBe("");
    expect(label!.style.getPropertyValue("--edge-label-ink")).toBe("var(--text-dim)");
    expect(CSS).toMatch(/\n\.archer-edge-label \{[^}]*color: var\(--edge-label-ink\);/);
  });
});
