// Exercise both production adapters against one real project and Unix-socket
// service. Reset files between mutations, so revision checks see identical input.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { browserAuthor } from "../application/cumulative-review-support.ts";
import { OPERATIONS } from "../../src/application/index.ts";
import { main, type Io } from "../../src/bin/main.ts";
import { CommentsStore, type Place } from "../../src/comments/store.ts";
import { findProject, revisionOf } from "../../src/project/index.ts";
import { connectService } from "../../src/service/client.ts";
import { call, connect, refusal, structured, text } from "../mcp/support.ts";
import { cleanUp, project, service } from "../service/support.ts";

afterEach(cleanUp);
const names = [
  "list_diagrams",
  "read_diagram",
  "read_note",
  "validate_diagram",
  "write_diagram",
  "register_diagram",
  "set_selection",
  "present_diagram",
  "list_emphases",
  "set_emphasis",
  "get_presentation_context",
  "get_ui_url",
  "list_note_emphases",
  "set_note_emphasis",
  "list_changes",
  "create_comment",
  "get_comments",
  "reply_comment",
  "resolve_comment",
  "list_walkthroughs",
  "write_walkthrough",
  "find_elements",
];
// Git and export adapter parity use real history/renderers in application/{accuracy,export}.test.ts.
test("parity scopes cover every advertised operation", () => {
  expect(
    [
      ...names,
      "export_diagram",
      "measure_diagram",
      "docs_index",
      "list_stale_diagrams",
      "read_diagram_at_commit",
      "compare_diagrams",
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
      "read_change",
      "resolve_change",
    ].sort(),
  ).toEqual(OPERATIONS.map((operation) => operation.name).sort());
});

// Only generated presentation IDs and newly created agent thread/comment IDs and
// timestamps differ. Existing thread IDs, semantic IDs, revisions and content stay asserted.
function comparable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(comparable);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  if (record["profile"] === "desktop-1025x896-gutter24" && record["inspect"] !== undefined) {
    // The owner-approved attachment may finish in 150ms on one adapter and be pending
    // on the other. Compare its snapshot/inspection contract exactly; explicit measurement
    // parity tests compare the complete geometry, without normalizing completion state.
    expect(["pending", "ready", "partial", "unavailable"]).toContain(record["status"]);
    expect(record["version"]).toBe(1);
    expect(record["sourceRevision"]).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(record["inspect"]).toMatchObject({ tool: "measure_diagram", arguments: { viewId: expect.any(String) } });
    if (record["status"] === "pending") expect(record["suggestions"]).toBeUndefined();
    else {
      expect(Array.isArray(record["suggestions"])).toBe(true);
      expect((record["suggestions"] as unknown[]).length).toBeLessThanOrEqual(1);
      if (record["status"] === "unavailable") expect(record["reason"]).toEqual(expect.any(String));
    }
    return {
      version: record["version"],
      profile: record["profile"],
      sourceRevision: record["sourceRevision"],
      inspect: comparable(record["inspect"]),
    };
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [
      key,
      key === "presentationId"
        ? "generated-presentation"
        : key === "writtenAt"
          ? "generated-time"
          : key === "id" && Array.isArray(record["comments"]) && record["comments"][0]?.author === "agent"
            ? "generated-agent-thread"
            : record["author"] === "agent" && (key === "id" || key === "createdAt")
              ? `generated-${key}`
              : comparable(item),
    ]),
  );
}

