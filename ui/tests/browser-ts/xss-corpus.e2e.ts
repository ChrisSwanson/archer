// Security rubric G7 (probe P6, docs/quality/rubrics/security.md): no script from content. The hostile
// devkit corpus (tools/devkit/corpus/hostile/project, read from disk here so the corpus and the test cannot
// drift) is served by the real service and opened in Chromium through every renderer: diagram canvases of
// every family, note Markdown, a project document, comment bodies, embedded figures, gallery thumbnails and
// the SVG export (standalone and embedded). Detectors (support/xss-detectors.ts) must stay at 0; the first
// test plants an unsanitised sink and shows every detector trips, so a 0 means something.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { startTsProject, type TsProject } from "../support/ts-service";
import { armDetectors, describeHits, DETECTORS, type Detectors } from "./support/xss-detectors";
import { testPage } from "./support/page-path";

const PAGE = testPage();
const CORPUS = resolve(import.meta.dirname, "../../../tools/devkit/corpus/hostile/project");

function corpusFiles(dir = CORPUS): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) Object.assign(files, corpusFiles(path));
    else files[relative(CORPUS, path)] = readFileSync(path, "utf8");
  }
  return files;
}
const FILES = corpusFiles();
const VIEWS = [
  ...FILES["archer.toml"]!.matchAll(/^id = "([^"]+)"\nkind = "[^"]+"\ntitle = .*\nsource = "\.archer\/([^"]+)"$/gm),
].map((m) => ({ id: m[1]!, path: m[2]! }));
const INERT = VIEWS.filter((v) => v.id.endsWith("-inert") || v.id === "flow-directives");
const NOTES = Object.keys(FILES)
  .filter((p) => p.startsWith(".archer/notes/"))
  .map((p) => p.slice(".archer/".length));
const COMMENTS = (JSON.parse(FILES[".devkit/comments.json"]!) as { bodies: string[] }).bodies;

