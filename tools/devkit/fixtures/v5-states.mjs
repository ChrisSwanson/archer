/** V5 boundary states. Every opening owns a new sandbox; no supplied target is stopped or changed.
 * Uses an existing page build (ARCHER_UI_STATES_PAGE overrides ui/dist/index.html); never builds.
 * Offline ends an already-open native SSE request. Loading holds real browser requests until leave.
 * Read-only is project edit=false: --reader alone is an ordinary admitted link, not an edit boundary.
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { expect } from "@playwright/test";
import { REPO, up, down, issueLink, copyCorpusProject } from "../sandbox.mjs";

const leases = new WeakMap();
export const V5_STATES = [
  ["P3.offline", "P3", "Note reader, existing event stream disconnected"],
  ["P7.offline", "P7", "Project review, existing event stream disconnected"],
  ["P7.loading", "P7", "Project review, initial comment activity request pending"],
  ["P11.loading", "P11", "Revision compare, history request pending"],
  ["P4.read-only", "P4", "Diagram page, project editing disabled"],
].map(([id, surface, label]) => ({ id, surface, label, open: (page) => openV5State(page, id), leave: leaveV5State }));

export async function leaveV5State(page) {
  const lease = leases.get(page);
  if (!lease) return;
  await lease.close();
  leases.delete(page);
}

/** Release held reads without leaving, so callers can verify that real data replaces loading. */
export async function releaseV5Requests(page) {
  await leases.get(page)?.release();
}

