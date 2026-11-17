/// <reference lib="dom" />
/**
 * A seamless hot swap (ADR 0032), end to end: a page open on a diagram with an emphasis showing,
 * an agent's MCP session (build A) mid-conversation, then `archer restart` from a rebuilt version
 * (build B). The page never says it lost Archer, reloads itself to B, the agent's calls during the
 * swap succeed, and the emphasis, presentation and comments are unchanged. The gap is printed.
 *
 *   npm --workspace ui run build && npx playwright test -c ts/test/service/browser hot-swap
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { bundle } from "../../../scripts/bundle.ts";
import { ensureService, type ServiceClient } from "../../../src/service/index.ts";
import { isolatedProcessEnv, stopServicesUnder } from "../support.ts";

const PAGE = resolve(import.meta.dirname, "../../../../ui/dist/index.html");
const FLOW = "flowchart LR\n  web[Web app] e1@--> api[API]\n  api e2@--> db[(Database)]\n";

let scratch: string, state: string, root: string, env: Record<string, string>;
let service: ServiceClient | undefined;
let agent: Client | undefined;

test.setTimeout(240_000);

test.beforeAll(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "archer-swap-")));
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
  await bundle(join(scratch, "a"), { version: "9.0.0-a" });
  await bundle(join(scratch, "b"), { version: "9.0.0-b" });
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
    command: [process.execPath, join(scratch, "a", "archer.js"), "serve", "--foreground", "--page", PAGE],
  });
  agent = new Client({ name: "hot-swap", version: "0" });
  await agent.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(scratch, "a", "archer.js"), "mcp"],
      cwd: root,
      env,
      stderr: "pipe",
    }),
  );
});

test.afterAll(async () => {
  await agent?.close();
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

const tool = async (
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; structured: Record<string, unknown> }> => {
  const answer = await agent!.callTool({ name, arguments: args });
  const text = (answer.content as { type: string; text?: string }[]).map((part) => part.text ?? "").join("\n");
  if (answer.isError === true) throw new Error(`${name}: ${text}`);
  return { text, structured: answer.structuredContent as Record<string, unknown> };
};

test("a hot swap to a rebuilt version goes unnoticed by the page and the agent", async ({ page }) => {
  // Every load of the page counts itself, and any "lost Archer" state it ever shows is remembered across reloads.
  await page.addInitScript(() => {
    const count = Number(sessionStorage.getItem("swap.loads") ?? "0") + 1;
    sessionStorage.setItem("swap.loads", String(count));
    const lost = (): void => {
      if (
        document.querySelector('[data-connection="lost"]') !== null ||
        /Reconnecting/.test(document.body?.innerText ?? "")
      )
        sessionStorage.setItem("swap.lost", "1");
    };
    new MutationObserver(lost).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
  });
  const presented = await tool("present_diagram", { viewId: "system", annotation: "the request path" });
  const url = (presented.structured["ui"] as { url: string }).url;
  await tool("set_emphasis", {
    id: "path",
    viewId: "system",
    groups: [{ id: "request", style: "flow", label: "request path", nodes: ["web", "api"], edges: ["e1"] }],
  });
  await tool("create_comment", {
    target: "view:system",
    anchor: { kind: "node", id: "api", label: "API" },
    body: "Is the API stateless?",
  });
  await page.goto(url);
  await expect(page.getByText("request path").first()).toBeVisible({ timeout: 20_000 });
  const before = {
    emphases: (await tool("list_emphases", { viewId: "system" })).structured,
    presentation: (await tool("get_presentation_context")).structured,
    comments: (await tool("get_comments", { target: "view:system" })).structured,
  };

  // The agent keeps calling throughout the swap.
  const failures: string[] = [],
    texts: string[] = [];
  let calls = 0,
    swapping = true;
  const caller = (async () => {
    while (swapping) {
      try {
        texts.push((await tool("get_presentation_context")).text);
        calls++;
      } catch (error) {
        failures.push(String(error));
      }
      await new Promise((done) => setTimeout(done, 25));
    }
  })();
  const swap = await new Promise<{ code: number; out: string; err: string }>((done) => {
    execFile(
      process.execPath,
      [join(scratch, "b", "archer.js"), "restart"],
      { env, timeout: 60_000 },
      (error, out, err) => done({ code: error === null ? 0 : 1, out, err }),
    );
  });
  expect(swap.code, swap.err).toBe(0);
  const gap = Number(/in (\d+) ms/.exec(swap.out)?.[1]);
  console.log(`hot swap: ${swap.out.trim()} (gap ${gap} ms)`);
  expect(gap).toBeLessThan(1_000);

  // The page reloads itself to the new version, and never showed it had lost Archer. A read that lands
  // during that reload loses its page (O62), so it counts as not yet reloaded and the poll reads again.
  const loads = (): Promise<number> => page.evaluate(() => Number(sessionStorage.getItem("swap.loads"))).catch(() => 0);
  await expect.poll(loads, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await expect(page.getByText("request path").first()).toBeVisible({ timeout: 20_000 });
  expect(await page.evaluate(() => sessionStorage.getItem("swap.lost"))).toBeNull();
  expect(new URL(page.url()).pathname).toBe(new URL(url).pathname);

  await new Promise((done) => setTimeout(done, 300));
  swapping = false;
  await caller;
  expect(failures).toEqual([]);
  expect(calls).toBeGreaterThan(5);

  // The session's MCP is a relay (ADR 0035 §6): its tools already run in B, so it is never told to
  // restart for them; ADR 0032's "a newer Archer" notice is for an in-process session (handover.test.ts).
  expect(texts.filter((text) => /a newer Archer/.test(text))).toEqual([]);
  expect((await tool("start_service")).structured["version"]).toBe("9.0.0-b");
  expect((await tool("list_emphases", { viewId: "system" })).structured).toEqual(before.emphases);
  expect((await tool("get_presentation_context")).structured).toEqual(before.presentation);
  expect((await tool("get_comments", { target: "view:system" })).structured).toEqual(before.comments);
  expect(readFileSync(join(state, "service.log"), "utf8")).toContain(
    "warm; waiting for the running service to hand over",
  );
});