let project: TsProject;
let origin: string;
let slug: string;
test.describe.configure({ timeout: 180_000 });
test.beforeAll(async () => {
  project = await startTsProject({ files: FILES, pagePath: PAGE });
  origin = new URL(project.url).origin;
  slug = new URL(project.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
});
test.afterAll(async () => {
  await project?.stop();
});

async function open(context: BrowserContext): Promise<{ page: Page; detectors: Detectors }> {
  const page = await context.newPage();
  const detectors = await armDetectors(context, page, origin);
  const access = await project.issueAccess("xss corpus");
  await page.goto(access.url);
  await page.waitForURL((url) => url.href.startsWith(origin) && !url.search.includes("token="));
  return { page, detectors };
}

/** Visit one address, let it render, scan, click every link that leaves, scan again. */
async function visit(
  page: Page,
  detectors: Detectors,
  where: string,
  address: string,
  rendered: (page: Page) => Promise<void>,
): Promise<void> {
  await test.step(where, async () => {
    detectors.at(where);
    if (page.isClosed()) return;
    if (process.env.XSS_DEBUG) console.log(`[xss] ${where}: goto`);
    await page.goto(address);
    await rendered(page);
    if (process.env.XSS_DEBUG) console.log(`[xss] ${where}: rendered`);
    await detectors.scan(page);
    const clicked = await detectors.clickLinks(page);
    if (process.env.XSS_DEBUG) console.log(`[xss] ${where}: clicked ${clicked}`);
  });
}

const zero = (detectors: Detectors): Record<string, number> => Object.fromEntries(DETECTORS.map((d) => [d, 0]));

/** The PLANTED sink, test-only: the raw-HTML note's own source given to innerHTML, unsanitised, plus links. */
async function plant(page: Page): Promise<void> {
  const rawHtml = FILES[".archer/notes/raw-html.md"]!;
  await page.evaluate((html) => {
    const host = document.querySelector(".archer-note-body")!;
    // The planted link first: the corpus's own web link without a target takes the tab away when clicked.
    host.innerHTML =
      `<a href="javascript:window.__xss='planted-click'">planted click</a>` +
      `<img src="https://xss-canary.invalid/planted-csp.png">` +
      html;
  }, rawHtml);
}

// The page's CSP runs no inline handler or `javascript:` URL (script-src by hash only, B3), so the detectors
// that need a script to run are proven with the policy bypassed; the next test shows the policy stopping them.
test("positive control: a planted unsanitised sink trips every detector (CSP bypassed; csp in the next test)", async ({
  browser,
}) => {
  const context = await browser.newContext({ bypassCSP: true });
  try {
    const { page, detectors } = await open(context);
    await visit(page, detectors, "clean note", `${origin}/projects/${slug}/notes/clobber.md`, async (p) => {
      await expect(p.locator(".archer-note-body").first()).toBeVisible();
    });
    // The rendered corpus note is clean: every detector at zero before the plant.
    expect(detectors.counts(), describeHits(detectors.hits)).toEqual(zero(detectors));

    detectors.at("planted sink");
    await plant(page);
    await expect.poll(() => detectors.counts().dialog, { message: describeHits(detectors.hits) }).toBeGreaterThan(0);
    await detectors.scan(page);
    await detectors.clickLinks(page, ".archer-note-body");
    await expect
      .poll(() => detectors.hits.some((h) => h.detector === "canary" && h.detail === "planted-click"), {
        message: describeHits(detectors.hits),
      })
      .toBe(true);
    // Last, as it takes the tab away: a planted handler that sends the tab to the canary host.
    if (page.url().startsWith(origin)) {
      await page
        .evaluate(() => {
          document.body.insertAdjacentHTML(
            "beforeend",
            `<img src="data:," onerror="location.href='https://xss-canary.invalid/planted-request'">`,
          );
        })
        .catch(() => {});
    }
    await expect.poll(() => detectors.counts().request).toBeGreaterThan(0);
    await expect
      .poll(() => detectors.counts().navigation, { message: describeHits(detectors.hits) })
      .toBeGreaterThan(0);
    const counts = detectors.counts();
    test.info().annotations.push({ type: "planted", description: JSON.stringify(counts) });
    for (const detector of DETECTORS.filter((d) => d !== "csp"))
      expect(
        counts[detector],
        `${detector} must trip on the planted sink\n${describeHits(detectors.hits)}`,
      ).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});

test("the page's CSP stops the same planted sink: violations reported, no handler or javascript: URL runs", async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const { page, detectors } = await open(context);
    await visit(page, detectors, "clean note", `${origin}/projects/${slug}/notes/clobber.md`, async (p) => {
      await expect(p.locator(".archer-note-body").first()).toBeVisible();
    });
    expect(detectors.counts(), describeHits(detectors.hits)).toEqual(zero(detectors));
    detectors.at("planted sink under the CSP");
    await plant(page);
    await expect.poll(() => detectors.counts().csp, { message: describeHits(detectors.hits) }).toBeGreaterThan(0);
    await page
      .locator(".archer-note-body a", { hasText: "planted click" })
      .click()
      .catch(() => {});
    await page.waitForTimeout(500);
    expect(detectors.hits.filter((h) => h.detector === "csp").map((h) => h.detail.split(" ")[0])).toContain(
      "script-src-attr",
    );
    const counts = detectors.counts();
    expect([counts.dialog, counts.canary, counts.navigation], describeHits(detectors.hits)).toEqual([0, 0, 0]);
  } finally {
    await context.close();
  }
});

test("every diagram family's hostile labels draw as text, and the refused ones are refused", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const { page, detectors } = await open(context);
    const drawn = ":is(.react-flow__node, .archer-seq-viewport, .archer-journey-el):visible";
    const refusal = (p: Page) => p.getByText("This diagram's file does not compile");
    const outcome: Record<string, string> = {};
    for (const view of VIEWS) {
      await visit(page, detectors, `canvas ${view.id}`, `${origin}/projects/${slug}/${view.path}`, async (p) => {
        await expect(p.locator(drawn).first().or(refusal(p))).toBeVisible();
        outcome[view.id] = (await refusal(p).isVisible()) ? "refused" : "drawn";
      });
    }
    test.info().annotations.push({ type: "outcomes", description: JSON.stringify(outcome) });
    // The corpus still exercises both paths: every inert diagram is drawn, every refused one refused.
    expect(outcome).toEqual(
      Object.fromEntries(
        VIEWS.map((v) => [v.id, v.id.endsWith("-refused") || v.id === "flow-styles" ? "refused" : "drawn"]),
      ),
    );
    expect(detectors.counts(), describeHits(detectors.hits)).toEqual(zero(detectors));
  } finally {
    await context.close();
  }
});