async function openV5State(page, id) {
  await leaveV5State(page);
  const scratch = mkdtempSync(join(tmpdir(), "archer-f23-v5-"));
  const corpus = join(scratch, "pageturner");
  copyCorpusProject(join(REPO, "tools/devkit/corpus/pageturner"), corpus);
  if (id === "P4.read-only") {
    const config = join(corpus, "archer.toml");
    writeFileSync(config, `edit = false\n${readFileSync(config, "utf8")}`);
  }
  let sandbox,
    stopped = false,
    closing,
    release = async () => {};
  const disposers = [];
  const onPageClose = () => {
    void close().catch(() => {});
  };
  const close = () =>
    (closing ??= (async () => {
      page.off("close", onPageClose);
      try {
        await release();
      } finally {
        for (const dispose of disposers) dispose();
        try {
          if (sandbox && !stopped) {
            await down({ name: sandbox.name });
            stopped = true;
          }
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
      }
    })());
  leases.set(page, { close, release: () => release() });
  page.once("close", onPageClose);
  try {
    const previous = process.env.ARCHER_WRITERS_DIR;
    process.env.ARCHER_WRITERS_DIR = join(scratch, "writers");
    try {
      sandbox = await up({
        name: `f23-v5-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
        corpus,
        page: resolve(process.env.ARCHER_UI_STATES_PAGE ?? join(REPO, "ui/dist/index.html")),
      });
    } finally {
      if (previous === undefined) delete process.env.ARCHER_WRITERS_DIR;
      else process.env.ARCHER_WRITERS_DIR = previous;
    }
    const project = sandbox.projects[0];
    const evidence = {
      sandboxName: sandbox.name,
      origin: sandbox.origin,
      projectRoot: project.root,
      page: sandbox.page,
    };
    const link = issueLink({ name: sandbox.name, reader: true, label: `F23 ${id}` });
    // Log in via the request context: no disposable app document can start extra reads or streams.
    const login = await page.request.get(link.url, { maxRedirects: 0 });
    if (login.status() >= 400) throw new Error(`fixture login answered ${login.status()}`);
    let held = [],
      completedWhileHeld = 0;
    if (id.endsWith("loading")) {
      let resume;
      const gate = new Promise((resolveGate) => {
        resume = resolveGate;
      });
      const matches = (url) =>
        url.origin === sandbox.origin &&
        (id === "P7.loading"
          ? url.pathname.endsWith("/api/comment-activity")
          : url.pathname.endsWith("/api/operations"));
      const handler = async (route) => {
        held.push(route.request().url());
        await gate;
        await route.continue().catch(() => {});
      };
      const onResponse = (response) => {
        if (matches(new URL(response.url()))) completedWhileHeld++;
      };
      await page.route(matches, handler);
      page.on("response", onResponse);
      release = async () => {
        page.off("response", onResponse);
        resume();
        await page.unroute(matches, handler).catch(() => {});
      };
    }
    let streamResponse,
      streamRequest,
      dropped = false;
    if (id.endsWith("offline")) {
      // Observe native EventSource events; no synthetic event or connection state is dispatched.
      await page.addInitScript(() => {
        const Native = window.EventSource;
        window.__devkitV5Streams = [];
        window.EventSource = class extends Native {
          constructor(...args) {
            super(...args);
            const record = { source: this, opened: false, errors: 0 };
            window.__devkitV5Streams.push(record);
            this.addEventListener("open", () => {
              record.opened = true;
            });
            this.addEventListener("error", () => {
              record.errors++;
            });
          }
        };
      });
      streamResponse = page.waitForResponse(
        (response) => new URL(response.url()).pathname.endsWith("/api/events") && response.status() === 200,
        { timeout: 15000 },
      );
      const onEnd = (request) => {
        if (request === streamRequest) dropped = true;
      };
      page.on("requestfinished", onEnd);
      page.on("requestfailed", onEnd);
      disposers.push(() => {
        page.off("requestfinished", onEnd);
        page.off("requestfailed", onEnd);
      });
    }
    const file = id === "P3.offline" ? "notes/scenario-declined-card.md" : "diagrams/fulfilment.mmd";
    await page.goto(`${sandbox.origin}/projects/${project.slug}/${file}`, { waitUntil: "domcontentloaded" });
    if (id === "P3.offline") await page.getByText(/^Amira has two books/).waitFor({ timeout: 15000 });
    else await page.locator(".react-flow__node").first().waitFor({ timeout: 15000 });
    if (id.startsWith("P7.")) {
      const panel = page.getByRole("region", { name: "Project Review", exact: true });
      if (!(await panel.isVisible()))
        await page
          .getByRole("button", { name: /^Notifications\b/ })
          .first()
          .click({ timeout: 5000 });
      await panel.waitFor({ state: "visible", timeout: 10000 });
    }
    if (id === "P11.loading") {
      await page.getByRole("button", { name: /^(Export, compare and more|Graph tools)$/ }).click({ timeout: 5000 });
      await page.getByRole("button", { name: "Compare revisions", exact: true }).click({ timeout: 5000 });
      await page.getByLabel("From commit", { exact: true }).fill("HEAD", { timeout: 5000 });
      await page.getByRole("button", { name: "Compare", exact: true }).click({ timeout: 5000 });
      await page
        .getByRole("status")
        .filter({ hasText: "Reading committed diagram history" })
        .waitFor({ timeout: 10000 });
    }
    if (id.endsWith("loading")) {
      await expect.poll(() => held.length, { timeout: 10000 }).toBeGreaterThan(0);
      evidence.pendingRequests = held;
      evidence.completedWhileHeld = completedWhileHeld;
      const region =
        id === "P7.loading"
          ? page.getByRole("region", { name: "Project Review", exact: true })
          : page.locator(".accuracy-compare");
      evidence.loadingCue = await region.evaluate((el) => ({
        text: el.innerText,
        busy: el.getAttribute("aria-busy"),
        live: [...el.querySelectorAll('[role="status"],[aria-live],[aria-busy="true"]')].map(
          (node) => node.textContent,
        ),
      }));
    }
    if (id.endsWith("offline")) {
      const response = await streamResponse;
      streamRequest = response.request();
      await page.waitForFunction(
        () => window.__devkitV5Streams.some((record) => record.opened && record.source.readyState === 1),
        null,
        { timeout: 10000 },
      );
      const stream = { status: response.status(), contentType: response.headers()["content-type"], opened: true };
      await down({ name: sandbox.name });
      stopped = true;
      await expect.poll(() => dropped, { timeout: 10000 }).toBe(true);
      await page.waitForFunction(
        () =>
          window.__devkitV5Streams.some(
            (record) => record.opened && record.errors > 0 && record.source.readyState !== 1,
          ),
        null,
        { timeout: 10000 },
      );
      // Record the shipped cue separately from fixture reachability. P3 may retain its note
      // without exposing connection status; that is a product finding, not a failed disconnect.
      if (id === "P7.offline")
        await page
          .getByText(/Reconnecting/)
          .first()
          .waitFor({ timeout: 15000 });
      evidence.reconnectingVisible = await page
        .getByText(/Reconnecting/)
        .first()
        .isVisible();
      evidence.stream = { ...stream, dropped, nativeError: true };
      evidence.serviceStopped = true;
    }
    if (id === "P4.read-only") {
      const grants = JSON.parse(readFileSync(join(sandbox.stateDir, "authoring-grants.json"), "utf8"));
      evidence.grantHasAuthoringRoots = grants.entitlements.some((e) => e.grantId === link.id);
      const response = await page.request.get(`${sandbox.origin}/p/${project.slug}/api/authoring`);
      evidence.capabilities = await response.json();
      // Desktop shows Edit, disabled. A phone width has no Edit at all (editing is desktop-only, EX-R1-02):
      // record that instead of waiting for a control that is never drawn.
      const edit = page.getByRole("button", { name: "Edit", exact: true });
      if ((await edit.count()) > 0) {
        await expect(edit).toHaveAttribute("aria-disabled", "true");
        evidence.edit = "disabled";
      } else {
        evidence.edit = "absent (narrow width, EX-R1-02)";
      }
      if (evidence.capabilities?.edit?.enabled !== false)
        throw new Error("P4.read-only: the service still reports editing enabled");
    }
    return { evidence };
  } catch (error) {
    await leaveV5State(page);
    throw error;
  }
}
