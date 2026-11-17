// The UI/UX rubric's matrix (docs/quality/rubrics/ui-ux.md §1) as data, plus what every round-1 measurement
// tool shares: where the page is (a devkit sandbox or an already running page), how a browser context is made
// for one cell (viewport, pointer, theme, motion), how a cell's state is reached, and how results are written.
//
// Used by the a11y sweep (ui/tests/browser-ts/a11y-sweep.e2e.ts), focus-walk.mjs, targets.mjs and motion.mjs.
//
// Target, first match wins:
//   --origin <url> --login <link>        an already running page (a Vite dev server, an installed service)
//   ARCHER_MEASURE_ORIGIN / ARCHER_MEASURE_LOGIN   the same, from the environment
//   --sandbox <name> / ARCHER_SANDBOX    a devkit sandbox (`node tools/devkit/sandbox.mjs up --name <name>`)
//   --zero-sandbox <name>               companion started with --zero-projects, for P1.zero
//   --embedded-sandbox <name>           companion started with --embedded, for P10.embedded
//   ARCHER_MEASURE_ZERO_SANDBOX / ARCHER_MEASURE_EMBEDDED_SANDBOX are the environment equivalents.
//
// Cell selection (comma lists; a trailing `*` matches a prefix; `all` is everything):
//   --surfaces / ARCHER_MEASURE_SURFACES   state ids (`P1.overview`, `P4.*`) or surfaces (`P4`)
//   --viewports / ARCHER_MEASURE_VIEWPORTS  1500x900, 1000x800, 390x844, 320x640
//   --themes / ARCHER_MEASURE_THEMES        light, dark
//
// The Impeccable live helper a dev server may inject (`ui/index.html`, ids `impeccable-live-*`) is not the product:
// its script request is aborted in every context, so it never reaches a measurement and no axe exclude is needed.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readRecord } from "../sandbox.mjs";
import { V5_STATES } from "../fixtures/v5-states.mjs";

/** True when the module at `metaUrl` is the process's entry point (so a tool is a CLI and a library at once). */
export const isMain = (metaUrl) => !!process.argv[1] && metaUrl === pathToFileURL(resolve(process.argv[1])).href;

/** The §1 viewports. 390×844 is the coarse-pointer (touch) cell; 320×640 is the reflow cell. */
export const VIEWPORTS = {
  "1500x900": { width: 1500, height: 900, coarse: false },
  "1000x800": { width: 1000, height: 800, coarse: false },
  "390x844": { width: 390, height: 844, coarse: true },
  "320x640": { width: 320, height: 640, coarse: true },
};
export const THEMES = ["light", "dark"];

/** The seven-family corpus in tools/devkit/corpus/pageturner is separate from ts/test/fixtures/pageturner. */
export const FIXTURES = [
  { family: "flowchart", file: "diagrams/system-context.mmd" },
  { family: "sequence", file: "diagrams/checkout.mmd" },
  { family: "state", file: "diagrams/order-lifecycle.mmd" },
  { family: "er", file: "diagrams/data-model.mmd" },
  { family: "c4", file: "diagrams/containers.mmd" },
  { family: "architecture", file: "diagrams/deployment.mmd" },
  { family: "journey", file: "diagrams/buying-a-book.mmd" },
];

const DIAGRAM_READY = ".react-flow__node, .archer-seq-participant, .archer-journey-tools, .archer-journey";

/**
 * Every state cell of the matrix that can be reached on the corpus. `open(page, ctx)` navigates and sets the state;
 * it returns `{ notAvailable: reason }` when the state is not present on this corpus (a walkthrough the corpus lacks),
 * which the tools record as such, never as a pass. `fresh: true` cells run without the access cookie (front door).
 * `writes: false` everywhere: no cell saves anything; an editor cell is left by navigation with no change made.
 */