test("note Markdown: links, autolinks, raw HTML and clobbering names are inert", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const { page, detectors } = await open(context);
    for (const note of NOTES) {
      await visit(page, detectors, `note ${note}`, `${origin}/projects/${slug}/${note}`, async (p) => {
        await expect(p.locator(".archer-note-body").first()).toBeVisible();
      });
    }
    await visit(
      page,
      detectors,
      "project document README.md",
      `${origin}/projects/${slug}/-/repo/README.md`,
      async (p) => {
        await expect(p.locator(".archer-note-body").first()).toBeVisible();
      },
    );
    expect(detectors.counts(), describeHits(detectors.hits)).toEqual(zero(detectors));
  } finally {
    await context.close();
  }
});

test("comment bodies, stored through the page's API and the agent's, are shown as text", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const { page, detectors } = await open(context);
    await page.goto(`${origin}/projects/${slug}/diagrams/flow-inert.mmd`);
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    // The person's path: POST api/comments, as the page's transport sends it.
    const stored = await page.evaluate(
      async ({ base, bodies }) => {
        const out: number[] = [];
        for (const body of bodies) {
          const response = await fetch(`${base}/api/comments`, {
            method: "POST",
            cache: "no-store",
            headers: { "content-type": "application/json" },
            // An operation (ADR 0016): a fresh 128-bit id, the time now, and the NewThread as its payload.
            body: JSON.stringify({
              operation: {
                id: [...crypto.getRandomValues(new Uint8Array(16))]
                  .map((b) => b.toString(16).padStart(2, "0"))
                  .join(""),
                issuedAt: Date.now(),
                name: "comment.create",
                target: "view:flow-inert",
              },
              payload: { target: "view:flow-inert", anchor: { kind: "view" }, body },
            }),
          });
          out.push(response.status);
        }
        return out;
      },
      { base: `${origin}/p/${slug}`, bodies: COMMENTS },
    );
    expect(
      stored.every((s) => s >= 200 && s < 300),
      `POST api/comments: ${stored.join(",")}`,
    ).toBe(true);
    const listed = await page.evaluate(
      async (base) =>
        (await (await fetch(`${base}/api/comments?target=view%3Aflow-inert`, { cache: "no-store" })).json()) as unknown,
      `${origin}/p/${slug}`,
    );
    expect(JSON.stringify(listed), "the page's comments are stored as written").toContain("cm-bare");
    // The agent's path: create_comment. The chat shows the newest agent thread: each body in turn.
    await visit(
      page,
      detectors,
      "comments on flow-inert",
      `${origin}/projects/${slug}/diagrams/flow-inert.mmd`,
      async (p) => {
        await p.getByRole("button", { name: /^Chat with the agent about/ }).click();
      },
    );
    const conversation = page.getByRole("log", { name: "Conversation" });
    for (const [index, body] of COMMENTS.entries()) {
      detectors.at(`agent comment ${index}`);
      await project.agentCreateComment("view:flow-inert", { kind: "view" }, body);
      await expect(conversation.getByText(body, { exact: true })).toBeVisible();
      await detectors.scan(page);
      await detectors.clickLinks(page, '[role="log"]');
    }
    expect(detectors.counts(), describeHits(detectors.hits)).toEqual(zero(detectors));
  } finally {
    await context.close();
  }
});

