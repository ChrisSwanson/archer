// The conversation tools, which go through the Archer service: present_diagram,
// set_emphasis, get_presentation_context and get_ui_url, against a fake
// service speaking the protocol over a real socket through the real client,
// and (at the end) the same contract against the fake and the real service.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { connectService, type EnsureService } from "../../src/mcp/index.ts";
import { revisionOf } from "../../src/project/index.ts";
import { MAX_SUMMARY_CHARS, startService } from "../../src/service/index.ts";
import { events, apiBase, ownerFetch } from "../service/support.ts";
import {
  BROKEN,
  call,
  connect,
  FLOW,
  refusal,
  removeSocketDirs,
  removeTempDirs,
  SEQ,
  startFakeService,
  structured,
  tempDir,
  text,
  write,
  type FakeService,
} from "./support.ts";

const services: FakeService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.close();
  removeSocketDirs();
  removeTempDirs();
});

const rev = (t: string) => revisionOf(Buffer.from(t, "utf8"));
const FLOW3 = "flowchart LR\n  a[Client] e1@--> b[API]\n  b e2@--> c[DB]\n";

async function withService(files: Record<string, string>, options: { base?: string } = {}) {
  const service = await startFakeService(options);
  services.push(service);
  let started = 0;
  const ensureService: EnsureService = async () => {
    started += 1;
    return connectService(service.socketPath);
  };
  let found = 0;
  const findService = async () => {
    found += 1;
    return connectService(service.socketPath);
  };
  const dir = tempDir(files);
  const connected = await connect({ cwd: dir, ensureService, findService });
  return { ...connected, service, dir, started: () => started, found: () => found };
}

describe("who changed it: write_diagram and register_diagram tell a running service first", () => {
  test("write_diagram records the write, with its summary, before the file changes, and never starts the service", async () => {
    const { client, close, service, dir, started } = await withService({ ".archer/arch.mmd": FLOW });
    let onDisk = "";
    service.onRecordWrite = () => (onDisk = readFileSync(join(dir, ".archer/arch.mmd"), "utf8"));
    await call(client, "write_diagram", {
      viewId: "arch",
      source: FLOW3,
      expectedRevision: rev(FLOW),
      summary: "added the database",
    });
    // The write asks the service for the project model, for its advice (ADR 0036 A6); this one has not attached it.
    expect(service.requests.map((r) => r.method)).toEqual([
      "hello",
      "attach",
      "recordWrite",
      "getProjectModel",
      "pendingChanges",
    ]);
    expect(service.requests[2]?.params).toEqual({ root: dir, viewId: "arch", summary: "added the database" });
    expect(onDisk).toBe(FLOW);
    expect(readFileSync(join(dir, ".archer/arch.mmd"), "utf8")).toBe(FLOW3);
    expect(started()).toBe(0);

    // Without a summary, the record carries none; an unchanged source writes nothing and records nothing.
    await call(client, "write_diagram", { viewId: "arch", source: FLOW, expectedRevision: rev(FLOW3) });
    expect(service.requests.filter((r) => r.method === "recordWrite").at(-1)?.params).toEqual({
      root: dir,
      viewId: "arch",
    });
    const recorded = service.requests.filter((r) => r.method === "recordWrite").length;
    await call(client, "write_diagram", { viewId: "arch", source: FLOW, expectedRevision: rev(FLOW) });
    expect(service.requests.filter((r) => r.method === "recordWrite").length).toBe(recorded);
    await close();
  }, 15_000); // a real service: 0.5 s idle, 6.4-7.4 s (timed out) beside a disk writer or under write throttling

  test("with no service running, write_diagram still writes, and starts nothing", async () => {
    const dir = tempDir({ ".archer/arch.mmd": FLOW });
    let started = 0;
    const { client, close } = await connect({
      cwd: dir,
      ensureService: () => {
        started += 1;
        return Promise.reject(new Error("not to be started"));
      },
      findService: async () => null,
    });
    const result = await call(client, "write_diagram", {
      viewId: "arch",
      source: FLOW3,
      expectedRevision: rev(FLOW),
      summary: "x",
    });
    expect(structured(result)).toMatchObject({ status: "compiled" });
    expect(readFileSync(join(dir, ".archer/arch.mmd"), "utf8")).toBe(FLOW3);
    expect(started).toBe(0);
    await close();
  });

  test("a service that refuses the record does not stop the write", async () => {
    const { client, close, service, dir } = await withService({ ".archer/arch.mmd": FLOW });
    service.failNext("recordWrite", { code: "unknown_method", message: "no method recordWrite" });
    const result = await call(client, "write_diagram", { viewId: "arch", source: FLOW3, expectedRevision: rev(FLOW) });
    expect(structured(result)).toMatchObject({ status: "compiled" });
    expect(readFileSync(join(dir, ".archer/arch.mmd"), "utf8")).toBe(FLOW3);
    await close();
  });

  test("summary is checked strictly", async () => {
    const { client, close, service } = await withService({ ".archer/arch.mmd": FLOW });
    for (const summary of [5, "x".repeat(MAX_SUMMARY_CHARS + 1)]) {
      const error = await refusal(client, "write_diagram", {
        viewId: "arch",
        source: FLOW3,
        expectedRevision: rev(FLOW),
        summary,
      });
      expect(error.data.code).toBe("invalid_arguments");
    }
    expect(service.requests).toEqual([]);
    await close();
  });

  test("register_diagram records a write when it changes archer.toml, and not when it changes nothing", async () => {
    const { client, close, service, dir } = await withService({
      "archer.toml": "version = 1\n",
      ".archer/arch.mmd": FLOW,
    });
    let manifest: string | null = "";
    service.onRecordWrite = () => {
      try {
        manifest = readFileSync(join(dir, "archer.toml"), "utf8");
      } catch {
        manifest = null;
      }
    };
    await call(client, "register_diagram", { sourcePath: "arch.mmd", viewId: "overview", title: "Overview" });
    expect(service.requests.filter((r) => r.method === "recordWrite").map((r) => r.params)).toEqual([
      { root: dir, viewId: "overview" },
    ]);
    expect(manifest).toBe("version = 1\n"); // announced before archer.toml changes
    await call(client, "register_diagram", { sourcePath: "arch.mmd" });
    expect(service.requests.filter((r) => r.method === "recordWrite")).toHaveLength(1);
    await close();
  });
});