export const STATES = [
  ...V5_STATES,
  { id: "P1.overview", surface: "P1", label: "Global overview, with projects", open: (p, c) => go(p, c, "/projects/") },
  {
    id: "P1.filters",
    surface: "P1",
    label: "Global overview, Project Filters dialog",
    open: async (p, c) => {
      await go(p, c, "/projects/");
      await click(p.getByRole("button", { name: /^Filters/ }).first());
      await p
        .getByRole("dialog")
        .first()
        .waitFor({ timeout: 5000 })
        .catch(() => {});
    },
  },
  {
    id: "P1.zero",
    surface: "P1",
    label: "Global overview, zero projects",
    open: async (p, c) => {
      if (c.projects.length !== 0) return { notAvailable: "needs --zero-sandbox <name> started with --zero-projects" };
      await go(p, c, "/projects/");
      await p
        .getByText(/No diagrams or notes yet\./i)
        .first()
        .waitFor({ timeout: 10000 });
    },
  },
  { id: "P2.project", surface: "P2", label: "Project page", open: (p, c) => go(p, c, `/projects/${c.slug}/`) },
  {
    id: "P2.folder",
    surface: "P2",
    label: "Project folder",
    open: (p, c) => go(p, c, `/projects/${c.slug}/diagrams/`),
  },
  {
    id: "P2.search-empty",
    surface: "P2",
    label: "Search with no results",
    open: async (p, c) => {
      await go(p, c, `/projects/${c.slug}/`);
      const box = p.getByRole("searchbox").or(p.locator("input[type=search]")).first();
      await box.fill("zzqx-no-such-thing");
      await box.press("Enter");
      await p.waitForTimeout(600);
    },
  },
  {
    id: "P3.note",
    surface: "P3",
    label: "Note reader",
    open: (p, c) => go(p, c, `/projects/${c.slug}/notes/scenario-declined-card.md`),
  },
  {
    id: "P3.embedded",
    surface: "P3",
    label: "Note with embedded diagrams (awkward corpus)",
    open: async (p, c) => {
      if (!c.projects?.includes("awkward")) return { notAvailable: "the awkward corpus is not attached" };
      await go(p, c, "/projects/awkward/notes/embedded-families.md");
      await p
        .locator(DIAGRAM_READY)
        .first()
        .waitFor({ timeout: 10_000 })
        .catch(() => {});
    },
  },
  {
    id: "P3.selection",
    surface: "P3",
    label: "Note reader, selection → Comment on selection",
    open: async (p, c) => {
      await go(p, c, `/projects/${c.slug}/notes/scenario-declined-card.md`);
      const para = p
        .locator("main p")
        .filter({ hasText: /\S{3,}( \S+){8,}/ })
        .first();
      const box = await para.boundingBox().catch(() => null);
      if (!box) return { notAvailable: "no paragraph to select" };
      await p.mouse.move(box.x + 2, box.y + box.height / 2);
      await p.mouse.down();
      await p.mouse.move(box.x + Math.min(box.width - 2, 220), box.y + box.height / 2, { steps: 6 });
      await p.mouse.up();
      await p.waitForTimeout(400);
    },
  },
  ...FIXTURES.map((f) => ({
    id: `P4.explore.${f.family}`,
    surface: "P4",
    label: `Diagram page, Explore (${f.family}: ${f.file})`,
    family: f.family,
    open: (p, c) => diagram(p, c, f.file),
  })),
  {
    id: "P4.highlights",
    surface: "P4",
    label: "Diagram page, Highlights with key",
    open: async (p, c) => {
      // A diagram that carries an agent emphasis: --emphasis-diagram <slug>/<path>; the Pageturner corpus ships one on
      // containers.mmd (tools/devkit/corpus/pageturner/.devkit/emphasis.json).
      await go(p, c, `/projects/${c.emphasisDiagram ?? `${c.slug}/${FIXTURE_DIAGRAM}`}`);
      await p
        .locator(DIAGRAM_READY)
        .first()
        .waitFor({ timeout: 15_000 })
        .catch(() => {});
      if ((await p.getByRole("button", { name: /^Highlights/ }).count()) === 0)
        return { notAvailable: "no emphasis on this diagram (Highlights is shown only with one)" };
      // On desktop the panel already shows Highlights (aria-pressed=true): clicking it again would turn highlights off.
      // Click only while the Highlights view (its Members control) is not shown: the phone sheet opener, then the tab.
      await showHighlights(p);
      if (!(await membersShown(p))) return { notAvailable: "the Highlights view (Members) could not be shown" };
    },
  },
  {
    id: "P4.walkthrough",
    surface: "P4",
    label: "Diagram page, Walkthrough step 1",
    open: async (p, c) => {
      // The Pageturner corpus's checkout-tour on containers.mmd (containers.walkthroughs.json).
      await diagram(p, c, c.walkthroughFile ?? FIXTURE_DIAGRAM);
      let w = p.getByRole("button", { name: /^Walkthroughs?\b/ }).first();
      const sheet = p.getByRole("button", { name: "Highlights", exact: true }).first();
      if ((await w.count()) === 0 && (await sheet.count()) === 0)
        return { notAvailable: "the corpus has no walkthrough on this diagram" };
      if (!(await w.isVisible().catch(() => false)) && (await sheet.count())) {
        await click(sheet);
        await p.waitForTimeout(500);
      } // phone: the panel is a sheet
      w = p.getByRole("button", { name: /^Walkthroughs?\b/ }).first();
      if ((await w.count()) === 0) return { notAvailable: "the corpus has no walkthrough on this diagram" };
      await click(w);
      const choice = p
        .getByRole("group", { name: "Walkthroughs on this diagram", exact: true })
        .getByRole("button")
        .first();
      await choice.waitFor({ timeout: 5000 }).catch(() => {});
      if ((await choice.count()) === 0) return { notAvailable: "Walkthroughs opened no walkthrough choice" };
      await click(choice);
      await p
        .locator(".archer-walk")
        .first()
        .waitFor({ timeout: 5000 })
        .catch(() => {});
      await p.waitForTimeout(600);
    },
  },
  {
    id: "P4.edit",
    surface: "P4",
    label: "Diagram page, Edit",
    leave: discardEdit,
    open: async (p, c) => {
      await go(p, c, `/projects/${c.slug}/diagrams/fulfilment.mmd?edit`);
      await p.locator(".authoring-workspace").first().waitFor({ timeout: 15_000 });
      await p
        .locator(DIAGRAM_READY)
        .first()
        .waitFor({ timeout: 15_000 })
        .catch(() => {});
    },
  },
  {
    id: "P4.nested",
    surface: "P4",
    label: "Diagram page, nested view",
    open: async (p, c) => {
      await diagram(p, c, c.nestedFile ?? "diagrams/containers.mmd");
      const n = p.getByRole("button", { name: "Nested view", exact: true }).first();
      if ((await n.count()) === 0) return { notAvailable: "no Nested view control on this diagram" };
      await click(n);
      await p.waitForTimeout(800);
    },
  },
  {
    id: "P4.compile-error",
    surface: "P4",
    label: "Diagram that does not compile (awkward notes/auth.md#broken)",
    open: async (p, c) => {
      if (!c.projects?.includes("awkward")) return { notAvailable: "the awkward corpus is not attached" };
      await go(p, c, "/projects/awkward/notes/auth.md#broken");
    },
  },
  {
    id: "P4.stale",
    surface: "P4",
    label: "Diagram page, stale (Diagram accuracy checked)",
    open: async (p, c) => {
      // containers.mmd covers shop/**, changed after the diagram's commit (tools/devkit/corpus/pageturner/.devkit/after-snapshot).
      await diagram(p, c, c.staleFile ?? FIXTURE_DIAGRAM);
      if (!(await openCanvasTools(p))) return { notAvailable: "no canvas tools launcher" };
      const acc = p.getByRole("button", { name: "Check diagram accuracy", exact: true }).first();
      await acc.waitFor({ timeout: 5000 }).catch(() => {});
      if ((await acc.count()) === 0) return { notAvailable: "no Check diagram accuracy action" };
      await click(acc);
      const check = p.getByRole("button", { name: "Check covered files", exact: true }).first();
      await check.waitFor({ timeout: 5000 });
      await click(check);
      const status = p
        .getByRole("status")
        .filter({ hasText: /^Covered files|^No code paths|^This diagram has no|^Git accuracy/ })
        .first();
      await status.waitFor({ timeout: 15_000 }).catch(() => {});
      if (!/changed since/.test((await status.textContent().catch(() => "")) ?? ""))
        return { notAvailable: "this diagram is not stale on this corpus" };
      await p.waitForTimeout(300);
    },
  },
  {
    id: "P5.new",
    surface: "P5",
    label: "New diagram, flowchart starter",
    leave: discardEdit,
    open: (p, c) => newDiagram(p, c),
  },
  {
    id: "P5.discard",
    surface: "P5",
    label: "New diagram, Cancel → Discard dialog",
    leave: discardEdit,
    open: async (p, c) => {
      const none = await newDiagram(p, c);
      if (none) return none;
      const part = p.locator(".authoring-parts").getByRole("button", { name: "Process", exact: true });
      if (await part.count()) {
        await click(part);
        await p.keyboard.type("Probe");
        await p.keyboard.press("Enter");
        await p.waitForTimeout(400);
      }
      await click(p.getByRole("button", { name: "Cancel", exact: true }).first());
      await p
        .getByRole("alertdialog")
        .first()
        .waitFor({ timeout: 5000 })
        .catch(() => {});
    },
  },
  {
    id: "P6.document",
    surface: "P6",
    label: "Read-only source document",
    open: (p, c) => go(p, c, `/projects/${c.slug}/-/repo/archer.toml`),
  },
  {
    id: "P7.review",
    surface: "P7",
    label: "Project review sidebar (diagram page), as the corpus has it",
    open: async (p, c) => {
      await diagram(p, c, "diagrams/fulfilment.mmd");
      if ((await p.getByRole("button", { name: "Close project review" }).count()) === 0) await click(bell(p));
      await p
        .getByRole("button", { name: "Close project review" })
        .first()
        .waitFor({ timeout: 5000 })
        .catch(() => {});
    },
  },
  {
    id: "P7.notifications",
    surface: "P7",
    label: "Notifications",
    open: async (p, c) => {
      await go(p, c, `/projects/${c.slug}/`);
      await click(bell(p));
      await p.waitForTimeout(400);
    },
  },
  {
    id: "P8.settings",
    surface: "P8",
    label: "Archer settings",
    open: async (p, c) => {
      await go(p, c, "/projects/");
      await viaMenu(p, "Archer settings");
      await click(p.getByRole("button", { name: "Archer settings", exact: true }).first());
      await p
        .getByRole("dialog")
        .first()
        .waitFor({ timeout: 5000 })
        .catch(() => {});
    },
  },
  {
    id: "P8.project-settings",
    surface: "P8",
    label: "Project settings (gear)",
    open: async (p, c) => {
      await go(p, c, `/projects/${c.slug}/`);
      await click(p.getByRole("button", { name: "Project settings", exact: true }).first());
      await p.waitForTimeout(500);
    },
  },
  // The front door is the service's own page: a Vite dev server serves the app shell without a cookie instead, so
  // these cells go to `serviceOrigin` (--service-origin / ARCHER_MEASURE_SERVICE_ORIGIN) when the target is a dev server.
  {
    id: "P9.front-door",
    surface: "P9",
    label: "Front door, clean cookie (pairing code page)",
    fresh: true,
    open: (p, c) => door(p, c, "/"),
  },
  {
    id: "P9.no-link",
    surface: "P9",
    label: "Front door, a page address without a cookie",
    fresh: true,
    open: (p, c) => door(p, c, "/projects/"),
  },
  {
    id: "P9.wrong-code",
    surface: "P9",
    label: "Front door, wrong pairing code",
    fresh: true,
    open: async (p, c) => {
      const r = await door(p, c, "/");
      if (r) return r;
      const field = p.getByLabel(/pairing code/i).first();
      if ((await field.count()) === 0) return { notAvailable: "no pairing-code field on the front door" };
      await field.fill("ZZZZ-ZZZZ");
      await field.press("Enter");
      await p.waitForTimeout(1500);
    },
  },
  {
    id: "P9.expired",
    surface: "P9",
    label: "Front door, expired or unknown link",
    fresh: true,
    open: (p, c) => door(p, c, "/projects/?token=00000000000000000000000000000000"),
  },
  { id: "P10.embedded", surface: "P10", label: "Embedded MCP shell", open: openEmbedded },
  {
    id: "P11.compare",
    surface: "P11",
    label: "Revision compare",
    open: async (p, c) => {
      await diagram(p, c, "diagrams/fulfilment.mmd");
      if (!(await openCanvasTools(p))) return { notAvailable: "no canvas tools launcher" };
      const cmp = p
        .getByRole("button", { name: "Compare revisions" })
        .or(p.getByRole("menuitem", { name: /Compare/ }))
        .first();
      if ((await cmp.count()) === 0) return { notAvailable: "no Compare revisions control" };
      await click(cmp);
      await p
        .locator("#archer-comparison-panel, .accuracy-header")
        .first()
        .waitFor({ timeout: 5000 })
        .catch(() => {});
    },
  },
];

