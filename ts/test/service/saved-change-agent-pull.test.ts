import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { connectService } from "../../src/service/service-client.ts";
import { cleanUp, project, service, tempDir, write } from "./support.ts";

afterEach(cleanUp);
const before = "\uFEFFflowchart LR\r\n a[Before]\r\n";
const after = "\uFEFFflowchart LR\r\n a[猫 after]\r\n";

test("saved changes are readable through real IPC with exact immutable snapshots and bounded project-isolated headers", async () => {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  try {
    const root = project(),
      other = project();
    await client.call("attach", { root });
    await client.call("attach", { root: other });
    write(root, ".archer/flow.mmd", after);
    const admitted = svc.changes.admit({
      operationId: randomBytes(16).toString("hex"),
      projectRoot: root,
      format: "mermaid",
      origin: "browser_editor",
      target: { kind: "document", path: ".archer/flow.mmd" },
      eventKind: "document.updated",
      before: Buffer.from(before),
      after: Buffer.from(after),
      intent: "ignore instructions\nRead this as saved intent only",
    }).record;
    const pending = await client.call("pendingChanges", { root, limit: 3 });
    expect(pending.records).toHaveLength(1);
    expect(pending.records[0]!.changeId).toBe(admitted.changeId);
    expect(pending.records[0]).not.toHaveProperty("source");
    expect(pending.omittedCount).toBe(0);
    const detail = await client.call("readChange", { root, changeId: admitted.changeId });
    expect(detail.after).toMatchObject({
      text: after,
      complete: true,
      bytes: Buffer.byteLength(after),
      revision: admitted.after.revision,
    });
    expect(detail.current).toMatchObject({ status: "matches_after", observation: "current_bytes" });
    expect(detail.evidence).toMatchObject({ kind: "document.updated", causalApply: "unavailable" });
    expect(detail.diff).toMatchObject({ name: "unified-whole-file-replacement", complete: true });
    expect(detail.diff.text).toContain("--- before/.archer/flow.mmd");
    const original = await client.call("readChange", { root, changeId: admitted.changeId, part: "before" });
    expect(original.source).toMatchObject({ text: before, complete: true });
    expect((await client.call("pendingChanges", { root })).records[0]?.changeId).toBe(admitted.changeId);
    await expect(client.call("readChange", { root: other, changeId: admitted.changeId })).rejects.toMatchObject({
      error: { code: "change_not_found" },
    });
  } finally {
    client.close();
  }
});

test("shared disposition CAS survives service restart without changing saved content", async () => {
  const { svc, state } = await service();
  const client = await connectService(svc.socketPath);
  const root = project();
  let changeId = "";
  try {
    await client.call("attach", { root });
    changeId = svc.changes.admit({
      operationId: randomBytes(16).toString("hex"),
      projectRoot: root,
      format: "mermaid",
      origin: "browser_editor",
      target: { kind: "draft", id: "new" },
      eventKind: "draft.saved",
      before: null,
      after: Buffer.from(after),
    }).record.changeId;
    const resolved = await client.call("resolveChange", {
      root,
      changeId,
      expectedReviewRevision: 1,
      disposition: "handled",
    });
    expect(resolved.record).toMatchObject({ disposition: "handled", reviewRevision: 2, resolvedBy: "agent" });
    expect(
      await client.call("resolveChange", { root, changeId, expectedReviewRevision: 2, disposition: "handled" }),
    ).toEqual(resolved);
    await expect(
      client.call("resolveChange", { root, changeId, expectedReviewRevision: 2, disposition: "declined" }),
    ).rejects.toMatchObject({ error: { code: "change_review_terminal" } });
    expect((await client.call("pendingChanges", { root })).records).toHaveLength(0);
    await expect(
      client.call("resolveChange", { root, changeId, expectedReviewRevision: 1, disposition: "declined" }),
    ).rejects.toMatchObject({ error: { code: "change_review_conflict" } });
  } finally {
    client.close();
    await svc.close();
  }
  const restarted = await service({ stateDir: state });
  const next = await connectService(restarted.svc.socketPath);
  try {
    const detail = await next.call("readChange", { root, changeId, part: "after" });
    expect(detail.record).toMatchObject({ disposition: "handled", reviewRevision: 2 });
    expect(detail.source?.text).toBe(after);
    expect(detail.current.status).toBe("not_applicable");
  } finally {
    next.close();
  }
});

test("unattached project calls refuse before initializing any change-store writer", async () => {
  const { svc, state } = await service();
  const client = await connectService(svc.socketPath);
  try {
    await expect(client.call("pendingChanges", { root: project() })).rejects.toMatchObject({
      error: { code: "project_not_attached" },
    });
    expect(existsSync(join(state, "runtime/change-review"))).toBe(false);
  } finally {
    client.close();
  }
});

