import { describe, expect, it } from "vitest";
import { estimateTextWidth, truncateToWidth, wrapText } from "../src/layout/text-measure";

describe("wrapText", () => {
  it("returns a short label untouched", () => {
    expect(wrapText("POST /login", 340, 12, 3)).toEqual(["POST /login"]);
  });

  it("breaks between words and keeps every line inside the width", () => {
    const lines = wrapText("302 redirect carrying the authorization code back to the client", 160, 12, 4);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(estimateTextWidth(line, 12)).toBeLessThanOrEqual(160);
    }
    expect(lines.join(" ")).toBe("302 redirect carrying the authorization code back to the client");
  });

  it("starts an over-long token on the current line instead of stranding the word before it", () => {
    // Seen in the app: `GET` sat alone above a URL that had been pushed whole
    // onto the next line.
    const lines = wrapText(
      "GET /authorize?response_type=code&client_id=abc&redirect_uri=https://example.com/cb",
      340,
      12,
      3,
    );
    expect(lines[0].startsWith("GET /authorize")).toBe(true);
    for (const line of lines) {
      expect(estimateTextWidth(line, 12)).toBeLessThanOrEqual(340);
    }
  });

  it("cuts what does not fit in the last allowed line with an ellipsis", () => {
    const lines = wrapText("alpha beta gamma delta epsilon zeta eta theta iota kappa", 70, 12, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith("…")).toBe(true);
    expect(estimateTextWidth(lines[1], 12)).toBeLessThanOrEqual(70);
  });
});

describe("truncateToWidth", () => {
  it("leaves text that fits alone and shortens text that does not", () => {
    expect(truncateToWidth("short", 200, 12)).toBe("short");
    const cut = truncateToWidth("a considerably longer label than the box", 80, 12);
    expect(cut.endsWith("…")).toBe(true);
    expect(estimateTextWidth(cut, 12)).toBeLessThanOrEqual(80);
  });
});

describe("estimateTextWidth, bold", () => {
  // Measured, not guessed: the rendered width of the embedded Fira Sans at
  // weight 700, 12px, with the page's tracking, in headless Chromium on macOS
  // and Linux, the wider of the two rounded up (2026-11-11). A selected message
  // label is drawn at this weight on a plate cut from this estimate, and
  // "user record" once touched both ends of its plate.
  const MEASURED_BOLD_12PX: readonly (readonly [string, number])[] = [
    ["user record", 71],
    ["POST /login", 71],
    ["SELECT user", 72],
    ["401 Unauthorized", 107],
    ["200 OK", 42],
    ["GET /session", 77],
    ["Open dashboard", 99],
    ["200 session", 71],
    ["refresh token", 84],
    ["error: retry after timeout", 154],
    ["first third for terror", 120],
  ];

  it.each(MEASURED_BOLD_12PX)("is never narrower than %j is drawn in bold", (text, drawn) => {
    expect(estimateTextWidth(text, 12, true)).toBeGreaterThanOrEqual(drawn);
  });

  it("does not balloon: stays within a quarter of the drawn width", () => {
    for (const [text, drawn] of MEASURED_BOLD_12PX) {
      expect(estimateTextWidth(text, 12, true)).toBeLessThanOrEqual(drawn * 1.25);
    }
  });
});