/** The diagram that carries the Pageturner corpus's walkthrough, emphasis and stale fixtures. */
const FIXTURE_DIAGRAM = "diagrams/containers.mmd";

/** The launcher's names: "Export, compare and more" since round 1 (R3-08); 0.7.2 called it "Graph tools". */
export const CANVAS_TOOLS_NAMES = ["Export, compare and more", "Graph tools"];
async function openCanvasTools(page) {
  for (const name of CANVAS_TOOLS_NAMES) {
    const b = page.getByRole("button", { name, exact: true }).first();
    if (await b.count()) {
      await click(b);
      return true;
    }
  }
  return false;
}

/** The bell. With an unread item its name carries a count ("Notifications, 1 unread agent answer"). */
export const NOTIFICATIONS_NAME = /^Notifications\b/;
const bell = (page) => page.getByRole("button", { name: NOTIFICATIONS_NAME }).first();

const membersShown = (page) =>
  page
    .getByRole("button", { name: "Members", exact: true })
    .first()
    .isVisible()
    .catch(() => false);
async function showHighlights(page) {
  if (await membersShown(page)) return;
  const opener = page.getByRole("button", { name: "Highlights", exact: true }).first(); // phone sheet
  if (await opener.count()) {
    await click(opener);
    await page.waitForTimeout(500);
  }
  if (await membersShown(page)) return;
  const tab = page.getByRole("button", { name: /^Highlights ·/ }).first();
  if (await tab.count()) {
    await click(tab);
    await page.waitForTimeout(500);
  }
}

