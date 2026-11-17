// The a11y sweep (rubric docs/quality/rubrics/ui-ux.md §8; G1, G8, G9, V4): every matrix cell (state × viewport ×
// theme) gets
//   - axe with the WCAG tags `wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa` (G1), plus `best-practice` reported apart
//     (§5); violations and incomplete results per cell, with no `exclude()` (the dev server's Impeccable helper is
//     blocked at the network instead, so nothing of the product is excluded);
//   - viewport geometry: page-level horizontal overflow, controls outside the viewport, text clipped by its own
//     box (G8, V4), the pointer and theme the cell actually ran with;
//   - a live-region log from document start (G9): what each region said, and when.
// Each cell is a JSON file under the output directory; `summary.json` and `summary.md` are rebuilt as cells land.
//
// The self-tests (always run, no service) show each collector on a known pass and a known fail (rubric §8): a labelled
// button / an unlabelled one; 320 px / 330 px content at 320; a status message logged once.
//
// The matrix runs only with ARCHER_SWEEP=1 (about 25 states × 4 viewports × 2 themes):
//   ARCHER_SWEEP=1 npx playwright test -c tests/browser-ts a11y-sweep
// Select a quick run with comma lists (a trailing * is a prefix; a bare surface id such as P4 selects its states):
//   ARCHER_SWEEP_SURFACES=P1.overview,P4.explore.*  ARCHER_SWEEP_VIEWPORTS=1500x900,320x640  ARCHER_SWEEP_THEMES=dark
// Target: ARCHER_SWEEP_ORIGIN + ARCHER_SWEEP_LOGIN (an already running page and its sign-in link; the dev server's
// front door needs ARCHER_SWEEP_SERVICE_ORIGIN, and the Highlights cell ARCHER_SWEEP_EMPHASIS_DIAGRAM=<slug>/<path> of a
// diagram carrying an emphasis; see surfaces.mjs), or ARCHER_SANDBOX=<name> (a devkit sandbox), else
// this file serves the Pageturner corpus itself from this checkout's build (ui/dist, `npm run build` first).
// Output: ARCHER_SWEEP_OUT, else $TMPDIR/archer-a11y-sweep-<runner pid>/.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { liveRegionRecorder, pageGeometry, type LiveEvent } from "../../../tools/devkit/harness/page-probes.mjs";
import {
  cellContext,
  leaveState,
  loginState,
  mdTable,
  openState,
  redact,
  resolveTarget,
  selectCells,
  type Target,
} from "../../../tools/devkit/harness/surfaces.mjs";
import { startTsProject, type TsProject } from "../support/ts-service";
import { testPage } from "./support/page-path";

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const OUT = process.env.ARCHER_SWEEP_OUT ?? join(tmpdir(), `archer-a11y-sweep-${process.ppid}`);

type AxeNode = { target: unknown; html: string; failureSummary?: string };
type AxeRule = { id: string; impact?: string | null; tags: string[]; help: string; helpUrl: string; nodes: AxeNode[] };
type Cell = {
  cell: string;
  state: string;
  surface: string;
  viewport: string;
  theme: string;
  url?: string;
  notAvailable?: string;
  error?: string;
  axe?: {
    version: string;
    wcag: AxeRule[];
    bestPractice: AxeRule[];
    incomplete: AxeRule[];
    counts: Record<string, number>;
  };
  geometry?: ReturnType<typeof pageGeometry>;
  live?: { events: LiveEvent[]; regions: unknown[] };
  ms?: number;
};

/** axe over the page as it is, WCAG tags and best-practice in one run, split by tag. */
async function axe(page: Page): Promise<NonNullable<Cell["axe"]>> {
  const r = await new AxeBuilder({ page }).withTags([...WCAG, "best-practice"]).analyze();
  const slim = (v: (typeof r.violations)[number]): AxeRule => ({
    id: v.id,
    impact: v.impact,
    tags: v.tags,
    help: v.help,
    helpUrl: v.helpUrl,
    nodes: v.nodes
      .slice(0, 25)
      .map((n) => ({ target: n.target, html: n.html.slice(0, 300), failureSummary: n.failureSummary?.slice(0, 400) })),
  });
  const isWcag = (v: { tags: string[] }) => v.tags.some((t) => WCAG.includes(t));
  const wcag = r.violations.filter(isWcag).map(slim),
    bestPractice = r.violations.filter((v) => !isWcag(v)).map(slim);
  const incomplete = r.incomplete.filter(isWcag).map(slim);
  const nodes = (rules: AxeRule[]) => rules.reduce((n, v) => n + v.nodes.length, 0);
  const counts: Record<string, number> = {
    wcagRules: wcag.length,
    wcagNodes: nodes(wcag),
    bestPracticeNodes: nodes(bestPractice),
    incompleteNodes: nodes(incomplete),
  };
  for (const v of wcag)
    counts[`impact:${v.impact ?? "none"}`] = (counts[`impact:${v.impact ?? "none"}`] ?? 0) + v.nodes.length;
  return { version: r.testEngine.version, wcag, bestPractice, incomplete, counts };
}

