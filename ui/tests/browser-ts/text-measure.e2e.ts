// The layout measures text without a browser (`layout/text-measure.ts`), from
// Fira Sans's own advances and the page's tracking. Here the estimate is held
// to what Chromium draws once the embedded faces have loaded: never narrower
// (a label that overruns its box is the failure that matters), and not much
// wider (a box far wider than its label wraps text that would have fitted).
// An isolated project; never the live service.
import { expect, test } from "@playwright/test";
import { estimateTextWidth, TYPE_TRACKING_EM, type TextWeight } from "../../src/layout/text-measure";
import {
  EDGE_LABEL_FONT_PX,
  NODE_DESCRIPTION_FONT_PX,
  NODE_LABEL_FONT_PX,
  NODE_TITLE_FONT_PX,
} from "../../src/layout/graph-metrics";
import { FRAME_CAPTION_FONT_PX } from "../../src/layout/captions";
import { MESSAGE_FONT, PARTICIPANT_FONT } from "../../src/layout/sequence-layout";
import { startTsProject, type TsProject } from "../support/ts-service";
import { walkthroughFiles } from "../support/walkthrough-project";
import { testPage } from "./support/page-path";

const PAGE = testPage();

const LABELS = [
  "Notification worker",
  "Web application (Next.js)",
  "Orders database (Postgres)",
  "API gateway",
  "Identity and access management",
  "POST /orders/42/refund",
  "INTERNAL tools",
  "Is the WWW mirror in sync?",
  "Customer-facing Web Application",
  "Shopper",
  "user record",
  "401 Unauthorized",
  "error: retry after timeout",
  "GET /authorize?response_type=code",
  "302 redirect carrying the authorization code",
  "Idempotency-Key: 7f3a",
  "a+b < c => d",
  "retry #3 ~2s",
  "illicit filling lilt",
  "MMWW @%& mmww",
  "Reads and writ",
];

/** One way the canvas sets text: the size, the face drawn, and the weight the layout measures it with. */
type Setting = {
  readonly name: string;
  readonly px: number;
  readonly css: { readonly weight: 400 | 600 | 700; readonly style: "normal" | "italic" };
  readonly measured: TextWeight;
};

const SETTINGS: readonly Setting[] = [
  { name: "node title, 600", px: NODE_TITLE_FONT_PX, css: { weight: 600, style: "normal" }, measured: true },
  { name: "node title, selected 700", px: NODE_TITLE_FONT_PX, css: { weight: 700, style: "normal" }, measured: true },
  { name: "node label, 600", px: NODE_LABEL_FONT_PX, css: { weight: 600, style: "normal" }, measured: true },
  {
    name: "node description, 400",
    px: NODE_DESCRIPTION_FONT_PX,
    css: { weight: 400, style: "normal" },
    measured: false,
  },
  { name: "edge caption, 400", px: EDGE_LABEL_FONT_PX, css: { weight: 400, style: "normal" }, measured: false },
  {
    name: "edge caption, italic",
    px: EDGE_LABEL_FONT_PX,
    css: { weight: 400, style: "italic" },
    measured: "italic",
  },
  { name: "edge caption, selected 700", px: EDGE_LABEL_FONT_PX, css: { weight: 700, style: "normal" }, measured: true },
  { name: "frame caption, 600", px: FRAME_CAPTION_FONT_PX, css: { weight: 600, style: "normal" }, measured: true },
  { name: "participant, 600", px: PARTICIPANT_FONT, css: { weight: 600, style: "normal" }, measured: true },
  { name: "message, 400", px: MESSAGE_FONT, css: { weight: 400, style: "normal" }, measured: false },
];

/**
 * The most the estimate may exceed the drawn width: six pixels, or 8%. It is sized for the wider of the two ways
 * Chromium draws (exact advances on macOS, hinted whole pixels on Linux), so it leans wide on either; measured
 * 2026-11-11 on macOS it was 5.4px over on average, at most 10.7px (4.1%) and at most 7.5% (5.2px on 70px).
 */
const slack = (drawn: number): number => Math.max(6, drawn * 0.08);

test.describe("text measured without a browser, against Chromium", () => {
  let server: TsProject;
  test.beforeAll(async () => {
    server = await startTsProject({ pagePath: PAGE, files: walkthroughFiles() });
    await server.present("containers");
  });
  test.afterAll(async () => {
    await server?.stop();
  });

  test("is never narrower than a label is drawn, and within a few pixels of it", async ({ page }) => {
    await page.goto(server.url);
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    const drawn = await page.evaluate(
      async ({ labels, settings }) => {
        const host = document.createElement("div");
        host.style.cssText = "position:absolute;left:0;top:0;visibility:hidden;white-space:pre";
        document.body.append(host);
        const spans = settings.flatMap((setting) =>
          labels.map((label) => {
            const span = document.createElement("span");
            span.style.cssText = `display:inline-block;font-size:${setting.px}px;font-weight:${setting.css.weight};font-style:${setting.css.style}`;
            span.textContent = label;
            host.append(span);
            return { setting: setting.name, label, span };
          }),
        );
        await document.fonts.ready;
        const faces = [...document.fonts]
          .filter((face) => face.family.replace(/"/g, "") === "Fira Sans")
          .map((face) => `${face.weight} ${face.style} ${face.status}`)
          .sort();
        const widths = spans.map(({ setting, label, span }) => ({
          setting,
          label,
          width: span.getBoundingClientRect().width,
          tracking: getComputedStyle(span).letterSpacing,
          family: getComputedStyle(span).fontFamily,
        }));
        host.remove();
        return { faces, widths };
      },
      { labels: LABELS, settings: SETTINGS },
    );

    // Drawn in the embedded faces, every one loaded: no host fallback.
    expect(drawn.faces).toEqual(
      expect.arrayContaining(["400 italic loaded", "400 normal loaded", "600 normal loaded", "700 normal loaded"]),
    );
    const report: string[] = [];
    for (const { setting: name, label, width, tracking, family } of drawn.widths) {
      const setting = SETTINGS.find((candidate) => candidate.name === name)!;
      expect(family, name).toMatch(/^"Fira Sans",/);
      expect(Number.parseFloat(tracking), `${name}: letter-spacing`).toBeCloseTo(TYPE_TRACKING_EM * setting.px, 2);
      const estimate = estimateTextWidth(label, setting.px, setting.measured);
      report.push(`${name.padEnd(28)} ${label.padEnd(46)} drawn ${width.toFixed(2).padStart(7)} estimate ${estimate}`);
      expect.soft(estimate, `${name}: ${label} (drawn ${width})`).toBeGreaterThanOrEqual(width);
      expect.soft(estimate - width, `${name}: ${label} (drawn ${width})`).toBeLessThanOrEqual(slack(width));
    }
    test.info().annotations.push({ type: "widths", description: report.join("\n") });
    if (process.env["ARCHER_TEXT_MEASURE_REPORT"]) console.log(report.join("\n"));
  });
});