/** Leave an editor cell the way a person abandons it (Cancel, then Discard), so no draft is left on the service. */
async function discardEdit(page) {
  const dialog = page.getByRole("alertdialog").first();
  if (!(await dialog.isVisible().catch(() => false)))
    await page
      .getByRole("button", { name: "Cancel", exact: true })
      .first()
      .click({ timeout: 3000 })
      .catch(() => {});
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Discard", exact: true })
    .first()
    .click({ timeout: 2000 })
    .catch(() => {});
  await page.waitForTimeout(300);
}

/** Run a state's `leave` (editor cells discard their draft). Never throws. */
export async function leaveState(page, state) {
  if (state.leave) await state.leave(page).catch(() => {});
}

async function click(locator) {
  await locator.click({ timeout: 5000 });
}

async function go(page, ctx, path) {
  await page.goto(ctx.origin + path, { waitUntil: "domcontentloaded" });
  await settle(page);
}
async function door(page, ctx, path) {
  if (ctx.source === "existing" && !ctx.serviceOrigin)
    return { notAvailable: "a dev server serves the app shell, not the service's front door: pass --service-origin" };
  await page.goto((ctx.serviceOrigin ?? ctx.origin) + path, { waitUntil: "domcontentloaded" });
  await settle(page);
}
async function diagram(page, ctx, file) {
  await go(page, ctx, `/projects/${ctx.slug}/${file}`);
  await page
    .locator(DIAGRAM_READY)
    .first()
    .waitFor({ timeout: 15_000 })
    .catch(() => {});
  await settle(page);
}
/** At phone widths the rail is a drawer behind "Menu": open it when the control is not exposed. */
async function viaMenu(page, name) {
  if (await page.getByRole("button", { name, exact: true }).count()) return;
  const menu = page.getByRole("button", { name: "Menu", exact: true }).first();
  if (await menu.count()) {
    await click(menu);
    await page.waitForTimeout(400);
  }
}
async function newDiagram(page, ctx) {
  await go(page, ctx, `/projects/${ctx.slug}/`);
  if ((await page.getByRole("button", { name: "New", exact: true }).count()) === 0)
    return { notAvailable: "New is not offered at this width (no New control in the accessibility tree)" };
  await click(page.getByRole("button", { name: "New", exact: true }).first());
  await click(page.getByRole("menu", { name: "New" }).getByRole("menuitem", { name: "Diagram", exact: true }));
  await page.locator(".authoring-workspace").first().waitFor({ timeout: 15_000 });
  await settle(page);
  return undefined;
}