async function measureCell(page: Page): Promise<Pick<Cell, "axe" | "geometry" | "live">> {
  const geometry = await page.evaluate(pageGeometry);
  const live = await page.evaluate(() => ({
    events: (window as unknown as { __liveLog?: LiveEvent[] }).__liveLog ?? [],
    regions: (window as unknown as { __liveRegions?: () => unknown[] }).__liveRegions?.() ?? [],
  }));
  return { axe: await axe(page), geometry, live };
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** Rebuild summary.json / summary.md from every cell file present (workers race; the last writer has them all). */
function summarise(dir: string): void {
  const cells: Cell[] = readdirSync(join(dir, "cells"))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, "cells", f), "utf8")));
  const rules = new Map<string, { impact: string; help: string; nodes: number; cells: string[] }>();
  for (const c of cells)
    for (const v of c.axe?.wcag ?? []) {
      const e = rules.get(v.id) ?? { impact: v.impact ?? "", help: v.help, nodes: 0, cells: [] };
      e.nodes += v.nodes.length;
      e.cells.push(c.cell);
      rules.set(v.id, e);
    }
  const measured = cells.filter((c) => c.axe);
  const totals = {
    cells: cells.length,
    measured: measured.length,
    notAvailable: cells.filter((c) => c.notAvailable).length,
    errors: cells.filter((c) => c.error).length,
    wcagNodes: measured.reduce((n, c) => n + (c.axe?.counts.wcagNodes ?? 0), 0),
    cellsWithWcagViolations: measured.filter((c) => (c.axe?.counts.wcagNodes ?? 0) > 0).length,
    incompleteNodes: measured.reduce((n, c) => n + (c.axe?.counts.incompleteNodes ?? 0), 0),
    bestPracticeNodes: measured.reduce((n, c) => n + (c.axe?.counts.bestPracticeNodes ?? 0), 0),
    maxOverflowPx: Math.max(0, ...measured.map((c) => c.geometry?.horizontalOverflowPx ?? 0)),
    cellsWithOverflow: measured.filter((c) => (c.geometry?.horizontalOverflowPx ?? 0) > 0).length,
    controlsOutsideViewport: measured.reduce(
      (n, c) => n + (c.geometry?.controlsOutsideViewport.filter((o) => !o.inScroller).length ?? 0),
      0,
    ),
    liveEvents: measured.reduce((n, c) => n + (c.live?.events.filter((e) => e.text !== "").length ?? 0), 0),
    axeVersion: measured[0]?.axe?.version ?? null,
  };
  const json = {
    tool: "a11y-sweep",
    schema: "archer-a11y-sweep/1",
    generatedAt: new Date().toISOString(),
    tags: WCAG,
    totals,
    rules: Object.fromEntries(rules),
    cells: cells.map((c) => ({
      cell: c.cell,
      url: c.url,
      notAvailable: c.notAvailable,
      error: c.error,
      counts: c.axe?.counts,
      overflowPx: c.geometry?.horizontalOverflowPx,
      outside: c.geometry?.controlsOutsideViewport.length,
      clipped: c.geometry?.clippedText.length,
      live: c.live?.events.filter((e) => e.text !== "").length,
    })),
  };
  let md = `# A11y sweep (G1, G8, G9, V4)\n\n${json.generatedAt} · axe ${totals.axeVersion} · tags ${WCAG.join(", ")} · ${totals.measured} cells measured, ${totals.notAvailable} not available, ${totals.errors} errors\n\n`;
  md += `WCAG violations: **${totals.wcagNodes} nodes** in ${totals.cellsWithWcagViolations} cells; incomplete ${totals.incompleteNodes}; best-practice ${totals.bestPracticeNodes}. Page overflow: max ${totals.maxOverflowPx} px, ${totals.cellsWithOverflow} cells. Controls outside the viewport (not in a scroller): ${totals.controlsOutsideViewport}. Live-region announcements (non-empty) during load: ${totals.liveEvents}.\n\n`;
  md +=
    "## WCAG rules\n\n" +
    mdTable(
      ["rule", "impact", "nodes", "cells", "help"],
      [...rules.entries()]
        .sort((a, b) => b[1].nodes - a[1].nodes)
        .map(([id, e]) => [id, e.impact, e.nodes, e.cells.length, e.help]),
    );
  md +=
    "\n## Cells\n\n" +
    mdTable(
      [
        "cell",
        "WCAG nodes",
        "incomplete",
        "best-practice",
        "overflow px",
        "outside",
        "clipped text",
        "live events",
        "note",
      ],
      cells.map((c) => [
        c.cell,
        c.axe?.counts.wcagNodes ?? "",
        c.axe?.counts.incompleteNodes ?? "",
        c.axe?.counts.bestPracticeNodes ?? "",
        c.geometry?.horizontalOverflowPx ?? "",
        c.geometry?.controlsOutsideViewport.length ?? "",
        c.geometry?.clippedText.length ?? "",
        c.live?.events.filter((e) => e.text !== "").length ?? "",
        c.notAvailable ? `not available: ${c.notAvailable}` : c.error ? `error: ${c.error}` : "",
      ]),
    );
  writeAtomic(join(dir, "summary.json"), redact(JSON.stringify(json, null, 2)));
  writeAtomic(join(dir, "summary.md"), redact(md));
}