async function setup() {
  const root = project();
  const { svc } = await service();
  const attached = await connectService(svc.socketPath);
  try {
    await attached.call("attach", { root });
  } finally {
    attached.close();
  }
  const env = { ARCHER_SOCKET: svc.socketPath };
  const mcp = await connect({
    cwd: root,
    findService: () => connectService(svc.socketPath),
    ensureService: () => connectService(svc.socketPath),
  });
  const store = new CommentsStore(findProject(root));
  const place: Place = {
    target: "view:flow",
    path: "flow.comments.json",
    subject: { kind: "view", elements: new Map() },
  };
  const thread = store.create(place, { anchor: { kind: "view" }, body: "Please explain this flow" }).value;
  store.submit();
  await call(mcp.client, "get_comments", {});
  writeFileSync(join(root, ".archer/note.md"), "# Note\n\nThe client sends a signed token to the API.\n");
  writeFileSync(
    join(root, ".archer/note.md.emphases.json"),
    `${JSON.stringify({ schemaVersion: 1, notePath: "note.md", revision: 0, emphases: [] }, null, 2)}\n`,
  );
  const paths = [
    join(root, "archer.toml"),
    join(root, ".archer/flow.mmd"),
    join(root, ".archer/flow.comments.json"),
    join(root, ".archer/note.md"),
    join(root, ".archer/note.md.emphases.json"),
  ];
  const originals = paths.map((path) => readFileSync(path, "utf8"));
  const snapshot = () =>
    paths.map((path, i) =>
      i === 2 || i === 4 ? comparable(JSON.parse(readFileSync(path, "utf8"))) : readFileSync(path, "utf8"),
    );
  const restore = () => paths.forEach((path, i) => writeFileSync(path, originals[i]!));
  const cli = async (name: string, args: object) => {
    let out = "",
      err = "";
    const io: Io & { stdin: () => Promise<string> } = {
      cwd: root,
      env,
      isTTY: false,
      columns: undefined,
      stdout: (text) => (out += text),
      stderr: (text) => (err += text),
      stdin: async () => JSON.stringify(args),
    };
    const code = await main(["call", name, "--stdin", "--json"], io);
    return { code, out, err };
  };
  const args: Record<string, Record<string, unknown>> = {
    set_selection: {
      schemaVersion: 1,
      viewId: "flow",
      revision: revisionOf(Buffer.from(originals[1]!)),
      presentationId: "reader:flow",
      nodes: [{ id: "a" }],
      edges: [],
    },
    list_changes: {},
    list_diagrams: {},
    read_diagram: { viewId: "flow" },
    find_elements: { query: "client" },
    read_note: { notePath: "note.md" },
    validate_diagram: { viewId: "flow", source: originals[1]! },
    write_diagram: {
      viewId: "flow",
      source: originals[1]!.replace("Client", "Updated client"),
      expectedRevision: revisionOf(Buffer.from(originals[1]!)),
    },
    register_diagram: { sourcePath: "chat.mmd", viewId: "chat", kind: "sequence", title: "Conversation" },
    present_diagram: { viewId: "flow", annotation: "Shared adapter parity" },
    list_emphases: { viewId: "flow" },
    set_emphasis: {
      viewId: "flow",
      id: "parity",
      groups: [{ id: "customer", label: "customer", style: "highlight", nodes: ["a"] }],
    },
    list_note_emphases: { notePath: "note.md" },
    set_note_emphasis: {
      notePath: "note.md",
      id: "auth",
      title: "Authentication",
      expectedRevision: 0,
      groups: [
        {
          id: "token",
          label: "Token exchange",
          passages: [{ kind: "passage", quote: "signed token", prefix: "The client sends a ", suffix: " to the API." }],
        },
      ],
    },
    get_presentation_context: {},
    get_ui_url: {},
    create_comment: {
      target: "view:flow",
      anchor: { kind: "node", id: "a", label: "caller label" },
      body: "Agent-opened question",
    },
    get_comments: { target: "view:flow" },
    reply_comment: { threadId: thread.id, expectedRevision: 1, body: "The client sends a request." },
    resolve_comment: { threadId: thread.id, expectedRevision: 1, note: "Reviewed together" },
    list_walkthroughs: { viewId: "flow" },
    write_walkthrough: {
      viewId: "flow",
      modelRevision: revisionOf(Buffer.from(originals[1]!)),
      walkthrough: {
        id: "parity",
        title: "Parity",
        steps: [{ title: "Ask", kind: "sends", what: "A request.", edges: [{ id: "e1" }] }],
      },
    },
  };
  return { root, env, svc, ...mcp, cli, args, snapshot, restore, originals };
}

