// Exercise the same fresh copy, Git baseline and service APIs as `sandbox up`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { REPO, up, down } from "../sandbox.mjs";

const NOTE = "notes/0001-hosted-payment-page.md";
test("F15: a fresh sandbox exposes replay, stale coverage, highlights and unread discussion fixtures", {
  timeout: 120_000,
}, async (t) => {
  const name = `f15-corpus-${process.pid}`;
  const scratch = mkdtempSync(join(tmpdir(), "f15-corpus-page-"));
  const page = join(scratch, "index.html");
  writeFileSync(page, "<!doctype html><title>API fixture test</title>");
  try {
    const sandbox = await up({ name, corpus: join(REPO, "tools/devkit/corpus/pageturner"), page });
    t.after(() => down({ name }));
    const login = await fetch(sandbox.link, { redirect: "manual" });
    const cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const base = `${sandbox.origin}/p/${sandbox.projects[0].slug}/api/`;
    async function api(path, body) {
      const res = await fetch(base + path, {
        headers: { cookie, origin: sandbox.origin, "content-type": "application/json" },
        ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
      });
      assert.equal(res.status, 200, `${path}: ${await res.clone().text()}`);
      return res.json();
    }
    await t.test("walkthrough has several current steps and a playable message step", async () => {
      const replay = await api("walkthroughs?viewId=containers");
      const walk = replay.walkthroughs.find((w) => w.id === "checkout-tour");
      assert.ok(walk, "a saved walkthrough is discoverable");
      assert.ok(walk.steps.length >= 4);
      assert.ok(
        walk.steps.some((s) => s.messages?.length > 0),
        "Sequence mode has a message to play",
      );
      assert.equal(replay.resolution.find((r) => r.id === walk.id).status, "current");
      assert.deepEqual(replay.deadCode, []);
    });
    await t.test("covered source really changed after the diagram Git baseline", async () => {
      const stale = await api("operations", { name: "list_stale_diagrams", arguments: { viewId: "containers" } });
      const view = stale.views.find((v) => v.viewId === "containers");
      assert.equal(view.status, "stale");
      assert.match(view.baselineCommit, /^[a-f0-9]{40}$/);
      assert.deepEqual(view.changedPaths, [{ path: "shop/orders.ts", status: "modified" }]);
    });
    await t.test("diagram highlight groups are present", async () => {
      const highlighted = await api("emphasis/containers");
      assert.ok(
        highlighted.emphases.some((e) => e.groups.length >= 2),
        "Members has groups to inspect",
      );
    });
    await t.test("grounded note passage highlights are present", async () => {
      const note = await api(`note-emphases?path=${encodeURIComponent(NOTE)}`);
      assert.ok(note.snapshot.emphases.length > 0);
      assert.deepEqual(note.orphans, []);
    });
    await t.test("a fresh browser has an agent answer to mark read and a note discussion to open", async () => {
      const note = await api(`comments?target=${encodeURIComponent(`note:${NOTE}`)}`);
      assert.ok(
        note.threads.some(
          (thread) => thread.status === "answered" && thread.comments.some((c) => c.author === "agent"),
        ),
        "agent answers are unread before this browser records seeing them",
      );
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