test("authoring tools never start the service", async () => {
  const { client, close, started } = await withService({ ".archer/arch.mmd": FLOW });
  await call(client, "list_diagrams");
  await call(client, "read_diagram", { viewId: "arch" });
  await call(client, "validate_diagram", { viewId: "arch", source: FLOW });
  expect(started()).toBe(0);
  await close();
});

test("present_diagram starts the service on first need, attaches the project and presents with the caption", async () => {
  const { client, close, service, dir, started } = await withService({ ".archer/arch.mmd": FLOW });
  const result = await call(client, "present_diagram", { viewId: "arch", annotation: "The request path." });
  const payload = structured(result) as Record<string, any>;
  expect(payload.presentation).toEqual({
    presentationId: "p-1",
    viewId: "arch",
    revision: rev(FLOW),
    annotation: "The request path.",
  });
  expect(payload.envelope.view.id).toBe("arch");
  // The diagram's own address (claude-08); following the agent is the separate followUrl.
  expect(payload.ui).toEqual({
    mode: "http",
    url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:4100\/projects\/[a-z0-9-]+\/arch\.mmd\?token=/),
    followUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:4100\/projects\/[a-z0-9-]+\/\?follow&token=/),
  });
  // The link alone on its line, so an agent copies it rather than retyping it (ADR 0014, amended 2026-10-22).
  expect(text(result)).toMatch(
    /^Presenting 'arch' \(rev [^)]+\)\. Give the person this link exactly \(copy it, never retype it\):\nhttp:\/\/127\.0\.0\.1:4100\/\S+$/m,
  );
  expect(service.requests.map((r) => r.method)).toEqual(["hello", "attach", "present", "pendingChanges"]);
  expect(service.requests[2]?.params).toEqual({ root: dir, viewId: "arch", annotation: "The request path." });
  await call(client, "present_diagram", { viewId: "arch" });
  expect(started()).toBe(1);
  expect(service.requests.filter((r) => r.method !== "pendingChanges").at(-1)?.params).toEqual({
    root: dir,
    viewId: "arch",
  });
  await close();
});

test("present_diagram refuses a stale model revision and an unknown view, and presents nothing", async () => {
  const { client, close, service } = await withService({ ".archer/arch.mmd": FLOW });
  const stale = await refusal(client, "present_diagram", { viewId: "arch", expectedRevision: rev(FLOW3) });
  expect(stale.data).toMatchObject({ code: "revision_conflict", modelRevision: rev(FLOW) });
  expect((await refusal(client, "present_diagram", { viewId: "nope" })).data.code).toBe("diagram_not_found");
  expect(service.requests.filter((r) => r.method === "present")).toEqual([]);
  await close();
});

