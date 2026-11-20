import { commentOperation } from "../support/comment-operations";
import { openFile, expectCurrentFile } from "./support/primary-navigation";
import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expectChevronsMoving } from "./support/emphasis-motion";
import { apiBaseOf, fetchAsOwner, signInCookie } from "../support/ts-service";
import { testPage } from "./support/page-path";
const base = resolve(import.meta.dirname, "../../../ts/src");
const load = async (p: string) => import(/* @vite-ignore */ pathToFileURL(join(base, p)).href);
async function fixture(options: { readonly commentSubmission?: "queued" | "immediate" } = {}) {
  const { startService } = await load("service/service.ts"),
    { connectService } = await load("service/client.ts");
  const dir = mkdtempSync(join(tmpdir(), "archer-ui-recovery-")),
    root = join(dir, "project"),
    state = join(dir, "state");
  const configPath = join(dir, "instance.archer.toml");
  writeFileSync(
    configPath,
    options.commentSubmission === undefined
      ? "version = 1\n"
      : `version = 1\n[service]\ncomment_submission = "${options.commentSubmission}"\n`,
    { mode: 0o600 },
  );
  mkdirSync(join(root, ".archer"), { recursive: true });
  writeFileSync(
    join(root, "archer.toml"),
    'version = 1\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "Flow"\nsource = ".archer/flow.mmd"\n[[views]]\nid = "other"\nkind = "freeform"\ntitle = "Other"\nsource = ".archer/other.mmd"\n',
  );
  writeFileSync(join(root, ".archer/flow.mmd"), "flowchart LR\n a[Customer] e1@--> b[Shop]\n");
  writeFileSync(join(root, ".archer/other.mmd"), "flowchart LR\n x[Reader] e2@--> y[Queue]\n");
  let svc = await startService({
      forceHttp: true,
      env: {
        HOME: dir,
        XDG_CONFIG_HOME: join(dir, ".config"),
        ARCHER_CONFIG: configPath,
        ARCHER_OPEN_BROWSER: "never",
      },
      stateDir: state,
      socketPath: join(state, "archer.sock"),
      pagePath: testPage(),
      log: () => {},
    }),
    client = await connectService(svc.socketPath);
  const attached = await client.call("attach", { root });
  let url: string = attached.url;
  // The owner's browser session: the agent link's token exchanged once (a restart keeps the service's sessions).
  let session: Promise<string> | undefined;
  // A restarted service opens saved projects after it answers (server review S2): a call naming one
  // waits a moment, then answers project_loading. Attaching again until it is open waits on that
  // condition (each attempt itself waits), bounded by the test's own timeout.
  const attachOnceOpen = async (): Promise<{ url: string }> => {
    for (;;) {
      try {
        return await client.call("attach", { root });
      } catch (error) {
        if ((error as { error?: { code?: string } }).error?.code !== "project_loading") throw error;
      }
    }
  };
  return {
    root,
    get socketPath() {
      return svc.socketPath;
    },
    async announceInventory() {
      const file = join(root, "archer.toml");
      writeFileSync(file, readFileSync(file, "utf8").replace('title = "Other"', 'title = "Other updated"'));
      await client.call("getContext", { root });
    },
    api: (path: string): string => new URL(path, apiBaseOf(url)).href,
    async fetch(path: string, init?: RequestInit): Promise<Response> {
      session ??= signInCookie(url);
      return fetchAsOwner(new URL(path, apiBaseOf(url)).href, await session, init);
    },
    get url() {
      return url;
    },
    call: (method: string, params: object = {}) => client.call(method, { root, ...params }),
    async restart(restoreState = true, changed = false) {
      client.close();
      await svc.close();
      if (changed) writeFileSync(join(root, ".archer/flow.mmd"), "flowchart LR\n a[Updated customer] e1@--> b[Shop]\n");
      svc = await startService({
        forceHttp: true,
        env: {
          HOME: dir,
          XDG_CONFIG_HOME: join(dir, ".config"),
          ARCHER_CONFIG: configPath,
          ARCHER_OPEN_BROWSER: "never",
        },
        stateDir: state,
        socketPath: join(state, "archer.sock"),
        pagePath: testPage(),
        restoreState,
        log: () => {},
      });
      client = await connectService(svc.socketPath);
      const before = url;
      url = restoreState ? (await attachOnceOpen()).url : svc.homeUrl;
      if (url !== before) session = undefined;
    },
    async stop() {
      client.close();
      await svc.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("flow dots move after actual service restart and reload without republishing emphasis", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const server = await fixture();
  try {
    await server.call("present", { viewId: "flow" });
    await server.call("setEmphasis", {
      viewId: "flow",
      emphases: [
        {
          id: "remembered-flow",
          groups: [{ id: "request", label: "request", nodes: [], edges: ["e1"], style: "flow" }],
        },
      ],
    });
    await page.goto(server.url);
    const packet = page.locator('.archer-emph-chevrons[data-edge="e1"]');
    await expectChevronsMoving(packet);
    await server.restart();
    await page.goto(server.url);
    await expectChevronsMoving(packet);
    await page.reload();
    await expectChevronsMoving(packet);
  } finally {
    await server.stop();
  }
});
test("fresh page renders restored agent selection after actual service restart", async ({ page }) => {
  const server = await fixture();
  try {
    await server.call("present", { viewId: "flow", annotation: "Remember customer" });
    await server.call("setEmphasis", {
      viewId: "flow",
      emphases: [
        {
          id: "remembered",
          title: "Remembered emphasis",
          groups: [{ id: "customer", label: "customer", nodes: ["a"], edges: [], style: "highlight" }],
        },
      ],
    });
    await page.goto(server.url);
    const customer = page.locator('.react-flow__node[data-id="a"]');
    await expect(customer).toBeVisible();
    await page.getByRole("button", { name: "Select mode", exact: true }).click();
    await customer.click();
    await expect
      .poll(async () => ((await server.call("getContext")).selection?.nodes ?? []).map((n: { id: string }) => n.id))
      .toEqual(["a"]);
    await server.restart();
    await page.goto(server.url);
    await expect(customer).toBeVisible();
    await expect(customer).toHaveClass(/selected/);
    await expect(page.getByText("Remember customer", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Remembered emphasis" })).toBeVisible();
    await page.screenshot({ path: "/tmp/archer-hydration-desktop.png" });
  } finally {
    await server.stop();
  }
});
for (const withAgent of [true, false])
  test(`reader selection restores its view with agent=${withAgent}`, async ({ page }) => {
    const server = await fixture();
    try {
      if (withAgent) await server.call("present", { viewId: "flow", annotation: "Agent stays on Flow" });
      if (!withAgent) await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(server.url);
      await openFile(page, { name: "Other" });
      const reader = page.locator('.react-flow__node[data-id="x"]');
      await expect(reader).toBeVisible();
      await page.getByRole("button", { name: "Select mode", exact: true }).click();
      await reader.click();
      await expect
        .poll(async () => ((await server.call("getContext")).selection?.nodes ?? []).map((n: { id: string }) => n.id))
        .toEqual(["x"]);
      await server.restart();
      await page.goto(server.url);
      await expect(reader).toBeVisible();
      await expect(reader).toHaveClass(/selected/);
      expect((await server.call("getContext")).selection.presentationId).toBe("reader:other");
      expect((await server.call("getContext")).presentation?.viewId ?? null).toBe(withAgent ? "flow" : null);
      if (!withAgent) await page.screenshot({ path: "/tmp/archer-hydration-phone.png" });
    } finally {
      await server.stop();
    }
  });
test("offline source change drops stale rendered selection", async ({ page }) => {
  const server = await fixture();
  try {
    await server.call("present", { viewId: "flow" });
    await page.goto(server.url);
    const customer = page.locator('.react-flow__node[data-id="a"]');
    await expect(customer).toBeVisible();
    await page.getByRole("button", { name: "Select mode", exact: true }).click();
    await customer.click();
    await expect
      .poll(async () => ((await server.call("getContext")).selection?.nodes ?? []).map((n: { id: string }) => n.id))
      .toEqual(["a"]);
    await server.restart(true, true);
    await page.goto(server.url);
    await expect(customer).toBeVisible();
    await expect(customer).not.toHaveClass(/selected/);
    expect((await server.call("getContext")).selection).toBeNull();
  } finally {
    await server.stop();
  }
});
test("disabled restore shows empty home and preserves recovery for a later enabled restart", async ({ page }) => {
  const server = await fixture();
  try {
    await server.call("present", { viewId: "flow" });
    await page.goto(server.url);
    const customer = page.locator('.react-flow__node[data-id="a"]');
    await expect(customer).toBeVisible();
    await page.getByRole("button", { name: "Select mode", exact: true }).click();
    await customer.click();
    await expect
      .poll(async () => ((await server.call("getContext")).selection?.nodes ?? []).map((n: { id: string }) => n.id))
      .toEqual(["a"]);
    await server.restart(false);
    // The service's home link: all projects' page, which lists none.
    await page.goto(server.url);
    await expect.poll(() => new URL(page.url()).pathname).toBe("/projects/");
    const catalog = await page.request.get(new URL("/api/browser-projects", page.url()).href);
    expect(((await catalog.json()) as { projects: unknown[] }).projects).toEqual([]);
    await expect(page.locator(".react-flow__node")).toHaveCount(0);
    await server.restart();
    await page.goto(server.url);
    await expect(customer).toHaveClass(/selected/);
  } finally {
    await server.stop();
  }
});
test("reader navigation and selection beat an older initial bootstrap", async ({ page }) => {
  const server = await fixture();
  let release = () => {};
  try {
    await server.call("present", { viewId: "flow" });
    const response = await server.fetch("api/bootstrap"),
      snapshot = await response.json();
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/bootstrap", async (route) => {
      await gate;
      await route.fulfill({ json: snapshot });
    });
    const stream = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/api/events"));
    await page.goto(server.url, { waitUntil: "domcontentloaded" });
    await stream;
    await server.announceInventory();
    // The project breadcrumb opens its browser in this App. The sidebar's
    // global overview starts a new document with its own bootstrap instead.
    await page
      .getByRole("navigation", { name: "Breadcrumb", exact: true })
      .getByRole("button")
      .filter({ hasNotText: /^Projects$/ })
      .first()
      .click();
    await page
      .getByRole("region", { name: "Project documents", exact: true })
      .getByRole("button", { name: "Other updated", exact: true })
      .click();
    const reader = page.locator('.react-flow__node[data-id="x"]');
    await expect(reader).toBeVisible();
    await page.getByRole("button", { name: "Select mode", exact: true }).click();
    await reader.click();
    await expect
      .poll(async () => ((await server.call("getContext")).selection?.nodes ?? []).map((n: { id: string }) => n.id))
      .toEqual(["x"]);
    const recoveredResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith("/api/bootstrap"),
    );
    release();
    await recoveredResponse;
    await expect
      .poll(() =>
        page.evaluate(async () => {
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          return document.querySelector('.react-flow__node[data-id="x"]')?.classList.contains("selected");
        }),
      )
      .toBe(true);
    await expectCurrentFile(page, { name: "Other updated" });
    await expect(reader).toHaveClass(/selected/);
  } finally {
    release();
    await server.stop();
  }
});
test("stream reconnect keeps the reader's newer view and selection", async ({ page }) => {
  const server = await fixture();
  try {
    await page.addInitScript(() => {
      const Native = window.EventSource;
      window.EventSource = class extends Native {
        constructor(url: string | URL, options?: EventSourceInit) {
          super(url, options);
          (
            window as unknown as {
              archerStream: EventSource;
            }
          ).archerStream = this;
        }
      };
    });
    await server.call("present", { viewId: "flow" });
    await page.goto(server.url);
    await expect(page.locator('.react-flow__node[data-id="a"]')).toBeVisible();
    await openFile(page, { name: "Other" });
    const reader = page.locator('.react-flow__node[data-id="x"]');
    await expect(reader).toBeVisible();
    await page.getByRole("button", { name: "Select mode", exact: true }).click();
    await reader.click();
    await expect
      .poll(async () => ((await server.call("getContext")).selection?.nodes ?? []).map((n: { id: string }) => n.id))
      .toEqual(["x"]);
    await server.restart();
    await expect(page.locator('[data-connection="lost"]')).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                archerStream: EventSource;
              }
            ).archerStream.readyState,
        ),
      )
      .toBe(1);
    await expect(page.locator("[data-connection]")).toHaveCount(0);
    await expect(reader).toHaveClass(/selected/);
    await expectCurrentFile(page, { name: "Other" });
  } finally {
    await page.context().setOffline(false);
    await server.stop();
  }
});

