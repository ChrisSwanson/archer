// Every tool refuses what its advertised schema forbids, before it runs, with
// invalid_arguments and the problems listed (Rust's check_call).
import { afterEach, expect, test } from "vitest";
import { unsupportedKeywords } from "../../src/mcp/arguments.ts";
import { TOOLS } from "../../src/mcp/tools.ts";
import { connect, refusal, removeTempDirs, tempDir } from "./support.ts";

afterEach(removeTempDirs);

const REV = `sha256:${"0".repeat(64)}`;

/** A valid call of each tool, which the cases below spoil one way at a time. */
const VALID: Record<string, Record<string, unknown>> = {
  issue_authoring_access: { label: "Editor", projectRoots: ["/tmp/project"] },
  list_changes: {},
  read_change: { changeId: `chg_${"0".repeat(32)}` },
  resolve_change: { changeId: `chg_${"0".repeat(32)}`, expectedReviewRevision: 1, disposition: "handled" },
  issue_access_link: { label: "Browser" },
  list_access_links: {},
  revoke_access_link: { grantId: "a".repeat(36) },
  issue_pairing_code: {},
  setup_network_access: { personConfirmed: false },
  start_service: {},
  stop_service: {},
  list_projects: {},
  attach_project: { root: "." },
  detach_project: { root: "." },
  export_diagram: { viewId: "v" },
  find_elements: { query: "orders db" },
  list_diagrams: {},
  docs_index: { question: "How does X work?", check: true, write: false },
  list_stale_diagrams: {},
  read_diagram_at_commit: { viewId: "v", commit: "HEAD" },
  compare_diagrams: { viewId: "v", from: "HEAD~1", to: "HEAD" },
  set_selection: { schemaVersion: 1, viewId: "v", revision: REV, presentationId: "reader:v", nodes: [], edges: [] },
  read_diagram: { viewId: "v" },
  measure_diagram: { viewId: "v", states: [{ mode: "full" }] },
  read_note: { notePath: "notes/policy.md" },
  validate_diagram: { viewId: "v", source: "flowchart LR\n" },
  write_diagram: { viewId: "v", source: "flowchart LR\n", expectedRevision: REV },
  register_diagram: { sourcePath: "v.mmd" },
  present_diagram: { viewId: "v" },
  list_emphases: {},
  set_emphasis: { id: "e", viewId: "v", groups: [] },
  list_note_emphases: { notePath: "note.md" },
  set_note_emphasis: { notePath: "note.md", id: "e", groups: [], expectedRevision: 0 },
  list_walkthroughs: { viewId: "v" },
  write_walkthrough: { viewId: "v", walkthrough: { id: "w" }, delete: true, expectedRevision: 1 },
  get_presentation_context: {},
  get_ui_url: {},
  create_comment: { target: "view:v", anchor: { kind: "view" }, body: "x" },
  get_comments: {},
  reply_comment: { threadId: "t-1", body: "x" },
  resolve_comment: { threadId: "t-1" },
};

test("the table covers every tool, and every schema uses only enforced keywords", () => {
  expect(Object.keys(VALID).sort()).toEqual(TOOLS.map((t) => t.name).sort());
  for (const tool of TOOLS) expect(unsupportedKeywords(tool.inputSchema), tool.name).toEqual([]);
});

test.each(TOOLS.map((t) => t.name))("%s refuses an argument it does not define", async (name) => {
  const { client, close } = await connect({ cwd: tempDir() });
  const error = await refusal(client, name, { ...VALID[name], bogus: 1 });
  // Tools that parse their own arguments refuse with their own code, still naming the field.
  const own: Record<string, string> = { set_emphasis: "invalid_emphasis", set_note_emphasis: "invalid_note_emphasis" };
  expect(error.data.code).toBe(own[name] ?? "invalid_arguments");
  expect(error.message).toContain("bogus");
  expect(error.code).toBe(-32602);
  await close();
});

test("present_diagram's emphasis is checked by set_emphasis's parser; its other arguments by the schema", async () => {
  const { client, close } = await connect({ cwd: tempDir({ ".archer/v.mmd": "flowchart LR\n  a[A]\n" }) });
  const inner = await refusal(client, "present_diagram", { viewId: "v", emphasis: { id: "e", groups: [], bogus: 1 } });
  expect(inner.data.code).toBe("invalid_emphasis");
  expect(inner.message).toContain("bogus");
  const outer = await refusal(client, "present_diagram", { viewId: 5, emphasis: { id: "e", groups: [] } });
  expect(outer.data.code).toBe("invalid_arguments");
  await close();
});

const WRONG_TYPES: [string, Record<string, unknown>, string][] = [
  ["measure_diagram", { viewId: 7 }, "viewId: must be a string, and is a number"],
  ["measure_diagram", { viewId: "v", source: ["x"] }, "source: must be a string, and is an array"],
  [
    "measure_diagram",
    { viewId: "v", states: Array.from({ length: 9 }, () => ({ mode: "full" })) },
    "states: must hold at most 8 items, and holds 9",
  ],
  [
    "measure_diagram",
    { viewId: "v", viewport: { canvas: { width: 0, height: 896 } } },
    "viewport.canvas.width: must be at least 1, and is 0",
  ],
  ["read_diagram", { viewId: 7 }, "viewId: must be a string, and is a number"],
  ["validate_diagram", { viewId: "v", source: ["x"] }, "source: must be a string, and is an array"],
  [
    "write_diagram",
    { viewId: "v", source: "x", expectedRevision: null },
    "expectedRevision: must be a string, and is null",
  ],
  ["register_diagram", { sourcePath: "v.mmd", kind: "mindmap" }, 'kind: must be one of "c4-context"'],
  ["register_diagram", { sourcePath: "" }, "sourcePath: must not be empty"],
  ["present_diagram", { viewId: "v", annotation: "x".repeat(501) }, "annotation: must be at most 500 characters"],
  ["read_diagram", {}, "viewId: is required and was not given"],
];

test.each(WRONG_TYPES)("%s refuses %j", async (name, args, problem) => {
  const { client, close } = await connect({ cwd: tempDir() });
  const error = await refusal(client, name, args);
  expect(error.data.code).toBe("invalid_arguments");
  expect(error.message).toContain(problem);
  expect(error.message).toContain("Nothing was done");
  expect(error.data.tool).toBe(name);
  await close();
});

test("a view id outside the stable-id grammar and a malformed revision are invalid arguments", async () => {
  const { client, close } = await connect({ cwd: tempDir() });
  expect((await refusal(client, "read_diagram", { viewId: "../etc" })).data.code).toBe("invalid_arguments");
  const bad = await refusal(client, "write_diagram", { viewId: "v", source: "x", expectedRevision: "sha256:XYZ" });
  expect(bad.data.code).toBe("invalid_arguments");
  expect(bad.message).toContain("sourceRevision");
  await close();
});

test("the refusal's message reaches the client as written, prefixed once by the SDK", async () => {
  const { client, close } = await connect({ cwd: tempDir() });
  const error = await refusal(client, "read_diagram", {});
  expect(error.message).toMatch(/^MCP error -32602: read_diagram rejected its arguments/);
  await close();
});

test("an unknown tool and an oversized source are refused under their own codes", async () => {
  const { client, close } = await connect({ cwd: tempDir() });
  expect((await refusal(client, "pin_diagram", { viewId: "v" })).data.code).toBe("unknown_tool");
  const big = await refusal(client, "validate_diagram", { viewId: "v", source: "é".repeat(140 * 1024) });
  expect(big.data.code).toBe("source_too_large");
  await close();
});
