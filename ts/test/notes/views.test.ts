// Slice C on the service side (ADR 0012): a diagram embedded in a note is a
// view under its address -- listed, served, presented, commented on and
// emphasised, by the person and by the agent -- and the first comment or
// emphasis pins its name into the note; viewing and selecting never do.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { connectService as connectMcpService } from "../../src/mcp/index.ts";
import { connectService, startService, type ServiceClient } from "../../src/service/index.ts";
import {
  cleanUp,
  events,
  http,
  json,
  service,
  tempDir as svcTempDir,
  write,
  apiBase,
  pageHttp,
} from "../service/support.ts";
import { call, connect, structured } from "../mcp/support.ts";

afterEach(cleanUp);
const clients: ServiceClient[] = [];
afterEach(() => clients.splice(0).forEach((c) => c.close()));

const NOTE = [
  "# Auth",
  "",
  "## Login flow",
  "",
  "```mermaid",
  "flowchart LR",
  '  user["User"] e1@--> api["API"]',
  "```",
  "",
  "Prose.",
  "",
].join("\n");
const ADDRESS = "notes/auth.md#login-flow";
const enc = encodeURIComponent;

async function attached(note = NOTE) {
  const { svc } = await service();
  const c = await connectService(svc.socketPath);
  clients.push(c);
  const root = svcTempDir("archer-proj-");
  write(root, ".archer/notes/auth.md", note);
  const page = apiBase((await c.call("attach", { root })).url);
  const origin = `http://127.0.0.1:${svc.port}`;
  const post = (path: string, body: unknown) =>
    pageHttp(`${page}${path}`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const file = join(root, ".archer/notes/auth.md");
  return { svc, c, root, page, post, file, note: () => readFileSync(file, "utf8") };
}

describe("an embedded diagram is a view under its address", () => {
  test("listed in the inventory, apart from file views, and served by address", async () => {
    const { page } = await attached();
    const inventory = (await json(`${page}api/diagrams`)) as { views: Record<string, unknown>[] };
    expect(inventory.views).toEqual([
      expect.objectContaining({
        id: ADDRESS,
        title: "Login flow",
        kind: "freeform",
        registration: "embedded",
        sourcePath: "notes/auth.md",
        note: "notes/auth.md",
        name: "login-flow",
      }),
    ]);
    const envelope = (await json(`${page}api/diagrams/${enc(ADDRESS)}`)) as {
      view: { id: string };
      model: { type: string };
    };
    expect(envelope.view.id).toBe(ADDRESS);
    expect(envelope.model.type).toBe("freeform-graph");
  });

  test("presented by address; a selection on it never touches the note", async () => {
    const { c, root, page, post, note } = await attached();
    const { presentationId } = (await c.call("present", { root, viewId: ADDRESS, openBrowser: false })) as {
      presentationId: string;
    };
    const boot = (await json(`${page}api/bootstrap`)) as { presentation: { viewId: string; revision: string } };
    expect(boot.presentation.viewId).toBe(ADDRESS);
    const selected = await post("api/selection", {
      schemaVersion: 1,
      viewId: ADDRESS,
      revision: boot.presentation.revision,
      presentationId,
      nodes: [{ id: "user" }],
      edges: [],
    });
    expect(selected.status).toBe(204);
    expect(note()).toBe(NOTE);
  });

  test("the first comment pins its name, beside the note, and moves neither the model nor its revision", async () => {
    const { page, post, root, note } = await attached();
    const before = (await json(`${page}api/diagrams/${enc(ADDRESS)}`)) as { revision: string };
    const created = await post("api/comments", {
      target: `view:${ADDRESS}`,
      anchor: { kind: "node", id: "user", label: "User" },
      body: "Who is this?",
    });
    expect(created.status, created.body).toBe(200);
    expect(note()).toBe(NOTE.replace("```mermaid\n", "```mermaid\n%% archer-id: login-flow\n"));
    expect(existsSync(join(root, ".archer/notes/auth.login-flow.comments.json"))).toBe(true);
    const listed = (await json(`${page}api/comments?target=${enc(`view:${ADDRESS}`)}`)) as { threads: unknown[] };
    expect(listed.threads).toHaveLength(1);
    // The pinned note recompiles to the same model at the same revision.
    await expect
      .poll(async () => ((await json(`${page}api/diagrams`)) as { views: { id: string }[] }).views.map((v) => v.id))
      .toEqual([ADDRESS]);
    expect(((await json(`${page}api/diagrams/${enc(ADDRESS)}`)) as { revision: string }).revision).toBe(
      before.revision,
    );
    // Its comments survive the block moving below another one: the name is pinned now.
    writeFileSync(
      join(root, ".archer/notes/auth.md"),
      note().replace("## Login flow\n", '## Login flow\n\n```mermaid\nflowchart TB\n  z["Z"]\n```\n'),
    );
    await expect
      .poll(async () =>
        ((await json(`${page}api/diagrams`)) as { views: { id: string }[] }).views.map((v) => v.id).sort(),
      )
      .toEqual([ADDRESS, "notes/auth.md#login-flow-2"].sort());
    expect(
      ((await json(`${page}api/comments?target=${enc(`view:${ADDRESS}`)}`)) as { threads: { orphaned?: boolean }[] })
        .threads[0]?.orphaned,
    ).toBeUndefined();
  });

  test("an emphasis pins its name too", async () => {
    const { c, root, note } = await attached();
    await c.call("setEmphasis", {
      root,
      viewId: ADDRESS,
      emphases: [
        { id: "path", groups: [{ id: "g", label: "g", style: "highlight", nodes: ["user", "api"], edges: ["e1"] }] },
      ],
    });
    expect(note()).toContain("%% archer-id: login-flow\nflowchart LR");
  });

  test("a block that is renamed is gone from its old address, and its presentation with it", async () => {
    const { c, root, page, file } = await attached();
    await c.call("present", { root, viewId: ADDRESS, openBrowser: false });
    writeFileSync(file, NOTE.replace("```mermaid\n", "```mermaid\n%% archer-id: sign-in\n"));
    await expect
      .poll(async () => ((await json(`${page}api/diagrams`)) as { views: { id: string }[] }).views.map((v) => v.id))
      .toEqual(["notes/auth.md#sign-in"]);
    expect(((await json(`${page}api/bootstrap`)) as { presentation?: unknown }).presentation ?? null).toBeNull();
    expect((await pageHttp(`${page}api/diagrams/${enc(ADDRESS)}`)).status).toBe(404);
  });
});

test("the agent presents, emphasises, writes and reads comments by address, and the page sees the write live", async () => {
  const state = svcTempDir("archer-state-");
  const svc = await startService({
    forceHttp: true,
    stateDir: state,
    env: { HOME: state },
    socketPath: `${state}/archer.sock`,
    log: () => {},
  });
  const dir = svcTempDir("archer-proj-");
  write(dir, ".archer/notes/auth.md", NOTE);
  const { client, close } = await connect({
    cwd: dir,
    ensureService: () => connectMcpService(svc.socketPath),
    findService: () => connectMcpService(svc.socketPath),
  });
  try {
    const presented = structured(await call(client, "present_diagram", { viewId: ADDRESS })) as {
      presentation: { viewId: string };
      envelope: { view: { id: string } };
      ui: { url: string };
    };
    expect(presented.presentation.viewId).toBe(ADDRESS);
    expect(presented.envelope.view.id).toBe(ADDRESS);
    const stream = await events(`${apiBase(presented.ui.url)}api/events`);

    const emphasised = await call(client, "set_emphasis", {
      id: "path",
      viewId: ADDRESS,
      groups: [{ id: "g", label: "g", style: "flow", nodes: ["user"], edges: ["e1"] }],
    });
    expect(emphasised.isError ?? false).toBe(false);
    expect(readFileSync(join(dir, ".archer/notes/auth.md"), "utf8")).toContain("%% archer-id: login-flow");

    const read = structured(await call(client, "read_diagram", { viewId: ADDRESS })) as { sourceRevision: string };
    await call(client, "write_diagram", {
      viewId: ADDRESS,
      source: '%% archer-id: login-flow\nflowchart LR\n  user["User"] e1@--> api["API"]\n  api e2@--> db[("DB")]\n',
      expectedRevision: read.sourceRevision,
    });
    expect(await stream.next("change")).toMatchObject({ viewId: ADDRESS, added: ["db", "e2"] });
    stream.close();

    const page = apiBase(presented.ui.url);
    const origin = new URL(page).origin;
    await pageHttp(`${page}api/comments`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({
        target: `view:${ADDRESS}`,
        anchor: { kind: "node", id: "db", label: "DB" },
        body: "Which database?",
      }),
    });
    await pageHttp(`${page}api/comments/submit`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: "{}",
    });
    const comments = structured(await call(client, "get_comments", { target: `view:${ADDRESS}` })) as {
      threads: { target: string }[];
    };
    expect(comments.threads.map((t) => t.target)).toEqual([`view:${ADDRESS}`]);
  } finally {
    await close();
    await svc.close();
  }
});

