// list_walkthroughs and write_walkthrough (ADR 0034 §5, plan slice 2): the
// agent sends ids and text; Archer fills in labels and ends, refuses the whole
// call on any problem, and writes the sidecar beside the diagram.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { cleanup, commit, git, repo, write } from "../accuracy/support.ts";

afterEach(cleanup);

const FLOW = "flowchart LR\n  a[Client]\n  b[API]\n  c[(Store)]\n  a e1@-->|Calls| b\n  b e2@-->|Writes| c\n";
const SIDECAR = ".archer/flow.walkthroughs.json";
const step = (extra: Record<string, unknown> = {}) => ({
  title: "Ask",
  kind: "sends",
  what: "A request.",
  edges: [{ id: "e1" }],
  ...extra,
});
const draft = (extra: Record<string, unknown> = {}) => ({
  id: "ask",
  title: "Asking the API",
  steps: [step(), step({ title: "Store", edges: [{ id: "e2" }] })],
  ...extra,
});

function project(files: Record<string, string> = {}) {
  const cwd = repo({ ".archer/flow.mmd": FLOW, ...files });
  const app = createApplication({ cwd });
  const modelRevision = async (viewId = "flow") =>
    (await app.call("read_diagram", { viewId })).structured["modelRevision"] as string;
  return { cwd, app, modelRevision };
}

test("a write naming an unknown edge is refused with 'Did you mean', and nothing is written", async () => {
  const { cwd, app, modelRevision } = project();
  try {
    const bad = draft({ steps: [step({ edges: [{ id: "e11" }] })] });
    await expect(
      app.call("write_walkthrough", { viewId: "flow", modelRevision: await modelRevision(), walkthrough: bad }),
    ).rejects.toMatchObject({
      data: {
        code: "invalid_walkthrough",
        issues: [{ where: "steps[0].edges[0]", fix: expect.stringContaining('Did you mean "e1"') }],
      },
    });
    expect(existsSync(join(cwd, SIDECAR))).toBe(false);
  } finally {
    app.close();
  }
});

