// The page's typography: the face the page names is the face it gets, the
// chrome is set on one ramp, and it is set in `rem`, so a reader who has
// raised their browser's text size gets bigger chrome. And no light weight
// in small text: a weight-300 stroke at 12px is about a pixel wide and breaks
// up on an ordinary screen (the care the retired Line map design took).
//
// What is NOT held here is the canvas: node, edge and caption labels are
// drawn at sizes the layout measures in pixels (`layout/`, the framing), so
// their sizes stay where they are and are listed below by name.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { declarationsOf, readStylesheet, rulesOf, tokensOf, type Rule } from "./stylesheet";
import { JOURNEY_LABEL_FONT_PX } from "../src/export/journey-metrics";
import { FRAME_CAPTION_FONT_PX } from "../src/layout/captions";
import { PARTICIPANT_FONT } from "../src/layout/sequence-layout";
import {
  EDGE_LABEL_FONT_PX,
  EDGE_TECHNOLOGY_FONT_PX,
  NODE_KIND_FONT_PX,
  NODE_LABEL_FONT_PX,
} from "../src/layout/graph-metrics";
import { NEST_CAPTION_FONT_PX } from "../src/layout/elk-layout";

const CSS = readStylesheet();
const ROOT_PX = 16;

/**
 * Text drawn ON the canvas or measured by the framing, whose size in pixels
 * is part of a layout calculation. Each is someone else's contract:
 * `.archer-node` and the edge labels are measured by `layout/`, the frame
 * caption by `FrameNode`, the journey board by `JourneyCanvas`, and the
 * off-screen cue, the legend and the canvas controls by the framing's
 * clearance (`diagrams/chrome-clearance.ts`, `CUE_HEIGHT_PX`).
 */
const CANVAS = [
  /^\.archer-node\b/,
  /^\.archer-edge\b/,
  /^\.archer-frame-caption\b/,
  /^\.archer-journey/,
  /^\.archer-overview-cue\b/,
  /^\.archer-offscreen/,
  /^\.archer-emph-legend/,
  /^\.archer-canvas-controls\b/,
  /^\.react-flow/,
];

const isCanvas = (selector: string): boolean =>
  CANVAS.some((pattern) => pattern.test(selector.replace(/^:root(\[[^\]]+\])*\s*/, "")));

const base = (): Rule[] => rulesOf(CSS);

const RAMP = {
  "--type-floor": 11,
  "--type-small": 12,
  "--type-body": 14,
  "--type-title": 17,
  "--type-display": 22,
  // The note pages' long-form reading scale (round 1).
  "--type-reading": 15,
  "--type-reading-heading": 22.5,
  "--type-reading-title": 26,
} as const;

/** A font size in px, through the ramp's tokens; `undefined` when it is not a length this test can read. */
function px(value: string): number | undefined {
  const token = /^var\((--type-[a-z-]+)\)$/.exec(value);
  if (token !== null) return RAMP[token[1] as keyof typeof RAMP];
  const rem = /^([\d.]+)rem$/.exec(value);
  if (rem !== null) return Number(rem[1]) * ROOT_PX;
  const pixels = /^([\d.]+)px$/.exec(value);
  if (pixels !== null) return Number(pixels[1]);
  return undefined;
}

const chromeSizes = (): Array<{ selector: string; value: string }> =>
  base().flatMap((rule) =>
    declarationsOf(rule.body)
      .filter(([property]) => property === "font-size")
      .flatMap(([, value]) =>
        rule.selectors.filter((selector) => !isCanvas(selector)).map((selector) => ({ selector, value })),
      ),
  );