/** Settled: fonts loaded, nothing aria-busy, two quiet animation frames, then a short dwell. */
export async function settle(page, dwellMs = 350) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page
    .evaluate(async () => {
      await document.fonts?.ready;
      const until = performance.now() + 4000;
      while (performance.now() < until && document.querySelector("[aria-busy='true']"))
        await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    })
    .catch(() => {});
  await page.waitForTimeout(dwellMs);
}

/** A comma list from an argument or the environment; `all`, empty or undefined selects everything. */
export function selectList(all, wanted, key = (x) => x) {
  if (!wanted || wanted === "all") return all;
  const pats = String(wanted)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return all.filter((item) =>
    pats.some((p) => {
      const k = key(item);
      if (p.endsWith("*")) return k.startsWith(p.slice(0, -1));
      return k === p || (typeof item === "object" && item.surface === p);
    }),
  );
}

/** Cells: states × viewports × themes, each selectable. */
export function selectCells({ surfaces, viewports, themes } = {}) {
  const states = selectList(STATES, surfaces, (s) => s.id);
  const vps = selectList(Object.keys(VIEWPORTS), viewports);
  const ths = selectList(THEMES, themes);
  return { states, viewports: vps, themes: ths };
}

/**
 * Where the page is. `values` holds parsed CLI options (origin, login, sandbox, slug); the environment fills gaps.
 * Returns { origin, login, slug, projects, source }.
 */
