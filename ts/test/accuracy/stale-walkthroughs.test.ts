// list_stale_diagrams' top-level `walkthroughs` (ADR 0034 §3): every diagram
// whose walkthroughs need attention, covered by code or not.
import { rmSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { cleanup, repo, write } from "./support.ts";

afterEach(cleanup);

const FLOW = "flowchart LR\n  a[Client]\n  b[API]\n  c[(Store)]\n  a e1@-->|Calls| b\n  b e2@-->|Writes| c\n";
const step = (id: string, extra: Record<string, unknown> = {}) => ({
  title: id,
  kind: "sends",
  what: "Something.",
  edges: [{ id }],
  ...extra,
});

test("an uncovered view with an out-of-date walkthrough is listed, with the steps and dead code", async () => {
  // flow.mmd is not in archer.toml: no coverage, so the view itself is not in `views`.
  const cwd = repo({ ".archer/flow.mmd": FLOW, "src/a.ts": "export {};\n" });
  const app = createApplication({ cwd });
  try {
    const modelRevision = (await app.call("read_diagram", { viewId: "flow" })).structured["modelRevision"];
    await app.call("write_walkthrough", {
      viewId: "flow",
      modelRevision,
      walkthrough: { id: "ask", title: "Asking", steps: [step("e1", { code: ["src/a.ts"] }), step("e2")] },
    });
    expect((await app.call("list_stale_diagrams", {})).structured["walkthroughs"]).toEqual([]);

    write(cwd, ".archer/flow.mmd", FLOW.replace("  b e2@-->|Writes| c\n", "").replace("|Calls|", "|Asks|"));
    rmSync(`${cwd}/src/a.ts`);
    const listed = await app.call("list_stale_diagrams", {});
    expect(listed.structured["walkthroughs"]).toEqual([
      {
        viewId: "flow",
        id: "ask",
        status: "partly-out-of-date",
        outOfDate: [2],
        changed: [1],
        deadCode: [{ step: 1, ref: "src/a.ts", reason: "does not exist" }],
      },
    ]);
    expect(listed.text).toContain("1 walkthrough");
  } finally {
    app.close();
  }
});

test("a viewId filter lists that view's walkthroughs only", async () => {
  const cwd = repo({
    "archer.toml":
      'version = 1\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "Flow"\nsource = ".archer/flow.mmd"\n',
    ".archer/flow.mmd": FLOW,
    ".archer/other.mmd": FLOW,
  });
  const app = createApplication({ cwd });
  try {
    for (const viewId of ["flow", "other"]) {
      const modelRevision = (await app.call("read_diagram", { viewId })).structured["modelRevision"];
      await app.call("write_walkthrough", {
        viewId,
        modelRevision,
        walkthrough: { id: "ask", title: "Asking", steps: [step("e2")] },
      });
      write(cwd, `.archer/${viewId}.mmd`, FLOW.replace("  b e2@-->|Writes| c\n", ""));
    }
    const only = (await app.call("list_stale_diagrams", { viewId: "flow" })).structured["walkthroughs"] as {
      viewId: string;
    }[];
    expect(only.map((w) => w.viewId)).toEqual(["flow"]);
    const all = (await app.call("list_stale_diagrams", {})).structured["walkthroughs"] as { viewId: string }[];
    expect(all.map((w) => w.viewId).sort()).toEqual(["flow", "other"]);
  } finally {
    app.close();
  }
});