test("present_diagram of a view that never compiled is diagram_not_compiled with the diagnostics", async () => {
  const { client, close } = await withService({ ".archer/arch.mmd": BROKEN });
  const error = await refusal(client, "present_diagram", { viewId: "arch" });
  expect(error.data.code).toBe("diagram_not_compiled");
  expect((error.data.diagnostics as unknown[]).length).toBeGreaterThan(0);
  await close();
});

test("a refusal from the service keeps its code", async () => {
  const { client, close, service } = await withService({ ".archer/arch.mmd": FLOW });
  service.failNext("present", { code: "too_many_views", message: "the service holds too many" });
  const error = await refusal(client, "present_diagram", { viewId: "arch" });
  expect(error.data.code).toBe("too_many_views");
  expect(error.message).toContain("the service holds too many");
  await close();
});

test("a service that cannot be started is an io_failure that names the tool", async () => {
  const dir = tempDir({ ".archer/arch.mmd": FLOW });
  const { client, close } = await connect({ cwd: dir, ensureService: () => connectService(`${dir}/no-such.sock`) });
  const error = await refusal(client, "get_ui_url");
  expect(error.data.code).toBe("io_failure");
  expect(error.message).toContain("get_ui_url needs the Archer service");
  await close();
});

test("a lost connection is reopened through ensureService, once per call", async () => {
  const first = await startFakeService();
  services.push(first);
  let target = first.socketPath;
  let started = 0;
  const ensureService: EnsureService = () => {
    started += 1;
    return connectService(target);
  };
  const { client, close } = await connect({ cwd: tempDir({ ".archer/arch.mmd": FLOW }), ensureService });
  await call(client, "get_ui_url");
  await first.close(); // the service stops: every connection drops

  const second = await startFakeService(); // ensureService starts a new one
  services.push(second);
  target = second.socketPath;
  await call(client, "get_ui_url");
  expect(started).toBe(2);
  expect(second.requests.map((r) => r.method)).toEqual(["hello", "attach", "pendingChanges"]);

  await second.close();
  const error = await refusal(client, "get_ui_url"); // and now nothing answers
  expect(error.data.code).toBe("io_failure");
  expect(started).toBe(3);
  await close();
});

test("set_emphasis resolves the payload against the model and sends it to the service", async () => {
  const { client, close, service, dir } = await withService({ ".archer/arch.mmd": FLOW3 });
  const result = await call(client, "set_emphasis", {
    id: "path",
    viewId: "arch",
    title: "Request path",
    groups: [{ id: "req", label: "req", style: "flow", nodes: ["a", "b"], edges: ["e1"] }],
  });
  const sent = service.requests.find((r) => r.method === "setEmphasis");
  const request = {
    id: "path",
    viewId: "arch",
    title: "Request path",
    groups: [{ id: "req", label: "req", style: "flow", speed: "normal", nodes: ["a", "b"], edges: ["e1"] }],
  };
  expect(sent?.params).toEqual({ root: dir, viewId: "arch", emphases: [request] });
  // What comes back is the wire shape, with the palette and state derived from position.
  const emphasis = { ...request, groups: [{ ...request.groups[0], palette: "teal", state: "existing" }] };
  expect(structured(result)).toEqual({ emphasis });
  await close();
});

const BAD_EMPHASES: [string, Record<string, unknown>, string][] = [
  [
    "an unknown node, with a suggestion",
    { groups: [{ id: "g", label: "g", style: "highlight", nodes: ["aa"] }] },
    'Did you mean "a"?',
  ],
  [
    "a node listed as an edge",
    { groups: [{ id: "g", label: "g", style: "highlight", edges: ["a"] }] },
    "Move it to `nodes`",
  ],
  [
    "a colour",
    { groups: [{ id: "g", label: "g", style: "highlight", palette: "#ff0000", nodes: ["a"] }] },
    "sets palette, which an emphasis no longer accepts",
  ],
  [
    "a proposed state",
    { groups: [{ id: "g", label: "g", style: "highlight", state: "proposed", nodes: ["a"] }] },
    "Proposed is said in the label",
  ],
  ["a group with no label", { groups: [{ id: "g", style: "highlight", nodes: ["a"] }] }, "has no label"],
  [
    "a speed on a highlight",
    { groups: [{ id: "g", label: "g", style: "highlight", speed: "fast", nodes: ["a"] }] },
    "sets a speed on a highlight",
  ],
  ["a group naming nothing", { groups: [{ id: "g", label: "g", style: "flow" }] }, "names neither a node nor an edge"],
  [
    "a repeated group id",
    {
      groups: [
        { id: "g", label: "g", style: "flow", nodes: ["a"] },
        { id: "g", label: "g", style: "flow", nodes: ["b"] },
      ],
    },
    "repeats an id",
  ],
  [
    "four groups",
    { groups: Array.from({ length: 4 }, (_, i) => ({ id: `g${i}`, label: `G${i}`, style: "flow", nodes: ["a"] })) },
    "more than the limit of 3",
  ],
  [
    "an unknown field",
    { groups: [{ id: "g", label: "g", style: "flow", nodes: ["a"], colour: "red" }] },
    'unknown field "colour"',
  ],
  ["groups that are not an array", { groups: "a" }, "groups: is a string, not an array"],
];

