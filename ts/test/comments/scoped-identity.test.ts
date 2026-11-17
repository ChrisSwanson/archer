import { afterEach, expect, test } from "vitest";
import { validateCommentsFile } from "../../src/comments/store.ts";
import { findProject } from "../../src/project/index.ts";
import { removeTempDirs, tempDir } from "../mcp/support.ts";

afterEach(removeTempDirs);

for (const [kind, id] of [
  ["group", "frag-0"],
  ["node", "note-0"],
] as const) {
  test(`a ${kind} scope stores the same optional identity shape`, async () => {
    const root = tempDir({
      ".archer/sequence.mmd": "sequenceDiagram\n  participant A\n  opt scope\n    Note over A: Annotation\n  end\n",
    });
    const { createComment } = await import("../../src/comments/agent.ts");
    const answer = await createComment(findProject(root), "view:sequence", { kind, id, label: "" }, "Review");
    expect(answer.structured).toHaveProperty("identity", {
      version: 1,
      fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      unique: true,
    });
  });
}

test("an ambiguous identity diagnostic names the identity field", () => {
  const result = validateCommentsFile({
    version: 6,
    target: "view:sequence",
    threads: [
      {
        id: "t-one",
        target: "view:sequence",
        anchor: { kind: "node", id: "note-0", label: "Annotation" },
        status: "draft",
        revision: 1,
        identity: { version: 1, fingerprint: `sha256:${"a".repeat(64)}`, unique: false },
        comments: [{ id: "c-one", author: "person", body: "Review", createdAt: "2026-11-12T00:00:00.000Z" }],
      },
    ],
  });
  expect(result).toEqual({ ok: false, problem: "threads[0].identity is ambiguous and requires orphaned: true" });
});
