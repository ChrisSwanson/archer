// A write_diagram that changes a walkthrough's status says so in its result
// (ADR 0034 §3), as emphasis's focusChange does: the agent learns at the moment
// it caused the breakage. A write touching nothing a walkthrough names omits the key.
import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { cleanup, repo } from "../accuracy/support.ts";

afterEach(cleanup);

const FLOW = "flowchart LR\n  a[Client]\n  b[API]\n  c[(Store)]\n  a e1@-->|Calls| b\n  b e2@-->|Writes| c\n";
const walkthrough = {
  id: "ask",
  title: "Asking",
  steps: [
    { title: "Ask", kind: "sends", what: "A request.", edges: [{ id: "e1" }] },
    { title: "Store", kind: "sends", what: "A write.", edges: [{ id: "e2" }] },
  ],
};
const cases = [
  { name: "standalone", viewId: "flow", file: ".archer/flow.mmd", wrap: (s: string) => s },
  {
    name: "embedded",
    viewId: "notes/n.md#flow",
    file: ".archer/notes/n.md",
    wrap: (s: string) => `# N\n\n\`\`\`mermaid\n%% archer-id: flow\n${s}\`\`\`\n`,
  },
];

for (const c of cases) {
  async function setup() {
    const cwd = repo({ [c.file]: c.wrap(FLOW) });
    const app = createApplication({ cwd });
    const read = await app.call("read_diagram", { viewId: c.viewId });
    await app.call("write_walkthrough", {
      viewId: c.viewId,
      modelRevision: read.structured["modelRevision"],
      walkthrough,
    });
    return {
      app,
      source: (read.structured["source"] as { text: string }).text,
      revision: read.structured["sourceRevision"] as string,
    };
  }

  test(`${c.name}: a write removing a relationship returns walkthroughChange`, async () => {
    const { app, source, revision } = await setup();
    try {
      const written = await app.call("write_diagram", {
        viewId: c.viewId,
        source: source.replace("  b e2@-->|Writes| c\n", ""),
        expectedRevision: revision,
      });
      expect(written.structured["walkthroughChange"]).toEqual([
        { id: "ask", status: "partly-out-of-date", outOfDate: [2], changed: [] },
      ]);
      expect(written.text).toContain("walkthrough");
    } finally {
      app.close();
    }
  });

  test(`${c.name}: a relabelled relationship lists the changed step`, async () => {
    const { app, source, revision } = await setup();
    try {
      const written = await app.call("write_diagram", {
        viewId: c.viewId,
        source: source.replace("|Calls|", "|Asks|"),
        expectedRevision: revision,
      });
      expect(written.structured["walkthroughChange"]).toEqual([
        { id: "ask", status: "current", outOfDate: [], changed: [1] },
      ]);
    } finally {
      app.close();
    }
  });

  test(`${c.name}: a write touching nothing a walkthrough names omits the key`, async () => {
    const { app, source, revision } = await setup();
    try {
      const written = await app.call("write_diagram", {
        viewId: c.viewId,
        source: `${source}  d[Cache]\n`,
        expectedRevision: revision,
      });
      expect(written.structured["status"]).toBe("compiled");
      expect(written.structured).not.toHaveProperty("walkthroughChange");
    } finally {
      app.close();
    }
  });
}

test("a view with no walkthroughs never has the key", async () => {
  const cwd = repo({ ".archer/flow.mmd": FLOW });
  const app = createApplication({ cwd });
  try {
    const read = await app.call("read_diagram", { viewId: "flow" });
    const written = await app.call("write_diagram", {
      viewId: "flow",
      source: FLOW.replace("  b e2@-->|Writes| c\n", ""),
      expectedRevision: read.structured["sourceRevision"],
    });
    expect(written.structured).not.toHaveProperty("walkthroughChange");
  } finally {
    app.close();
  }
});