test.each(BAD_EMPHASES)(
  "set_emphasis refuses %s, naming every problem, and sends nothing",
  async (_, payload, problem) => {
    const { client, close, service } = await withService({ ".archer/arch.mmd": FLOW3 });
    const error = await refusal(client, "set_emphasis", { id: "e", viewId: "arch", ...payload });
    expect(error.data.code).toBe("invalid_emphasis");
    expect(error.message).toContain(problem);
    expect((error.data.issues as unknown[]).length).toBeGreaterThan(0);
    expect(service.requests).toEqual([]);
    await close();
  },
);

test("set_emphasis on an unknown view suggests the nearest one", async () => {
  const { client, close } = await withService({ ".archer/arch.mmd": FLOW3 });
  const error = await refusal(client, "set_emphasis", { id: "e", viewId: "arc", groups: [] });
  expect(error.data.code).toBe("invalid_emphasis");
  expect(error.message).toContain('Did you mean "arch"?');
  await close();
});

test("set_emphasis on a sequence view points at participants and messages, not fragments", async () => {
  const source =
    "sequenceDiagram\n  participant A as Alice\n  participant B as Bob\n  loop retry\n    A->>B: hi\n  end\n";
  const { client, close } = await withService({ ".archer/login.mmd": source });
  const error = await refusal(client, "set_emphasis", {
    id: "e",
    viewId: "login",
    groups: [{ id: "g", label: "g", style: "highlight", edges: ["frag-0"] }],
  });
  expect(error.message).toContain("which is a fragment and cannot be emphasised");
  const ok = await call(client, "set_emphasis", {
    id: "e",
    viewId: "login",
    groups: [{ id: "g", label: "g", style: "highlight", nodes: ["A"], edges: ["msg-0"] }],
  });
  expect(structured(ok)).toMatchObject({ emphasis: { groups: [{ nodes: ["A"], edges: ["msg-0"] }] } });
  await close();
});

// Presenting and pointing in one call: present_diagram's emphasis is set_emphasis's payload for the
// presented view, validated the same way, and refused whole before anything is shown.
test("present_diagram with an emphasis sets it, then presents, in one call", async () => {
  const { client, close, service, dir } = await withService({ ".archer/arch.mmd": FLOW3 });
  const result = await call(client, "present_diagram", {
    viewId: "arch",
    annotation: "The request path.",
    emphasis: {
      id: "path",
      title: "Request path",
      groups: [{ id: "req", label: "req", style: "flow", nodes: ["a", "b"], edges: ["e1"] }],
    },
  });
  // One request: the service sets the emphasis and presents in one transaction.
  expect(service.requests.map((r) => r.method).filter((m) => m === "setEmphasis" || m === "present")).toEqual([
    "present",
  ]);
  const request = {
    id: "path",
    viewId: "arch",
    title: "Request path",
    groups: [{ id: "req", label: "req", style: "flow", speed: "normal", nodes: ["a", "b"], edges: ["e1"] }],
  };
  expect(service.requests.find((r) => r.method === "present")?.params).toEqual({
    root: dir,
    viewId: "arch",
    annotation: "The request path.",
    emphases: [request],
  });
  const wire = { ...request, groups: [{ ...request.groups[0], palette: "teal", state: "existing" }] };
  // The snapshot is what an MCP App draws from: it has no stream to hear the emphasis on.
  expect(structured(result)).toMatchObject({
    presentation: { viewId: "arch" },
    emphasis: wire,
    emphasisSnapshot: { viewId: "arch", emphases: [wire] },
  });
  expect(text(result)).not.toMatch(/set_emphasis/);
  // The payload's own viewId may be given if it is the presented view's.
  await call(client, "present_diagram", { viewId: "arch", emphasis: { id: "path", viewId: "arch", groups: [] } });
  await close();
});

test("present_diagram's emphasis reaches a service from before present took emphases", async () => {
  const { client, close, service } = await withService({ ".archer/arch.mmd": FLOW3 });
  service.ignorePresentEmphases = true;
  const result = await call(client, "present_diagram", {
    viewId: "arch",
    emphasis: { id: "e", groups: [{ id: "g", label: "g", style: "highlight", nodes: ["a"] }] },
  });
  expect(service.requests.map((r) => r.method).filter((m) => m === "setEmphasis" || m === "present")).toEqual([
    "present",
    "setEmphasis",
  ]);
  expect(structured(result)).toMatchObject({ emphasis: { id: "e" } });
  await close();
});

