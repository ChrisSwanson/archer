// Round 1 (UI/UX) fixes, pass 8, batch F29: state cues and focus. The browser test
// (`browser-ts/round1-f29.e2e.ts`) measures the painted pixels; this pins the rules they rest on, and the
// export's presentation key (D18), which is SVG text and needs no browser.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { paintExport } from "../src/export/painter";
import { loadModelEnvelope } from "./fixtures";

const css = (path: string): string => readFileSync(resolve(__dirname, "../src", path), "utf8");
const styles = css("styles.css");
/** The declarations of the first rule whose selector text is exactly `selector`. */
function rule(sheet: string, selector: string): string {
  const at = sheet.indexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  return sheet.slice(sheet.indexOf("{", at) + 1, sheet.indexOf("}", at));
}

describe("R6-claude-01: a focus ring never fades with the line it rings", () => {
  it("a keyboard-focused dimmed edge is drawn at full strength, so its rail is too", () => {
    expect(rule(styles, ".archer-edge.archer-dimmed.archer-kbd-focus .react-flow__edge-path")).toMatch(
      /opacity:\s*1\s*!important/,
    );
  });
  it("so is a focused dimmed sequence message's stroke group, and the rings of a dimmed participant or message", () => {
    expect(
      rule(
        styles,
        '.archer-seq-svg g[opacity="0.25"].archer-seq-kbd-focus :is(.archer-seq-participant-ring, .archer-seq-message-ring, .archer-seq-message-stroke :is(line, path, polyline, polygon))',
      ),
    ).toMatch(/opacity:\s*1;/);
  });
});

describe("R6-claude-02: a selected edge wears the accent whether or not the pointer can select it", () => {
  // In Hand mode React Flow drops `.selectable` from every edge, but Space still selects one (aria-pressed).
  it("the selected stroke rule does not ask for .selectable", () => {
    const body = rule(styles, ".archer-edge.selected .react-flow__edge-path");
    expect(body).toMatch(/stroke:\s*var\(--accent\)\s*!important/);
    // 2 units each side over the resting 2px line (owner, 2026-11-15: lighter lines, less cartoony).
    expect(body).toMatch(/stroke-width:\s*6\s*!important/);
    expect(styles).not.toMatch(/\.archer-edge(\.archer-line-thick)?\.selectable\.selected \.react-flow__edge-path/);
  });
});

/** The controls listed in the shared rule that draws a 1px accent edge inside a borderless pressed control. */
const insetPressed = (): string[] => {
  const m =
    /:is\(([^)]*)\):is\(\[aria-pressed="true"\], \[aria-selected="true"\]\) \{\s*box-shadow: inset 0 0 0 1px var\(--accent\);/.exec(
      styles,
    );
  expect(m).not.toBeNull();
  return m![1]!.split(",").map((s) => s.trim());
};

describe("R6-claude-03: the editor toolbar's pressed tools have an accent edge", () => {
  it("`.authoring-edit-cluster button` is in the shared pressed rule", () => {
    expect(insetPressed()).toContain(".authoring-edit-cluster button");
  });
});