export function resolveTarget(values = {}, env = process.env) {
  const origin = values.origin ?? env.ARCHER_MEASURE_ORIGIN;
  const login = values.login ?? env.ARCHER_MEASURE_LOGIN;
  const slug = values.slug ?? env.ARCHER_MEASURE_PROJECT ?? "pageturner";
  if (origin || login) {
    if (!origin || !login)
      throw new Error(
        "an existing page needs both --origin and --login (or ARCHER_MEASURE_ORIGIN and ARCHER_MEASURE_LOGIN)",
      );
    const serviceOrigin = values["service-origin"] ?? env.ARCHER_MEASURE_SERVICE_ORIGIN;
    const emphasisDiagram = values["emphasis-diagram"] ?? env.ARCHER_MEASURE_EMPHASIS_DIAGRAM;
    return withAuxiliaryTargets(values, env, {
      origin: origin.replace(/\/$/, ""),
      login,
      slug,
      ...(serviceOrigin ? { serviceOrigin: serviceOrigin.replace(/\/$/, "") } : {}),
      ...(emphasisDiagram ? { emphasisDiagram } : {}),
      projects: (values.projects ?? env.ARCHER_MEASURE_PROJECTS ?? "pageturner,awkward,journeys").split(","),
      source: "existing",
    });
  }
  const name = values.sandbox ?? env.ARCHER_SANDBOX;
  if (!name) throw new Error("no target: pass --origin and --login, or --sandbox <name>");
  const record = readRecord(name);
  if (!record?.link)
    throw new Error(
      `no running sandbox named ${name}; start one with: node tools/devkit/sandbox.mjs up --name ${name}`,
    );
  return withAuxiliaryTargets(values, env, sandboxTarget(record, values.slug ?? env.ARCHER_MEASURE_PROJECT));
}

/** Optional companion sandboxes let a single matrix run collect the empty and MCP surfaces. */
function withAuxiliaryTargets(values, env, target) {
  for (const kind of ["zero", "embedded"]) {
    const name = values[`${kind}-sandbox`] ?? env[`ARCHER_MEASURE_${kind.toUpperCase()}_SANDBOX`];
    if (!name) continue;
    const record = readRecord(name);
    if (!record?.link) throw new Error(`no running sandbox named ${name}`);
    target[kind] = sandboxTarget(record, values.slug ?? env.ARCHER_MEASURE_PROJECT);
  }
  return target;
}

/** Run the real MCP build with a minimal host handshake, using a real compiled corpus envelope.
 * The shell stays in the top document so the shared measurement tools inspect the embedded controls.
 */