test("a refused event stream reconnects automatically without reloading the page", async ({ page }) => {
  const server = await fixture();
  let attempts = 0;
  try {
    await server.call("present", { viewId: "flow" });
    await page.route("**/api/events", async (route) => {
      attempts++;
      if (attempts === 1) await route.fulfill({ status: 503, json: { error: { code: "too_many_connections" } } });
      else await route.continue();
    });
    await page.goto(server.url);
    await expect(page.locator('.react-flow__node[data-id="a"]')).toBeVisible();
    await expect.poll(() => attempts, { timeout: 10000 }).toBeGreaterThan(1);
    await expect(page.locator("[data-connection]")).toHaveCount(0);
    await server.call("present", { viewId: "other" });
    await expect(page.locator('.react-flow__node[data-id="x"]')).toBeVisible();
  } finally {
    await server.stop();
  }
});

test("incompatible backend keeps the drawing and explains why reconnect stopped", async ({ page }) => {
  const server = await fixture();
  try {
    await server.call("present", { viewId: "flow" });
    await page.goto(server.url);
    const customer = page.locator('.react-flow__node[data-id="a"]');
    await expect(customer).toBeVisible();
    await expect(page.locator("[data-connection]")).toHaveCount(0);
    await page.route("**/api/connection", (route) =>
      route.fulfill({
        json: {
          browserProtocolMajor: 2,
          supportedBrowserProtocolMajors: [2],
          serverEpoch: "e460ed61-dcb3-45db-9987-2f0192079dea",
          capabilities: [],
          applicationVersion: "2.0.0",
          semanticSchemaVersion: 2,
          heartbeatIntervalMs: 15000,
        },
      }),
    );
    await server.restart();
    await expect(page.locator('[data-connection="incompatible"]')).toContainText("compatible Archer version");
    await expect(customer).toBeVisible();
  } finally {
    await server.stop();
  }
});