test.each(BAD_EMPHASES)(
  "present_diagram refuses an emphasis with %s, presenting nothing",
  async (_, payload, problem) => {
    const { client, close, service } = await withService({ ".archer/arch.mmd": FLOW3 });
    const error = await refusal(client, "present_diagram", { viewId: "arch", emphasis: { id: "e", ...payload } });
    expect(error.data.code).toBe("invalid_emphasis");
    expect(error.message).toContain(problem);
    // The refusal names the argument the agent sent, not a tool it did not call.
    expect(error.message).toMatch(
      /present_diagram's emphasis argument was rejected: \d+ problems?\. Nothing was presented/,
    );
    expect(error.message).not.toContain("set_emphasis");
    expect(service.requests).toEqual([]);
    await close();
  },
);

test("present_diagram refuses an emphasis without an id, or for another view", async () => {
  const { client, close, service } = await withService({ ".archer/arch.mmd": FLOW3, ".archer/login.mmd": SEQ });
  const group = [{ id: "g", label: "g", style: "highlight", nodes: ["a"] }];
  for (const emphasis of [{ groups: group }, { id: "e", viewId: "login", groups: group }, "path"]) {
    const error = await refusal(client, "present_diagram", { viewId: "arch", emphasis });
    expect(error.data.code).toBe("invalid_emphasis");
  }
  expect(service.requests).toEqual([]);
  await close();
});

test("present_diagram's emphasis on a sequence takes messages in order", async () => {
  const source = "sequenceDiagram\n  participant A as Alice\n  participant B as Bob\n  A->>B: hi\n  B->>A: ok\n";
  const { client, close } = await withService({ ".archer/login.mmd": source });
  const ok = await call(client, "present_diagram", {
    viewId: "login",
    emphasis: { id: "e", groups: [{ id: "g", label: "g", style: "flow", edges: ["msg-0", "msg-1"] }] },
  });
  expect(structured(ok)).toMatchObject({ emphasis: { groups: [{ edges: ["msg-0", "msg-1"] }] } });
  const lifelines = await call(client, "present_diagram", {
    viewId: "login",
    emphasis: { id: "e", groups: [{ id: "g", label: "g", style: "highlight", nodes: ["A"] }] },
  });
  expect(text(lifelines)).toMatch(/messages \(msg-N\)/);
  await close();
});

// An answer is the picture with its path emphasised and a few sentences (PRODUCT.md principles 1-2),
// said in the result only when it applies.
test("present_diagram suggests emphasis and a short answer until the view has an emphasis this session", async () => {
  const { client, close } = await withService({ ".archer/arch.mmd": FLOW });
  expect(text(await call(client, "present_diagram", { viewId: "arch" }))).toMatch(
    /set_emphasis[^\n]*present_diagram's emphasis[^\n]*few sentences/,
  );
  await call(client, "set_emphasis", {
    id: "e",
    viewId: "arch",
    groups: [{ id: "g", label: "g", style: "highlight", nodes: ["a"] }],
  });
  expect(text(await call(client, "present_diagram", { viewId: "arch" }))).not.toMatch(/set_emphasis/);
  await close();
});

test("set_emphasis on a sequence with participants only says a path is its messages", async () => {
  const source = "sequenceDiagram\n  participant A as Alice\n  participant B as Bob\n  A->>B: hi\n";
  const { client, close } = await withService({ ".archer/login.mmd": source });
  const lifelines = await call(client, "set_emphasis", {
    id: "e",
    viewId: "login",
    groups: [{ id: "g", label: "g", style: "highlight", nodes: ["A", "B"] }],
  });
  expect(text(lifelines)).toMatch(/messages \(msg-N\)/);
  const path = await call(client, "set_emphasis", {
    id: "e",
    viewId: "login",
    groups: [{ id: "g", label: "g", style: "flow", edges: ["msg-0"] }],
  });
  expect(text(path)).not.toMatch(/msg-N/);
  await close();
});

test("an empty groups array clears the emphasis", async () => {
  const { client, close, service } = await withService({ ".archer/arch.mmd": FLOW3 });
  const result = await call(client, "set_emphasis", { id: "path", viewId: "arch", groups: [] });
  expect(text(result)).toContain("Cleared");
  expect(service.requests.find((r) => r.method === "setEmphasis")?.params).toMatchObject({
    emphases: [{ id: "path", groups: [] }],
  });
  await close();
});

