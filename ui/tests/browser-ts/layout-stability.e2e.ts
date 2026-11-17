// The page holds its layout while it opens (G7, PF-6 of review evidence performance-2026-11-02-draft, private, not published): on a
// diagram, a flowchart, a note and the note by its folder path, the header's tools and identity arrive in space kept
// for them, the route's "Opening …" line moves nothing, and a note's figures hold their place, so the reader's text
// never jumps. CLS stays under 0.1 on each.
import { expect, test, type Page } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { sharedTsProject } from "./support/shared-service";

const prose = (n: number) =>
  Array.from({ length: n }, (_, i) => `Paragraph ${i + 1} about how a session is kept.`).join("\n\n");
const files = {
  "archer.toml":
    'version = 1\n\n[[views]]\nid = "system"\nkind = "freeform"\ntitle = "System"\nsource = ".archer/diagrams/system.mmd"\n\n' +
    '[[views]]\nid = "login"\nkind = "sequence"\ntitle = "Login"\nsource = ".archer/diagrams/login.mmd"\n',
  ".archer/diagrams/system.mmd": "flowchart LR\n  a[Client] e1@--> b[API]\n  b e2@--> c[(Store)]\n",
  ".archer/diagrams/login.mmd":
    "sequenceDiagram\n  participant U as User\n  participant A as API\n  U->>A: sign in\n  A-->>U: session\n",
  ".archer/notes/auth.md": [
    "# Auth design",
    "",
    "## Login flow",
    "",
    "```mermaid",
    "flowchart LR",
    '  user["User"] e1@--> api["API"]',
    '  api e2@--> store[("Session store")]',
    "```",
    "",
    prose(3),
    "",
    "## Tokens",
    "",
    "```mermaid",
    "sequenceDiagram",
    "  participant A as API",
    "  participant S as Store",
    "  A->>S: put session",
    "  S-->>A: ok",
    "```",
    "",
    prose(30),
    "",
  ].join("\n"),
};

let project: TsProject;
// An agent presents another diagram, as the performance fixture does: the page must still open the address.
test.beforeEach(async () => {
  project = await sharedTsProject({ files });
  await project.present("login");
});
test.afterEach(async ({ page }) => {
  await page.close();
  await project.stop();
});

type Shift = { value: number; input: boolean; sources: { node: string; dy: number; dx: number }[] };

/** Every layout shift of the next document, with what moved and by how much. */
async function recordShifts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const shifts: unknown[] = ((window as unknown as { __shifts: unknown[] }).__shifts = []);
    const name = (n: Node | null): string => {
      if (n === null || n.nodeType !== 1) return n?.nodeName ?? "?";
      const e = n as Element;
      return (
        e.tagName.toLowerCase() +
        [...e.classList]
          .slice(0, 2)
          .map((c) => `.${c}`)
          .join("")
      );
    };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as {
        value: number;
        hadRecentInput: boolean;
        sources: { node: Node | null; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[];
      }[]) {
        shifts.push({
          value: e.value,
          input: e.hadRecentInput,
          sources: e.sources.map((s) => ({
            node: name(s.node),
            dy: Math.round(s.currentRect.y - s.previousRect.y),
            dx: Math.round(s.currentRect.x - s.previousRect.x),
          })),
        });
      }
    }).observe({ type: "layout-shift", buffered: true });
    // Whether the project overview was on screen at any frame (a diagram's address must not flash it first).
    const seen = ((window as unknown as { __overview: { shown: boolean } }).__overview = { shown: false as boolean });
    const look = () => {
      if (document.querySelector(".archer-contents-panel")) seen.shown = true;
      else if (performance.now() < 5000) requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
}

