// What the agent receives from get_comments (wave 2, ticket 08): for every thread the target, the file path
// relative to the project, the diagram address, each anchored element with id and label, the source line range
// when it resolves, and the page the person sent it from. Through the MCP tool, on a real temp project.
import { execFileSync, spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { embeddedCommentsPath } from "../../src/notes/embedded.ts";
import { CommentsStore, PROJECT_COMMENTS_PATH, elementsOf, type Place } from "../../src/comments/store.ts";
import type { GraphModel } from "../../src/model/index.ts";
import { findProject } from "../../src/project/index.ts";
import { call, connect, FLOW, removeTempDirs, structured, tempDir, text } from "../mcp/support.ts";

afterEach(removeTempDirs);

const GRAPH: GraphModel = {
  type: "freeform-graph",
  nodes: [
    { id: "a", label: "Client" },
    { id: "b", label: "API" },
  ],
  edges: [{ id: "e1", source: "a", target: "b" }],
  groups: [],
};
const NOTE = [
  "# Auth", // 1
  "", // 2
  "Tokens matter, and the client holds one.", // 3
  "", // 4
  "## Login", // 5
  "", // 6
  "```mermaid", // 7
  "%% archer-id: login", // 8
  "flowchart LR", // 9
  "  a[Client] e1@--> b[API]", // 10
  "  b[API] --> c[DB]", // 11
  "```", // 12
  "",
].join("\n");

async function setup() {
  const root = tempDir({ ".archer/flow.mmd": FLOW, ".archer/notes/auth.md": NOTE });
  const store = new CommentsStore(findProject(root));
  const connected = await connect({ cwd: root });
  const send = () => store.submit();
  return { root, store, send, ...connected };
}

type Ref = {
  target: string;
  file?: string;
  address?: string;
  anchored: { kind: string; id?: string; label?: string; quote?: string }[];
  lines?: { start: number; end: number };
  page?: string;
  document?: string;
};
type Got = { threads: { id: string; references: Ref }[] };

test("a thread on a diagram file names the file, the address, the element with id and label, its lines and the page", async () => {
  const { store, send, client, close } = await setup();
  const place: Place = {
    target: "view:flow",
    path: "flow.comments.json",
    subject: { kind: "view", elements: elementsOf(GRAPH) },
  };
  store.create(place, {
    anchor: { kind: "node", id: "a", label: "x" },
    body: "Why a client?",
    context: { page: "/projects/demo/diagrams/flow" },
  });
  send();
  const result = await call(client, "get_comments");
  const got = structured(result) as unknown as Got;
  expect(got.threads[0]?.references).toEqual({
    target: "view:flow",
    file: ".archer/flow.mmd",
    address: "flow",
    anchored: [{ kind: "node", id: "a", label: "Client" }],
    lines: { start: 2, end: 2 },
    page: "/projects/demo/diagrams/flow",
  });
  const said = text(result);
  expect(said).toContain(".archer/flow.mmd");
  expect(said).toContain('node a ("Client")');
  expect(said).toContain("line 2");
  expect(said).toContain("/projects/demo/diagrams/flow");
  await close();
});

test("a thread on a diagram in a note: the note's file, the note.md#name address, lines of the note file", async () => {
  const { store, send, client, close } = await setup();
  const place: Place = {
    target: "view:notes/auth.md#login",
    path: embeddedCommentsPath("notes/auth.md", "login"),
    subject: { kind: "view", elements: elementsOf({ ...GRAPH, nodes: [...GRAPH.nodes, { id: "c", label: "DB" }] }) },
  };
  store.create(place, {
    anchor: {
      kind: "selection",
      nodes: [
        { id: "a", label: "" },
        { id: "c", label: "" },
      ],
      edges: [],
    },
    body: "Both?",
  });
  store.create(place, { anchor: { kind: "view" }, body: "Whole thing" });
  send();
  const got = structured(await call(client, "get_comments")) as unknown as Got;
  const [selection, whole] = got.threads.map((t) => t.references);
  expect(selection).toEqual({
    target: "view:notes/auth.md#login",
    file: ".archer/notes/auth.md",
    address: "notes/auth.md#login",
    anchored: [
      { kind: "node", id: "a", label: "Client" },
      { kind: "node", id: "c", label: "DB" },
    ],
    lines: { start: 10, end: 11 },
  });
  // No element named: the whole diagram's block in the note (fence body, lines 8 to 11).
  expect(whole).toMatchObject({ address: "notes/auth.md#login", anchored: [], lines: { start: 8, end: 11 } });
  await close();
});

test("a thread on a note passage names the note's file and the lines the passage is on", async () => {
  const { store, send, client, close } = await setup();
  const place: Place = {
    target: "note:notes/auth.md",
    path: "notes/auth.comments.json",
    subject: { kind: "note", text: NOTE },
  };
  store.create(place, {
    anchor: { kind: "passage", quote: "the client holds one", prefix: "", suffix: "" },
    body: "Where?",
    context: { page: "/projects/demo/notes/auth.md", document: "notes/auth.md" },
  });
  send();
  const got = structured(await call(client, "get_comments")) as unknown as Got;
  expect(got.threads[0]?.references).toEqual({
    target: "note:notes/auth.md",
    file: ".archer/notes/auth.md",
    anchored: [{ kind: "passage", quote: "the client holds one" }],
    lines: { start: 3, end: 3 },
    page: "/projects/demo/notes/auth.md",
    document: "notes/auth.md",
  });
  await call(client, "get_comments");
  await close();
});

test("a project thread has no file; it names the page, and the latest page wins", async () => {
  const { store, send, client, close } = await setup();
  const place: Place = { target: "project:", path: PROJECT_COMMENTS_PATH, subject: { kind: "project" } };
  const thread = store.create(place, {
    anchor: { kind: "project" },
    body: "Hello",
    context: { page: "/projects/demo/search" },
  }).value;
  store.reply(thread.id, "Again", "person", undefined, { page: "/projects/demo/folders/notes" });
  send();
  const result = await call(client, "get_comments");
  const got = structured(result) as unknown as Got;
  expect(got.threads[0]?.references).toEqual({
    target: "project:",
    anchored: [],
    page: "/projects/demo/folders/notes",
  });
  expect(text(result)).toContain("the project as a whole");
  expect(text(result)).toContain("/projects/demo/folders/notes");
  await close();
});

test("a thread from before wave 2 (no context) still reads, and so does one whose diagram is gone", async () => {
  const { root, store, send, client, close } = await setup();
  const place: Place = {
    target: "view:flow",
    path: "flow.comments.json",
    subject: { kind: "view", elements: elementsOf(GRAPH) },
  };
  store.create(place, { anchor: { kind: "view" }, body: "plain" });
  send();
  const got = structured(await call(client, "get_comments")) as unknown as Got;
  expect(got.threads[0]?.references).toEqual({
    target: "view:flow",
    file: ".archer/flow.mmd",
    address: "flow",
    anchored: [],
    lines: { start: 1, end: 2 },
  });
  rmSync(join(root, ".archer/flow.mmd"));
  store.create({ ...place, target: "view:flow" }, { anchor: { kind: "view" }, body: "second" });
  const gone = structured(await call(client, "get_comments")) as unknown as Got;
  expect(gone.threads.map((t) => t.references)).toEqual([{ target: "view:flow", address: "flow", anchored: [] }]);
  await close();
});

test("a diagram source that is a FIFO is not read: get_comments answers, without lines, and does not hang", () => {
  const { root } = {
    root: tempDir({
      ".archer/flow.mmd": FLOW,
      "archer.toml":
        'version = 1\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "Flow"\nsource = ".archer/flow.mmd"\n',
    }),
  };
  const store = new CommentsStore(findProject(root));
  store.create(
    { target: "view:flow", path: "flow.comments.json", subject: { kind: "view", elements: elementsOf(GRAPH) } },
    { anchor: { kind: "node", id: "a", label: "Client" }, body: "Why?" },
  );
  store.submit();
  rmSync(join(root, ".archer/flow.mmd"));
  execFileSync("mkfifo", [join(root, ".archer/flow.mmd")]);
  // In a child: a blocking read of a FIFO with no writer never returns, and would stall this worker.
  const script = `import { getComments } from ${JSON.stringify(fileURLToPath(new URL("../../src/comments/agent.ts", import.meta.url)))};
import { findProject } from ${JSON.stringify(fileURLToPath(new URL("../../src/project/index.ts", import.meta.url)))};
process.stdout.write(JSON.stringify(getComments(findProject(process.argv[1])).structured));`;
  const loader = fileURLToPath(new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url));
  const run = spawnSync(process.execPath, ["--import", loader, "--input-type=module", "-e", script, root], {
    encoding: "utf8",
    timeout: 15_000,
  });
  expect(run.signal, run.stderr).toBeNull();
  const got = JSON.parse(run.stdout) as Got;
  expect(got.threads[0]?.references).toEqual({
    target: "view:flow",
    file: ".archer/flow.mmd",
    address: "flow",
    anchored: [{ kind: "node", id: "a", label: "Client" }],
  });
}, 30_000);

