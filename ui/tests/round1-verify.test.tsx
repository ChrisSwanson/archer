// @vitest-environment jsdom
// Round 1 (UI/UX) integration: the leftovers the fix batches reported, pinned where jsdom can see them.
// The rendered sizes are checked on the built page by `browser-ts/round1-verify.e2e.ts`.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import ArcherSettings from "../src/app/ArcherSettings";
import { READING_TEXT_PX, readingZoom, type ReadingNotation } from "../src/diagrams/viewport-fit";
import { ER_KEY_FONT_PX, STATE_MARK_FONT_PX } from "../src/layout/figure-metrics";
import { BADGE_FONT, FRAGMENT_FONT } from "../src/layout/sequence-layout";

const css = (path: string): string => readFileSync(resolve(process.cwd(), "src", path), "utf8");

afterEach(cleanup);

describe("round 1 integration leftovers", () => {
  // The opening framing stops where the notation's smallest reading text reaches 12px; a mark set smaller than that
  // face would be drawn smaller than it there. (Fit view shows everything since AM-R1-02, and has no floor.)
  const marks: readonly [ReadingNotation, string, number][] = [
    ["er", "an ER key chip", ER_KEY_FONT_PX],
    ["state", "a start or end word", STATE_MARK_FONT_PX],
    ["sequence", "a message number", BADGE_FONT],
    ["sequence", "a fragment's kind chip", FRAGMENT_FONT],
  ];
  it.each(marks)(
    "V6: on a %s diagram, %s is drawn no smaller than the reading text where the opening framing stops",
    (notation, _what, px) => {
      expect(px * readingZoom(notation).min).toBeGreaterThanOrEqual(READING_TEXT_PX.min - 1e-9);
    },
  );

  it("the sequence canvas sets the fragment chip at FRAGMENT_FONT, not a size under it", () => {
    expect(readFileSync(resolve(process.cwd(), "src/diagrams/SequenceCanvas.tsx"), "utf8")).not.toMatch(
      /FRAGMENT_FONT\s*-\s*1/,
    );
  });

  it("walkthroughs.css keeps no off-path rule keyed on an inline opacity: focus-style's archer-dimmed does that", () => {
    expect(css("walkthroughs/walkthroughs.css")).not.toMatch(/\[style\*=/);
  });

  it("New's plus and caret are drawn on the icon scale, not sized off the button's font", () => {
    const menu = css("app/NewMenu.css");
    expect(menu).toMatch(/\.archer-new-plus\s*\{[^}]*width:\s*var\(--icon-inline\)/);
    expect(menu).toMatch(/\.archer-new-caret\s*\{[^}]*width:\s*var\(--icon-indicator\)/);
    expect(menu).not.toMatch(/font-size:\s*[\d.]+em/);
  });

  it("Archer Settings: the single-character shortcuts row is a styled settings row at the body size", () => {
    render(
      <main>
        <ArcherSettings />
      </main>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Archer settings" }));
    const row = screen.getByRole("checkbox", { name: "Single-character shortcuts" }).closest("label")!;
    expect(row).toHaveClass("archer-settings-toggle");
    expect(row.getAttribute("style")).toBeNull();
    expect(css("app/ArcherSettingsDialog.css")).toMatch(/\.archer-settings-toggle\{[^}]*font-size:var\(--type-body\)/);
  });
});
