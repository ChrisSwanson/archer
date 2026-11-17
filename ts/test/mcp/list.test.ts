// The tool list and list_diagrams: what an agent sees first.
import { afterEach, expect, test } from "vitest";
import { call, connect, FLOW, removeTempDirs, SEQ, structured, tempDir, text } from "./support.ts";

afterEach(removeTempDirs);

const MILESTONE_ONE = [
  "list_diagrams",
  "read_diagram",
  "read_note",
  "validate_diagram",
  "write_diagram",
  "register_diagram",
  "present_diagram",
  "list_emphases",
  "set_emphasis",
  "get_presentation_context",
  "get_ui_url",
];
/** Comments (ts/src/comments/contract.ts). */
const COMMENTS = ["create_comment", "get_comments", "reply_comment", "resolve_comment"];
const NOTE_EMPHASIS = ["list_note_emphases", "set_note_emphasis"];
const WALKTHROUGHS = ["list_walkthroughs", "write_walkthrough"];

test("the server lists milestone 1's tools and the comment tools, each with a closed input schema", async () => {
  const { client, close } = await connect({ cwd: tempDir() });
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(
    [
      ...MILESTONE_ONE,
      ...COMMENTS,
      ...NOTE_EMPHASIS,
      ...WALKTHROUGHS,
      "export_diagram",
      "measure_diagram",
      "docs_index",
      "find_elements",
      "list_stale_diagrams",
      "read_diagram_at_commit",
      "compare_diagrams",
      "set_selection",
      "start_service",
      "stop_service",
      "list_projects",
      "attach_project",
      "detach_project",
      "issue_access_link",
      "list_access_links",
      "revoke_access_link",
      "issue_pairing_code",
      "setup_network_access",
      "issue_authoring_access",
      "list_changes",
      "read_change",
      "resolve_change",
    ].sort(),
  );
  for (const tool of tools) {
    expect(tool.inputSchema.type).toBe("object");
    expect((tool.inputSchema as { additionalProperties?: unknown }).additionalProperties, tool.name).toBe(false);
    expect(tool.description?.length, tool.name).toBeGreaterThan(20);
  }
  await close();
});

test("tool descriptions tell an agent where diagrams live, the edge-id form and the reference", async () => {
  const { client, close } = await connect({ cwd: tempDir() });
  const { tools } = await client.listTools();
  const all = tools.map((t) => t.description ?? "").join("\n");
  expect(all).toContain("Archer folder");
  expect(all).toContain("a id@--> b");
  expect(all).toContain("archer://docs/supported-mermaid");
  const register = tools.find((t) => t.name === "register_diagram")?.description ?? "";
  expect(register).toContain("archer://docs/supported-mermaid");
  await close();
});

test("list_diagrams lists every diagram in the Archer folder, listed or not, with its notes", async () => {
  const dir = tempDir({
    "archer.toml":
      'version = 1\n[[views]]\nid = "overview"\nkind = "c4-context"\ntitle = "Overview"\nsource = ".archer/arch.mmd"\n',
    ".archer/arch.mmd": FLOW,
    ".archer/flows/login.mmd": SEQ,
    ".archer/flows/login.md": "---\ntype: workflow\n---\nThe login flow.\n",
  });
  const { client, close } = await connect({ cwd: dir });
  const result = await call(client, "list_diagrams");
  expect(structured(result)).toMatchObject({
    schemaVersion: 1,
    views: [
      { id: "overview", kind: "c4-context", title: "Overview", registration: "durable", source: "arch.mmd" },
      { id: "login", kind: "sequence", title: "login", registration: "ephemeral", source: "flows/login.mmd" },
    ],
    notes: [{ path: "flows/login.md", type: "workflow", diagrams: ["flows/login.mmd"] }],
  });
  expect(text(result)).toContain("2 diagrams");
  await close();
});

test("list_diagrams says so when the folder is empty", async () => {
  const { client, close } = await connect({ cwd: tempDir() });
  const result = await call(client, "list_diagrams");
  expect(structured(result)).toMatchObject({ schemaVersion: 1, views: [] });
  expect(text(result)).toMatch(/no diagrams/i);
  await close();
});