test.each(names)("MCP and CLI %s return equal results and leave equal production state", async (name) => {
  const fixture = await setup();
  try {
    // Seed live context and emphasis before discovery/context operations.
    if (name === "get_presentation_context") await call(fixture.client, "present_diagram", { viewId: "flow" });
    if (name === "list_emphases") await call(fixture.client, "set_emphasis", fixture.args["set_emphasis"]!);
    const mcp = structured(await call(fixture.client, name, fixture.args[name]!));
    const mcpFiles = fixture.snapshot();
    const sidecar = join(fixture.root, ".archer/flow.walkthroughs.json");
    const wrote = existsSync(sidecar) ? readFileSync(sidecar, "utf8") : null;
    if (wrote !== null) rmSync(sidecar);
    fixture.restore();
    const cli = await fixture.cli(name, fixture.args[name]!);
    expect(cli.code, cli.err).toBe(0);
    expect(comparable(JSON.parse(cli.out))).toEqual(comparable(mcp));
    expect(fixture.snapshot()).toEqual(mcpFiles);
    // Both adapters wrote the same walkthrough file (its time aside).
    if (name === "write_walkthrough")
      expect(JSON.parse(readFileSync(sidecar, "utf8"), (key, value) => (key === "writtenAt" ? "" : value))).toEqual(
        JSON.parse(wrote!, (key, value) => (key === "writtenAt" ? "" : value)),
      );
    if (name === "write_diagram")
      expect(readFileSync(join(fixture.root, ".archer/flow.mmd"), "utf8")).toBe(fixture.args[name]!["source"]);
    if (name === "register_diagram")
      expect(findProject(fixture.root).views.some((view) => view.id === "chat" && view.kind === "sequence")).toBe(true);
    if (
      name === "create_comment" ||
      name === "get_comments" ||
      name === "reply_comment" ||
      name === "resolve_comment"
    ) {
      const file = JSON.parse(readFileSync(join(fixture.root, ".archer/flow.comments.json"), "utf8"));
      if (name === "create_comment") {
        expect(file.threads.at(-1).id).toMatch(/^t-[0-9a-f]{12}$/);
        expect(file.threads.at(-1).id).not.toBe(file.threads[0].id);
        expect(file.threads.at(-1)).toMatchObject({
          status: "answered",
          anchor: { kind: "node", id: "a", label: "Client" },
          comments: [{ author: "agent", body: "Agent-opened question" }],
        });
      } else
        expect(file.threads[0].status).toBe(
          name === "reply_comment" ? "answered" : name === "resolve_comment" ? "resolved" : "sent",
        );
      if (name === "reply_comment")
        expect(file.threads[0].comments.at(-1)).toMatchObject({ author: "agent", body: fixture.args[name]!["body"] });
    }
    if (name === "set_note_emphasis") {
      const file = JSON.parse(readFileSync(join(fixture.root, ".archer/note.md.emphases.json"), "utf8"));
      expect(file).toMatchObject({ revision: 1, emphases: [{ id: "auth", author: "agent" }] });
    }
    if (name === "set_emphasis") {
      const held = await connectService(fixture.svc.socketPath);
      try {
        const listing = await held.call("listEmphases", { root: fixture.root, viewId: "flow" });
        expect(listing.views[0]?.emphases[0]).toMatchObject({
          id: "parity",
          groups: [{ nodes: ["a"], palette: "teal" }],
        });
      } finally {
        held.close();
      }
    }
  } finally {
    await fixture.close();
  }
});

test("MCP and CLI create_comment on a walkthrough step and list openComments equally", async () => {
  const fixture = await setup();
  try {
    await call(fixture.client, "write_walkthrough", fixture.args["write_walkthrough"]!);
    const anchor = { kind: "step", walkthrough: "parity", step: "ask", label: "caller label" };
    const mcp = structured(
      await call(fixture.client, "create_comment", { target: "view:flow", anchor, body: "Is this step enough?" }),
    );
    const cli = await fixture.cli("create_comment", { target: "view:flow", anchor, body: "Is this step enough?" });
    expect(cli.code, cli.err).toBe(0);
    expect(comparable(JSON.parse(cli.out))).toEqual(comparable(mcp));
    expect(mcp).toMatchObject({ anchor: { kind: "step", step: "ask", label: "1. Ask" } });
    // Agent-opened threads are answered, hence open: both adapters count the two threads alike.
    const listed = structured(await call(fixture.client, "list_walkthroughs", { viewId: "flow" }));
    const viaCli = await fixture.cli("list_walkthroughs", { viewId: "flow" });
    expect(JSON.parse(viaCli.out)).toEqual(listed);
    expect(listed).toMatchObject({ walkthroughs: [{ id: "parity", openComments: 2 }] });
  } finally {
    await fixture.close();
  }
});

test("MCP and CLI access operations share durable grants and independent revocation", async () => {
  const fixture = await setup();
  try {
    const first = structured(await call(fixture.client, "issue_access_link", { label: "MCP browser" })) as Record<
      string,
      unknown
    >;
    const issued = await fixture.cli("issue_access_link", { label: "CLI browser" });
    expect(issued.code, issued.err).toBe(0);
    const second = JSON.parse(issued.out) as Record<string, unknown>;
    expect(first["token"]).not.toBe(second["token"]);
    const listed = await fixture.cli("list_access_links", {});
    expect(listed.code, listed.err).toBe(0);
    expect(JSON.parse(listed.out)).toEqual(structured(await call(fixture.client, "list_access_links", {})));
    expect(listed.out).not.toContain(String(first["token"]));
    const revoked = await fixture.cli("revoke_access_link", { grantId: first["id"] });
    expect(JSON.parse(revoked.out)).toEqual({ revoked: true });
    const grants = structured(await call(fixture.client, "list_access_links", {})) as {
      grants: { id: string; revokedAt: string | null }[];
    };
    expect(grants.grants.find((grant) => grant.id === first["id"])?.revokedAt).toEqual(expect.any(String));
    expect(grants.grants.find((grant) => grant.id === second["id"])?.revokedAt).toBeNull();
    expect(structured(await call(fixture.client, "revoke_access_link", { grantId: second["id"] }))).toEqual({
      revoked: true,
    });
  } finally {
    await fixture.close();
  }
});

