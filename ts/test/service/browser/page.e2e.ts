/**
 * The core loop in a real browser, against the TypeScript service: the agent
 * presents a diagram, the page draws it, an edit redraws it, a break shows the
 * compile notice over the last good drawing, and a node the reader clicks
 * reaches the agent through getContext (what get_presentation_context reads).
 *
 * The service runs as its own detached process, started the way the front
 * doors start it (ensureService), on a temporary state directory.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { ensureService, type ServiceClient } from "../../../src/service/index.ts";
import { defaultServeCommand } from "../../../src/service/client.ts";
import { isolatedProcessEnv } from "../support.ts";

/**
 * The page this checkout builds (`npm run build`), as the ui suite serves it; the service's own default
 * (the same build, `defaultPagePath`) unless ARCHER_PAGE names another.
 */
const BUILT = resolve(import.meta.dirname, "../../../../ui/dist/index.html");
const PAGE = process.env.ARCHER_PAGE ?? (existsSync(BUILT) ? BUILT : undefined);

const FLOW = "flowchart LR\n  web[Web app] e1@--> api[API]\n  api e2@--> db[(Database)]\n";
const FLOW_MORE =
  "flowchart LR\n  web[Web app] e1@--> api[API]\n  api e2@--> db[(Database)]\n  api e3@--> cache[Cache]\n";
/** An implicit node: Archer's validator refuses it. */
const BROKEN = "flowchart LR\n  web[Web app] --> api\n";

let state: string;
let root: string;
let client: ServiceClient;
let pid: number;

function write(path: string, text: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

test.beforeAll(async () => {
  state = realpathSync(mkdtempSync(join(tmpdir(), "archer-state-")));
  root = realpathSync(mkdtempSync(join(tmpdir(), "archer-proj-")));
  write(
    "archer.toml",
    'version = 1\n\n[[views]]\nid = "system"\nkind = "freeform"\ntitle = "The system"\nsource = ".archer/system.mmd"\n',
  );
  write(".archer/system.mmd", FLOW);
  // Its own home and no ARCHER_* from the shell: the person's global config (its port, often their
  // own live service's) and ARCHER_HOST never reach the service under test.
  client = await ensureService({
    stateDir: state,
    timeoutMs: 30_000,
    env: isolatedProcessEnv(state, { ARCHER_FORCE_HTTP: "true" }),
    ...(PAGE === undefined ? {} : { command: [...defaultServeCommand(), "--page", PAGE] }),
  });
  pid = Number(readFileSync(join(state, "archer.lock"), "utf8").split(" ")[0]);
});

test.afterAll(async () => {
  try {
    await client?.call("stop", {});
  } catch {
    // already gone
  }
  client?.close();
  await expect
    .poll(() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    })
    .toBe(false);
  rmSync(state, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("present, redraw on edit, compile notice on a break, and the reader's click read back", async ({ page }) => {
  const { url } = await client.call("attach", { root });
  await page.goto(url);
  await expect(page.locator(".archer-web-shell")).toBeVisible();

  await client.call("present", { root, viewId: "system", annotation: "Requests go through the API" });
  await expect(page.locator(".react-flow__node.archer-node")).toHaveCount(3);
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await expect(page.getByText("Requests go through the API", { exact: true })).toBeVisible();

  write(".archer/system.mmd", FLOW_MORE);
  await expect(page.locator(".react-flow__node.archer-node")).toHaveCount(4);
  await expect(page.locator(".react-flow__edge")).toHaveCount(3);

  write(".archer/system.mmd", BROKEN);
  await expect(page.getByRole("alert")).toContainText("no longer compiles");
  // The last drawing that compiled stays on screen under the notice.
  await expect(page.locator(".react-flow__node.archer-node")).toHaveCount(4);

  write(".archer/system.mmd", FLOW_MORE);
  await expect(page.getByRole("alert")).toHaveCount(0);

  // The canvas opens in hand mode (panning); picking a part is select mode's.
  await page.getByRole("button", { name: "Select mode", exact: true }).click();
  await page.locator('.react-flow__node[data-id="api"]').click();
  await expect
    .poll(async () => (await client.call("getContext", { root })).selection?.nodes)
    .toEqual([{ id: "api", label: "API" }]);
});