test("offline restart retains the unsent comment and reconnects without navigation", async ({ page }) => {
  const server = await fixture();
  try {
    await server.call("present", { viewId: "flow" });
    await page.goto(server.url);
    const customer = page.locator('.react-flow__node[data-id="a"]');
    await expect(customer).toBeVisible();
    await expect(page.locator("[data-connection]")).toHaveCount(0);
    await page.getByRole("button", { name: "Select mode", exact: true }).click();
    await customer.click();
    await page.keyboard.press("c");
    const editor = page.getByRole("textbox", { name: "Comment", exact: true });
    await editor.fill("Keep this question through restart");
    await page.context().setOffline(true);
    await server.restart();
    await expect(page.locator('[data-connection="lost"]')).toBeVisible();
    await expect(editor).toHaveValue("Keep this question through restart");
    await page.getByRole("button", { name: "Add comment", exact: true }).click();
    await expect(editor).toHaveValue("Keep this question through restart");
    await page.context().setOffline(false);
    await expect(page.locator("[data-connection]")).toHaveCount(0);
    await expect(editor).toHaveValue("Keep this question through restart");
    await page.getByRole("button", { name: "Add comment", exact: true }).click();
    await expect(page.getByText("Keep this question through restart", { exact: true })).toHaveCount(1);
    await expect(customer).toHaveClass(/selected/);
  } finally {
    await page.context().setOffline(false);
    await server.stop();
  }
});

