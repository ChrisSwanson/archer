import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { STATES, openState, leaveState } from "../harness/surfaces.mjs";
import { readRecord } from "../sandbox.mjs";
import { releaseV5Requests } from "../fixtures/v5-states.mjs";

let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});
// An unusable primary target ensures the recipe cannot stop or mutate a supplied sandbox.
const target = {
  origin: "http://unused.invalid",
  login: "http://unused.invalid/",
  slug: "unused",
  projects: [],
  source: "existing",
};
const ids = ["P3.offline", "P7.offline", "P7.loading", "P11.loading", "P4.read-only"];
for (const id of ids)
  test(`F23 ${id}: real isolated state, evidence and cleanup`, { timeout: 60000 }, async (t) => {
    const state = STATES.find((s) => s.id === id);
    assert.ok(state, `${id} must be wired into surfaces.mjs`);
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    let name;
    try {
      const opened = await openState(page, state, target);
      if (!opened.ok) t.diagnostic(await page.locator("body").innerText());
      assert.equal(opened.ok, true, JSON.stringify(opened));
      const e = opened.evidence;
      name = e.sandboxName;
      assert.match(name, /^f23-v5-/);
      assert.equal(new URL(page.url()).origin, e.origin);
      assert.notEqual(e.origin, target.origin);
      if (id.endsWith("offline")) {
        assert.equal(e.stream.status, 200);
        assert.match(e.stream.contentType, /text\/event-stream/);
        assert.equal(e.stream.opened, true, "a native SSE connection was open before stopping");
        assert.equal(e.stream.dropped, true, "that existing SSE request finished or failed");
        assert.equal(e.stream.nativeError, true);
        assert.equal(e.serviceStopped, true);
        if (id === "P3.offline") await expect(page.getByText(/^Amira has two books/)).toBeVisible();
        else {
          await expect(page.getByText(/Reconnecting/).first()).toBeVisible();
          await expect(page.getByRole("region", { name: "Project Review", exact: true })).toBeVisible();
        }
      } else if (id.endsWith("loading")) {
        assert.ok(e.pendingRequests.length > 0, "a real page request must be held");
        assert.equal(e.completedWhileHeld, 0);
        if (id === "P11.loading") {
          assert.match(e.pendingRequests[0], /api\/operations/);
          await expect(page.getByRole("status").filter({ hasText: "Reading committed diagram history" })).toBeVisible();
          await expect(page.locator(".accuracy-result")).toHaveAttribute("aria-busy", "true");
        } else {
          assert.ok(e.pendingRequests.some((url) => /comment-activity/.test(url)));
          await expect(page.getByRole("region", { name: "Project Review", exact: true })).toBeVisible();
          const panel = await page.getByRole("region", { name: "Project Review", exact: true }).boundingBox();
          assert.ok(
            panel.x + panel.width <= (await page.evaluate(() => innerWidth)) + 1,
            "loading fixture must finish opening its sidebar before measurement",
          );
        }
        const response = page.waitForResponse((r) => e.pendingRequests.includes(r.url()), { timeout: 10000 });
        await releaseV5Requests(page);
        assert.equal((await response).status(), 200, "release continues to the real service");
        if (id === "P11.loading") await expect(page.locator(".accuracy-result")).toHaveAttribute("aria-busy", "false");
      } else {
        assert.equal(e.capabilities.authorized, true);
        assert.deepEqual(e.capabilities.edit, { enabled: false, reason: "project" });
        assert.equal(e.grantHasAuthoringRoots, false);
        const edit = page.getByRole("button", { name: "Edit", exact: true });
        await expect(edit).toHaveAttribute("aria-disabled", "true");
        await edit.focus();
        await page.keyboard.press("Enter");
        await expect(page.locator(".authoring-workspace")).toHaveCount(0);
        const base = `${e.origin}/p/pageturner/api/authoring`;
        const openedDoc = await page.request.post(`${base}/open`, {
          headers: { origin: e.origin },
          data: { target: { kind: "view", viewId: "fulfilment" } },
        });
        assert.equal(openedDoc.status(), 200);
        const doc = await openedDoc.json();
        const file = join(e.projectRoot, ".archer/diagrams/fulfilment.mmd");
        const original = readFileSync(file, "utf8");
        const saved = await page.request.post(base, {
          headers: { origin: e.origin },
          data: {
            op: "document.apply",
            target: { kind: "view", viewId: "fulfilment" },
            source: original.replace("flowchart", "graph"),
            expectedSourceRevision: doc.sourceRevision,
            expectedTargetRevision: doc.targetRevision,
            operationId: randomBytes(16).toString("hex"),
            journalGeneration: e.capabilities.generation,
            intent: "F23 refusal probe",
          },
        });
        assert.equal(saved.status(), 403);
        assert.equal((await saved.json()).error.code, "editing_disabled");
        assert.equal(readFileSync(file, "utf8"), original);
      }
      t.diagnostic(JSON.stringify({ id, evidence: e }));
    } finally {
      await leaveState(page, state);
      await context.close();
    }
    assert.equal(readRecord(name), null, "throwaway sandbox removed after leaving");
  });

// Packet 6: P4.read-only errored at 390 and 320, where the header has no Edit (editing is desktop-only,
// EX-R1-02). The recipe must still prove the project is read-only there and record Edit as absent.
test("F28 P4.read-only at a phone width: read-only proven, Edit recorded absent", { timeout: 60000 }, async () => {
  const state = STATES.find((s) => s.id === "P4.read-only");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  try {
    const opened = await openState(page, state, target);
    assert.equal(opened.ok, true, JSON.stringify(opened));
    assert.equal(opened.evidence.capabilities.edit.enabled, false);
    assert.match(opened.evidence.edit, /^absent/);
  } finally {
    await leaveState(page, state).catch(() => {});
    await context.close();
  }
});
