// Phase 3, the front door and presence, on the service's side: the inventory's new fields,
// api/search, the `change` event, and who changed a view (recordWrite).
import { readFileSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import { DIAGRAM_KINDS, type DiagramKind, type DiagramModel } from "../../src/model/index.ts";
import { connectService, MAX_SUMMARY_CHARS, type ServiceClient } from "../../src/service/index.ts";
import {
  diffElements,
  GROUP_OF_KIND,
  groupOf,
  MAX_QUERY_CHARS,
  MAX_SEARCH_RESULTS,
} from "../../src/service/front-door.ts";
import { ProjectState } from "../../src/service/project-state.ts";
import { revisionOf } from "../../src/project/envelope.ts";
import {
  cleanUp,
  events,
  exactly,
  FLOW,
  http,
  json,
  project,
  service,
  tempDir,
  write,
  type Reply,
  apiBase,
  pageHttp,
} from "./support.ts";

afterEach(cleanUp);
const clients: ServiceClient[] = [];
afterEach(() => clients.splice(0).forEach((c) => c.close()));

async function model(source: string): Promise<DiagramModel> {
  const { model } = await compile(source);
  if (model === null) throw new Error(`does not compile: ${source}`);
  return model;
}

describe("groups", () => {
  const EXPECTED: Record<DiagramKind, string> = {
    freeform: "system",
    "c4-context": "system",
    "c4-container": "system",
    "c4-component": "system",
    "c4-code": "system",
    "data-flow": "system",
    c4: "system",
    architecture: "system",
    sequence: "behaviour",
    state: "behaviour",
    "entity-relationship": "data",
    journey: "journeys",
  };

  test.each(DIAGRAM_KINDS.map((k) => [k]))("%s has its group", (kind) => {
    expect(groupOf(kind)).toBe(EXPECTED[kind]);
    expect(GROUP_OF_KIND[kind]).toBe(EXPECTED[kind]);
  });

  test("a kind Archer does not know goes under other", () => {
    expect(groupOf("mindmap")).toBe("other");
    expect(groupOf("toString")).toBe("other");
  });
});

describe("diffElements", () => {
  test("added, relabelled and removed elements, by id, the removed with their last label", async () => {
    const before = await model("flowchart LR\n  a[Client] e1@--> b[API]\n  b e2@--> c[DB]\n");
    const after = await model("flowchart LR\n  a[Browser] e1@--> b[API]\n  b e3@--> d[Cache]\n");
    expect(diffElements(before, after)).toEqual({
      added: ["d", "e3"],
      changed: ["a"],
      removed: [
        { id: "c", label: "DB" },
        { id: "e2", label: "b → c" },
      ],
    });
  });

  test("nothing moved is three empty lists", async () => {
    const same = await model(FLOW);
    expect(diffElements(same, await model(FLOW))).toEqual({ added: [], changed: [], removed: [] });
  });

  test("a sequence diagram's participants and messages", async () => {
    const before = await model("sequenceDiagram\n  participant A as Alice\n  participant B as Bob\n  A->>B: hi\n");
    const after = await model("sequenceDiagram\n  participant A as Alice\n  participant C as Carol\n  A->>C: hello\n");
    const diff = diffElements(before, after);
    expect(diff.added).toContain("C");
    expect(diff.removed).toContainEqual({ id: "B", label: "Bob" });
  });
});

// ------------------------------------------------------------- the service

const NOTE = "---\ndiagrams: [flow.mmd]\n---\n# Auth decision\n\nTokens are short-lived and rotated.\n";
const LONE = "# Glossary\n\nA quokka is a small marsupial.\n";

async function attached(files: Record<string, string> = {}, extra: { readonly comments?: "queued" } = {}) {
  const { svc, state } = await service({}, extra);
  const c = await connectService(svc.socketPath);
  clients.push(c);
  const root = project();
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  const page = apiBase((await c.call("attach", { root })).url);
  const origin = `http://127.0.0.1:${svc.port}`;
  const post = async (path: string, body: unknown): Promise<unknown> => {
    const reply = await pageHttp(`${page}${path}`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (reply.status !== 200) throw new Error(`POST ${path}: ${reply.status} ${reply.body}`);
    return JSON.parse(reply.body) as unknown;
  };
  return { svc, state, c, root, page, post };
}

type Entry = Record<string, any>;
const inventory = async (page: string): Promise<Entry[]> =>
  ((await json(`${page}api/diagrams`)) as { views: Entry[] }).views;
const entry = async (page: string, id: string): Promise<Entry | undefined> =>
  (await inventory(page)).find((v) => v.id === id);

describe("inventory", () => {
  test("each view carries its group, counts, open threads by state and, at first, its file's time by the person", async () => {
    const root = project();
    const when = new Date("2026-09-01T10:00:00.000Z");
    utimesSync(join(root, ".archer/flow.mmd"), when, when);
    const { svc } = await service();
    const c = await connectService(svc.socketPath);
    clients.push(c);
    const page = apiBase((await c.call("attach", { root })).url);
    // The dates have their own test below; which source CREATED comes from depends on the file system.
    const undated = (await inventory(page)).map(({ createdAt: _created, createdFrom: _from, ...rest }) => rest);
    expect(undated).toEqual([
      {
        id: "flow",
        sourcePath: "flow.mmd",
        kind: "freeform",
        title: "The flow",
        registration: "durable",
        group: "system",
        counts: { elements: 2, links: 1 },
        modelRevision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        // The file's bytes revision, as an authoring receipt names it (claude-308).
        sourceRevision: revisionOf(readFileSync(join(root, ".archer/flow.mmd"))),
        threads: { draft: 0, sent: 0, read: 0, answered: 0, resolved: 0 },
        lastChange: { at: when.toISOString(), by: "person" },
        modifiedAt: when.toISOString(),
      },
      {
        id: "chat",
        sourcePath: "chat.mmd",
        kind: "sequence",
        title: "chat",
        registration: "durable",
        group: "behaviour",
        counts: { elements: 2, links: 1 },
        modelRevision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        // The file's bytes revision, as an authoring receipt names it (claude-308).
        sourceRevision: revisionOf(readFileSync(join(root, ".archer/chat.mmd"))),
        threads: { draft: 0, sent: 0, read: 0, answered: 0, resolved: 0 },
        lastChange: { at: statSync(join(root, ".archer/chat.mmd")).mtime.toISOString(), by: "person" },
        modifiedAt: statSync(join(root, ".archer/chat.mmd")).mtime.toISOString(),
      },
    ]);
  });

  test("each diagram and note says what it is about and when it was created and edited, in the inventory, api/notes/all and api/projects", async () => {
    const { page } = await attached({
      ".archer/described.mmd": "%% description: Where requests go\nflowchart LR\n  a[A]\n",
      ".archer/commented.mmd": "%% The cache path\nflowchart LR\n  a[A]\n",
      ".archer/auth.md": "---\ndescription: Why tokens rotate\n---\n# Auth\n\nProse.\n",
      ".archer/loose.md": "# Glossary\n\nA quokka is a small marsupial.\n",
    });
    // CREATED comes from the file system's birth time, or Git, which this project is not in
    // (ts/test/project/file-dates.test.ts covers both); EDITED is always there.
    const dated = (item: Entry | undefined): void => {
      expect(Date.parse(item?.modifiedAt)).not.toBeNaN();
      if (item?.createdAt !== undefined) {
        expect(item.createdFrom).toBe("filesystem");
        expect(Date.parse(item.createdAt)).not.toBeNaN();
      } else expect(item).not.toHaveProperty("createdFrom");
    };
    expect(await entry(page, "described")).toMatchObject({
      description: "Where requests go",
      descriptionFrom: "comment",
    });
    expect(await entry(page, "commented")).toMatchObject({ description: "The cache path", descriptionFrom: "derived" });
    expect(await entry(page, "flow")).not.toHaveProperty("description");
    dated(await entry(page, "flow"));
    const notes = ((await json(`${page}api/notes/all`)) as { notes: Entry[] }).notes;
    const auth = notes.find((n) => n.path === "auth.md");
    expect(auth).toMatchObject({ description: "Why tokens rotate", descriptionFrom: "frontmatter" });
    dated(auth);
    expect(notes.find((n) => n.path === "loose.md")).toMatchObject({
      description: "A quokka is a small marsupial.",
      descriptionFrom: "derived",
    });
    const catalog = (await json(`${page}api/projects`)) as { projects: { views: Entry[]; notes: Entry[] }[] };
    expect(catalog.projects[0]?.views.find((v) => v.id === "described")).toMatchObject({
      description: "Where requests go",
    });
    expect(catalog.projects[0]?.notes.find((n) => n.path === "auth.md")).toMatchObject({
      description: "Why tokens rotate",
    });
  });

  test("thread counts follow the comments, and the inventory event says so", async () => {
    const { page, post } = await attached({}, { comments: "queued" });
    const stream = await events(`${page}api/events`);
    await post("api/comments", { target: "view:flow", anchor: { kind: "view" }, body: "Why?" });
    await post("api/comments", {
      target: "view:flow",
      anchor: { kind: "node", id: "a", label: "Client" },
      body: "And this?",
    });
    await expect
      .poll(async () => (await entry(page, "flow"))?.threads)
      .toEqual({ draft: 2, sent: 0, read: 0, answered: 0, resolved: 0 });
    await post("api/comments/submit", {});
    expect((await entry(page, "flow"))?.threads).toMatchObject({ draft: 0, sent: 2 });
    const announced = (await stream.next("inventory")) as { views: Entry[] };
    expect(announced.views.find((v) => v.id === "flow")?.threads).toMatchObject({ draft: 1 });
    stream.close();
  });

  test("the caption is the agent's latest for the view, and a view never presented has none", async () => {
    const { c, root, page } = await attached();
    await c.call("present", { root, viewId: "flow", annotation: "Where requests go" });
    expect(await entry(page, "flow")).toMatchObject({ caption: "Where requests go", presentedAt: expect.any(String) });
    expect(await entry(page, "chat")).not.toHaveProperty("caption");
    await c.call("present", { root, viewId: "chat", annotation: "The handshake" });
    await c.call("present", { root, viewId: "flow", annotation: "Now the cache" });
    expect((await entry(page, "flow"))?.caption).toBe("Now the cache");
    expect((await entry(page, "chat"))?.caption).toBe("The handshake");
    await c.call("present", { root, viewId: "flow" });
    expect(await entry(page, "flow")).not.toHaveProperty("caption");
  });

  test("a view that never compiled has no counts", async () => {
    const { page } = await attached({ ".archer/broken.mmd": "flowchart LR\n  a[A] --> b[B]\n" });
    const broken = await entry(page, "broken");
    expect(broken).toMatchObject({ id: "broken", group: "system" });
    expect(broken).not.toHaveProperty("counts");
  });
});

describe("api/search", () => {
  const files = { ".archer/auth.md": NOTE, ".archer/docs/glossary.md": LONE };

  type Result = {
    target: string;
    title: string;
    where: string[];
    matches: Record<string, string>[];
    moreMatches?: number;
  };
  async function full(page: string, q: string): Promise<{ query: string; results: Result[] }> {
    return (await json(`${page}api/search?q=${encodeURIComponent(q)}`)) as never;
  }
  /** The answer as an older page reads it: `where`, unchanged by the match fields. */
  async function search(
    page: string,
    q: string,
  ): Promise<{ query: string; results: { target: string; title: string; where: string[] }[] }> {
    const answer = await full(page, q);
    for (const r of answer.results) expect(Array.isArray(r.matches)).toBe(true);
    return {
      query: answer.query,
      results: answer.results.map(({ target, title, where }) => ({ target, title, where })),
    };
  }

  test("finds a view by its title, its kind, its Mermaid source, its notes and its comments, and says where", async () => {
    const { page, post } = await attached(files);
    await post("api/comments", { target: "view:chat", anchor: { kind: "view" }, body: "Should Bob retry on timeout?" });
    expect(await search(page, "the FLOW")).toEqual({
      query: "the FLOW",
      results: [{ target: "view:flow", title: "The flow", where: ["title", "diagram"] }],
    });
    expect((await search(page, "sequence")).results).toEqual([
      { target: "view:chat", title: "chat", where: ["title", "diagram"] },
    ]);
    expect((await search(page, "client")).results).toEqual([
      { target: "view:flow", title: "The flow", where: ["diagram"] },
    ]);
    expect((await search(page, "rotated")).results).toEqual([
      { target: "view:flow", title: "The flow", where: ["note"] },
      { target: "note:auth.md", title: "Auth decision", where: ["note"] },
    ]);
    expect((await search(page, "timeout")).results).toEqual([
      { target: "view:chat", title: "chat", where: ["comment"] },
    ]);
  });

  test("every word must match, anywhere in the card; a note about nothing is its own result", async () => {
    const { page } = await attached(files);
    expect((await search(page, "client tokens")).results).toEqual([
      { target: "view:flow", title: "The flow", where: ["diagram", "note"] },
    ]);
    expect((await search(page, "client quokka")).results).toEqual([]);
    expect((await search(page, "QUOKKA glossary")).results).toEqual([
      { target: "note:docs/glossary.md", title: "Glossary", where: ["title", "note"] },
    ]);
  });

  test("each result names the fields it matched in, and the element of the compiled model", async () => {
    const { page, post } = await attached(files);
    const posted = (await post("api/comments", {
      target: "view:chat",
      anchor: { kind: "view" },
      body: "Should Bob retry on timeout?",
    })) as { id: string };
    expect((await full(page, "client")).results).toEqual([
      {
        target: "view:flow",
        title: "The flow",
        where: ["diagram"],
        matches: [{ field: "node", text: "Client", elementId: "a" }],
      },
    ]);
    expect((await full(page, "flow.mmd")).results[0]?.matches).toEqual([{ field: "path", text: "flow.mmd" }]);
    expect((await full(page, "the flow")).results[0]?.matches).toEqual([
      { field: "title", text: "The flow" },
      { field: "path", text: "flow.mmd" },
    ]);
    // A sequence: its participant, by label and by id.
    expect((await full(page, "alice")).results).toEqual([
      {
        target: "view:chat",
        title: "chat",
        where: ["diagram"],
        matches: [{ field: "participant", text: "Alice", elementId: "A" }],
      },
    ]);
    const hi = (await full(page, "hi")).results.find((r) => r.target === "view:chat");
    expect(hi?.matches).toEqual([{ field: "message", text: "hi", elementId: expect.any(String) }]);
    expect((await full(page, "rotated")).results).toEqual([
      {
        target: "view:flow",
        title: "The flow",
        where: ["note"],
        matches: [{ field: "note", text: expect.stringContaining("rotated"), notePath: "auth.md" }],
      },
      {
        target: "note:auth.md",
        title: "Auth decision",
        where: ["note"],
        matches: [{ field: "note", text: expect.stringContaining("rotated") }],
      },
    ]);
    const threadId = posted.id;
    expect((await full(page, "timeout")).results).toEqual([
      {
        target: "view:chat",
        title: "chat",
        where: ["comment"],
        matches: [{ field: "comment", text: "Should Bob retry on timeout?", threadId }],
      },
    ]);
    expect((await full(page, "glossary")).results).toEqual([
      {
        target: "note:docs/glossary.md",
        title: "Glossary",
        where: ["title", "note"],
        matches: [
          { field: "title", text: "Glossary" },
          { field: "path", text: "docs/glossary.md" },
          { field: "note", text: "# Glossary A quokka is a small marsupial." },
        ],
      },
    ]);
  });

  test("a word only in the source, in no element, is a source match", async () => {
    const { page } = await attached({
      ".archer/flow.mmd": "flowchart LR\n  %% wombat path\n  a[Client] e1@--> b[API]\n",
    });
    expect((await full(page, "wombat")).results).toEqual([
      {
        target: "view:flow",
        title: "The flow",
        where: ["diagram"],
        matches: [{ field: "source", text: "%% wombat path" }],
      },
    ]);
  });

  test("matches stop at the cap, and say how many more", async () => {
    const nodes = Array.from({ length: 8 }, (_, i) => `  n${i}[Needle ${i}]`).join("\n");
    const { page } = await attached({ ".archer/flow.mmd": `flowchart LR\n${nodes}\n` });
    const [result] = (await full(page, "needle")).results;
    expect(result?.matches).toHaveLength(5);
    expect(result?.moreMatches).toBe(3);
  });

  test("a note's comments find the note", async () => {
    const { page, post } = await attached(files);
    await post("api/comments", { target: "note:docs/glossary.md", anchor: { kind: "view" }, body: "Add wombat" });
    expect((await search(page, "wombat")).results).toEqual([
      { target: "note:docs/glossary.md", title: "Glossary", where: ["comment"] },
    ]);
  });

  test("refuses no query, an empty one and an over-long one, and answers nothing without a credential", async () => {
    const { page } = await attached();
    const code = (reply: Reply) => [reply.status, (JSON.parse(reply.body) as { error: { code: string } }).error.code];
    expect(code(await pageHttp(`${page}api/search`))).toEqual([422, "invalid_request"]);
    expect(code(await pageHttp(`${page}api/search?q=%20%20`))).toEqual([422, "invalid_request"]);
    expect(code(await pageHttp(`${page}api/search?q=${"x".repeat(MAX_QUERY_CHARS + 1)}`))).toEqual([
      422,
      "invalid_request",
    ]);
    expect((await pageHttp(`${page}api/search?q=${"x".repeat(MAX_QUERY_CHARS)}`)).status).toBe(200);
    expect((await pageHttp(`${page}api/search?q=flow`, { method: "POST" })).status).toBe(404);
    expect((await exactly(`${page}api/search?q=flow`)).status).toBe(404);
  });

  test("results stop at the cap", async () => {
    const extra: Record<string, string> = {};
    for (let i = 0; i < MAX_SEARCH_RESULTS + 5; i++) extra[`.archer/many/n${i}.md`] = `# Note ${i}\n\nneedle\n`;
    const { page } = await attached(extra);
    expect((await search(page, "needle")).results).toHaveLength(MAX_SEARCH_RESULTS);
  });
});

describe("the change event and who changed it", () => {
  test("a person's edit: what was added, relabelled and removed, by the person", async () => {
    const { root, page } = await attached();
    const stream = await events(`${page}api/events`);
    write(root, ".archer/flow.mmd", "flowchart LR\n  a[Browser] e1@--> c[DB]\n");
    expect(await stream.next("change")).toEqual({
      viewId: "flow",
      at: expect.any(String),
      by: "person",
      added: ["c"],
      changed: ["a", "e1"],
      removed: [{ id: "b", label: "API" }],
    });
    expect((await entry(page, "flow"))?.lastChange).toEqual({ at: expect.any(String), by: "person" });
    stream.close();
  });

  test("a recorded write is the agent's, with its summary, in the event and the inventory", async () => {
    const { c, root, page } = await attached();
    const stream = await events(`${page}api/events`);
    expect(await c.call("recordWrite", { root, viewId: "flow", summary: "added the database" })).toEqual({
      recorded: true,
    });
    write(root, ".archer/flow.mmd", "flowchart LR\n  a[Client] e1@--> b[API]\n  b e2@--> c[DB]\n");
    const change = (await stream.next("change")) as Entry;
    expect(change).toEqual({
      viewId: "flow",
      at: expect.any(String),
      by: "agent",
      summary: "added the database",
      added: ["c", "e2"],
      changed: [],
      removed: [],
    });
    expect((await entry(page, "flow"))?.lastChange).toEqual({
      at: change.at,
      by: "agent",
      summary: "added the database",
    });

    // The record is spent: the next edit is the person's.
    write(root, ".archer/flow.mmd", FLOW);
    expect(await stream.next("change")).toMatchObject({ by: "person", removed: [{ id: "c" }, { id: "e2" }] });
    expect((await entry(page, "flow"))?.lastChange).toEqual({ at: expect.any(String), by: "person" });
    stream.close();
  });

  test("a source that stops compiling changes lastChange but sends no change", async () => {
    const { c, root, page } = await attached();
    const stream = await events(`${page}api/events`);
    await c.call("recordWrite", { root, viewId: "flow", summary: "tried something" });
    write(root, ".archer/flow.mmd", "flowchart LR\n  a[A] --> b[B]\n");
    await stream.next("compile");
    expect((await entry(page, "flow"))?.lastChange).toMatchObject({ by: "agent", summary: "tried something" });
    write(root, ".archer/flow.mmd", "flowchart LR\n  a[Client] e1@--> b[Server]\n");
    // Diffed against the last model that compiled.
    expect(await stream.next("change")).toMatchObject({ by: "person", added: [], changed: ["b"], removed: [] });
    stream.close();
  });

  test("recordWrite refuses an unattached project, a bad view id and an over-long summary", async () => {
    const { c, root } = await attached();
    await expect(c.call("recordWrite", { root: tempDir(), viewId: "flow" })).rejects.toMatchObject({
      error: { code: "project_not_attached" },
    });
    await expect(c.call("recordWrite", { root, viewId: "../x" })).rejects.toMatchObject({
      error: { code: "invalid_params" },
    });
    await expect(
      c.call("recordWrite", { root, viewId: "flow", summary: "x".repeat(MAX_SUMMARY_CHARS + 1) }),
    ).rejects.toMatchObject({ error: { code: "invalid_params" } });
    await expect(c.call("recordWrite", { root, viewId: "flow", summary: 3 } as never)).rejects.toMatchObject({
      error: { code: "invalid_params" },
    });
  });

  test("a write recorded longer ago than the window is the person's", async () => {
    const root = project();
    let now = Date.parse("2026-10-04T10:00:00.000Z");
    const state = await ProjectState.open(
      root,
      (slug) => `http://x/${slug}/`,
      () => {},
      { now: () => now },
    );
    try {
      const seen: [string, Entry][] = [];
      state.subscribe((event, payload) => seen.push([event, payload as Entry]));
      state.recordWrite("flow", "late");
      now += 6_000;
      write(root, ".archer/flow.mmd", "flowchart LR\n  a[Client] e1@--> b[Gateway]\n");
      await state.reload();
      expect(seen.find(([e]) => e === "change")?.[1]).toMatchObject({
        by: "person",
        at: "2026-10-04T10:00:06.000Z",
        changed: ["b"],
      });

      state.recordWrite("flow", "in time");
      now += 4_000;
      write(root, ".archer/flow.mmd", FLOW);
      await state.reload();
      expect(seen.filter(([e]) => e === "change").at(-1)?.[1]).toMatchObject({
        by: "agent",
        summary: "in time",
        at: "2026-10-04T10:00:10.000Z",
      });
    } finally {
      state.close();
    }
  });

  test("after a restart, unchanged source retains exact agent change attribution", async () => {
    const { svc, state, c, root, page } = await attached();
    const stream = await events(`${page}api/events`);
    await c.call("recordWrite", { root, viewId: "flow", summary: "agent work" });
    write(root, ".archer/flow.mmd", "flowchart LR\n  a[Client] e1@--> b[Gateway]\n");
    await stream.next("change");
    const before = (await entry(page, "flow"))?.lastChange;
    expect(before).toMatchObject({ by: "agent", summary: "agent work" });
    stream.close();
    c.close();
    await svc.close();

    const again = await service({ stateDir: state });
    const c2 = await connectService(again.svc.socketPath);
    clients.push(c2);
    const { url } = await c2.call("attach", { root });
    expect((await entry(apiBase(url), "flow"))?.lastChange).toEqual(before);
  });
});