describe("the page's face", () => {
  const FONT_CSS = "src/theme/current-font.css";
  const declarations = existsSync(resolve(process.cwd(), FONT_CSS))
    ? readFileSync(resolve(process.cwd(), FONT_CSS), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
    : "";
  const faces = [...declarations.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((match) => {
    const body = match[1]!;
    const value = (property: string): string | undefined =>
      new RegExp(`${property}:\\s*([^;]+);`).exec(body)?.[1]?.trim();
    return {
      family: value("font-family"),
      weight: value("font-weight"),
      style: value("font-style"),
      src: /src:\s*url\("(\.\/[^"]+\.woff2)"\)\s*format\("woff2"\)/.exec(body)?.[1],
    };
  });

  it("is named by one token, first on the root, and the root uses it", () => {
    const tokens = tokensOf(CSS, ":root");
    expect(tokens.get("--font-sans")).toMatch(/^"Fira Sans",/);
    const root = rulesOf(CSS).find(
      (rule) => rule.selectors.length === 1 && rule.selectors[0] === ":root" && /font-family/.test(rule.body),
    );
    expect(root, ":root { font-family }").toBeDefined();
    expect(declarationsOf(root!.body).find(([property]) => property === "font-family")?.[1]).toBe("var(--font-sans)");
  });

  it("is embedded: Fira Sans 400, 500, 600, 700 and 400 italic, local woff2s the build inlines, nothing from the network", () => {
    // The page is one file under `font-src data:`: a face that is only
    // declared renders in whatever the system falls back to.
    expect(declarations).not.toMatch(/https?:/);
    expect(faces.map(({ family, weight, style }) => `${family} ${weight} ${style}`).sort()).toEqual([
      '"Fira Sans" 400 italic',
      '"Fira Sans" 400 normal',
      '"Fira Sans" 500 normal',
      '"Fira Sans" 600 normal',
      '"Fira Sans" 700 normal',
    ]);
    for (const face of faces) {
      expect(face.src, `${face.weight} ${face.style}: a relative woff2 source`).toBeDefined();
      const font = readFileSync(resolve(process.cwd(), dirname(FONT_CSS), face.src!));
      expect(font.subarray(0, 4).toString("latin1")).toBe("wOF2");
      // A latin subset, not the whole family: the bundle carries every face inline.
      expect(font.length).toBeLessThan(40_000);
    }
  });

  it("has a face for every weight the stylesheet asks for, so none is drawn in a neighbour's or synthesised", () => {
    const drawn = new Set(faces.filter((face) => face.style === "normal").map((face) => Number(face.weight)));
    const asked = base().flatMap((rule) =>
      declarationsOf(rule.body)
        .filter(([property, value]) => property === "font-weight" && /^\d+$/.test(value))
        .map(([, value]) => Number(value)),
    );
    expect([...new Set(asked)].filter((weight) => !drawn.has(weight))).toEqual([]);
  });

  it("is loaded by the page, and ships with its licence", () => {
    expect(readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8")).toMatch(
      /import "\.\/theme\/current-font\.css";/,
    );
    const licence = readFileSync(resolve(process.cwd(), "src/theme/fonts/FiraSans-OFL.txt"), "utf8");
    expect(licence).toMatch(/The Mozilla Foundation and Telefonica S\.A\./);
    expect(licence).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/);
  });
});