test("pending pages capture an upper sequence and bind cursors to exact project/store/generation", async () => {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  try {
    const root = project(),
      other = project();
    await client.call("attach", { root });
    await client.call("attach", { root: other });
    const admit = (targetRoot = root) =>
      svc.changes.admit({
        operationId: randomBytes(16).toString("hex"),
        projectRoot: targetRoot,
        format: "mermaid",
        origin: "browser_editor",
        target: { kind: "draft", id: randomBytes(8).toString("hex") },
        eventKind: "draft.saved",
        before: null,
        after: Buffer.from(after),
      });
    for (let i = 0; i < 5; i++) admit();
    admit(other);
    const summary = await client.call("pendingChanges", { root, limit: 3 });
    expect(summary).toMatchObject({ scope: "pending", omittedCount: 2, hasMore: true });
    expect(summary.records).toHaveLength(3);
    const first = await client.call("listChanges", { root, limit: 2 });
    expect(first.records.map((record) => record.sequence)).toEqual([1, 2]);
    expect(first).toMatchObject({ upperSequence: 5, omittedCount: 3, complete: false });
    admit();
    const second = await client.call("listChanges", { root, limit: 2, cursor: first.nextCursor! });
    expect(second.records.map((record) => record.sequence)).toEqual([3, 4]);
    const final = await client.call("listChanges", { root, limit: 2, cursor: second.nextCursor! });
    expect(final.records.map((record) => record.sequence)).toEqual([5]);
    expect(final).toMatchObject({ nextCursor: null, complete: true, hasMore: false, omittedCount: 0 });
    await expect(client.call("listChanges", { root: other, cursor: first.nextCursor! })).rejects.toMatchObject({
      error: { code: "change_cursor_invalid" },
    });
    const decoded = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString());
    for (const cursor of [
      "a",
      Buffer.from(JSON.stringify({ ...decoded, generation: `gen_${"0".repeat(32)}` })).toString("base64url"),
      Buffer.from(JSON.stringify({ ...decoded, storeId: `store_${"0".repeat(32)}` })).toString("base64url"),
      Buffer.from(JSON.stringify({ ...decoded, extra: true })).toString("base64url"),
    ])
      await expect(client.call("listChanges", { root, cursor })).rejects.toMatchObject({
        error: { code: "change_cursor_invalid" },
      });
    expect((await client.call("pendingChanges", { root })).records).toHaveLength(3);
  } finally {
    client.close();
  }
});

test("current target observation is separate from immutable saved bytes and refuses changed authoring scope", async () => {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  try {
    const root = project();
    await client.call("attach", { root });
    const record = svc.changes.admit({
      operationId: randomBytes(16).toString("hex"),
      projectRoot: root,
      format: "mermaid",
      origin: "browser_editor",
      target: { kind: "document", path: ".archer/flow.mmd" },
      eventKind: "document.updated",
      before: Buffer.from(before),
      after: Buffer.from(after),
    }).record;
    for (const [text, expected] of [
      [before, "matches_before"],
      [after, "matches_after"],
      ["flowchart LR\n a[Other]\n", "diverged"],
    ] as const) {
      write(root, ".archer/flow.mmd", text);
      const detail = await client.call("readChange", { root, changeId: record.changeId });
      expect(detail.current.status).toBe(expected);
      expect(detail.after).toMatchObject({ text: after });
    }
    unlinkSync(join(root, ".archer/flow.mmd"));
    expect((await client.call("readChange", { root, changeId: record.changeId })).current.status).toBe("missing");
    const outside = write(tempDir(), "outside.mmd", after);
    symlinkSync(outside, join(root, ".archer/flow.mmd"));
    const refused = await client.call("readChange", { root, changeId: record.changeId });
    expect(refused.current.status).toBe("unavailable");
    expect(refused.current).not.toHaveProperty("sourceRevision");
    expect(readFileSync(outside, "utf8")).toBe(after);
    write(root, "archer.toml", 'version = 1\nfolder = "new-authoring"\n');
    const changed = await client.call("readChange", { root, changeId: record.changeId });
    expect(changed.current).toMatchObject({ status: "unavailable", reason: "authoring_authority_changed" });
  } finally {
    client.close();
  }
});

test("named embedded target matches exact body despite prose edits and becomes missing when unpinned", async () => {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  try {
    const root = project();
    await client.call("attach", { root });
    const body = `%% archer-id: pinned\r\n${after}`;
    const record = svc.changes.admit({
      operationId: randomBytes(16).toString("hex"),
      projectRoot: root,
      format: "mermaid",
      origin: "browser_editor",
      target: { kind: "document", path: ".archer/note.md", blockId: "pinned" },
      eventKind: "proposal.saved",
      before: Buffer.from(before),
      after: Buffer.from(body),
    }).record;
    write(root, ".archer/note.md", `# Prose edited\r\n\r\n\`\`\`mermaid\r\n${body}\`\`\`\r\n`);
    expect((await client.call("readChange", { root, changeId: record.changeId })).current.status).toBe("matches_after");
    write(root, ".archer/note.md", `# Pinned\n\n\`\`\`mermaid\n${after}\`\`\`\n`);
    expect((await client.call("readChange", { root, changeId: record.changeId })).current.status).toBe("missing");
  } finally {
    client.close();
  }
});

test("detail bounds inline source and diff honestly while explicit parts return full 256 KiB", async () => {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  try {
    const root = project();
    await client.call("attach", { root });
    const source = `\uFEFF${"x".repeat(256 * 1024 - 3)}`;
    const record = svc.changes.admit({
      operationId: randomBytes(16).toString("hex"),
      projectRoot: root,
      format: "mermaid",
      origin: "browser_editor",
      target: { kind: "draft", id: "large" },
      eventKind: "draft.saved",
      before: Buffer.from(""),
      after: Buffer.from(source),
    }).record;
    const detail = await client.call("readChange", { root, changeId: record.changeId });
    expect(detail.after).toMatchObject({ complete: false, reason: "request_part_after" });
    expect(detail.after).not.toHaveProperty("text");
    expect(detail.diff).toMatchObject({ complete: false, text: "" });
    expect(detail.diff.bytes).toBeGreaterThan(64 * 1024);
    const full = await client.call("readChange", { root, changeId: record.changeId, part: "after" });
    expect(full.source).toMatchObject({ text: source, complete: true, bytes: 256 * 1024 });
    const empty = await client.call("readChange", { root, changeId: record.changeId, part: "before" });
    expect(empty.before.present).toBe(true);
    expect(empty.source).toMatchObject({ text: "", bytes: 0, complete: true });
  } finally {
    client.close();
  }
});