test("create, replace at expectedRevision, a stale expectedRevision, then delete", async () => {
  const { cwd, app, modelRevision } = project();
  try {
    const revision = await modelRevision();
    const made = await app.call("write_walkthrough", { viewId: "flow", modelRevision: revision, walkthrough: draft() });
    expect(made.structured).toMatchObject({
      walkthrough: {
        id: "ask",
        revision: 1,
        modelRevision: revision,
        author: "agent",
        steps: [{ edges: [{ id: "e1", source: "a", target: "b", label: "Calls" }] }, {}],
      },
      resolution: { id: "ask", status: "current", outOfDate: [], changed: [] },
    });
    expect(JSON.parse(readFileSync(join(cwd, SIDECAR), "utf8")).target).toBe("view:flow");

    const replaced = await app.call("write_walkthrough", {
      viewId: "flow",
      modelRevision: revision,
      walkthrough: draft({ title: "Asking" }),
      expectedRevision: 1,
    });
    expect(replaced.structured["walkthrough"]).toMatchObject({ title: "Asking", revision: 2 });

    await expect(
      app.call("write_walkthrough", {
        viewId: "flow",
        modelRevision: revision,
        walkthrough: draft(),
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({
      data: { code: "walkthrough_changed", walkthrough: { id: "ask", revision: 2, title: "Asking" } },
    });
    // A create over an existing id is the same stale write.
    await expect(
      app.call("write_walkthrough", { viewId: "flow", modelRevision: revision, walkthrough: draft() }),
    ).rejects.toMatchObject({ data: { code: "walkthrough_changed" } });

    const gone = await app.call("write_walkthrough", {
      viewId: "flow",
      modelRevision: revision,
      walkthrough: { id: "ask" },
      expectedRevision: 2,
      delete: true,
    });
    expect(gone.structured).toMatchObject({ deleted: "ask" });
    expect(existsSync(join(cwd, SIDECAR))).toBe(false);
  } finally {
    app.close();
  }
});

test("a stale modelRevision is a revision_conflict, and nothing is written", async () => {
  const { cwd, app } = project();
  try {
    await expect(
      app.call("write_walkthrough", {
        viewId: "flow",
        modelRevision: `sha256:${"0".repeat(64)}`,
        walkthrough: draft(),
      }),
    ).rejects.toMatchObject({ data: { code: "revision_conflict" } });
    expect(existsSync(join(cwd, SIDECAR))).toBe(false);
  } finally {
    app.close();
  }
});

test("labels, ends and Archer's fields sent by the caller are ignored", async () => {
  const { app, modelRevision } = project();
  try {
    const lying = draft({
      revision: 9,
      author: "person",
      steps: [
        step({ edges: [{ id: "e1", source: "c", target: "a", label: "Lies" }], nodes: [{ id: "b", label: "Wrong" }] }),
      ],
    });
    const made = await app.call("write_walkthrough", {
      viewId: "flow",
      modelRevision: await modelRevision(),
      walkthrough: lying,
    });
    expect(made.structured["walkthrough"]).toMatchObject({
      revision: 1,
      author: "agent",
      steps: [
        {
          edges: [{ id: "e1", source: "a", target: "b", label: "Calls" }],
          nodes: [{ kind: "node", id: "b", label: "API" }],
        },
      ],
    });
  } finally {
    app.close();
  }
});

test("a dead code path refuses the whole call, naming every problem", async () => {
  const { cwd, app, modelRevision } = project({ "src/api.ts": "export {};\n" });
  try {
    const bad = draft({ steps: [step({ code: ["src/api.ts", "src/nowhere.ts"] }), step({ edges: [{ id: "zz" }] })] });
    await expect(
      app.call("write_walkthrough", { viewId: "flow", modelRevision: await modelRevision(), walkthrough: bad }),
    ).rejects.toMatchObject({
      data: { code: "invalid_walkthrough", issues: [{ where: "steps[0].code[1]" }, { where: "steps[1].edges[0]" }] },
    });
    expect(existsSync(join(cwd, SIDECAR))).toBe(false);
  } finally {
    app.close();
  }
});

test("commit is recorded when HEAD holds the revision, and left out when it does not", async () => {
  const { cwd, app, modelRevision } = project();
  try {
    const revision = await modelRevision();
    const uncommitted = await app.call("write_walkthrough", {
      viewId: "flow",
      modelRevision: revision,
      walkthrough: draft(),
    });
    expect(uncommitted.structured["walkthrough"]).not.toHaveProperty("commit");
    const head = commit(cwd);
    const committed = await app.call("write_walkthrough", {
      viewId: "flow",
      modelRevision: revision,
      walkthrough: draft(),
      expectedRevision: 1,
    });
    expect(committed.structured["walkthrough"]).toMatchObject({ revision: 2, commit: head });
    // The working tree moves on: HEAD no longer holds the revision it is written against.
    write(cwd, ".archer/flow.mmd", `${FLOW}  a e3@-->|Pings| c\n`);
    const moved = await modelRevision();
    const later = await app.call("write_walkthrough", {
      viewId: "flow",
      modelRevision: moved,
      walkthrough: draft({ id: "later" }),
    });
    expect(later.structured["walkthrough"]).not.toHaveProperty("commit");
    expect(git(cwd, "status", "--porcelain")).toContain("walkthroughs.json");
  } finally {
    app.close();
  }
});

test("list_walkthroughs summarises a view, and with an id lists every step's references", async () => {
  const { cwd, app, modelRevision } = project();
  try {
    expect((await app.call("list_walkthroughs", { viewId: "flow" })).structured).toMatchObject({
      viewId: "flow",
      walkthroughs: [],
    });
    await app.call("write_walkthrough", { viewId: "flow", modelRevision: await modelRevision(), walkthrough: draft() });
    write(cwd, ".archer/flow.mmd", FLOW.replace("e2@-->|Writes| c", "e2@-->|Writes| a"));
    const summary = await app.call("list_walkthroughs", { viewId: "flow" });
    expect(summary.structured).toMatchObject({
      walkthroughs: [
        { id: "ask", title: "Asking the API", steps: 2, status: "partly-out-of-date", outOfDate: [2], revision: 1 },
      ],
    });
    expect(summary.structured["walkthroughs"]).toEqual([expect.not.objectContaining({ title: undefined })]);
    const full = await app.call("list_walkthroughs", { viewId: "flow", id: "ask" });
    expect(full.structured).toMatchObject({
      walkthrough: { id: "ask", steps: [{ title: "Ask" }, { title: "Store" }] },
      resolution: {
        status: "partly-out-of-date",
        steps: [
          { status: "current", edges: [{ status: "current" }] },
          { status: "out-of-date", edges: [{ status: "out-of-date" }] },
        ],
      },
    });
    await expect(app.call("list_walkthroughs", { viewId: "flow", id: "nope" })).rejects.toMatchObject({
      data: { code: "invalid_walkthrough" },
    });
  } finally {
    app.close();
  }
});

test("a diagram embedded in a note keeps its walkthroughs beside the note", async () => {
  const { cwd, app } = project({ ".archer/notes/n.md": `# N\n\n\`\`\`mermaid\n%% archer-id: ask\n${FLOW}\`\`\`\n` });
  try {
    const revision = (await app.call("read_diagram", { viewId: "notes/n.md#ask" })).structured[
      "modelRevision"
    ] as string;
    await app.call("write_walkthrough", { viewId: "notes/n.md#ask", modelRevision: revision, walkthrough: draft() });
    expect(existsSync(join(cwd, ".archer/notes/n.ask.walkthroughs.json"))).toBe(true);
  } finally {
    app.close();
  }
});

test("a sequence diagram cannot host a walkthrough", async () => {
  const { app, modelRevision } = project({
    ".archer/chat.mmd": "sequenceDiagram\n  participant A\n  participant B\n  A->>B: Hi\n",
  });
  try {
    await expect(
      app.call("write_walkthrough", {
        viewId: "chat",
        modelRevision: await modelRevision("chat"),
        walkthrough: draft(),
      }),
    ).rejects.toMatchObject({
      data: { code: "invalid_walkthrough", issues: [{ where: "viewId" }] },
    });
  } finally {
    app.close();
  }
});

test("list_diagrams shows walkthroughs: N per view, and per embedded diagram, only when there are some", async () => {
  const { app, modelRevision } = project({
    ".archer/chat.mmd": FLOW,
    ".archer/notes/n.md": `# N\n\n\`\`\`mermaid\n%% archer-id: ask\n${FLOW}\`\`\`\n`,
  });
  try {
    await app.call("write_walkthrough", { viewId: "flow", modelRevision: await modelRevision(), walkthrough: draft() });
    await app.call("write_walkthrough", {
      viewId: "flow",
      modelRevision: await modelRevision(),
      walkthrough: draft({ id: "second" }),
    });
    await app.call("write_walkthrough", {
      viewId: "notes/n.md#ask",
      modelRevision: await modelRevision("notes/n.md#ask"),
      walkthrough: draft(),
    });
    const listed = (await app.call("list_diagrams", {})).structured as {
      views: { id: string; walkthroughs?: number }[];
      embedded: { address: string; walkthroughs?: number }[];
    };
    expect(listed.views.find((v) => v.id === "flow")?.walkthroughs).toBe(2);
    expect(listed.views.find((v) => v.id === "chat")).not.toHaveProperty("walkthroughs");
    expect(listed.embedded.find((e) => e.address === "notes/n.md#ask")?.walkthroughs).toBe(1);
  } finally {
    app.close();
  }
});