describe("the chrome's type ramp", () => {
  it("is declared once, on the root, in rem", () => {
    const tokens = tokensOf(CSS, ":root");
    for (const [name, size] of Object.entries(RAMP)) {
      expect(tokens.get(name), name).toBe(`${size / ROOT_PX}rem`);
    }
  });

  it("sets every chrome size on the ramp, so a raised browser text size raises it", () => {
    const off = chromeSizes()
      .filter(({ value }) => value !== "inherit" && !/^var\(--type-[a-z-]+\)$/.test(value))
      .map(({ selector, value }) => `${selector} { font-size: ${value} }`);
    expect(off).toEqual([]);
  });

  it("holds every stylesheet under src/ to it: chrome on the ramp, canvas lettering on a named canvas token", () => {
    // Not only styles.css: the shell, comments, chat, authoring, walkthroughs and the rest (redesign slice 8).
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = resolve(dir, name);
        if (statSync(path).isDirectory()) return files(path);
        return name.endsWith(".css") && !path.endsWith("current-font.css") ? [path] : [];
      });
    const off: string[] = [];
    for (const file of files(resolve(process.cwd(), "src"))) {
      const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const rule of rulesOf(css))
        for (const [property, value] of declarationsOf(rule.body)) {
          const size =
            property === "font-size"
              ? value
              : property === "font"
                ? /([\d.]+(?:px|rem|em))/.exec(value)?.[1]
                : undefined;
          // `0` hides a text glyph an icon stands in for; it is not a size text is read at.
          if (size === undefined || size === "inherit" || size === "0" || /^var\(--type-[a-z-]+\)$/.test(size))
            continue;
          if (property === "font" && /var\(--type-[a-z-]+\)/.test(value)) continue;
          off.push(`${file.split("/src/")[1]}: ${rule.selectors.join(", ")} { ${property}: ${value} }`);
        }
    }
    expect(off).toEqual([]);
  });

  it("names a family only through its token: --font-sans or --font-mono, in every stylesheet", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = resolve(dir, name);
        if (statSync(path).isDirectory()) return files(path);
        return name.endsWith(".css") && !path.endsWith("current-font.css") ? [path] : [];
      });
    const named: string[] = [];
    for (const file of files(resolve(process.cwd(), "src"))) {
      const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const rule of rulesOf(css))
        for (const [property, value] of declarationsOf(rule.body)) {
          if (property === "font-family" && !/^(var\(--font-(sans|mono)\)|inherit)$/.test(value))
            named.push(`${file.split("/src/")[1]}: ${rule.selectors.join(", ")} { font-family: ${value} }`);
          if (property === "font" && /monospace|Menlo|Consolas|Monaco|sans-serif/.test(value))
            named.push(`${file.split("/src/")[1]}: ${rule.selectors.join(", ")} { font: ${value} }`);
        }
    }
    expect(named).toEqual([]);
  });

  it("never sets functional text below 11px", () => {
    const small = chromeSizes()
      .filter(({ value }) => (px(value) ?? Infinity) < RAMP["--type-floor"])
      .map(({ selector, value }) => `${selector} { font-size: ${value} }`);
    expect(small).toEqual([]);
  });

  it("sizes the document bar's controls in rem, so they grow with the text in them", () => {
    const shell = readFileSync(resolve(process.cwd(), "src/app/WorkspaceNavigation.css"), "utf8");
    const button = rulesOf(shell).find(
      (rule) => rule.selectors.includes(".primary-document-actions button") && /min-height/.test(rule.body),
    );
    expect(declarationsOf(button!.body).find(([property]) => property === "min-height")?.[1]).toMatch(/rem$/);
  });

  it("holds the bar's action row in rem, so the space kept for its tools grows with them (O240)", () => {
    const shell = readFileSync(resolve(process.cwd(), "src/app/WorkspaceNavigation.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const row = rulesOf(shell).find(
      (rule) => rule.selectors.includes(".primary-document-actions") && /min-height/.test(rule.body),
    );
    expect(declarationsOf(row!.body).find(([property]) => property === "min-height")?.[1]).toMatch(/rem$/);
  });
});

