// flows-r1 (outside the rubric, S3): create_comment's schema says Archer writes an anchor's label and replaces any
// sent, yet a node anchor with no label was refused ("the node anchor.label must be text"). The label is optional on
// a new thread; Archer writes it from the diagram. A thread read back from the comments file still needs its label.
import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { FLOW, removeTempDirs, tempDir } from "../project/support.ts";

afterEach(removeTempDirs);

test("create_comment takes a node, edge or selection anchor with no label and writes the diagram's", async () => {
  const app = createApplication({ cwd: tempDir({ ".archer/flow.mmd": FLOW }) });
  try {
    const node = await app.call("create_comment", {
      target: "view:flow",
      anchor: { kind: "node", id: "a" },
      body: "Who is this?",
    });
    expect(node.structured["anchor"]).toEqual({ kind: "node", id: "a", label: "Client" });
    const edge = await app.call("create_comment", {
      target: "view:flow",
      anchor: { kind: "edge", id: "e1" },
      body: "Which call?",
    });
    expect((edge.structured["anchor"] as { label: string }).label).toBeTypeOf("string");
    const picked = await app.call("create_comment", {
      target: "view:flow",
      anchor: { kind: "selection", nodes: [{ id: "a" }, { id: "b" }], edges: [] },
      body: "These two.",
    });
    expect(picked.structured["anchor"]).toMatchObject({
      kind: "selection",
      nodes: [
        { id: "a", label: "Client" },
        { id: "b", label: "API" },
      ],
    });
    // A label sent is still replaced, as the schema says.
    const sent = await app.call("create_comment", {
      target: "view:flow",
      anchor: { kind: "node", id: "a", label: "x" },
      body: "Again.",
    });
    expect(sent.structured["anchor"]).toEqual({ kind: "node", id: "a", label: "Client" });
    // A label that is not text is still refused.
    await expect(
      app.call("create_comment", { target: "view:flow", anchor: { kind: "node", id: "a", label: 3 }, body: "No." }),
    ).rejects.toThrow(/label/);
  } finally {
    app.close();
  }
});