test("get_presentation_context reads the selection back with what was presented", async () => {
  const { client, close, service } = await withService({ ".archer/arch.mmd": FLOW, ".archer/login.mmd": SEQ });
  const none = await call(client, "get_presentation_context");
  expect(structured(none)).toEqual({ presentation: null, selection: null });
  expect(text(none)).toContain("no user selection");

  await call(client, "present_diagram", { viewId: "arch" });
  service.selection = {
    schemaVersion: 1,
    viewId: "arch",
    revision: rev(FLOW),
    nodes: [{ id: "a", label: "Client" }],
    edges: [],
  };
  const same = await call(client, "get_presentation_context");
  expect(structured(same)).toMatchObject({ presentation: { viewId: "arch" }, selection: { nodes: [{ id: "a" }] } });
  expect(structured(same)).not.toHaveProperty("readerView");
  expect(text(same)).toContain("includes a user selection");

  service.selection = { schemaVersion: 1, viewId: "login", revision: rev(SEQ), nodes: [], edges: [] };
  const other = await call(client, "get_presentation_context");
  expect(structured(other)).toMatchObject({ readerView: { viewId: "login" } });
  expect(text(other)).toContain("The reader is looking at 'login', not the presented 'arch'.");
  expect(service.requests.filter((r) => r.method === "getContext").length).toBe(3);
  await close();
});

test("get_ui_url reports the project's page", async () => {
  const { client, close, dir } = await withService({});
  const result = await call(client, "get_ui_url");
  expect(structured(result)).toEqual({
    mode: "http",
    url: `http://127.0.0.1:4100/projects/${dir.split("/").pop()?.toLowerCase()}/?token=${"ab".repeat(32)}`,
    followUrl: `http://127.0.0.1:4100/projects/${dir.split("/").pop()?.toLowerCase()}/?follow&token=${"ab".repeat(32)}`,
    boundAddress: "127.0.0.1",
    port: 4100,
    exposure: "loopback",
    project: { name: expect.any(String), root: expect.any(String) },
  });
  expect(text(result)).toMatch(
    /^Archer page of project "[^"]+"; give this link exactly \(copy it, never retype it\):\nhttp:\/\/127\.0\.0\.1:4100\/\S+$/,
  );
  await close();
});

// O36: the warning follows the scheme. A network page over HTTPS is not called plaintext; one over HTTP is.
test.each([
  ["https://192.168.1.42:42403", "network_https", /open to your network over HTTPS/, /plaintext/],
  ["http://192.168.1.42:42403", "network_plaintext_http", /plaintext HTTP on a network interface/, /over HTTPS/],
])("get_ui_url on %s says how the page is exposed", async (base, exposure, says, never) => {
  const { client, close } = await withService({}, { base });
  const result = await call(client, "get_ui_url");
  expect(structured(result)).toMatchObject({ boundAddress: "192.168.1.42", port: 42403, exposure });
  expect(text(result)).toMatch(says);
  expect(text(result)).not.toMatch(never);
  await close();
});

// ---- the contract: the same conversation against the fake and the real service

interface Backend {
  readonly ensureService: EnsureService;
  readonly findService: () => Promise<Awaited<ReturnType<EnsureService>>>;
  /** The reader selects `nodes` on the presented view, as the page would. */
  select(
    root: string,
    stamp: { viewId: string; revision: string; presentationId: string },
    nodes: { id: string; label: string }[],
  ): Promise<void>;
  /** The named emphases the service holds for a view, by id. */
  emphases(root: string, viewId: string): Promise<string[]>;
  /** Who the service says last changed a view, once it has seen the change. */
  lastChange(root: string, viewId: string): Promise<{ by: string; summary?: string } | undefined>;
  close(): Promise<void>;
}