const SEGMENTED = ":is(.archer-emph-legend-mode, .archer-walk-tabs, .archer-chat-switch)";
describe("R6-claude-04..06: one segmented-control rule for One/All, the walkthrough tabs and the chat scope", () => {
  it("the group draws no border of its own and clips nothing (04: the chat switch cut its focus ring to a bar)", () => {
    const group = rule(styles, SEGMENTED);
    expect(group).toMatch(/border:\s*0/);
    expect(group).toMatch(/overflow:\s*visible/);
    for (const [file, selector] of [
      ["chat/chat.css", ".archer-chat-switch {"],
      ["walkthroughs/walkthroughs.css", ".archer-walk-tabs {"],
    ] as const) {
      const own =
        css(file)
          .split("\n")
          .find((line) => line.startsWith(selector)) ?? "";
      expect(own, file).not.toMatch(/overflow:\s*hidden|border:\s*(1px|var\(--line-chrome\))/);
    }
    expect(rule(styles, ".archer-emph-legend-mode")).not.toMatch(
      /overflow:\s*hidden|border:\s*(1px|var\(--line-chrome\))/,
    );
  });
  it("each segment carries the border and the ends carry the group's radius (06: no grey line beside the accent, no square corner)", () => {
    expect(rule(styles, `${SEGMENTED} > button`)).toMatch(
      /border:\s*var\(--line-chrome\) solid var\(--border-strong\)/,
    );
    expect(rule(styles, `${SEGMENTED} > button + button`)).toMatch(/margin-left:\s*-1px/);
    // The group's radius is the card role, 8px (redesign slice 8: corners by role).
    expect(rule(styles, `${SEGMENTED} > button:first-child`)).toMatch(
      /border-start-start-radius:\s*var\(--radius-card\)/,
    );
    expect(rule(styles, `${SEGMENTED} > button:last-child`)).toMatch(/border-end-end-radius:\s*var\(--radius-card\)/);
  });
  it("a pressed segment's own border turns accent and sits over its neighbours'; the inset edge is not drawn too", () => {
    expect(rule(styles, `${SEGMENTED} > button:is([aria-pressed="true"], [aria-selected="true"])`)).toMatch(
      /border-color:\s*var\(--accent\)/,
    );
    for (const control of [".archer-emph-legend-mode button", ".archer-walk-tabs button", ".archer-chat-switch button"])
      expect(insetPressed()).not.toContain(control);
  });
  it("focus is an outer ring, 2px off the segment, so it reads apart from the pressed edge (05)", () => {
    const focus = rule(styles, `${SEGMENTED} > button:focus-visible`);
    expect(focus).toMatch(/outline:\s*2px solid var\(--accent\)/);
    expect(focus).toMatch(/outline-offset:\s*2px/);
    // No later sheet pulls the ring back inside.
    expect(styles).not.toMatch(/\.archer-emph-legend-mode button:focus-visible/);
    expect(css("walkthroughs/walkthroughs.css")).not.toMatch(/\.archer-walk-tabs button:focus-visible/);
  });
});

describe("R6-claude-08: the mode buttons are one height", () => {
  it("a mode button drops the margins `.archer-highlights-open` has elsewhere (they made its row 38 tall)", () => {
    const own =
      css("app/diagram-panel.css")
        .split("\n")
        .find((line) => line.startsWith(".archer-diagram-modes button {")) ?? "";
    expect(own).toMatch(/margin:\s*0;/);
  });
});

// ---- D18 ----------------------------------------------------------------------------------------------
// A C4 drawing, so the key has rows (Person, Container, ...).
const envelope = loadModelEnvelope("c4", "widened", "shop");
const presentation = {
  emphases: [
    {
      id: "mark",
      viewId: "shop",
      groups: [
        {
          id: "pay",
          label: "Payment path",
          style: "highlight",
          palette: "teal",
          state: "existing",
          nodes: ["customer"],
          edges: [],
        },
        {
          id: "follow",
          label: "Order follow-up",
          style: "highlight",
          palette: "violet",
          state: "existing",
          nodes: ["web"],
          edges: [],
        },
      ],
    },
  ],
};
const panelOf = (content: string): string => content.slice(content.indexOf('data-export-presentation="true"'));

describe("D18: the export's presentation key reads in one column", () => {
  it("each key row's words start beside its symbol, not centred far to its right", async () => {
    const painted = await paintExport({ envelope, mode: "presentation", presentation } as never);
    const panel = panelOf(painted.content);
    const symbols = [...panel.matchAll(/<g transform="translate\(([-\d.]+) [-\d.]+\)" color="var\(--text\)">/g)].map(
      (m) => Number(m[1]),
    );
    expect(symbols.length).toBeGreaterThan(0);
    const rows = [...panel.matchAll(/<text x="([-\d.]+)"[^>]*>(?:<tspan[^>]*>)?([^<]*:[^<]*)</g)].filter((m) =>
      /^[A-Z][\w ]*: /.test(m[2]!),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Number(row[1]), row[2]).toBeGreaterThan(symbols[0]!);
      expect(Number(row[1]) - symbols[0]!, row[2]).toBeLessThanOrEqual(48);
    }
    expect(panel, "nothing in the key is centred").not.toContain('text-anchor="middle"');
  });
  it("each highlight group's name has its hue beside it", async () => {
    const painted = await paintExport({ envelope, mode: "presentation", presentation } as never);
    const panel = panelOf(painted.content);
    for (const [name, hue] of [
      ["Payment path", "g1"],
      ["Order follow-up", "g3"],
    ] as const) {
      const at = panel.indexOf(name);
      expect(at, name).toBeGreaterThan(-1);
      const before = panel.slice(0, at);
      const swatch = before.lastIndexOf(`fill="var(--${hue})"`);
      expect(swatch, `${name} swatch`).toBeGreaterThan(-1);
      // The swatch is this name's: no other group's name lies between them.
      expect(before.slice(swatch)).not.toMatch(/Payment path|Order follow-up/);
    }
  });
});