async function openEmbedded(page, target) {
  if (!target.embeddedPage) return { notAvailable: "needs --embedded-sandbox <name> started with --embedded" };
  const response = await page.request.get(`${target.origin}/p/${target.slug}/api/diagrams/system-context`);
  if (!response.ok()) throw new Error(`embedded fixture answered ${response.status()}`);
  const envelope = await response.json();
  await page.addInitScript(
    ({ origin, envelope }) => {
      if (location.origin !== origin) return;
      // Capture outgoing messages before the App transport sees its own requests in this top-level host.
      window.addEventListener(
        "message",
        (event) => {
          const message = event.data;
          if (
            event.source !== window ||
            message?.jsonrpc !== "2.0" ||
            typeof message.method !== "string" ||
            message.method === "ui/notifications/tool-result"
          )
            return;
          event.stopImmediatePropagation();
          if (message.method === "ui/notifications/initialized") {
            window.postMessage(
              {
                jsonrpc: "2.0",
                method: "ui/notifications/tool-result",
                params: {
                  content: [],
                  structuredContent: {
                    envelope,
                    presentation: { presentationId: "devkit:embedded", viewId: envelope.view.id },
                    diagnostics: [],
                  },
                },
              },
              "*",
            );
          } else if (message.id !== undefined) {
            const result =
              message.method === "ui/initialize"
                ? {
                    protocolVersion: message.params.protocolVersion,
                    hostInfo: { name: "archer-devkit", version: "1" },
                    hostCapabilities: { serverTools: {}, updateModelContext: { text: {}, structuredContent: {} } },
                    hostContext: {},
                  }
                : message.method === "tools/call"
                  ? { content: [] }
                  : {};
            window.postMessage({ jsonrpc: "2.0", id: message.id, result }, "*");
          }
        },
        true,
      );
    },
    { origin: target.origin, envelope },
  );
  await page.goto(`${target.origin}/projects/`);
  await page.locator(".archer-mcp-shell").waitFor({ state: "visible", timeout: 15000 });
  await page.locator(DIAGRAM_READY).first().waitFor({ state: "visible", timeout: 15000 });
}

/** The access cookie for `target`, once per browser: later contexts start from it instead of following the link again. */
export async function loginState(browser, target) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await blockDevHelpers(ctx);
    const page = await ctx.newPage();
    const res = await page.goto(target.login, { waitUntil: "domcontentloaded" });
    if (!res || res.status() >= 400) throw new Error(`the login link answered ${res?.status()}`);
    return { cookies: await ctx.cookies(), origins: [] };
  } finally {
    await ctx.close();
  }
}

/** Abort the Impeccable live helper a dev server injects: it is a dev tool, not the product. */
export async function blockDevHelpers(context) {
  await context.route(
    (url) =>
      url.pathname.startsWith("/__impeccable/") ||
      /^localhost:84\d\d$/.test(url.host) ||
      /\/live\.js$/.test(url.pathname),
    (route) => route.abort(),
  );
}

/**
 * A context for one cell. Coarse viewports get `isMobile` + `hasTouch`, so `(pointer: coarse)` matches; theme is the
 * OS preference (no stored choice); motion is `reducedMotion` plus an optional stored flow-animation choice.
 */
export async function cellContext(
  browser,
  {
    viewport = "1500x900",
    theme = "light",
    reducedMotion = "no-preference",
    flowAnimation,
    storageState,
    extra = {},
  } = {},
) {
  const vp =
    VIEWPORTS[viewport] ??
    (() => {
      const [w, h] = String(viewport).split("x").map(Number);
      return { width: w, height: h, coarse: false };
    })();
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
    isMobile: vp.coarse,
    hasTouch: vp.coarse,
    colorScheme: theme,
    reducedMotion,
    ...(storageState ? { storageState } : {}),
    ...extra,
  });
  await blockDevHelpers(context);
  if (flowAnimation)
    await context.addInitScript((v) => {
      try {
        localStorage.setItem("archer.flow-animation", v);
      } catch {
        /* blocked storage */
      }
    }, flowAnimation);
  return context;
}