test.describe("a11y sweep self-test (known pass / known fail)", () => {
  const plant = async (page: Page, html: string, width = 800): Promise<void> => {
    await page.setViewportSize({ width, height: 600 });
    await page.setContent(
      `<!doctype html><html lang="en"><head><title>Plant</title><meta name="viewport" content="width=device-width"><style>body{margin:0}</style></head><body><main><h1>Plant</h1>${html}</main></body></html>`,
    );
  };

  test("axe: a labelled button passes; an unlabelled one fails button-name", async ({ page }) => {
    await plant(page, `<button type="button">Save</button>`);
    expect((await axe(page)).counts.wcagNodes).toBe(0);
    await plant(
      page,
      `<button type="button"><svg width="16" height="16" aria-hidden="true"><rect width="16" height="16"/></svg></button>`,
    );
    const failed = await axe(page);
    expect(failed.wcag.map((v) => v.id)).toContain("button-name");
    expect(failed.counts.wcagNodes).toBe(1);
  });

  test("geometry: 320 px content at 320 does not overflow; 330 px content overflows by 10 px and puts a control outside", async ({
    page,
  }) => {
    await plant(
      page,
      `<div style="width:320px;height:40px"></div><button style="display:block;width:300px">Inside</button>`,
      320,
    );
    const ok = await page.evaluate(pageGeometry);
    expect(ok.horizontalOverflowPx).toBe(0);
    expect(ok.controlsOutsideViewport).toHaveLength(0);
    await plant(
      page,
      `<div style="width:330px;height:40px"></div><button style="display:block;width:70px;margin-left:260px;padding:0;border:0">Past the edge</button>`,
      320,
    );
    const bad = await page.evaluate(pageGeometry);
    expect(bad.horizontalOverflowPx).toBe(10);
    expect(bad.controlsOutsideViewport.map((o) => o.name)).toEqual(["Past the edge"]);
  });

  test("geometry: a horizontally scrolling table keeps its overflow inside (no page overflow; the cell is marked in a scroller)", async ({
    page,
  }) => {
    await plant(
      page,
      `<div style="overflow-x:auto;width:300px"><div style="width:600px"><button style="margin-left:400px">Far</button></div></div>`,
      320,
    );
    const g = await page.evaluate(pageGeometry);
    expect(g.horizontalOverflowPx).toBe(0);
    expect(g.controlsOutsideViewport[0]?.inScroller).toBeTruthy();
  });

  test("live-region log: a status message is logged once with its politeness; an unchanged rewrite is not", async ({
    page,
  }) => {
    await page.addInitScript(liveRegionRecorder);
    await page.goto(
      "data:text/html,<!doctype html><title>t</title><div role=status id=s></div><div aria-live=assertive id=a></div>",
    );
    await page.evaluate(() => {
      document.getElementById("s")!.textContent = "Saved";
      return new Promise((r) => setTimeout(r, 30));
    });
    await page.evaluate(() => {
      document.getElementById("s")!.textContent = "Saved";
      document.getElementById("a")!.textContent = "Save failed";
      const empty = document.createElement("div");
      empty.setAttribute("role", "status");
      document.body.append(empty); // mounts empty: not an announcement
      return new Promise((r) => setTimeout(r, 30));
    });
    const log = await page.evaluate(() => (window as unknown as { __liveLog: LiveEvent[] }).__liveLog);
    expect(log.map((e) => [e.text, e.politeness])).toEqual([
      ["Saved", "polite"],
      ["Save failed", "assertive"],
    ]);
  });
});

