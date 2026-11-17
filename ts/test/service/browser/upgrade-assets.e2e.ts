/// <reference lib="dom" />
/**
 * Page assets across an upgrade (ADR 0032, ADR 0014): a tab of build A that has not started its layout
 * worker yet, and cannot reload itself (it holds typed text), stays open while `archer restart` swaps in
 * build B, whose worker is another file. Opening a diagram in that tab then still lays out, with A's
 * worker, which B serves for the tabs A loaded, and still does after B restarts itself (A→B→B).
 *
 *   npm --workspace ui run build && npx playwright test -c ts/test/service/browser upgrade-assets
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { bundle } from "../../../scripts/bundle.ts";
import { ensureService, type ServiceClient } from "../../../src/service/index.ts";
import { nextUiBuild, snapshotUiDist } from "../../package/ui-dist.ts";
import { isolatedProcessEnv, stopServicesUnder } from "../support.ts";

const FLOW = "flowchart LR\n  web[Web app] e1@--> api[API]\n  api e2@--> db[(Database)]\n";

let scratch: string, state: string, root: string, env: Record<string, string>;
let service: ServiceClient | undefined;
let builds: { before: string; after: string };

test.setTimeout(240_000);

test.beforeAll(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "archer-upgrade-assets-")));
  state = join(scratch, "state");
  root = join(scratch, "project");
  for (const [path, text] of Object.entries({
    "archer.toml":
      'version = 1\n\n[[views]]\nid = "system"\nkind = "freeform"\ntitle = "The system"\nsource = ".archer/system.mmd"\n',
    ".archer/system.mmd": FLOW,
  })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const pages = await snapshotUiDist(join(scratch, "pages-a"));
  if (pages === undefined) throw new Error("build the page first: npm --workspace ui run build");
  const next = nextUiBuild(pages, join(scratch, "pages-b"));
  builds = next;
  // Each build serves its own page (no --page): A's from a/, B's from b/, as two installed copies would.
  await bundle(join(scratch, "a"), { version: "9.0.0-a", pages });
  await bundle(join(scratch, "b"), { version: "9.0.0-b", pages: next.dest });
  env = isolatedProcessEnv(state, {
    ARCHER_STATE_DIR: state,
    ARCHER_FORCE_HTTP: "true",
    ARCHER_HOST: "127.0.0.1",
    ARCHER_OPEN_BROWSER: "never",
  });
  service = await ensureService({
    stateDir: state,
    env,
    timeoutMs: 30_000,
    command: [process.execPath, join(scratch, "a", "archer.js"), "serve", "--foreground"],
  });
});

test.afterAll(async () => {
  try {
    await service?.call("stop", {});
  } catch {
    /* the swapped-out connection */
  }
  service?.close();
  const after = await ensureService({ stateDir: state, env, autoStart: false }).catch(() => null);
  if (after !== null) {
    await after.call("stop", {}).catch(() => undefined);
    after.close();
  }
  await stopServicesUnder(scratch);
  rmSync(scratch, { recursive: true, force: true });
});

test("a tab loaded before an upgrade, held by unsaved text, lays out with its own build's worker afterwards", async ({
  page,
}) => {
  const workers: { name: string; status: number }[] = [];
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith("/-/page-assets/"))
      workers.push({ name: path.slice("/-/page-assets/".length), status: response.status() });
  });
  const { url } = await service!.call("attach", { root });
  // The link's cookie, without loading the page it names (it follows the presented view, which lays out).
  await page.context().request.get(url);
  await page.goto(new URL("/projects/project/", url).href);
  const diagram = page.getByRole("button", { name: /^The system/ });
  await expect(diagram).toBeVisible({ timeout: 20_000 });
  // A project page lays nothing out: the worker has not started.
  expect(workers).toEqual([]);
  // Text the person typed and has not saved: the page will not reload itself (ADR 0032).
  await page.evaluate(() => {
    const draft = document.createElement("textarea");
    draft.value = "half a thought";
    document.body.append(draft);
  });

  const restart = (): Promise<{ code: number; out: string; err: string }> =>
    new Promise((done) => {
      execFile(
        process.execPath,
        [join(scratch, "b", "archer.js"), "restart"],
        { env, timeout: 60_000 },
        (error, out, err) => done({ code: error === null ? 0 : 1, out, err }),
      );
    });
  const swap = await restart();
  expect(swap.code, swap.err).toBe(0);
  await expect(page.getByRole("status").filter({ hasText: "Archer was updated" })).toBeVisible({ timeout: 20_000 });
  // B restarts itself (a same-build restart): A is still the previous build, and its tabs keep their worker.
  const again = await restart();
  expect(again.code, again.err).toBe(0);

  await diagram.click();
  await expect(page.locator('.react-flow__node[data-id="api"]')).toBeVisible({ timeout: 20_000 });
  expect(workers).toEqual([{ name: builds.before, status: 200 }]);
  expect(await page.locator("textarea").last().inputValue()).toBe("half a thought");
});
