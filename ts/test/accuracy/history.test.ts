import { afterEach, expect, test } from "vitest";
import { readDiagramAtCommit } from "../../src/accuracy/history.ts";
import { cleanup, commit, FLOW, manifest, project, repo, write } from "./support.ts";
afterEach(cleanup);
test("historical reads use historical registration, source bytes, and kind rather than today's path", async () => {
  const root = repo({ "archer.toml": manifest(), ".archer/flow.mmd": FLOW });
  const first = commit(root);
  write(root, "archer.toml", manifest("", ".archer/new.mmd"));
  write(root, ".archer/new.mmd", FLOW.replace("Client", "New client"));
  const second = commit(root);
  const old = await readDiagramAtCommit(project(root), "flow", first);
  expect(old.status).toBe("compiled");
  if (old.status === "unavailable") throw new Error(old.reason);
  expect(old.path).toBe(".archer/flow.mmd");
  expect(old.source).toEqual({ status: "text", text: FLOW });
  expect(old.result.envelope?.view.title).toBe("Flow");
  const now = await readDiagramAtCommit(project(root), "flow", second);
  expect(now.status).toBe("compiled");
  if (now.status === "unavailable") throw new Error(now.reason);
  expect(now.path).toBe(".archer/new.mmd");
  expect(now.sourceRevision).not.toBe(old.sourceRevision);
});
test("invalid historical Mermaid is failed with exact source, never today's valid model", async () => {
  const root = repo({ "archer.toml": manifest(), ".archer/flow.mmd": "garbage\n" });
  const bad = commit(root);
  write(root, ".archer/flow.mmd", FLOW);
  commit(root);
  const got = await readDiagramAtCommit(project(root), "flow", bad);
  expect(got.status).toBe("failed");
  if (got.status === "unavailable") throw new Error(got.reason);
  expect(got.result.envelope).toBeNull();
  expect(got.result.diagnostics.some((d) => d.severity === "error")).toBe(true);
});
test("a commit with no registry answers for the unlisted file, and names a view it cannot find", async () => {
  const root = repo({ ".archer/flow.mmd": FLOW });
  const old = commit(root);
  write(root, "archer.toml", manifest());
  commit(root);
  expect(await readDiagramAtCommit(project(root), "flow", old)).toMatchObject({
    status: "compiled",
    commit: old,
    path: ".archer/flow.mmd",
  });
  expect(await readDiagramAtCommit(project(root), "other", old)).toMatchObject({
    status: "unavailable",
    commit: old,
    reason: "historical_view_unavailable",
  });
});
test("historical bytes preserve BOM and invalid UTF-8 has an exact hash with no envelope", async () => {
  const bytes = Buffer.from([0xff, 0xfe]);
  const root = repo({ "archer.toml": manifest(), ".archer/flow.mmd": bytes });
  const old = commit(root);
  const failed = await readDiagramAtCommit(project(root), "flow", old);
  expect(failed.status).toBe("failed");
  if (failed.status === "unavailable") throw new Error(failed.reason);
  expect(failed.source).toEqual({ status: "not-utf8" });
  expect(failed.result.envelope).toBeNull();
  write(root, ".archer/flow.mmd", "\ufeff" + FLOW);
  const bom = commit(root);
  const valid = await readDiagramAtCommit(project(root), "flow", bom);
  expect(valid.status).toBe("compiled");
  if (valid.status === "unavailable") throw new Error(valid.reason);
  expect(valid.source).toEqual({ status: "text", text: "\ufeff" + FLOW });
  expect(valid.sourceRevision).not.toEqual(failed.sourceRevision);
});
// Widened reads (ADR 0034 §3): a view that archer.toml never listed, and a diagram embedded in a note.
const NOTE = (body: string) =>
  `---\nauthor: agent\n---\n# Pay\n\n\`\`\`mermaid\n%% archer-id: pay\n${body}\`\`\`\n\nProse.\n`;
test("an unregistered .mmd is read at a commit by its file name, with no archer.toml at all", async () => {
  const root = repo({ ".archer/sub/checkout.mmd": FLOW });
  const first = commit(root);
  write(root, ".archer/sub/checkout.mmd", FLOW.replace("Client", "Shopper"));
  commit(root);
  const old = await readDiagramAtCommit(project(root), "checkout", first);
  if (old.status === "unavailable") throw new Error(old.reason);
  expect(old.status).toBe("compiled");
  expect(old.path).toBe(".archer/sub/checkout.mmd");
  expect(old.source).toEqual({ status: "text", text: FLOW });
  expect(old.result.envelope?.view).toMatchObject({ id: "checkout", title: "checkout" });
  expect(await readDiagramAtCommit(project(root), "absent", first)).toMatchObject({
    status: "unavailable",
    reason: "historical_view_unavailable",
  });
});
test("an unregistered name that two files spell is unavailable, not a guess", async () => {
  const root = repo({ ".archer/a/x.mmd": FLOW, ".archer/b/x.mmd": FLOW });
  const first = commit(root);
  expect(await readDiagramAtCommit(project(root), "x", first)).toMatchObject({
    status: "unavailable",
    reason: "historical_view_ambiguous",
  });
});
test("a diagram embedded in a note is read at a commit by its address, fence chosen by name", async () => {
  const root = repo({ ".archer/notes/pay.md": NOTE(FLOW) });
  const first = commit(root);
  write(root, ".archer/notes/pay.md", NOTE(FLOW.replace("Client", "Shopper")));
  commit(root);
  const old = await readDiagramAtCommit(project(root), "notes/pay.md#pay", first);
  if (old.status === "unavailable") throw new Error(old.reason);
  expect(old.status).toBe("compiled");
  expect(old.path).toBe(".archer/notes/pay.md");
  expect(old.result.envelope?.view.id).toBe("notes/pay.md#pay");
  expect(JSON.stringify(old.result.envelope?.model)).toContain("Client");
  expect(JSON.stringify(old.result.envelope?.model)).not.toContain("Shopper");
  expect(await readDiagramAtCommit(project(root), "notes/pay.md#nope", first)).toMatchObject({
    status: "unavailable",
    reason: "historical_view_unavailable",
  });
  expect(await readDiagramAtCommit(project(root), "notes/missing.md#pay", first)).toMatchObject({
    status: "unavailable",
    reason: "historical_source_missing",
  });
});