const BACKENDS: [string, () => Promise<Backend>][] = [
  [
    "the fake service",
    async () => {
      const fake = await startFakeService();
      return {
        ensureService: () => connectService(fake.socketPath),
        findService: () => connectService(fake.socketPath),
        lastChange: async (root, viewId) => {
          const write = fake.writes.get(`${root}#${viewId}`);
          return write === undefined ? undefined : { by: "agent", ...write };
        },
        select: async (_root, stamp, nodes) => {
          fake.selection = { schemaVersion: 1, ...stamp, nodes, edges: [] };
        },
        emphases: async (root, viewId) => (fake.emphases.get(`${root}#${viewId}`) ?? []).map((e) => e.id),
        close: () => fake.close(),
      };
    },
  ],
  [
    "the real service",
    async () => {
      const state = tempDir();
      const svc = await startService({
        forceHttp: true,
        stateDir: state,
        env: { HOME: state },
        socketPath: `${state}/archer.sock`,
        log: () => {},
      });
      const pageOf = async (root: string) => {
        const client = await connectService(svc.socketPath);
        try {
          return apiBase((await client.call("attach", { root })).url);
        } finally {
          client.close();
        }
      };
      return {
        ensureService: () => connectService(svc.socketPath),
        findService: () => connectService(svc.socketPath),
        lastChange: async (root, viewId) => {
          const { views } = (await (await ownerFetch(`${await pageOf(root)}api/diagrams`)).json()) as {
            views: { id: string; lastChange?: { by: string; summary?: string } }[];
          };
          const change = views.find((v) => v.id === viewId)?.lastChange;
          return change === undefined
            ? undefined
            : { by: change.by, ...(change.summary === undefined ? {} : { summary: change.summary }) };
        },
        select: async (root, stamp, nodes) => {
          const reply = await ownerFetch(`${await pageOf(root)}api/selection`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ schemaVersion: 1, ...stamp, selectionRevision: 1, nodes, edges: [] }),
          });
          expect(reply.status).toBe(204);
        },
        emphases: async (root, viewId) => {
          const payload = (await (await ownerFetch(`${await pageOf(root)}api/emphasis/${viewId}`)).json()) as {
            emphases: { id: string }[];
          };
          return payload.emphases.map((e) => e.id);
        },
        close: () => svc.close(),
      };
    },
  ],
];

describe.each(BACKENDS)("against %s", (_name, start) => {
  const opened: Backend[] = [];
  afterEach(async () => {
    for (const b of opened.splice(0)) await b.close();
  });

  async function session(files: Record<string, string>) {
    const backend = await start();
    opened.push(backend);
    const dir = tempDir(files);
    const connected = await connect({
      cwd: dir,
      ensureService: backend.ensureService,
      findService: backend.findService,
    });
    return { ...connected, backend, dir };
  }

  test("management snapshots expose a different client's presentation and last-good model", async () => {
    const { backend, dir, close } = await session({ ".archer/arch.mmd": FLOW });
    const first = await backend.ensureService();
    const fresh = await backend.ensureService();
    try {
      await first.call("attach", { root: dir });
      const shown = await first.call("present", { root: dir, viewId: "arch", annotation: "Shared" });
      const context = await fresh.call("getContext", { root: dir });
      expect(context).toMatchObject({
        presentation: {
          presentationId: shown.presentationId,
          viewId: "arch",
          revision: rev(FLOW),
          annotation: "Shared",
        },
        selection: null,
      });
      const good = await fresh.call("getModel", { root: dir, viewId: "arch" });
      expect(good.envelope?.revision).toBe(rev(FLOW));
      write(dir, ".archer/arch.mmd", "flowchart LR\n  a[A] --> b[B]\n");
      expect(await fresh.call("getModel", { root: dir, viewId: "arch" })).toEqual(good);
      await expect(fresh.call("getModel", { root: dir, viewId: "missing" })).rejects.toMatchObject({
        error: { code: "diagram_not_found" },
      });
    } finally {
      first.close();
      fresh.close();
      await close();
    }
  });

  test("write_diagram with a summary is the agent's change, with that summary", async () => {
    const { client, close, backend, dir } = await session({ ".archer/arch.mmd": FLOW });
    await call(client, "present_diagram", { viewId: "arch" });
    await call(client, "write_diagram", {
      viewId: "arch",
      source: FLOW3,
      expectedRevision: rev(FLOW),
      summary: "added the database",
    });
    await expect.poll(() => backend.lastChange(dir, "arch")).toEqual({ by: "agent", summary: "added the database" });
    await close();
  });

  test("present_diagram and get_ui_url name the same project and follow address, and the presentation carries the service's id", async () => {
    const { client, close } = await session({ ".archer/arch.mmd": FLOW });
    const presented = structured(
      await call(client, "present_diagram", { viewId: "arch", annotation: "The path." }),
    ) as Record<string, any>;
    expect(presented.presentation).toEqual({
      presentationId: expect.any(String),
      viewId: "arch",
      revision: rev(FLOW),
      annotation: "The path.",
    });
    const ui = structured(await call(client, "get_ui_url")) as Record<string, any>;
    // Each link names its own page (claude-08): the diagram, the project; both follow the agent only at followUrl.
    expect(ui.followUrl).toBe(presented.ui.followUrl);
    expect(presented.ui.url).toBe(String(ui.url).replace("/?token=", "/arch.mmd?token="));
    expect(ui).toMatchObject({
      mode: "http",
      boundAddress: "127.0.0.1",
      exposure: "loopback",
      url: expect.stringMatching(
        /^http:\/\/127\.0\.0\.1:\d+\/projects\/[a-z0-9-]+\/\?token=[0-9a-f]{32}(?:[0-9a-f]{32})?$/,
      ),
    });
    await close();
  });

  test("set_emphasis merges by id: the same id replaces, an empty groups array clears", async () => {
    const { client, close, backend, dir } = await session({ ".archer/arch.mmd": FLOW3 });
    const group = (nodes: string[]) => [{ id: "g", label: "g", style: "highlight", nodes }];
    await call(client, "set_emphasis", { id: "one", viewId: "arch", groups: group(["a"]) });
    await call(client, "set_emphasis", { id: "two", viewId: "arch", groups: group(["b"]) });
    await call(client, "set_emphasis", { id: "one", viewId: "arch", groups: group(["c"]) });
    expect(await backend.emphases(dir, "arch")).toEqual(["one", "two"]);
    await call(client, "set_emphasis", { id: "one", viewId: "arch", groups: [] });
    expect(await backend.emphases(dir, "arch")).toEqual(["two"]);
    await close();
  });

  test("get_presentation_context reads back what the reader selected on the presented view", async () => {
    const { client, close, backend, dir } = await session({ ".archer/arch.mmd": FLOW });
    expect(structured(await call(client, "get_presentation_context"))).toEqual({ presentation: null, selection: null });
    const { presentation } = structured(await call(client, "present_diagram", { viewId: "arch" })) as {
      presentation: { presentationId: string; revision: string };
    };
    await backend.select(
      dir,
      { viewId: "arch", revision: presentation.revision, presentationId: presentation.presentationId },
      [{ id: "a", label: "Client" }],
    );
    const context = await call(client, "get_presentation_context");
    expect(structured(context)).toMatchObject({
      presentation: { viewId: "arch" },
      selection: { viewId: "arch", nodes: [{ id: "a", label: "Client" }], edges: [] },
    });
    expect(text(context)).toContain("includes a user selection");
    await close();
  });
});