test("list_diagrams reports manifest problems and files that cannot be named by a view id", async () => {
  const dir = tempDir({
    "archer.toml": 'version = 1\n[[views]]\nid = "x"\nkind = "nope"\ntitle = "X"\nsource = ".archer/x.mmd"\n',
    ".archer/x.mmd": FLOW,
    ".archer/bad name.mmd": FLOW,
    ".archer/a/dup.mmd": FLOW,
    ".archer/b/dup.mmd": FLOW,
  });
  const { client, close } = await connect({ cwd: dir });
  const result = await call(client, "list_diagrams");
  const payload = structured(result) as { views: { id: string }[]; diagnostics: { code: string; message: string }[] };
  expect(payload.views.map((v) => v.id)).toEqual(["x"]);
  expect(payload.diagnostics.map((d) => d.code).sort()).toEqual([
    "ambiguous_view_id",
    "invalid_view_id",
    "manifest_error",
  ]);
  expect(text(result)).toContain("3 workspace problem(s)");
  await close();
});

test("the supported-Mermaid reference is a resource", async () => {
  const { client, close } = await connect({ cwd: tempDir() });
  const { resources } = await client.listResources();
  expect(resources.map((r) => r.uri)).toContain("archer://docs/supported-mermaid");
  const read = await client.readResource({ uri: "archer://docs/supported-mermaid" });
  const first = read.contents[0] as { mimeType?: string; text?: string };
  expect(first.mimeType).toBe("text/markdown");
  expect(first.text).toContain("# Supported Mermaid");
  await close();
});

// Exercise the SDK handshake/list responses: agents receive these descriptions,
// rather than the implementation's constants or a separately maintained catalog.
test("MCP authoring metadata advertises all seven families and scopes identity rules to the family", async () => {
  const { client, close } = await connect({ cwd: tempDir() });
  try {
    const { tools } = await client.listTools();
    const { resources } = await client.listResources();
    const profile = resources.find((r) => r.uri === "archer://docs/supported-mermaid");
    const families = [/flowchart/i, /sequence/i, /state/i, /\bER\b/i, /\bC4\b/i, /architecture/i, /journey/i];
    for (const name of ["validate_diagram", "write_diagram", "register_diagram"]) {
      const description = tools.find((t) => t.name === name)?.description ?? "";
      for (const family of families) expect(description, name).toMatch(family);
      expect(description, name).toMatch(/flowchart[^.]*explicit edge ids/i);
      expect(description, name).toContain("a id@--> b");
      expect(description, name).toMatch(/other families[^.]*declared or derived identit/i);
      expect(description, name).toContain("archer://docs/supported-mermaid");
    }
    for (const family of families) expect(profile?.description).toMatch(family);
  } finally {
    await close();
  }
});

test("MCP instructions route by question and verify a newly created note before delivery", async () => {
  const { client, close } = await connect({ cwd: tempDir() });
  try {
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toMatch(/question[^.]*C4[^.]*structure[^.]*flowchart[^.]*data[^.]*sequence[^.]*order/i);
    expect(instructions).toMatch(/honor[^.]*user[^.]*scope[^.]*notation/i);
    expect(instructions).toMatch(/table or prose/i);
    // validate_diagram, not read_diagram: it reports the label warnings a file-tool write skips (v1 evals, decided 2026-10-21).
    expect(instructions).toMatch(
      /create[^.]*note first[^.]*validate_diagram[^.]*warning[^.]*present_diagram[^.]*returned URL/i,
    );
    expect(instructions).toMatch(/sourceRevision[^.]*edit[^.]*modelRevision[^.]*present/i);
    expect(instructions).toMatch(/compil[^.]*does not prove architectural correctness/i);
    expect(instructions).toContain("archer://docs/supported-mermaid");
  } finally {
    await close();
  }
});

// Small agents pass a diagram's file path as its view id (v1 small-agent evals, 2026-10-21):
// the refusal names the view that file is, so the next call can succeed.
test("a diagram's file path given as a view id is refused with that view's id", async () => {
  const dir = tempDir({
    "archer.toml":
      'version = 1\n[[views]]\nid = "overview"\nkind = "c4-context"\ntitle = "Overview"\nsource = ".archer/diagrams/arch.mmd"\n',
    ".archer/diagrams/arch.mmd": FLOW,
    ".archer/diagrams/flow.mmd": FLOW,
  });
  const { client, close } = await connect({ cwd: dir });
  try {
    for (const [given, view] of [
      ["diagrams/arch.mmd", "overview"],
      [".archer/diagrams/flow.mmd", "flow"],
    ] as const) {
      const refused = await client
        .callTool({ name: "read_diagram", arguments: { viewId: given } })
        .catch((error: Error) => error);
      expect(String((refused as Error).message ?? JSON.stringify(refused)), given).toContain(`viewId "${view}"`);
    }
  } finally {
    await close();
  }
});