// From a Codex review of note views.
describe("embedded views, adversarially", () => {
  test("views that would share a comments file are both refused before either can adopt it", async () => {
    const { c, root, page, post } = await attached();
    write(
      root,
      "archer.toml",
      'version = 1\n[[views]]\nid = "legacy"\nkind = "freeform"\ntitle = "Legacy"\nsource = ".archer/notes/auth.login-flow.mmd"\n',
    );
    write(root, ".archer/notes/auth.login-flow.mmd", 'flowchart LR\n  user["User"]\n');
    await c.call("attach", { root });
    await expect
      .poll(async () =>
        ((await json(`${page}api/diagrams`)) as { views: { id: string }[] }).views.map((v) => v.id).sort(),
      )
      .toEqual(["legacy", ADDRESS].sort());
    for (const target of ["view:legacy", `view:${ADDRESS}`]) {
      const refused = await post("api/comments", { target, anchor: { kind: "view" }, body: "Mine?" });
      expect(refused.status, target).toBe(409);
      expect(JSON.parse(refused.body), target).toMatchObject({ error: { code: "comments_file_conflict" } });
    }
    expect(existsSync(join(root, ".archer/notes/auth.login-flow.comments.json"))).toBe(false);
  });

  test("a block nested in a list cannot have its name pinned, so it is not commented on, and says why", async () => {
    const nested = '# Auth\n\n- In a list:\n\n  ```mermaid\n  flowchart LR\n    a["A"]\n  ```\n';
    const { post, note } = await attached(nested);
    const refused = await post("api/comments", {
      target: "view:notes/auth.md#auth",
      anchor: { kind: "view" },
      body: "?",
    });
    expect(refused.status).toBe(422);
    expect(JSON.parse(refused.body).error.message).toContain("nested");
    expect(note()).toBe(nested);
  });

  test("a renamed heading and moved prose refresh an explicitly named block's title and problem lines", async () => {
    const named = NOTE.replace("```mermaid\n", "```mermaid\n%% archer-id: login-flow\n");
    const { page, file } = await attached(named);
    writeFileSync(file, `Intro.\n\n${named.replace("## Login flow", "## Signing in")}`);
    await expect
      .poll(async () =>
        ((await json(`${page}api/diagrams`)) as { views: { title: string }[] }).views.map((v) => v.title),
      )
      .toEqual(["Signing in"]);
  });

  test("a note whose path cannot spell an address offers no diagram, and is not published", async () => {
    const { root, page } = await attached();
    write(root, ".archer/notes/a?b.md", NOTE);
    // A second note, written after it, whose diagram shows the reload took both.
    write(root, ".archer/notes/touch.md", '# Touch\n\n```mermaid\nflowchart LR\n  t["T"]\n```\n');
    await expect
      .poll(async () =>
        ((await json(`${page}api/diagrams`)) as { views: { id: string }[] }).views.map((v) => v.id).sort(),
      )
      .toEqual([ADDRESS, "notes/touch.md#touch"].sort());
  });
});