test("MCP, archer call and archer pair issue pairing codes from one service; each result gives the address and the code alone on their lines", async () => {
  const fixture = await setup();
  try {
    const result = await call(fixture.client, "issue_pairing_code", {});
    const issued = structured(result) as { code: string; url: string; minutes: number };
    expect(issued.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(issued.minutes).toBe(5);
    const lines = text(result).split("\n");
    expect(lines).toContain(issued.url);
    expect(lines).toContain(issued.code);
    expect(text(result)).toContain("5 minutes");
    const cli = await fixture.cli("issue_pairing_code", {});
    expect(cli.code, cli.err).toBe(0);
    expect(JSON.parse(cli.out).code).not.toBe(issued.code);
    let out = "",
      err = "";
    const code = await main(["pair"], {
      cwd: fixture.root,
      env: fixture.env,
      isTTY: false,
      columns: undefined,
      stdout: (line) => (out += line),
      stderr: (line) => (err += line),
    });
    expect(code, err).toBe(0);
    const pair = out.split("\n");
    expect(pair).toContain(issued.url);
    expect(
      pair.some((line) => /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(line) && line !== issued.code),
    ).toBe(true);
    expect(
      await main(["pair", "extra"], {
        cwd: fixture.root,
        env: fixture.env,
        isTTY: false,
        columns: undefined,
        stdout: () => {},
        stderr: () => {},
      }),
    ).toBe(2);
  } finally {
    await fixture.close();
  }
});

test.each([
  {
    name: "write_diagram",
    args: { viewId: "flow", source: "flowchart LR\n a[A]", expectedRevision: `sha256:${"0".repeat(64)}` },
    code: "revision_conflict",
  },
  { name: "register_diagram", args: { sourcePath: "../outside.mmd" }, code: "path_outside_archer_folder" },
  {
    name: "set_emphasis",
    args: { viewId: "flow", id: "bad", groups: [{ id: "g", label: "g", style: "highlight", nodes: ["missing"] }] },
    code: "invalid_emphasis",
  },
  {
    name: "reply_comment",
    args: { threadId: "missing", expectedRevision: 1, body: "Reply" },
    code: "thread_not_found",
  },
])("MCP and CLI refuse $name identically without changing files", async ({ name, args, code }) => {
  const fixture = await setup();
  try {
    const before = fixture.snapshot();
    const error = await refusal(fixture.client, name, args);
    expect(error.data["code"]).toBe(code);
    const result = await fixture.cli(name, args);
    expect(result.code).toBe(1);
    const output = JSON.parse(result.err);
    expect(output.code).toBe(code);
    const { code: _code, ...details } = error.data;
    expect(output.details).toEqual(details);
    expect(fixture.snapshot()).toEqual(before);
  } finally {
    await fixture.close();
  }
});

test("fresh CLI invocations discover presentation and retain the service's last good model", async () => {
  const fixture = await setup();
  try {
    const shown = await fixture.cli("present_diagram", { viewId: "flow", annotation: "Fresh command context" });
    expect(shown.code, shown.err).toBe(0);
    const presentation = JSON.parse(shown.out).presentation;
    const context = await fixture.cli("get_presentation_context", {});
    expect(context.code, context.err).toBe(0);
    expect(JSON.parse(context.out).presentation).toEqual(presentation);
    const { BROKEN } = await import("../service/support.ts");
    writeFileSync(join(fixture.root, ".archer/flow.mmd"), BROKEN);
    const read = await fixture.cli("read_diagram", { viewId: "flow" });
    expect(read.code, read.err).toBe(0);
    expect(JSON.parse(read.out)).toMatchObject({
      modelRevision: presentation.revision,
      sourceRevision: revisionOf(Buffer.from(BROKEN)),
      compile: { status: "failed", lastValidRevision: presentation.revision },
      envelope: { revision: presentation.revision, view: { id: "flow" } },
      source: { text: BROKEN },
    });
    const emphasized = await fixture.cli("set_emphasis", fixture.args["set_emphasis"]!);
    expect(emphasized.code, emphasized.err).toBe(0);
    expect(JSON.parse(emphasized.out)).toMatchObject({ emphasis: { id: "parity", groups: [{ nodes: ["a"] }] } });
  } finally {
    await fixture.close();
  }
});

test("archer call present_diagram presents and emphasises in one call, or refuses both", async () => {
  const fixture = await setup();
  try {
    const emphasis = { id: "one-call", groups: [{ id: "g", label: "Client", style: "highlight", nodes: ["a"] }] };
    const shown = await fixture.cli("present_diagram", { viewId: "flow", emphasis });
    expect(shown.code, shown.err).toBe(0);
    expect(JSON.parse(shown.out)).toMatchObject({
      presentation: { viewId: "flow" },
      emphasis: { id: "one-call", groups: [{ nodes: ["a"] }] },
    });
    const listed = await fixture.cli("list_emphases", { viewId: "flow" });
    expect(JSON.parse(listed.out).views[0].emphases.map((e: { id: string }) => e.id)).toContain("one-call");
    const before = JSON.parse((await fixture.cli("get_presentation_context", {})).out).presentation;
    const bad = await fixture.cli("present_diagram", {
      viewId: "flow",
      annotation: "never shown",
      emphasis: { id: "bad", groups: [{ id: "g", label: "g", style: "highlight", nodes: ["missing"] }] },
    });
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.err)).toMatchObject({ code: "invalid_emphasis" });
    expect(JSON.parse((await fixture.cli("get_presentation_context", {})).out).presentation).toEqual(before);
  } finally {
    await fixture.close();
  }
});