describe("light weights stay out of small text", () => {
  /*
   * A light weight is for text large enough to carry it. Below 13px a weight
   * under 400 is a stroke of about a pixel, and it breaks up. The rule each
   * weight is stated in has to set a size of its own of 13px or more for the
   * weight to be light; the stylesheet states none at present, and the first
   * one is held to this.
   */
  const weights = rulesOf(CSS).flatMap((rule) =>
    declarationsOf(rule.body)
      .filter(([property, value]) => property === "font-weight" && /^\d+$/.test(value))
      .map(([, value]) => ({ rule, weight: Number(value) })),
  );

  it("finds the weights the stylesheet states", () => {
    expect(weights.length).toBeGreaterThan(20);
  });

  it("sets nothing under 400 unless it is set at 13px or more", () => {
    const light = weights
      .filter(({ weight }) => weight < 400)
      .filter(({ rule }) => {
        const size = declarationsOf(rule.body).find(([property]) => property === "font-size")?.[1];
        return size === undefined || (px(size) ?? 0) < 13;
      })
      .map(({ rule, weight }) => `${rule.selectors.join(", ")} { font-weight: ${weight} }`);
    expect(light).toEqual([]);
  });

  it("states no light weight on an SVG label either", () => {
    // The canvases' own `fontWeight` attributes, which no stylesheet sees.
    const sources = [
      "src/diagrams/SequenceCanvas.tsx",
      "src/diagrams/JourneyCanvas.tsx",
      "src/diagrams/FigureNode.tsx",
    ].map((file) => readFileSync(resolve(process.cwd(), file), "utf8"));
    for (const source of sources) {
      for (const match of source.matchAll(/fontWeight=\{(\d+)\}/g))
        expect(Number(match[1])).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("the canvas lettering tokens", () => {
  /*
   * Canvas lettering stays off the chrome's ramp (the layout measures it in px), but the sizes between the
   * ramp's steps are named (round 1 pass 3): each token is the layout's own constant, so a token and
   * the measured text cannot drift apart, and the diagrams look exactly as they did.
   */
  const CANVAS_TYPE = {
    "--type-canvas-frame": FRAME_CAPTION_FONT_PX,
    "--type-canvas-participant": PARTICIPANT_FONT,
    "--type-canvas-journey": JOURNEY_LABEL_FONT_PX,
  } as const;
  const sizeOf = (selector: string): string | undefined =>
    declarationsOf(
      rulesOf(CSS).find((rule) => rule.selectors.includes(selector) && /font-size/.test(rule.body))?.body ?? "",
    ).find(([property]) => property === "font-size")?.[1];

  it("are the layout's sizes: 14, 13 and 13.5px", () => {
    expect(Object.values(CANVAS_TYPE)).toEqual([14, 13, 13.5]);
  });

  it("include the graph's lettering, each equal to the constant the layout measures it with", () => {
    const tokens = tokensOf(CSS, ":root");
    for (const [name, size] of Object.entries({
      "--type-canvas-node-label": NODE_LABEL_FONT_PX,
      "--type-canvas-edge-label": EDGE_LABEL_FONT_PX,
      "--type-canvas-edge-detail": EDGE_TECHNOLOGY_FONT_PX,
      "--type-canvas-kind": NODE_KIND_FONT_PX,
      "--type-canvas-nest-caption": NEST_CAPTION_FONT_PX,
    }))
      expect(tokens.get(name), name).toBe(`${size}px`);
  });

  it("are declared once, on the root, in px, equal to the layout's constants", () => {
    const tokens = tokensOf(CSS, ":root");
    for (const [name, size] of Object.entries(CANVAS_TYPE)) expect(tokens.get(name), name).toBe(`${size}px`);
  });

  it("are what the canvas rules set", () => {
    expect(sizeOf(".archer-frame-caption")).toBe("var(--type-canvas-frame)");
    expect(sizeOf(".archer-journey-section-label")).toBe("var(--type-canvas-journey)");
    expect(sizeOf(".archer-journey-task-label")).toBe("var(--type-canvas-journey)");
    expect(sizeOf(".archer-seq-participant text")).toBe("var(--type-canvas-participant)");
  });

  it("are type tokens to the harness's census too", () => {
    const harness = readFileSync(resolve(process.cwd(), "../tools/devkit/harness/tokens.mjs"), "utf8");
    const listed = /export const TYPE_TOKENS\s*=\s*Object\.freeze\(\[([^\]]*)\]\)/.exec(harness)?.[1] ?? "";
    const names = [...listed.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
    for (const name of [...Object.keys(RAMP), ...Object.keys(CANVAS_TYPE)]) expect(names, name).toContain(name);
  });
});