test("a legacy native event stream retries through a draining restart", async ({ page }) => {
  const server = await fixture();
  const { ProjectState } = await load("service/project-state.ts");
  const { connectService } = await load("service/client.ts");
  const originalOpen = ProjectState.open;
  const otherRoot = join(server.root, "../held-project");
  mkdirSync(join(otherRoot, ".archer"), { recursive: true });
  writeFileSync(join(otherRoot, "archer.toml"), "version = 1\n");
  let release = () => {};
  let entered = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admission = new Promise<void>((resolve) => {
    entered = resolve;
  });
  ProjectState.open = async (...args: unknown[]) => {
    if (args[0] === otherRoot) {
      entered();
      await gate;
    }
    return originalOpen.apply(ProjectState, args);
  };
  const attaching = await connectService(server.socketPath);
  let restart: Promise<void> | undefined;
  try {
    await server.call("present", { viewId: "flow" });
    await page.goto(server.url);
    await expect(page.locator('.react-flow__node[data-id="a"]')).toBeVisible();
    await page.evaluate(() => {
      const state = window as unknown as { legacyStream: EventSource; legacyOpens: number };
      state.legacyOpens = 0;
      state.legacyStream = new EventSource(
        location.pathname.replace(/^\/projects\/([^/]+)\/.*$/, "/p/$1/") + "api/events",
      );
      state.legacyStream.onopen = () => {
        state.legacyOpens++;
      };
    });
    await expect.poll(() => page.evaluate(() => (window as unknown as { legacyOpens: number }).legacyOpens)).toBe(1);
    const attach = attaching.call("attach", { root: otherRoot });
    await admission;
    restart = server.restart();
    // The old writer is held by a real admitted management operation.
    // Native EventSource must see an ordinary EOF and retry, rather than
    // receiving a terminal non-200 response during the drain.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { legacyOpens: number }).legacyOpens))
      .toBeGreaterThan(1);
    release();
    await attach;
    await restart;
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { legacyStream: EventSource }).legacyStream.readyState))
      .toBe(1);
    await expect(page.locator("[data-connection]")).toHaveCount(0);
  } finally {
    release();
    await restart;
    attaching.close();
    ProjectState.open = originalOpen;
    await page.evaluate(() => (window as unknown as { legacyStream?: EventSource }).legacyStream?.close());
    await server.stop();
  }
});