test("embedded figures and gallery thumbnails of hostile diagrams are inert", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const { page, detectors } = await open(context);
    await visit(page, detectors, "figures note", `${origin}/projects/${slug}/notes/figures.md`, async (p) => {
      await expect(p.locator(".archer-note-figure").first()).toBeVisible();
      // Each figure is brought into sight and held there until the page has seen it, as a reader stops at it: a
      // figure above drawing taller can push the one just scrolled to out of sight before the next frame (O182).
      for (const figure of await p.locator(".archer-note-figure").all()) {
        await expect(async () => {
          await figure.scrollIntoViewIfNeeded();
          await expect(figure).not.toHaveAttribute("data-state", "waiting", { timeout: 1_000 });
        }).toPass();
      }
      // Named one by one, so a figure left undrawn says which it is and what it shows.
      const states = () =>
        p
          .locator(".archer-note-figure")
          .evaluateAll((figures) =>
            figures.map((f) => `${f.getAttribute("aria-label")}: ${f.getAttribute("data-state")}`),
          );
      await expect.poll(states).toEqual(Array.from({ length: 7 }, () => expect.stringMatching(/: drawn$/)));
    });
    await visit(page, detectors, "project browser and README", `${origin}/projects/${slug}/`, async (p) => {
      await expect(p.getByText("<script>window.__xss='html-script'</script>", { exact: true }).first()).toBeVisible();
    });
    await visit(page, detectors, "gallery", `${origin}/projects/${slug}/diagrams/`, async (p) => {
      await p.getByRole("tab", { name: /^Diagrams/ }).click();
      await expect(p.locator("img.archer-document-preview-image").first()).toBeVisible();
    });
    // Every drawn diagram's thumbnail, asked for at the address the page spells (the service redirects to its
    // versioned one), then opened on its own as a top-level SVG document under the service's own headers.
    const thumbnails = await page.evaluate(
      async ({ base, ids }) => {
        const inventory = (await (await fetch(`${base}/api/diagrams`, { cache: "no-store" })).json()) as {
          views?: { id: string; modelRevision?: string }[];
        };
        const out: { id: string; url: string; status: number; code?: string }[] = [];
        for (const view of inventory.views ?? []) {
          if (!ids.includes(view.id) || view.modelRevision === undefined) continue;
          const response = await fetch(
            `${base}/api/thumbnails/${encodeURIComponent(view.id)}?rev=${view.modelRevision}&theme=light`,
            { cache: "no-store" },
          );
          // A refusal's code is kept: the safety check refusing a drawing (export_unsafe_svg) is inert, not drawn.
          const code = response.ok
            ? undefined
            : String(((await response.json().catch(() => ({}))) as { error?: { code?: unknown } }).error?.code ?? "");
          out.push({
            id: view.id,
            url: response.url,
            status: response.status,
            ...(code === undefined ? {} : { code }),
          });
        }
        return out;
      },
      { base: `${origin}/p/${slug}`, ids: INERT.map((v) => v.id) },
    );
    test.info().annotations.push({
      type: "thumbnails",
      description: JSON.stringify(thumbnails.map(({ id, status, code }) => ({ id, status, code }))),
    });
    expect(thumbnails.map((t) => t.id).sort(), "every drawn hostile diagram was asked for").toEqual(
      INERT.map((v) => v.id).sort(),
    );
    for (const thumbnail of thumbnails.filter((t) => t.status === 200)) {
      await visit(page, detectors, `thumbnail ${thumbnail.id} standalone`, thumbnail.url, async (p) => {
        await expect(p.locator("svg").first()).toBeAttached();
      });
    }
    expect(detectors.counts(), describeHits(detectors.hits)).toEqual(zero(detectors));
  } finally {
    await context.close();
  }
});

test("the SVG export of every hostile diagram, opened standalone and embedded inline with no CSP, is inert", async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const { page, detectors } = await open(context);
    await page.goto(`${origin}/projects/${slug}/`);
    const exports: Record<string, string> = {};
    for (const view of INERT) {
      const answer = await page.evaluate(
        async ({ base, viewId }) => {
          const response = await fetch(`${base}/api/operations`, {
            method: "POST",
            cache: "no-store",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "export_diagram", arguments: { viewId, format: "svg" } }),
          });
          return { status: response.status, body: (await response.json()) as { data?: string; encoding?: string } };
        },
        { base: `${origin}/p/${slug}`, viewId: view.id },
      );
      expect(answer.status, `export ${view.id}: ${JSON.stringify(answer.body).slice(0, 300)}`).toBe(200);
      const svg = Buffer.from(answer.body.data!, "base64").toString("utf8");
      // The hostile words are in the drawing, as text: an export that dropped them would prove nothing.
      if (view.id !== "flow-directives") expect(svg, `export ${view.id} holds its labels`).toMatch(/__xss|alert\(/);
      exports[view.id] = svg;
    }
    // Served from the service's origin but by the test, with no CSP: a downloaded file opened in a browser.
    for (const [viewId, svg] of Object.entries(exports)) {
      await context.route(`${origin}/__xss-export/${viewId}.svg`, (route) =>
        route.fulfill({ status: 200, contentType: "image/svg+xml", body: svg }),
      );
      await context.route(`${origin}/__xss-export/${viewId}.html`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `<!doctype html><title>${viewId}</title><body><div id="host"></div></body>`,
        }),
      );
      detectors.at(`export ${viewId} standalone`);
      await page.goto(`${origin}/__xss-export/${viewId}.svg`);
      await detectors.clickLinks(page);
      detectors.at(`export ${viewId} embedded`);
      await page.goto(`${origin}/__xss-export/${viewId}.html`);
      await page.evaluate((markup) => {
        document.getElementById("host")!.innerHTML = markup;
      }, svg);
      await detectors.scan(page);
      await detectors.clickLinks(page);
    }
    expect(detectors.counts(), describeHits(detectors.hits)).toEqual(zero(detectors));
  } finally {
    await context.close();
  }
});