test.describe("a11y sweep matrix", () => {
  test.skip(process.env.ARCHER_SWEEP !== "1", "the matrix runs only with ARCHER_SWEEP=1");
  const sel = selectCells({
    surfaces: process.env.ARCHER_SWEEP_SURFACES,
    viewports: process.env.ARCHER_SWEEP_VIEWPORTS,
    themes: process.env.ARCHER_SWEEP_THEMES,
  });
  let project: TsProject | undefined;
  let target: Target | undefined;
  let login: unknown;

  async function ensureTarget(browser: Browser): Promise<Target> {
    if (target === undefined) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ARCHER_MEASURE_ORIGIN: process.env.ARCHER_SWEEP_ORIGIN ?? process.env.ARCHER_MEASURE_ORIGIN,
        ARCHER_MEASURE_LOGIN: process.env.ARCHER_SWEEP_LOGIN ?? process.env.ARCHER_MEASURE_LOGIN,
        ARCHER_MEASURE_SERVICE_ORIGIN:
          process.env.ARCHER_SWEEP_SERVICE_ORIGIN ?? process.env.ARCHER_MEASURE_SERVICE_ORIGIN,
        ARCHER_MEASURE_EMPHASIS_DIAGRAM:
          process.env.ARCHER_SWEEP_EMPHASIS_DIAGRAM ?? process.env.ARCHER_MEASURE_EMPHASIS_DIAGRAM,
      };
      if (env.ARCHER_MEASURE_ORIGIN || env.ARCHER_SANDBOX) target = resolveTarget({}, env);
      else {
        const corpus = resolve(import.meta.dirname, "../../../tools/devkit/corpus/pageturner");
        const files: Record<string, string> = {};
        const walk = (dir: string): void => {
          for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else files[relative(corpus, p)] = readFileSync(p, "utf8");
          }
        };
        walk(corpus);
        project = await startTsProject({ pagePath: testPage(), files, nestedView: true });
        const agent = new URL(project.agentUrl);
        target = {
          origin: agent.origin,
          login: project.agentUrl,
          slug: /^\/projects\/([^/]+)\//.exec(agent.pathname)?.[1] ?? "pageturner",
          projects: [],
          source: "startTsProject",
        };
      }
      login = await loginState(browser, target);
    }
    return target;
  }
  test.afterAll(async () => {
    await project?.stop();
  });

  for (const viewport of sel.viewports)
    for (const theme of sel.themes) {
      test(`${viewport} ${theme}: ${sel.states.length} states`, async ({ browser }) => {
        test.setTimeout(60_000 + sel.states.length * 45_000);
        const t = await ensureTarget(browser);
        mkdirSync(join(OUT, "cells"), { recursive: true });
        for (const state of sel.states) {
          const started = Date.now();
          const cell: Cell = {
            cell: `${state.id}@${viewport}/${theme}`,
            state: state.id,
            surface: state.surface,
            viewport,
            theme,
          };
          const context = await cellContext(browser, {
            viewport,
            theme,
            storageState: state.fresh ? undefined : login,
          });
          await context.addInitScript(liveRegionRecorder);
          try {
            const page = await context.newPage();
            const opened = await openState(page, state, t);
            cell.url = opened.url;
            if (opened.notAvailable) cell.notAvailable = opened.notAvailable;
            else if (opened.error) cell.error = opened.error;
            else Object.assign(cell, await measureCell(page));
            await leaveState(page, state);
          } catch (error) {
            cell.error = String((error as Error)?.message ?? error).split("\n")[0];
          } finally {
            await context.close();
          }
          cell.ms = Date.now() - started;
          writeAtomic(
            join(OUT, "cells", `${state.id}@${viewport}-${theme}.json`),
            redact(JSON.stringify(cell, null, 2)),
          );
        }
        summarise(OUT);
        process.stdout.write(`a11y sweep: ${join(OUT, "summary.md")}\n`);
        // A measurement, not an assertion: the strict run (ARCHER_SWEEP_STRICT=1) fails on any WCAG violation.
        if (process.env.ARCHER_SWEEP_STRICT === "1") {
          const cells = readdirSync(join(OUT, "cells"))
            .filter((f) => f.includes(`@${viewport}-${theme}`))
            .map((f) => JSON.parse(readFileSync(join(OUT, "cells", f), "utf8")) as Cell);
          expect(cells.flatMap((c) => (c.axe?.wcag ?? []).map((v) => `${c.cell} ${v.id}`))).toEqual([]);
        }
      });
    }
});