test("a restart over a broken embedded block keeps its last good drawing and says it is broken", async () => {
  const first = await service();
  const c1 = await connectService(first.svc.socketPath);
  const root = svcTempDir("archer-proj-");
  write(root, ".archer/notes/auth.md", NOTE);
  await c1.call("attach", { root });
  await c1.call("present", { root, viewId: ADDRESS, openBrowser: false });
  write(root, ".archer/notes/auth.md", NOTE.replace('e1@--> api["API"]', "--> api[API]"));
  const { url } = (await c1.call("attach", { root })) as { url: string };
  await expect
    .poll(async () =>
      ((await json(`${apiBase(url)}api/compile`)) as { failures: { viewId: string }[] }).failures.map((f) => f.viewId),
    )
    .toEqual([ADDRESS]);
  c1.close();
  await first.svc.close();
  const second = await service({ stateDir: first.state });
  const c2 = await connectService(second.svc.socketPath);
  clients.push(c2);
  const again = (await c2.call("attach", { root })) as { url: string };
  expect(
    ((await json(`${apiBase(again.url)}api/compile`)) as { failures: { viewId: string }[] }).failures.map(
      (f) => f.viewId,
    ),
  ).toEqual([ADDRESS]);
  expect(
    ((await json(`${apiBase(again.url)}api/diagrams/${enc(ADDRESS)}`)) as { model: { nodes: unknown[] } }).model.nodes,
  ).toHaveLength(2);
});

test("an emphasis on an embedded diagram survives a service restart", async () => {
  const first = await service();
  const c1 = await connectService(first.svc.socketPath);
  const root = svcTempDir("archer-proj-");
  write(root, ".archer/notes/auth.md", NOTE);
  await c1.call("attach", { root });
  await c1.call("setEmphasis", {
    root,
    viewId: ADDRESS,
    emphases: [{ id: "path", groups: [{ id: "g", label: "g", style: "highlight", nodes: ["user"], edges: ["e1"] }] }],
  });
  // Let the pin's recompile land before the service goes, as it would in use.
  const { url } = (await c1.call("attach", { root })) as { url: string };
  await expect
    .poll(async () =>
      ((await json(`${apiBase(url)}api/emphasis/${enc(ADDRESS)}`)) as { emphases: { id: string }[] }).emphases.map(
        (e) => e.id,
      ),
    )
    .toEqual(["path"]);
  c1.close();
  await first.svc.close();
  const second = await service({ stateDir: first.state });
  const c2 = await connectService(second.svc.socketPath);
  clients.push(c2);
  const listed = (await c2.call("listEmphases", { root, viewId: ADDRESS })) as unknown as {
    views: { viewId: string; emphases: { id: string }[] }[];
  };
  expect(listed.views[0]?.emphases.map((e) => e.id)).toEqual(["path"]);
  const again = (await c2.call("attach", { root })) as { url: string };
  expect(
    ((await json(`${apiBase(again.url)}api/emphasis/${enc(ADDRESS)}`)) as { emphases: { id: string }[] }).emphases.map(
      (e) => e.id,
    ),
  ).toEqual(["path"]);
});
