/**
 * The front door in a real browser (projects-and-search.md, phase3-front-door.md
 * before it): the project page as the first screen, the search page finding a
 * diagram by a word only in a note and only in a comment, a row opened, the
 * agent's change pulsing on the drawing, axe in both themes, and the phone's
 * list -- what jsdom cannot see: layout, focus, the pulse's computed animation,
 * real contrast.
 *
 * Against the TypeScript service, the real thing, with the agent's write
 * announced as `write_diagram` announces it (`recordWrite`).
 *
 * Screenshots go to $ARCHER_SHOTS when it is set.
 */
import { commentOperation } from "../support/comment-operations";
import AxeBuilder from "@axe-core/playwright";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { testPage } from "./support/page-path";
import { sharedTsProject } from "./support/shared-service";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = testPage();
const FIXTURES = resolve(HERE, "../../../ts/test/fixtures");
const SHOTS = process.env.ARCHER_SHOTS;

const PIPELINE = "flowchart LR\n  lexer[Lexer] e1@--> parser[Parser]\n  parser e2@--> checker[Checker]\n";
const PIPELINE_AFTER =
  "flowchart LR\n  parser[Parser and lexer] e2@--> checker[Checker]\n  checker e3@--> emitter[Emitter]\n";
const LOGIN =
  "sequenceDiagram\n  participant B as Browser\n  participant S as Server\n  B->>S: POST /login\n  S-->>B: session cookie\n";
const PARSING = "# Parsing\n\nThe tokenizer hands tokens to the parser, one line at a time.\n";
const COMMENT = "Should signing in be idempotent?";

type Backend = {
  readonly url: string;
  present(viewId: string, caption?: string): Promise<void>;
  /** The agent rewriting the pipeline: Lexer merged into Parser, an Emitter added. */
  agentRewrite(): Promise<void>;
  stop(): Promise<void>;
};

const view = (id: string, kind: string, title: string): string =>
  `[[views]]\nid = "${id}"\nkind = "${kind}"\ntitle = "${title}"\nsource = ".archer/${id}.mmd"\n\n`;

/** A comment as the owner's page sends it: an operation (ADR 0016), with the browser's cookie and Origin. */
async function postComment(
  server: { fetch(path: string, init?: RequestInit): Promise<Response> },
  target: string,
  body: string,
): Promise<void> {
  const response = await server.fetch("api/comments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(commentOperation.create({ target, anchor: { kind: "view" }, body })),
  });
  expect(response.ok, `a comment on ${target}`).toBe(true);
}

const BACKENDS = {
  async service(): Promise<Backend> {
    const project = await sharedTsProject({
      files: {
        "archer.toml":
          "version = 1\n\n" +
          view("pipeline", "freeform", "Compile pipeline") +
          view("login", "sequence", "Sign in") +
          view("orders", "entity-relationship", "Orders data") +
          view("buying", "journey", "Buying a book"),
        ".archer/pipeline.mmd": PIPELINE,
        ".archer/login.mmd": LOGIN,
        ".archer/orders.mmd": readFileSync(resolve(FIXTURES, "er/minimal.mmd"), "utf8"),
        ".archer/buying.mmd": readFileSync(resolve(FIXTURES, "journey/minimal.mmd"), "utf8"),
        ".archer/notes/parsing.md": `---\ndiagrams: [../pipeline.mmd]\n---\n${PARSING}`,
      },
    });
    await postComment(project, "view:login", COMMENT);
    return {
      url: project.url,
      present: (id, caption) => project.present(id, caption),
      agentRewrite: () =>
        project.agentWrite("pipeline", ".archer/pipeline.mmd", PIPELINE_AFTER, "merged Lexer into Parser"),
      stop: () => project.stop(),
    };
  },
};

let backend: Backend | undefined;
let problems: string[];

test.beforeAll(() => {
  if (!existsSync(PAGE)) throw new Error(`no page at ${PAGE}; run: npm --workspace ui run build`);
});

test.beforeEach(async ({ page }) => {
  problems = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      problems.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`uncaught: ${error.message}`));
});

test.afterEach(async ({ page }) => {
  await page.close();
  await backend?.stop();
  backend = undefined;
  expect(problems, "the page logged errors or warnings").toEqual([]);
});

