// The page names its two families once each, as tokens, and sets every sans
// line with one tracking -- the tracking the layout measures labels with. A
// family written straight into a rule is a second copy that drifts (there were
// four monospace stacks, and Inter named in three places), and a tracking the
// layout does not know about overruns the boxes it sized.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TYPE_TRACKING_EM } from "../src/layout/text-measure";
import { declarationsOf, readStylesheet, rulesOf, tokensOf } from "./stylesheet";

const SRC = resolve(process.cwd(), "src");
const REPO = resolve(process.cwd(), "..");

function files(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path, pattern);
    return pattern.test(entry.name) ? [path] : [];
  });
}

/** Every rule of every stylesheet under `src/`, comments removed, but the face declarations. */
const RULES = files(SRC, /\.css$/)
  .filter((path) => !path.endsWith("theme/current-font.css"))
  .flatMap((path) =>
    rulesOf(readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")).map((rule) => ({
      file: relative(SRC, path),
      ...rule,
    })),
  );

const FACE_WEIGHTS = [
  ...readFileSync(join(SRC, "theme/current-font.css"), "utf8").matchAll(
    /font-style:\s*normal;\s*font-weight:\s*(\d+);/g,
  ),
].map((match) => Number(match[1]));

describe("the families", () => {
  const tokens = tokensOf(readStylesheet(), ":root");

  it("are two tokens on the root: Fira Sans, and one monospace stack", () => {
    expect(tokens.get("--font-sans")).toBe('"Fira Sans", ui-sans-serif, system-ui, sans-serif');
    expect(tokens.get("--font-mono")).toMatch(/^ui-monospace, .*monospace$/);
  });

  it("are only ever named by their tokens", () => {
    const named = RULES.flatMap(({ file, selectors, body }) =>
      declarationsOf(body)
        .filter(([property, value]) =>
          property === "font-family"
            ? !/^(var\(--font-(sans|mono)\)|inherit)$/.test(value)
            : property === "font" && /monospace|sans-serif|serif|"/.test(value),
        )
        .map(([property, value]) => `${file}: ${selectors.join(", ")} { ${property}: ${value} }`),
    );
    expect(named).toEqual([]);
  });

  it("has a face for every weight any stylesheet sets, so none is drawn in a neighbour's", () => {
    const off = RULES.flatMap(({ file, selectors, body }) =>
      declarationsOf(body)
        .filter(([property, value]) => property === "font-weight" && /^\d+$/.test(value))
        .filter(([, value]) => !FACE_WEIGHTS.includes(Number(value)))
        .map(([, value]) => `${file}: ${selectors.join(", ")} { font-weight: ${value} }`),
    );
    expect(off).toEqual([]);
  });

  it("leaves no trace of Inter in the page or the service", () => {
    const mentions = [...files(SRC, /\.(ts|tsx|css)$/), ...files(join(REPO, "ts/src"), /\.ts$/)]
      .filter((path) => /\bInter\b|inter-latin|"inter"/.test(readFileSync(path, "utf8")))
      .map((path) => relative(REPO, path));
    expect(mentions).toEqual([]);
  });
});

describe("the tracking", () => {
  it("is one token, the one the layout measures with", () => {
    expect(tokensOf(readStylesheet(), ":root").get("--type-tracking")).toBe(`${TYPE_TRACKING_EM}em`);
  });

  it("is set on every element in its own em, at no specificity", () => {
    // `letter-spacing` inherits as a length: set on the root alone, 0.04em of
    // the root's 16px would be 0.053em of 12px text.
    const every = rulesOf(readStylesheet()).find((rule) => rule.selectors.join(",") === ":where(*)");
    expect(every, ":where(*)").toBeDefined();
    expect(declarationsOf(every!.body)).toContainEqual(["letter-spacing", "var(--type-tracking)"]);
  });

  it("is off wherever the monospace family is set, so code keeps its grid", () => {
    const tracked = RULES.filter(({ body }) =>
      declarationsOf(body).some(([property, value]) => /^font(-family)?$/.test(property) && /--font-mono/.test(value)),
    )
      .filter(
        ({ body }) =>
          !declarationsOf(body).some(([property, value]) => property === "--type-tracking" && value === "0"),
      )
      .map(({ file, selectors }) => `${file}: ${selectors.join(", ")}`);
    expect(tracked).toEqual([]);
  });
});