test("an agent correction after offline restart preserves the pending node comment and publishes it once", async ({
  page,
}, testInfo) => {
  const server = await fixture({ commentSubmission: "queued" });
  const observations: { stage: string; atMs: number; [key: string]: unknown }[] = [];
  const started = performance.now();
  const mark = (stage: string, details: Record<string, unknown> = {}) =>
    observations.push({ stage, atMs: performance.now() - started, ...details });
  let phase: "setup" | "initial-selection" | "reading" | "recovery" | "correction" | "publish" | "reload" = "setup";
  const consoleMessages: {
    phase: string;
    type: string;
    text: string;
    location: { url: string; lineNumber: number; columnNumber: number };
  }[] = [];
  const pageErrors: string[] = [],
    failedRequests: {
      requestPhase: string;
      failurePhase: string;
      method: string;
      url: string;
      error: string | null;
      responseStatus: number | null;
    }[] = [];
  const requestPhases = new WeakMap<object, string>(),
    failureObservations: Promise<void>[] = [];
  page.on("request", (request) => requestPhases.set(request, phase));
  page.on("console", (message) =>
    consoleMessages.push({ phase, type: message.type(), text: message.text(), location: message.location() }),
  );
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    const observed = {
      requestPhase: requestPhases.get(request) ?? "unknown",
      failurePhase: phase,
      method: request.method(),
      url: request.url(),
      error: request.failure()?.errorText ?? null,
    };
    failureObservations.push(
      request.response().then((response) => {
        failedRequests.push({ ...observed, responseStatus: response?.status() ?? null });
      }),
    );
  });
  let app:
    | {
        call: (name: string, args: Record<string, unknown>) => Promise<{ structured: Record<string, unknown> }>;
        close: () => void;
      }
    | undefined;
  try {
    const note =
      "---\nstatus: proposed\ndiagrams: [../flow.mmd]\n---\n# Retention\nKeep the documented decision uncertain: 37 days.\n";
    mkdirSync(join(server.root, ".archer/notes"));
    writeFileSync(join(server.root, ".archer/notes/policy.md"), note);
    const source = "%% Preserve this source comment.\nflowchart LR\n a[Customer] e1@--> b[Shop]\n";
    writeFileSync(join(server.root, ".archer/flow.mmd"), source);
    const otherSource = readFileSync(join(server.root, ".archer/other.mmd"), "utf8");
    await server.call("present", { viewId: "flow" });
    const existingResponse = await server.fetch("api/comments", {
      method: "POST",
      headers: { "content-type": "application/json", origin: new URL(server.url).origin },
      body: JSON.stringify(
        commentOperation.create({
          target: "view:flow",
          anchor: { kind: "view" },
          body: "Existing discussion must survive correction",
        }),
      ),
    });
    expect(existingResponse.ok).toBe(true);
    const draftThread = (await existingResponse.json()).thread;
    const existingSubmit = await server.fetch("api/comments/submit", {
      method: "POST",
      headers: { "content-type": "application/json", origin: new URL(server.url).origin },
      body: JSON.stringify(commentOperation.submit({ target: "view:flow", threadId: draftThread.id })),
    });
    expect(existingSubmit.ok).toBe(true);
    const existingList = await server.fetch("api/comments?target=view%3Aflow");
    expect(existingList.ok).toBe(true);
    const existingThread = (await existingList.json()).threads[0];
    const originalUrl = server.url;
    phase = "initial-selection";
    mark("page-request", { url: originalUrl });
    await page.goto(originalUrl);
    const customer = page.locator('.react-flow__node[data-id="a"]');
    await expect(customer).toContainText("Customer");
    await expect(page.locator("[data-connection]")).toHaveCount(0);
    // The legacy link lands on the clean follow address; reconnecting never moves the page off it.
    const landedUrl = page.url();
    await page.getByRole("button", { name: "Select mode", exact: true }).click();
    await customer.click();
    await expect
      .poll(async () => (await server.call("getContext")).selection?.nodes.map((node: { id: string }) => node.id))
      .toEqual(["a"]);
    phase = "reading";
    mark("initial-selection-accepted");
    await page.keyboard.press("c");
    const editor = page.getByRole("textbox", { name: "Comment", exact: true });
    const question = "Does this corrected customer label preserve the same request?";
    await editor.fill(question);
    mark("pending-draft-created");
    phase = "recovery";
    mark("intentional-disconnect");
    await page.context().setOffline(true);
    mark("restart-requested");
    await server.restart();
    mark("restart-returned", { url: server.url });
    expect(server.url).toBe(originalUrl);
    await expect(page.locator('[data-connection="lost"]')).toBeVisible();
    await expect(editor).toHaveValue(question);
    mark("intentional-reconnect");
    await page.context().setOffline(false);
    await expect(page.locator("[data-connection]")).toHaveCount(0);
    await expect(editor).toHaveValue(question);
    expect(page.url()).toBe(landedUrl);
    mark("reconnected");
    phase = "correction";
    mark("correction-started");

    const { createApplication } = await load("application/index.ts"),
      { connectService } = await load("service/client.ts");
    app = createApplication({
      cwd: server.root,
      ensureService: () => connectService(server.socketPath),
      findService: () => connectService(server.socketPath),
    });
    mark("agent-read-requested");
    const read = await app!.call("read_diagram", { viewId: "flow" });
    mark("agent-read-returned", { sourceRevision: read.structured.sourceRevision });
    expect(read.structured.source).toMatchObject({ status: "text", text: source });
    const correctedSource = source.replace("a[Customer]", "a[Verified customer]");
    mark("agent-write-requested");
    const written = await app!.call("write_diagram", {
      viewId: "flow",
      source: correctedSource,
      expectedRevision: read.structured.sourceRevision,
      summary: "Correct the customer label while preserving its stable identity.",
    });
    mark("agent-write-returned", { sourceRevision: written.structured.sourceRevision });
    expect(written.structured.status).toBe("compiled");
    expect(written.structured.sourceRevision).not.toBe(read.structured.sourceRevision);
    await expect(customer).toContainText("Verified customer");
    await expect
      .poll(async () => (await server.call("getContext")).selection?.revision)
      .toBe(written.structured.sourceRevision);
    expect((await server.call("getContext")).selection.nodes.map((node: { id: string }) => node.id)).toEqual(["a"]);
    await expect(editor).toHaveValue(question);
    mark("corrected-source-rendered", { revision: written.structured.sourceRevision });
    phase = "publish";
    expect(readFileSync(join(server.root, ".archer/flow.mmd"), "utf8")).toBe(correctedSource);
    expect(readFileSync(join(server.root, ".archer/other.mmd"), "utf8")).toBe(otherSource);
    expect(readFileSync(join(server.root, ".archer/notes/policy.md"), "utf8")).toBe(note);

    const readThreads = async () => {
      const response = await server.fetch("api/comments?target=view%3Aflow");
      expect(response.ok).toBe(true);
      return (await response.json()).threads as {
        id: string;
        status: string;
        anchor: { kind: string; id?: string };
        comments: { body: string }[];
      }[];
    };
    expect(await readThreads()).toEqual([existingThread]);
    let creationRequests = 0,
      submitRequests = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/comments")) creationRequests++;
      if (request.method() === "POST" && request.url().endsWith("/api/comments/submit")) submitRequests++;
    });
    mark("draft-save-requested");
    await page.getByRole("button", { name: "Add comment", exact: true }).click();
    await expect(page.getByText(question, { exact: true })).toHaveCount(1);
    await expect
      .poll(
        async () =>
          (await readThreads()).filter((thread) => thread.comments.some((comment) => comment.body === question)).length,
      )
      .toBe(1);
    mark("draft-publish-requested");
    await page
      .getByRole("region", { name: "Contextual discussion", exact: true })
      .getByRole("button", { name: "Send queued comments (1)", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await readThreads()).find((thread) => thread.comments.some((comment) => comment.body === question))?.status,
      )
      .toBe("sent");
    const threads = await readThreads(),
      finalThread = threads.find((thread) => thread.comments.some((comment) => comment.body === question))!;
    expect(finalThread.anchor).toMatchObject({ kind: "node", id: "a" });
    expect(finalThread.status).toBe("sent");
    expect(threads.find((thread) => thread.id === existingThread.id)).toEqual(existingThread);
    expect(threads).toHaveLength(2);
    expect(creationRequests).toBe(1);
    expect(submitRequests).toBe(1);
    mark("draft-persisted-once", { threadId: finalThread.id, anchor: finalThread.anchor });
    phase = "reload";
    await page.reload();
    await expect(customer).toContainText("Verified customer");
    await expect(customer).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(async () => (await server.call("getContext")).selection?.nodes.map((node: { id: string }) => node.id))
      .toEqual(["a"]);
    await expect
      .poll(async () => (await server.call("getContext")).selection?.revision)
      .toBe(written.structured.sourceRevision);
    mark("reloaded-selection-accepted", { revision: written.structured.sourceRevision, nodes: ["a"] });
    expect(
      (await readThreads()).filter((thread) => thread.comments.some((comment) => comment.body === question)),
    ).toHaveLength(1);
    expect(creationRequests).toBe(1);
    expect(submitRequests).toBe(1);
    // Only the deliberately interrupted service stream is expected to log an error, and, while the
    // context is offline on purpose, the browser's own line for a reconnect check it could not send
    // (how many depends on how long the restart takes on a loaded host).
    const offlineCheck = (url: string, error: string | null | undefined) =>
      url === landedUrl.replace(/\/projects\/([^/]+)\/.*$/, "/p/$1/api/connection") &&
      /ERR_INTERNET_DISCONNECTED/.test(error ?? "");
    // A dropped event stream reconnects without a console line (G12), so only the offline check is expected.
    const unexpectedConsoleErrors = consoleMessages.filter(
      (message) =>
        message.type === "error" && !(message.phase === "recovery" && offlineCheck(message.location.url, message.text)),
    );
    await Promise.all(failureObservations);
    // The event stream the page reopened after recovery is still open when this test reloads the page, and
    // a reload aborts it. The Chromium of Playwright 1.65 reports that answered stream as a failed request;
    // 1.63's did not (O277). Exactly one such stream is expected: a second would be a stream the page leaked.
    const reloadAbortOfRecoveryStream = failedRequests.find(
      (request) =>
        request.requestPhase === "recovery" &&
        request.failurePhase === "reload" &&
        request.method === "GET" &&
        request.error === "net::ERR_ABORTED" &&
        request.responseStatus === 200 &&
        request.url === landedUrl.replace(/\/projects\/([^/]+)\/.*$/, "/p/$1/api/events"),
    );
    // This Chromium run reports ERR_ABORTED for selection POSTs that received HTTP 204.
    // See [attached observations](correction-restart-stage-observations.json); service-accepted selections are asserted above.
    const unexpectedFailedRequests = failedRequests.filter(
      (request) =>
        !(
          ["initial-selection", "recovery", "correction", "reload"].includes(request.requestPhase) &&
          request.method === "POST" &&
          request.url === landedUrl.replace(/\/projects\/([^/]+)\/.*$/, "/p/$1/api/selection") &&
          request.error === "net::ERR_ABORTED" &&
          request.responseStatus === 204
        ) &&
        !(request.failurePhase === "recovery" && offlineCheck(request.url, request.error)) &&
        // The page closes its own event stream when the browser says it is offline (O68), which Chromium
        // reports as an aborted request, or as disconnected when the network's own failure came first (O75);
        // the reconnect without reload is asserted above.
        !(
          request.failurePhase === "recovery" &&
          request.method === "GET" &&
          /ERR_ABORTED|ERR_INTERNET_DISCONNECTED/.test(request.error ?? "") &&
          request.url === landedUrl.replace(/\/projects\/([^/]+)\/.*$/, "/p/$1/api/events")
        ) &&
        request !== reloadAbortOfRecoveryStream,
    );
    expect(unexpectedConsoleErrors, "unexpected browser console errors").toEqual([]);
    expect(unexpectedFailedRequests, "unexpected browser request failures").toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally {
    const observationPath = testInfo.outputPath("correction-restart-stage-observations.json");
    writeFileSync(
      observationPath,
      JSON.stringify(
        {
          clock: "performance.now, milliseconds since fixture ready",
          observations,
          consoleMessages,
          pageErrors,
          failedRequests,
        },
        null,
        2,
      ),
    );
    await testInfo.attach("correction-restart-stage-observations", {
      path: observationPath,
      contentType: "application/json",
    });
    app?.close();
    await page.context().setOffline(false);
    await page.close();
    await server.stop();
  }
});
