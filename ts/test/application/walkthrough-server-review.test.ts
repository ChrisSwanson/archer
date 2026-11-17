import { afterEach, expect, test, vi } from "vitest";

const scans = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../src/project/index.ts", async (original) => {
  const real = await original<typeof import("../../src/project/index.ts")>();
  return {
    ...real,
    listDiagrams: (project: Parameters<typeof real.listDiagrams>[0]) => {
      scans.count++;
      return real.listDiagrams(project);
    },
  };
});

const { createApplication } = await import("../../src/application/index.ts");
const { staleWalkthroughs } = await import("../../src/application/walkthroughs.ts");
const { CommentsStore } = await import("../../src/comments/store.ts");
const { findProject } = await import("../../src/project/index.ts");
const { WalkthroughsStore } = await import("../../src/walkthroughs/store.ts");
const { cleanup, commit, repo } = await import("../accuracy/support.ts");

afterEach(cleanup);

const FLOW = "flowchart LR\n  a[Client]\n  b[API]\n  c[(Store)]\n  a e1@-->|Calls| b\n  b e2@-->|Writes| c\n";
const step = (title: string, edge = "e1") => ({ title, kind: "sends", what: "A request.", edges: [{ id: edge }] });
const draft = (id = "ask") => ({ id, title: "Asking the API", steps: [step("Ask"), step("Store", "e2")] });
const NOTE = (body: string, prose = "") =>
  `---\nauthor: agent\n---\n# Pay\n\n${prose}\n\`\`\`mermaid\n%% archer-id: pay\n${body}\`\`\`\n`;

async function revisionOf(app: ReturnType<typeof createApplication>, viewId: string): Promise<string> {
  return (await app.call("read_diagram", { viewId })).structured["modelRevision"] as string;
}

test("each request scans the Archer folder once, however many diagrams and threads it touches", async () => {
  const cwd = repo({ ".archer/flow.mmd": FLOW, ".archer/other.mmd": FLOW, ".archer/notes/pay.md": NOTE(FLOW) });
  const app = createApplication({ cwd });
  try {
    for (const viewId of ["flow", "other", "notes/pay.md#pay"])
      await app.call("write_walkthrough", {
        viewId,
        modelRevision: await revisionOf(app, viewId),
        walkthrough: draft(),
      });
    const once = async (label: string, run: () => Promise<unknown>) => {
      scans.count = 0;
      await run();
      expect([label, scans.count]).toEqual([label, 1]);
    };
    await once("staleWalkthroughs", () => staleWalkthroughs(findProject(cwd)));
    await once("list_walkthroughs", () => app.call("list_walkthroughs", { viewId: "flow" }));
    await once("list_walkthroughs id", () => app.call("list_walkthroughs", { viewId: "flow", id: "ask" }));
    const modelRevision = await revisionOf(app, "flow");
    await once("write_walkthrough", () =>
      app.call("write_walkthrough", { viewId: "flow", modelRevision, walkthrough: draft("second") }),
    );
    // Threads on two diagrams, each naming a walkthrough step.
    const store = new CommentsStore(findProject(cwd));
    for (const viewId of ["flow", "other"])
      store.create(
        {
          target: `view:${viewId}`,
          path: `${viewId}.comments.json`,
          subject: {
            kind: "view",
            elements: null,
            walkthroughs: new Map([["ask", { title: "Asking the API", steps: [{ id: "ask", title: "Ask" }] }]]),
          },
        },
        { anchor: { kind: "step", walkthrough: "ask", step: "ask", label: "" }, body: "Why?" },
      );
    store.submit();
    await once("get_comments", () => app.call("get_comments", {}));
  } finally {
    app.close();
  }
});

test("commit is recorded for a note larger than the old 256 KB cap", async () => {
  const cwd = repo({ ".archer/notes/pay.md": NOTE(FLOW, `${"Prose line.\n".repeat(30_000)}`) });
  const app = createApplication({ cwd });
  try {
    expect(Buffer.byteLength(NOTE(FLOW, "Prose line.\n".repeat(30_000)))).toBeGreaterThan(256 * 1024);
    const head = commit(cwd);
    const made = await app.call("write_walkthrough", {
      viewId: "notes/pay.md#pay",
      modelRevision: await revisionOf(app, "notes/pay.md#pay"),
      walkthrough: draft(),
    });
    expect(made.structured["walkthrough"]).toMatchObject({ commit: head });
  } finally {
    app.close();
  }
});

test("list_walkthroughs {id} on a diagram that never compiled does not call the walkthrough current", async () => {
  const cwd = repo({ ".archer/flow.mmd": "garbage\n" });
  const app = createApplication({ cwd });
  try {
    new WalkthroughsStore(findProject(cwd)).write(
      { viewId: "flow", path: "flow.walkthroughs.json" },
      {
        walkthrough: {
          id: "ask",
          title: "Asking",
          steps: [{ title: "Ask", kind: "sends", what: "A request.", edges: [{ id: "e1", source: "a", target: "b" }] }],
        },
        modelRevision: `sha256:${"a".repeat(64)}`,
        author: "agent",
      },
    );
    const one = await app.call("list_walkthroughs", { viewId: "flow", id: "ask" });
    expect(one.structured["resolution"]).toBeNull();
    expect(one.text).toContain("unchecked");
    expect(one.text).not.toContain("current");
  } finally {
    app.close();
  }
});

test("get_comments names a step that is gone without an empty label", async () => {
  const cwd = repo({ ".archer/flow.mmd": FLOW });
  const app = createApplication({ cwd });
  try {
    await app.call("write_walkthrough", {
      viewId: "flow",
      modelRevision: await revisionOf(app, "flow"),
      walkthrough: draft(),
    });
    const store = new CommentsStore(findProject(cwd));
    const subject = {
      kind: "view" as const,
      elements: new Map([["edge:e2", "Writes"]]),
      walkthroughs: new Map([["ask", { title: "Asking the API", steps: [{ id: "gone", title: "Gone" }] }]]),
    };
    store.create(
      { target: "view:flow", path: "flow.comments.json", subject },
      {
        anchor: { kind: "edge", id: "e2", label: "", context: { walkthrough: "ask", step: "gone" } },
        body: "Which store?",
      },
    );
    store.submit();
    const text = (await app.call("get_comments", { target: "view:flow" })).text;
    expect(text).toContain("step gone (which no longer exists)");
    expect(text).not.toContain('(""');
  } finally {
    app.close();
  }
});