async function open(
  page: Page,
  path: string,
  shown: (page: Page) => Promise<void>,
): Promise<{ shifts: Shift[]; overview: boolean }> {
  const access = await project.issueAccess("layout stability");
  await page.goto(access.url);
  const slug = new URL(project.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
  await recordShifts(page);
  await page.goto(`${new URL(project.url).origin}/projects/${slug}/${path}`);
  await shown(page);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(800);
  return page.evaluate(() => ({
    shifts: (window as unknown as { __shifts: Shift[] }).__shifts,
    overview: (window as unknown as { __overview: { shown: boolean } }).__overview.shown,
  }));
}

const FRAME =
  /^(body|main\.archer-main|article\.primary-note-reader|div\.primary-document-|header\.primary-document-bar)/;
const surfaces: ReadonlyArray<{
  readonly name: string;
  readonly path: string;
  readonly shown: (page: Page) => Promise<void>;
  readonly note?: true;
}> = [
  {
    name: "a sequence diagram",
    path: "diagrams/login.mmd",
    shown: (page) => expect(page.locator(".archer-seq-canvas").first()).toBeVisible(),
  },
  {
    name: "a flowchart",
    path: "diagrams/system.mmd",
    shown: (page) => expect(page.locator(".react-flow__node").first()).toBeVisible(),
  },
  {
    name: "a note",
    path: "notes/auth.md",
    note: true,
    shown: (page) => expect(page.locator('figure[data-state="drawn"]')).toHaveCount(2),
  },
  {
    name: "a note by its folder path",
    path: ".archer/notes/auth.md",
    note: true,
    shown: (page) => expect(page.locator('figure[data-state="drawn"]')).toHaveCount(2),
  },
];

for (const surface of surfaces) {
  test(`${surface.name}: the header, the frame and the text hold their place while it opens`, async ({ page }) => {
    const opened = await open(page, surface.path, surface.shown);
    if (!surface.note) expect(opened.overview, "the project overview flashed before the diagram").toBe(false);
    const shifts = opened.shifts.filter((s) => !s.input);
    const frame = shifts.flatMap((s) => s.sources.filter((x) => FRAME.test(x.node) && (x.dy !== 0 || x.dx !== 0)));
    expect(frame, "the page's frame and header moved").toEqual([]);
    if (!surface.note) {
      // The stage keeps its place while the header's line and the "agent is presenting" notice come above it (PF-6).
      const stage = shifts.flatMap((s) =>
        s.sources.filter((x) => /^div\.archer-(review-row|stage|diagram-content)/.test(x.node) && x.dy !== 0),
      );
      expect(stage, "the drawing's stage moved while the diagram opened").toEqual([]);
    }
    if (surface.note) {
      // The note's own words (a figure's caption moves with its drawing, which is as tall as it is laid out).
      const text = shifts.flatMap((s) => s.sources.filter((x) => /^(h2|p)\b/.test(x.node) && x.dy > 40));
      expect(text, "the note's text jumped as its figures came in").toEqual([]);
    }
    const cls = shifts.reduce((a, s) => a + s.value, 0);
    expect(cls, JSON.stringify(shifts)).toBeLessThan(0.1);
  });
}

test("the project page: its header and its file rows hold their place while it opens", async ({ page }) => {
  // The catalog lists the note as its source file too (.archer/notes/auth.md); shown before the notes listing, the
  // rows under it moved when the note row replaced it, and the header lost a line under the painted page (PF-6).
  const opened = await open(page, "", (page) => expect(page.locator(".archer-folder-tree-row").first()).toBeVisible());
  const shifts = opened.shifts.filter((s) => !s.input);
  const moved = shifts.flatMap((s) =>
    s.sources.filter(
      (x) =>
        (FRAME.test(x.node) || /^div\.archer-(folder-tree-row|contents-panel)/.test(x.node)) &&
        (x.dy !== 0 || x.dx !== 0),
    ),
  );
  expect(moved, JSON.stringify(shifts)).toEqual([]);
  expect(shifts.reduce((a, s) => a + s.value, 0)).toBeLessThan(0.01);
});
