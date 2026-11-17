import { afterEach, expect, test, vi } from "vitest";
import { CommentsStore } from "../../src/comments/store.ts";
import { createComment, getCommentsWithBlocks } from "../../src/comments/agent.ts";
import { findProject } from "../../src/project/index.ts";
import { removeTempDirs, tempDir } from "../mcp/support.ts";

afterEach(() => {
  vi.restoreAllMocks();
  removeTempDirs();
});

test("feedback edited during compilation is a draft and is not returned to the agent", async () => {
  const source = "sequenceDiagram\n  participant A\n  participant B\n  opt reviewed\n    A->>B: Send\n  end\n";
  const project = findProject(tempDir({ ".archer/sequence.mmd": source }));
  const opened = await createComment(
    project,
    "view:sequence",
    { kind: "group", id: "frag-0", label: "" },
    "Review this block",
  );
  const store = new CommentsStore(project);
  const threadId = opened.structured.id as string;
  store.reply(threadId, "Submitted feedback", "person");
  store.submit();
  const reconcile = CommentsStore.prototype.reconcile;
  vi.spyOn(CommentsStore.prototype, "reconcile").mockImplementation(function (this: CommentsStore, place) {
    // A person can edit while the compiler awaits; exercise the real mutation and reconciliation.
    store.reply(threadId, "Unsent newer feedback", "person");
    return reconcile.call(this, place);
  });
  const answer = await getCommentsWithBlocks(project, "view:sequence");
  expect(store.list({ target: "view:sequence", path: "sequence.comments.json" }).threads).toMatchObject([
    { status: "draft" },
  ]);
  expect(answer.structured.threads).toEqual([]);
  expect(answer.text).toBe("No comments await you on view:sequence.");
});

test("a listener still reads current sidecars and marks submitted feedback read", async () => {
  const project = findProject(tempDir({ ".archer/flow.mmd": "flowchart LR\n  A[Start]\n" }));
  const opened = await createComment(project, "view:flow", { kind: "view" }, "Review this diagram");
  const store = new CommentsStore(project);
  store.reply(opened.structured.id as string, "Please check", "person");
  store.submit();
  const scans = vi.spyOn(CommentsStore.prototype, "fetchForAgent");
  const answer = await getCommentsWithBlocks(project, "view:flow", { asListener: true });
  expect(answer.structured.threads).toMatchObject([{ status: "read" }]);
  expect(store.list({ target: "view:flow", path: "flow.comments.json" }).threads).toMatchObject([{ status: "read" }]);
  expect(scans).toHaveBeenCalledTimes(2);
});