// Finding 10: a passage is found in the rendered note (as the page anchored it), by its quote and context, and
// traced to the lines it is written on; never by its first words alone.
const REPEATS = [
  "# Tokens", // 1
  "", // 2
  "The token expires after an hour.", // 3
  "", // 4
  "Refresh: the **token** expires after a day.", // 5
  "", // 6
].join("\n");

test("a passage repeated in the note points at the occurrence the person anchored, through Markdown", async () => {
  const root = tempDir({ ".archer/notes/tokens.md": `---\nauthor: person\n---\n${REPEATS}` });
  const store = new CommentsStore(findProject(root));
  const place: Place = {
    target: "note:notes/tokens.md",
    path: "notes/tokens.comments.json",
    subject: { kind: "note", text: REPEATS },
  };
  // The rendered text reads "the token expires after a" in both paragraphs; the context says which.
  store.create(place, {
    anchor: { kind: "passage", quote: "token expires after a", prefix: "Refresh: the ", suffix: " day." },
    body: "Which?",
  });
  store.submit();
  const { client, close } = await connect({ cwd: root });
  const got = structured(await call(client, "get_comments")) as unknown as Got;
  // Three lines of front matter come first: the second paragraph is line 8 of the file.
  expect(got.threads[0]?.references.lines).toEqual({ start: 8, end: 8 });
  await close();
});

test("a passage whose quote is not in the note's rendered text has no lines (no first-words guess)", async () => {
  const root = tempDir({ ".archer/notes/tokens.md": REPEATS });
  const store = new CommentsStore(findProject(root));
  writeFileSync(
    join(root, ".archer/notes/tokens.comments.json"),
    JSON.stringify({
      version: 2,
      target: "note:notes/tokens.md",
      threads: [
        {
          id: "t-1",
          target: "note:notes/tokens.md",
          anchor: {
            kind: "passage",
            quote: "The token expires after an hour. Refresh: the client, not the token",
            prefix: "",
            suffix: "",
          },
          status: "sent",
          revision: 1,
          comments: [{ id: "c-1", author: "person", body: "Gone?", createdAt: "2026-10-01T00:00:00Z" }],
        },
      ],
    }),
  );
  void store;
  const { client, close } = await connect({ cwd: root });
  const got = structured(await call(client, "get_comments")) as unknown as Got;
  expect(got.threads[0]?.references).toEqual({
    target: "note:notes/tokens.md",
    file: ".archer/notes/tokens.md",
    anchored: [{ kind: "passage", quote: "The token expires after an hour. Refresh: the client, not the token" }],
  });
  await close();
});