test("against the real service, the agent's write and the person's edit are told apart on the page's stream", async () => {
  const state = tempDir();
  const svc = await startService({
    forceHttp: true,
    stateDir: state,
    env: { HOME: state },
    socketPath: `${state}/archer.sock`,
    log: () => {},
  });
  const dir = tempDir({ ".archer/arch.mmd": FLOW });
  const { client, close } = await connect({
    cwd: dir,
    ensureService: () => connectService(svc.socketPath),
    findService: () => connectService(svc.socketPath),
  });
  try {
    const { ui } = structured(await call(client, "present_diagram", { viewId: "arch" })) as { ui: { url: string } };
    const stream = await events(`${apiBase(ui.url)}api/events`);
    await call(client, "write_diagram", {
      viewId: "arch",
      source: FLOW3,
      expectedRevision: rev(FLOW),
      summary: "added the database",
    });
    expect(await stream.next("change")).toEqual({
      viewId: "arch",
      at: expect.any(String),
      by: "agent",
      summary: "added the database",
      added: ["c", "e2"],
      changed: [],
      removed: [],
    });
    write(dir, ".archer/arch.mmd", FLOW);
    expect(await stream.next("change")).toMatchObject({
      by: "person",
      removed: [
        { id: "c", label: "DB" },
        { id: "e2", label: "b → c" },
      ],
    });
    stream.close();
  } finally {
    await close();
    await svc.close();
  }
});

test("against the real service, a selection whose model has moved on is not handed to the agent", async () => {
  const state = tempDir();
  const svc = await startService({
    forceHttp: true,
    stateDir: state,
    env: { HOME: state },
    socketPath: `${state}/archer.sock`,
    log: () => {},
  });
  const dir = tempDir({ ".archer/arch.mmd": FLOW });
  const { client, close } = await connect({ cwd: dir, ensureService: () => connectService(svc.socketPath) });
  try {
    const { presentation, ui } = structured(await call(client, "present_diagram", { viewId: "arch" })) as {
      presentation: { presentationId: string; revision: string };
      ui: { url: string };
    };
    const body = {
      schemaVersion: 1,
      viewId: "arch",
      revision: presentation.revision,
      presentationId: presentation.presentationId,
      nodes: [{ id: "a" }],
      edges: [],
    };
    expect(
      (
        await ownerFetch(`${apiBase(ui.url)}api/selection`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(204);
    write(dir, ".archer/arch.mmd", FLOW3);
    await expect
      .poll(
        async () => (structured(await call(client, "get_presentation_context")) as { selection: unknown }).selection,
      )
      .toBeNull();
  } finally {
    await close();
    await svc.close();
  }
});