test("CLI and MCP read cumulative reviews identically, share stale-clear refusal and clear with current CAS", async () => {
  const f = await setup(),
    admin = await connectService(f.svc.socketPath);
  try {
    const author = await browserAuthor(f.svc, admin, f.root),
      source = f.originals[1]!;
    await author.save(source.replace("Client", "First parity"));
    const saved = await author.save(source.replace("Client", "Latest parity"));
    const review = saved.review as { reviewId: string; reviewRevision: number };
    for (const [name, args] of [
      ["list_changes", {}],
      ["read_change", { changeId: review.reviewId, part: "baseline" }],
      ["read_change", { changeId: review.reviewId, part: "latest" }],
    ] as const) {
      const mcp = structured(await call(f.client, name, args));
      const cli = await f.cli(name, args);
      expect(cli.code, cli.err).toBe(0);
      expect(JSON.parse(cli.out)).toEqual(mcp);
    }
    const args = {
      reviewId: review.reviewId,
      expectedReviewRevision: review.reviewRevision - 1,
      disposition: "cleared",
      summary: "Understood both parity edits; no questions needed.",
    };
    const mcp = await refusal(f.client, "resolve_change", args),
      cli = await f.cli("resolve_change", args);
    expect(cli.code).toBe(1);
    expect(mcp.data.code).toBe("change_review_conflict");
    const { code, ...details } = mcp.data;
    expect(JSON.parse(cli.err)).toMatchObject({ code, details });
    const resolved = await f.cli("resolve_change", { ...args, expectedReviewRevision: review.reviewRevision });
    expect(resolved.code, resolved.err).toBe(0);
    expect(JSON.parse(resolved.out).review.state).toBe("cleared");
    expect(
      (structured(await call(f.client, "list_changes", {})) as { cumulativeReviews: { reviews: unknown[] } })
        .cumulativeReviews.reviews,
    ).toEqual([]);
    expect(readFileSync(join(f.root, ".archer/flow.mmd"), "utf8")).toBe(source.replace("Client", "Latest parity"));
  } finally {
    admin.close();
    await f.close();
  }
});

test("CLI and MCP issue independently scoped authoring grants through the same production boundary", async () => {
  const f = await setup();
  try {
    const args = { label: "Authoring parity", projectRoots: [f.root] };
    const first = structured(await call(f.client, "issue_authoring_access", args)) as Record<string, unknown>,
      cli = await f.cli("issue_authoring_access", args);
    expect(cli.code, cli.err).toBe(0);
    const second = JSON.parse(cli.out);
    for (const result of [first, second]) {
      expect(result.projectRoots).toEqual([f.root]);
      expect(result.entitlementId).toEqual(expect.any(String));
      expect(result.token).toEqual(expect.any(String));
    }
    expect(first.token).not.toBe(second.token);
    expect(first.entitlementId).not.toBe(second.entitlementId);
  } finally {
    await f.close();
  }
});