/** Open one state on `page`. Resolves to { ok, notAvailable?, error?, url }. Never throws. */
export async function openState(page, state, target) {
  try {
    const auxiliary = state.id === "P1.zero" ? target.zero : state.id === "P10.embedded" ? target.embedded : null;
    if (auxiliary) {
      const response = await page.request.get(auxiliary.login, { maxRedirects: 0 });
      if (response.status() >= 400) throw new Error(`auxiliary login answered ${response.status()}`);
    }
    const r = await state.open(page, auxiliary ?? target);
    if (r?.notAvailable) return { ok: false, notAvailable: r.notAvailable, url: redact(page.url()) };
    await settle(page);
    return { ok: true, url: redact(page.url()), ...(r?.evidence ? { evidence: r.evidence } : {}) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).split("\n")[0], url: redact(page.url()) };
  }
}

/** Access tokens never reach a report (rubric §9, Secrets). */
export function redact(text) {
  return String(text)
    .replace(/([?&]token=)[0-9a-f]{16,}/gi, "$1<redacted>")
    .replace(/\/[0-9a-f]{32,64}\//g, "/<token>/");
}

/** Write `<dir>/<name>.json` and `<dir>/<name>.md`; returns their paths. */
export function writeReport(dir, name, json, markdown) {
  mkdirSync(dir, { recursive: true });
  const jsonPath = join(dir, `${name}.json`),
    mdPath = join(dir, `${name}.md`);
  writeFileSync(jsonPath, redact(JSON.stringify(json, null, 2)) + "\n");
  writeFileSync(mdPath, redact(markdown));
  return { json: jsonPath, md: mdPath };
}

/** The default output directory for a tool run: tools/devkit/runs/<stamp>-<tool>/ (gitignored). */
export function defaultOut(tool) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
  return resolve(import.meta.dirname, "../runs", `${stamp}-${tool}`);
}

/** Shared CLI options for the tools. */
export const TARGET_OPTIONS = {
  origin: { type: "string" },
  login: { type: "string" },
  "service-origin": { type: "string" },
  "emphasis-diagram": { type: "string" },
  sandbox: { type: "string" },
  "zero-sandbox": { type: "string" },
  "embedded-sandbox": { type: "string" },
  slug: { type: "string" },
  projects: { type: "string" },
  surfaces: { type: "string" },
  viewports: { type: "string" },
  themes: { type: "string" },
  out: { type: "string" },
  headed: { type: "boolean" },
  json: { type: "boolean" },
};

/** Markdown table from rows of plain values. */
export function mdTable(header, rows) {
  const esc = (v) =>
    String(v ?? "")
      .replace(/\|/g, "\\|")
      .replace(/\n/g, " ");
  return (
    [
      `| ${header.map(esc).join(" | ")} |`,
      `|${header.map(() => "---").join("|")}|`,
      ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`),
    ].join("\n") + "\n"
  );
}

/** The target for a harness journey's sandbox record (withPage passes it as `sandbox`). */
export function sandboxTarget(sandbox, slug) {
  const projects = (sandbox.projects ?? []).map((p) => (typeof p === "string" ? p : p.slug));
  slug ??= projects.includes("pageturner") ? "pageturner" : (projects[0] ?? "pageturner");
  return {
    origin: sandbox.origin ?? new URL(sandbox.link).origin,
    login: sandbox.link,
    slug,
    projects,
    embeddedPage: Boolean(sandbox.embedded),
    source: `sandbox:${sandbox.name}`,
  };
}

/**
 * The body of a tool's harness journey: open each state on the journey's own (logged-in) page, one `step` each, run
 * `measure(page, state)`, and write `<run dir>/<tool>.json|md` with `render`. The harness keeps its own evidence.
 */
export async function journeyCells({ page, step, sandbox, run }, { tool, states, measure, render }) {
  const target = sandboxTarget(sandbox);
  const cells = [];
  for (const id of states) {
    const s = STATES.find((x) => x.id === id);
    if (!s || s.fresh) continue;
    await step(
      `${tool}: ${id}`,
      async () => {
        const opened = await openState(page, s, target);
        if (!opened.ok) {
          cells.push({ cell: id, state: id, ...opened });
          return;
        }
        cells.push({ cell: id, state: id, url: opened.url, result: await measure(page, s) });
        await leaveState(page, s);
      },
      { leavesEditor: true, selectionMayChange: true },
    );
  }
  const report = {
    tool,
    generatedAt: new Date().toISOString(),
    target: { origin: target.origin, source: target.source },
    cells,
  };
  if (run?.dir) writeReport(run.dir, tool, report, render(report));
  return report;
}
