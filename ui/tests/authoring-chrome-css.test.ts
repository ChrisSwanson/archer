// The editor chrome's stylesheet contract: the classes the workspace and canvases put on their elements have
// rules here, so no element falls back to inline styles, and the layout rules that keep the chrome from clipping
// and overlapping at narrow widths stay in place (the browser checks are `chrome-clipped`/`chrome-overlap`).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/authoring/authoring.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const shell = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
/** Every declaration block whose selector list names `selector` exactly (rules nested in an at-rule included). */
const bodyOf = (selector: string, sheet = css): string =>
  [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) =>
      m[1]
        .split(",")
        .map((s) => s.trim())
        .includes(selector),
    )
    .map((m) => m[2])
    .join(";");

describe("editor chrome stylesheet", () => {
  it.each([
    ".authoring-feedback",
    ".authoring-feedback-info",
    ".authoring-feedback-warning",
    ".authoring-feedback-error",
    ".authoring-feedback-details",
    ".authoring-stale-note",
    ".authoring-diagnostics-notes",
    ".authoring-preview-stale>.react-flow",
    ".archer-connect-target",
    ".archer-seq-part",
    ".archer-seq-part-selection",
    ".archer-seq-part-selection-fragment",
  ])("styles %s", (selector) => {
    expect(bodyOf(selector)).not.toBe("");
  });

  it("styles the text-style action and the missing-route page", () => {
    expect(bodyOf(".authoring-workspace .authoring-link-button")).toMatch(/background:none/);
    expect(bodyOf(".archer-route-missing", shell)).toMatch(/max-width:640px/);
  });

  it("pins the feedback callout bottom-centre over the drawing", () => {
    expect(bodyOf(".authoring-feedback")).toMatch(/position:absolute.*bottom:16px.*left:50%.*translateX\(-50%\)/);
  });

  it("never draws compiler notes in the error colour", () => {
    expect(bodyOf(".authoring-diagnostics-notes")).not.toMatch(/danger/);
    expect(bodyOf(".authoring-feedback-info")).not.toMatch(/danger/);
  });

  it("drops the accent fill from a disabled Save", () => {
    expect(bodyOf(".authoring-toolbar .authoring-primary:disabled")).toMatch(/background:transparent/);
  });

  it("keeps the top band in flow and lets the parts bar wrap instead of clipping", () => {
    expect(css).not.toMatch(/top:88px/);
    expect(bodyOf(".authoring-tools-row")).toMatch(/position:relative.*flex-wrap:wrap/);
    expect(bodyOf(".authoring-tools-row .authoring-parts")).toMatch(/flex:0 0 auto.*flex-wrap:wrap/);
  });
  it("keeps the editing header on one row from tablet width: the trail and title give way, the tools do not (smoke-c#10:d)", () => {
    const tablet = /@media\(min-width:721px\)\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(tablet).toMatch(/\.primary-document-bar:has\(\.authoring-toolbar\)\{flex-wrap:nowrap\}/);
    expect(tablet).toMatch(/:is\(\.primary-document-local-tools,\.primary-document-actions\)\{flex:none\}/);
    expect(tablet).toMatch(/\.primary-document-title\{white-space:nowrap;overflow:hidden;text-overflow:ellipsis/);
  });
  it("places the reading page's diagram key over the drawing being edited, clear of the bottom-centre hint (ux:F13:b)", () => {
    expect(bodyOf(".authoring-preview")).toMatch(/--diagram-key-height:176px;--diagram-key-inset:12px/);
    // Clear of the key where there is room, never narrower than a readable 280 px (or the canvas) where there is not.
    expect(css).toContain(
      ".authoring-preview:has(>.archer-diagram-key)>:is(.authoring-coach,.authoring-feedback){max-width:max(min(280px,calc(100% - 24px)),calc(100% - 2*(var(--diagram-key-inset) + 236px)))}",
    );
  });
});