async function open(
  page: Page,
  options: { scheme?: "light" | "dark"; width?: number; reducedMotion?: boolean } = {},
): Promise<Backend> {
  backend = await BACKENDS.service();
  await page.setViewportSize({ width: options.width ?? 1440, height: options.width === 390 ? 844 : 900 });
  await page.emulateMedia({
    colorScheme: options.scheme ?? "light",
    reducedMotion: options.reducedMotion === true ? "reduce" : "no-preference",
  });
  await page.goto(backend.url);
  await expect(contents(page)).toBeVisible();
  return backend;
}

const contents = (page: Page): Locator => page.getByRole("region", { name: "Project documents", exact: true });
const filter = (page: Page): Locator => page.getByRole("searchbox", { name: "Search projects and files" });
/** The file rows of the Folders tree; every folder starts open. */
const results = (page: Page): Locator => contents(page).locator("[data-browser-row]");
const row = (page: Page, title: string): Locator =>
  results(page).filter({ has: page.getByRole("button", { name: title, exact: true }) });

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function violations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.passes.length).toBeGreaterThan(0);
  return results.violations.flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(" ")}`));
}

test.describe("against the service", () => {
  test("the first screen is the project browser: every file with its path, and search and filters ready", async ({
    page,
  }) => {
    await open(page);
    await expect(filter(page)).toBeVisible();
    await expect(page.getByRole("button", { name: /^Filters(?: \(\d+\))?$/ })).toBeVisible();
    await expect(results(page)).toHaveCount(5);
    await expect(row(page, "Sign in")).toContainText("Sequence");
    await expect(row(page, "Sign in").locator('[data-column="threads"]')).toContainText("1 open");
    await expect(row(page, "Parsing").locator(".archer-folder-tree-file")).toHaveAttribute(
      "title",
      ".archer/notes/parsing.md",
    );
    // Nothing is drawn on the reader's behalf.
    await expect(page.locator(".react-flow__node")).toHaveCount(0);
    await shot(page, "1440-light-project");
  });

  test("the search page finds a note by a word in its text, and a diagram by one only in a comment", async ({
    page,
  }) => {
    await open(page);
    await page.keyboard.press("/");
    await expect(filter(page)).toBeFocused();
    await page.keyboard.type("tokenizer");
    await filter(page).press("Enter");
    // The note, and not every diagram it is about.
    await expect(results(page)).toHaveCount(1);
    await expect(row(page, "Parsing").getByRole("button", { name: /^Note · .*tokenizer/ })).toBeVisible();
    await shot(page, "1440-light-search-note");

    await filter(page).fill("idempotent");
    await filter(page).press("Enter");
    await expect(results(page)).toHaveCount(1);
    await expect(row(page, "Sign in").getByRole("button", { name: /^Comment · / })).toBeVisible();

    // Submit a match on the diagram's type.
    await filter(page).fill("journey");
    await filter(page).press("Enter");
    await expect(results(page)).toHaveCount(1);
    await expect(row(page, "Buying a book")).toContainText("Journey");

    await page.keyboard.press("Escape");
    await expect(filter(page)).toHaveValue("");
    await expect(results(page)).toHaveCount(5);
  });

  test("a row opens its diagram, and Archer goes back to the project page", async ({ page }) => {
    await open(page);
    await page.keyboard.press("/");
    await filter(page).fill("pipe");
    await page.keyboard.press("Enter");
    await row(page, "Compile pipeline").getByRole("button", { name: "Compile pipeline", exact: true }).click();
    await expect(page.locator(".react-flow__node.archer-node")).toHaveCount(3);
    await expect(contents(page)).toBeHidden();
    await expect(page.locator(".archer-presence")).toContainText(/^Changed on disk · /); // nobody saved it in this browser (claude-206)
    await page.getByRole("button", { name: "Archer contents", exact: true }).click();
    await expect(contents(page)).toBeVisible();
    await row(page, "Sign in").getByRole("button", { name: "Sign in" }).click();
    // Both implementations draw the real compiled sequence family.
    await expect(page.locator(".archer-seq-participant, .react-flow__node.archer-node").first()).toBeVisible();
    await expect(contents(page)).toBeHidden();
  });

  test("the agent's change pulses once on the drawing, names what went, and shows again", async ({ page }) => {
    const server_ = await open(page);
    await server_.present("pipeline", "The compile pipeline, front to back.");
    await expect(page.locator(".react-flow__node.archer-node")).toHaveCount(3);
    await expect(page.locator(".archer-presence")).toHaveText(
      /^Presented by the agent · just now — The compile pipeline, front to back\.$/,
    );

    await server_.agentRewrite();
    const notice = page.locator(".archer-change");
    await expect(notice.locator(".archer-change-headline")).toHaveText("The agent changed 3 elements");
    await expect(notice).toContainText("merged Lexer into Parser");
    await expect(notice).toContainText("Removed: Lexer");
    const emitter = page.locator('.react-flow__node[data-id="emitter"]');
    await expect(emitter).toBeVisible();
    await expect
      .poll(() => emitter.evaluate((el) => getComputedStyle(el).animationName))
      .toMatch(/^archer-change-pulse-[01]$/);
    await shot(page, "1440-light-diagram-pulse");
    // Once: it ends, and the element is left as it was.
    await expect.poll(() => emitter.evaluate((el) => el.getAnimations().length), { timeout: 5000 }).toBe(0);

    const before = await emitter.evaluate((el) => getComputedStyle(el).animationName);
    await notice.getByRole("button", { name: "Show changes" }).click();
    await expect.poll(() => emitter.evaluate((el) => getComputedStyle(el).animationName)).not.toBe(before);
    expect(await violations(page)).toEqual([]);
  });

  test("a reader who asked for less motion gets a still outline", async ({ page }) => {
    const server_ = await open(page, { reducedMotion: true });
    await server_.present("pipeline");
    await expect(page.locator(".react-flow__node.archer-node")).toHaveCount(3);
    await server_.agentRewrite();
    const emitter = page.locator('.react-flow__node[data-id="emitter"]');
    await expect(emitter).toBeVisible();
    await expect.poll(() => emitter.evaluate((el) => getComputedStyle(el).filter)).toContain("drop-shadow");
    expect(await emitter.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`axe finds nothing on the project page or the search page, in ${scheme}`, async ({ page }) => {
      await open(page, { scheme });
      expect(await violations(page)).toEqual([]);
      await page.keyboard.press("/");
      await filter(page).fill("tokenizer");
      await filter(page).press("Enter");
      await expect(row(page, "Parsing")).toBeVisible();
      expect(await violations(page)).toEqual([]);
      await shot(page, `1440-${scheme}-search-axe`);
    });
  }

  test("on a phone the project page is the tree, scrolling inside its frame, and the drawer goes back to it", async ({
    page,
  }) => {
    await open(page, { width: 390 });
    await expect(results(page)).toHaveCount(5);
    const boxes = await results(page).evaluateAll((elements) =>
      elements.map((el) => el.getBoundingClientRect().toJSON() as DOMRect),
    );
    expect(new Set(boxes.map((b) => Math.round(b.x))).size, "one column").toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await shot(page, "390-light-project");
    expect(await violations(page)).toEqual([]);

    await row(page, "Compile pipeline").getByRole("button", { name: "Compile pipeline" }).click();
    await expect(page.locator(".react-flow__node.archer-node")).toHaveCount(3);
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    await page.getByRole("button", { name: "Archer contents" }).click();
    await expect(contents(page)).toBeVisible();
  });
});

test.describe("screenshots", () => {
  test.skip(SHOTS === undefined, "only when ARCHER_SHOTS names a folder");
  for (const scheme of ["light", "dark"] as const) {
    for (const width of [1440, 390]) {
      test(`${width} ${scheme}: the project page, a search, and a diagram with presence and a pulse`, async ({
        page,
      }) => {
        const server = await open(page, { scheme, width });
        await shot(page, `${width}-${scheme}-project`);
        await page.keyboard.press("/");
        await filter(page).fill("tokenizer");
        await filter(page).press("Enter");
        await expect(row(page, "Parsing")).toBeVisible();
        await shot(page, `${width}-${scheme}-search`);
        await server.present("pipeline", "The compile pipeline, front to back.");
        await expect(page.locator(".react-flow__node.archer-node")).toHaveCount(3);
        await server.agentRewrite();
        const emitter = page.locator('.react-flow__node[data-id="emitter"]');
        await expect(emitter).toBeVisible();
        // Caught at the pulse's height.
        await page.waitForFunction(() => {
          const el = document.querySelector('.react-flow__node[data-id="emitter"]');
          const animation = el?.getAnimations()[0];
          return animation !== undefined && (animation.currentTime as number) > 350;
        });
        await shot(page, `${width}-${scheme}-diagram-pulse`);
      });
    }
  }
});
