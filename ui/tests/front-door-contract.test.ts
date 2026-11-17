// The front door's contract (phase 3,
// with what the server slice settled): the inventory's new fields,
// `api/search`, and the `change` event, read through the page's own parsers,
// against the TypeScript service: what the page's reading of each route is
// held to.
import { commentOperation } from "./support/comment-operations";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseBrowserConnection } from "../src/app/http-connection";
import { parseInventory, type DiagramView } from "../src/app/inventory";
import { parseProjectCatalog } from "../src/app/project-directory";
import { parseSearch, type SearchAnswer } from "../src/app/search";
import { parseChange, type ViewChange } from "../src/app/change";
import { parseCommentActivity } from "../src/app/comment-activity";
import { parseThread } from "../src/comments/parse";
import { parseWalkthroughs } from "../src/walkthroughs/parse";
import { startTsProject } from "./support/ts-service";

const PIPELINE = "flowchart LR\n  lexer[Lexer] e1@--> parser[Parser]\n  parser e2@--> checker[Checker]\n";
const PIPELINE_AFTER =
  "flowchart LR\n  parser[Parser and lexer] e2@--> checker[Checker]\n  checker e3@--> emitter[Emitter]\n";
const LOGIN = "sequenceDiagram\n  participant B as Browser\n  participant S as Server\n  B->>S: POST /login\n";
const PARSING = "# Parsing\n\nThe tokenizer hands tokens to the parser.\n";
const IDEAS = "# Ideas\n\nSomeday, incremental compilation.\n";

type Server = {
  /** The agent's link to the page: opening it signs the browser in. */
  readonly url: string;
  /** An API route (`api/…`) fetched as the signed-in browser sends it. */
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>;
  /** An API route (`api/…`), absolute. */
  readonly api: (path: string) => string;
  present(viewId: string, caption?: string): Promise<void>;
  /** The agent rewriting the pipeline: Lexer merged into Parser, an Emitter added. */
  agentRewrite(summary: string): Promise<void>;
  stop(): Promise<void>;
};

const view = (id: string, kind: string, title: string): string =>
  `[[views]]\nid = "${id}"\nkind = "${kind}"\ntitle = "${title}"\nsource = ".archer/${id}.mmd"\n\n`;

async function startService(): Promise<Server> {
  const project = await startTsProject({
    commentSubmission: "queued",
    files: {
      "archer.toml": `version = 1\n\n${view("pipeline", "freeform", "Compile pipeline")}${view("login", "sequence", "Sign in")}`,
      ".archer/pipeline.mmd": PIPELINE,
      ".archer/login.mmd": LOGIN,
      ".archer/notes/parsing.md": `---\ndiagrams: [../pipeline.mmd]\n---\n${PARSING}`,
      ".archer/notes/ideas.md": IDEAS,
    },
  });
  return {
    url: project.url,
    fetch: (path, init) => project.fetch(path, init),
    api: (path) => project.api(path),
    present: (id, caption) => project.present(id, caption),
    agentRewrite: (summary) => project.agentWrite("pipeline", ".archer/pipeline.mmd", PIPELINE_AFTER, summary),
    stop: () => project.stop(),
  };
}

/** The page's SSE stream, read frame by frame. */
async function openEvents(
  server: Server,
): Promise<{ next(name: string, timeoutMs?: number): Promise<unknown>; close(): void }> {
  const controller = new AbortController();
  const response = await server.fetch("api/events", { signal: controller.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // A read outlives a `next` that timed out waiting for it: the next `next` takes its chunk, so none is lost.
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  return {
    async next(name, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        let end: number;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(frame)?.[1];
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (event === name && data !== undefined) return JSON.parse(data) as unknown;
        }
        if (Date.now() > deadline) throw new Error(`no ${name} event`);
        let timer: ReturnType<typeof setTimeout> | undefined;
        pending ??= reader.read();
        const read = await Promise.race([
          pending,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`no ${name} event`)), Math.max(1, deadline - Date.now()));
          }),
        ]).finally(() => {
          if (timer !== undefined) clearTimeout(timer);
        });
        pending = undefined;
        const { value, done } = read;
        if (done) throw new Error("the stream ended");
        buffer += decoder.decode(value, { stream: true });
      }
    },
    close: () => controller.abort(),
  };
}

function contractSuite(name: string, start: () => Promise<Server>): void {
  describe(name, () => {
    let server: Server;
    const get = async (path: string): Promise<Response> => server.fetch(path);
    const inventory = async (): Promise<DiagramView[]> => parseInventory(await (await get("api/diagrams")).json())!;
    const search = async (q: string): Promise<SearchAnswer> => {
      const response = await get(`api/search?${new URLSearchParams({ q }).toString()}`);
      expect(response.status, q).toBe(200);
      return parseSearch(await response.json())!;
    };
    const where = (answer: SearchAnswer, target: string) => answer.results.find((r) => r.target === target)?.where;

    beforeAll(async () => {
      server = await start();
    });
    afterAll(async () => {
      await server.stop();
    });

    it("serves authenticated readable browser pages and global catalog routes", async () => {
      const link = new URL(server.url);
      const token = link.searchParams.get("token")!;
      const slug = link.pathname.split("/")[2]!;
      const pages = [
        `/projects/${slug}/?follow`,
        `/projects/${slug}/`,
        `/projects/${slug}/notes/deep/`,
        `/projects/${slug}/notes/parsing.md`,
        `/projects/${slug}/pipeline.mmd`,
        `/projects/${slug}/-/repo/docs/guide.md`,
        "/projects/",
      ];
      const withToken = (path: string, value = token): URL =>
        new URL(`${path}${path.includes("?") ? "&" : "?"}token=${value}`, link);
      // A link's token signs the browser in: the access cookie, and the same clean address without the token.
      let cookie = "";
      const open = async (path: string): Promise<Response> => {
        const exchange = await fetch(withToken(path), { redirect: "manual" });
        expect(exchange.status, path).toBe(303);
        const location = new URL(exchange.headers.get("location")!, link);
        expect(location.pathname, path).toBe(new URL(path, link).pathname);
        expect(location.searchParams.has("token"), path).toBe(false);
        cookie = exchange.headers.get("set-cookie")!.split(";")[0]!;
        return fetch(location, { headers: { cookie }, redirect: "manual" });
      };
      for (const path of pages) {
        const response = await open(path);
        expect(response.status, path).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/html");
        // ADR 0014 (amended 2026-10-31): the page shell revalidates at its clean address (EX-S1-01, D8).
        expect(response.headers.get("cache-control")).toMatch(/^(?:private, no-cache|no-store)$/);
      }
      const response = await fetch(new URL("/api/browser-projects", link), { headers: { cookie } });
      expect(response.status).toBe(200);
      expect(parseProjectCatalog(await response.json())?.map((project) => project.slug)).toContain(slug);
      // No cookie, a wrong token, or (signed in) no such project: nothing.
      for (const [url, headers] of [
        [new URL("/projects/", link), {}],
        [new URL(`/projects/${slug}/notes/deep/`, link), {}],
        [new URL("/api/browser-projects", link), {}],
        [withToken("/projects/", "0".repeat(64)), {}],
        [withToken(`/projects/${slug}/`, "0".repeat(64)), {}],
        [new URL("/projects/missing-project/notes/deep/", link), { cookie }],
      ] as const)
        expect((await fetch(url, { headers, redirect: "manual" })).status, url.pathname).toBe(404);
    });

    it("authenticates browser negotiation and retains one bounded connection identity per lifetime", async () => {
      const response = await get("api/connection");
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      const metadata = (await response.json()) as Record<string, unknown>;
      const parsed = parseBrowserConnection(metadata);
      expect(parsed).toEqual({
        heartbeat: true,
        epoch: metadata.serverEpoch,
        applicationVersion: metadata.applicationVersion,
        capabilities: metadata.capabilities,
      });
      expect(metadata).toMatchObject({
        browserProtocolMajor: 1,
        supportedBrowserProtocolMajors: [1],
        semanticSchemaVersion: 2,
        heartbeatIntervalMs: 15000,
      });
      expect(metadata.applicationVersion).toEqual(expect.any(String));
      expect(metadata.capabilities).toContain("heartbeat");
      expect(await (await get("api/connection")).json()).toEqual(metadata);
      // Without the browser's cookie: nothing.
      expect((await fetch(server.api("api/connection"))).status).toBe(404);
    });

    it("emits the negotiated epoch as a named heartbeat at the promised cadence", async () => {
      const metadata = (await (await get("api/connection")).json()) as {
        serverEpoch: string;
        heartbeatIntervalMs: number;
      };
      expect(metadata.heartbeatIntervalMs).toBe(15000);
      // The stream's beat is scheduled on a fake interval clock, stepped to the promised cadence: the service, its
      // stream and the page's reading of it are real. (ts/test/service/browser-protocol.test.ts drives the same
      // production interval at KEEP_ALIVE_MS.) Only setInterval is faked, so the reads' own deadlines stay real.
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      let events: Awaited<ReturnType<typeof openEvents>> | undefined;
      try {
        events = await openEvents(server);
        // Sent in the same turn as the beat is scheduled: from here the stream's interval runs on the fake clock.
        await events.next("standing");
        const interval = metadata.heartbeatIntervalMs;
        for (let beat = 1; beat <= 2; beat++) {
          vi.advanceTimersByTime(interval - 1);
          // Nothing in this window: a short real wait shows no heartbeat a millisecond early.
          await expect(events.next("heartbeat", 300), `beat ${beat} early`).rejects.toThrow("no heartbeat event");
          vi.advanceTimersByTime(1);
          expect(await events.next("heartbeat"), `beat ${beat}`).toEqual({ serverEpoch: metadata.serverEpoch });
        }
      } finally {
        events?.close();
        vi.useRealTimers();
      }
    });

    it("lists the current project with registered diagram and note metadata", async () => {
      const response = await get("api/projects");
      expect(response.status).toBe(200);
      const projects = parseProjectCatalog(await response.json());
      expect(projects).not.toBeNull();
      expect(projects).toHaveLength(1);
      const project = projects![0]!;
      expect(project.slug).toBe(new URL(server.url).pathname.split("/")[2]);
      expect(project.name.length).toBeGreaterThan(0);
      expect(project.views.map((entry) => entry.id).sort()).toEqual(["login", "pipeline"]);
      expect(project.notes.map((entry) => entry.path).sort()).toEqual(["notes/ideas.md", "notes/parsing.md"]);
      expect(project.notes.every((entry) => !("markdown" in entry) && !("content" in entry))).toBe(true);
    });

    it("additive browser discovery and search retain the shared authoring aliases", async () => {
      const response = await get("api/browser-projects");
      expect(response.status).toBe(200);
      const projects = parseProjectCatalog(await response.json());
      expect(projects).not.toBeNull();
      const project = projects![0]!;
      expect(
        project.documents
          ?.flatMap((document) => (document.legacy?.viewId === undefined ? [] : [document.legacy.viewId]))
          .sort(),
      ).toEqual(["login", "pipeline"]);
      expect(
        project.documents
          ?.flatMap((document) => (document.legacy?.notePath === undefined ? [] : [document.legacy.notePath]))
          .sort(),
      ).toEqual(["notes/ideas.md", "notes/parsing.md"]);
      const result = await get("api/browser-search?q=parser");
      expect(result.status).toBe(200);
      expect(parseSearch(await result.json())?.results.map((entry) => entry.target)).toContain("view:pipeline");
    });

    it("reads advertised project-relative note sources and refuses missing or unauthenticated reads", async () => {
      const advertised = (await (await get("api/browser-projects")).json()) as {
        projects: { documents: { documents: { source: { path: string }; legacy?: { notePath?: string } }[] } }[];
      };
      const entry = advertised.projects[0]!.documents.documents.find(
        (document) => document.legacy?.notePath === "notes/parsing.md",
      )!;
      expect(entry.source.path).toBe(".archer/notes/parsing.md");
      const route = `api/documents/content?${new URLSearchParams({ path: entry.source.path })}`;
      const response = await get(route);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(await response.json()).toMatchObject({
        source: entry.source,
        kind: "markdown",
        revision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        markdown: PARSING,
        embedded: [],
        diagramProblems: [],
      });
      const catalog = await get("api/documents");
      expect(catalog.status).toBe(200);
      expect((await catalog.json()).documents).toContainEqual(
        expect.objectContaining({ source: entry.source, legacy: { notePath: "notes/parsing.md" } }),
      );
      for (const path of [
        "notes/parsing.md",
        ".archer/notes/missing.md",
        ".archer/../notes/parsing.md",
        "../.archer/notes/parsing.md",
      ]) {
        expect((await get(`api/documents/content?${new URLSearchParams({ path })}`)).status, path).toBe(404);
      }
      // Without the browser's cookie: nothing.
      expect((await fetch(server.api(route))).status).toBe(404);
    });

    it("tracks comment activity for every current diagram and note, and the project conversation", async () => {
      const activity = async () => {
        const response = await get("api/comment-activity");
        expect(response.status).toBe(200);
        const parsed = parseCommentActivity(await response.json());
        expect(parsed).not.toBeNull();
        return parsed!;
      };
      const quiet = await activity();
      expect([...quiet.keys()].sort()).toEqual([
        "note:notes/ideas.md",
        "note:notes/parsing.md",
        "project:",
        "view:login",
        "view:pipeline",
      ]);
      for (const value of quiet.values()) {
        expect(value).toMatchObject({ totalThreads: 0, unresolvedThreads: 0, lastCommentedAt: null });
        // A service that lists the agent's comments (PF-2) names none here.
        expect(value.agentComments ?? []).toEqual([]);
      }

      const origin = new URL(server.url).origin;
      const send = async (path: string, body: unknown) => {
        const response = await server.fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(200);
        return response;
      };
      // As the page sends them: a create or reply as its operation (ADR 0016), read as its receipt's thread.
      const created = parseThread(
        (
          await (
            await send(
              "api/comments",
              commentOperation.create({ target: "view:pipeline", anchor: { kind: "view" }, body: "First question" }),
            )
          ).json()
        ).thread,
      );
      expect(created).toBeDefined();
      const replied = parseThread(
        (
          await (
            await send(
              `api/comments/${created!.id}/replies`,
              commentOperation.reply("view:pipeline", { body: "More detail" }),
            )
          ).json()
        ).thread,
      );
      expect(replied).toBeDefined();
      const repliedAt = replied!.comments.at(-1)!.createdAt;
      expect(new Date(repliedAt).toISOString()).toBe(repliedAt);
      expect((await activity()).get("view:pipeline")).toMatchObject({
        totalThreads: 1,
        unresolvedThreads: 1,
        lastCommentedAt: repliedAt,
      });
      expect((await activity()).get("view:pipeline")?.agentComments ?? []).toEqual([]);

      await send(`api/comments/${created!.id}/resolve`, {});
      expect((await activity()).get("view:pipeline")).toMatchObject({
        totalThreads: 0,
        unresolvedThreads: 0,
        lastCommentedAt: null,
      });
    });

    it("numbers reads and streams by publication, so a change between a read and the stream is not lost", async () => {
      // ui/src/app/host-bridge.ts `checkAdopted`: the page re-reads when its stream starts past its first read.
      const seqOf = async (): Promise<number> => {
        const response = await get("api/bootstrap");
        expect(response.status).toBe(200);
        const header = response.headers.get("x-archer-event-seq");
        expect(header, "x-archer-event-seq").toMatch(/^\d+$/);
        return Number(header);
      };
      const read = await seqOf();
      await server.present("pipeline");
      const after = await seqOf();
      expect(after).toBeGreaterThan(read);
      const events = await openEvents(server);
      try {
        expect(await events.next("standing")).toEqual({ seq: after });
      } finally {
        events.close();
      }
    });

    it("answers a diagram's walkthroughs, an empty list included, and names what it refuses", async () => {
      // Every diagram page reads this (ui/src/walkthroughs/use-walkthroughs.ts); a 404 here is a console error on the page.
      for (const viewId of ["pipeline", "login"]) {
        const response = await get(`api/walkthroughs?viewId=${viewId}`);
        expect(response.status, viewId).toBe(200);
        const body = (await response.json()) as Record<string, unknown>;
        expect(body, viewId).toMatchObject({
          schemaVersion: 1,
          viewId,
          walkthroughs: [],
          resolution: [],
          deadCode: [],
        });
        const read = parseWalkthroughs(body);
        expect(read?.walks, viewId).toEqual([]);
        // A sequence diagram cannot host one yet, and says why; a flowchart can.
        if (viewId === "login") expect(read?.unsupported).toMatch(/sequence diagram/);
        else expect(read).not.toHaveProperty("unsupported");
      }
      const refusal = async (path: string, status: number, code: string): Promise<void> => {
        const response = await get(path);
        expect(response.status, path).toBe(status);
        expect(((await response.json()) as { error: { code: string } }).error.code, path).toBe(code);
      };
      await refusal("api/walkthroughs", 422, "invalid_request");
      await refusal("api/walkthroughs?viewId=nowhere", 404, "diagram_not_found");
      await refusal("api/walkthroughs/old?viewId=pipeline", 422, "invalid_request");
      await refusal("api/walkthroughs/old?viewId=pipeline&id=none", 404, "walkthrough_not_found");
    });

    it("gives each diagram its group, size, threads and last change", async () => {
      const views = await inventory();
      const pipeline = views.find((v) => v.id === "pipeline")!;
      const login = views.find((v) => v.id === "login")!;
      expect(pipeline.group).toBe("system");
      expect(login.group).toBe("behaviour");
      expect(pipeline.counts).toEqual({ elements: 3, links: 2 });
      expect(pipeline.threads).toEqual({ draft: 0, sent: 0, read: 0, answered: 0, resolved: 0 });
      // Seen at attach: the person's, dated by the file.
      expect(pipeline.lastChange?.by).toBe("person");
    });

    it("carries the caption and time of the agent's latest presentation", async () => {
      const before = Date.now() - 1000;
      await server.present("login", "The browser posts the form.");
      await expect
        .poll(async () => (await inventory()).find((v) => v.id === "login")?.caption)
        .toBe("The browser posts the form.");
      const login = (await inventory()).find((v) => v.id === "login")!;
      expect(Date.parse(login.presentedAt!)).toBeGreaterThanOrEqual(before);
    });

    it("counts a diagram's threads as they change", async () => {
      const origin = new URL(server.url).origin;
      const created = await server.fetch("api/comments", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify(
          commentOperation.create({
            target: "view:login",
            anchor: { kind: "view" },
            body: "Should this be idempotent?",
          }),
        ),
      });
      expect(created.ok).toBe(true);
      await expect.poll(async () => (await inventory()).find((v) => v.id === "login")?.threads?.draft).toBe(1);
    });

    it("finds a diagram by a word only in a note about it, and the note itself", async () => {
      const answer = await search("tokenizer");
      expect(where(answer, "view:pipeline")).toEqual(["note"]);
      expect(where(answer, "note:notes/parsing.md")).toEqual(["note"]);
      expect(where(answer, "view:login")).toBeUndefined();
    });

    it("finds a diagram by a word only in a comment on it", async () => {
      const answer = await search("idempotent");
      expect(where(answer, "view:login")).toEqual(["comment"]);
    });

    it("finds a note about nothing, as a result of its own", async () => {
      expect(where(await search("someday"), "note:notes/ideas.md")).toEqual(["note"]);
    });

    it("lets each word match in a different place, and names every place", async () => {
      expect(where(await search("compile checker"), "view:pipeline")).toEqual(["title", "diagram"]);
      expect(where(await search("compile nowhere-at-all"), "view:pipeline")).toBeUndefined();
    });

    it("names the element of the compiled model a word matched in, and keeps where", async () => {
      const result = (await search("checker")).results.find((r) => r.target === "view:pipeline");
      expect(result?.where).toEqual(["diagram"]);
      expect(result?.matches).toEqual([{ field: "node", text: "Checker", elementId: "checker" }]);
      const note = (await search("tokenizer")).results.find((r) => r.target === "view:pipeline");
      expect(note?.matches).toEqual([
        { field: "note", text: expect.stringContaining("tokenizer"), notePath: "notes/parsing.md" },
      ]);
    });

    it("refuses an empty or over-long query", async () => {
      expect((await get("api/search?q=")).status).toBe(422);
      expect((await get("api/search?q=%20%20")).status).toBe(422);
      expect((await get(`api/search?q=${"a".repeat(201)}`)).status).toBe(422);
    });

    it("tells the page what the agent changed, and who", async () => {
      const events = await openEvents(server);
      try {
        await server.agentRewrite("merged Lexer into Parser");
        const change = parseChange(await events.next("change")) as ViewChange;
        expect(change).toMatchObject({ viewId: "pipeline", by: "agent", summary: "merged Lexer into Parser" });
        expect([...change.added].sort()).toEqual(["e3", "emitter"]);
        expect(change.changed).toEqual(["parser"]);
        expect(change.removed.map((r) => r.id).sort()).toEqual(["e1", "lexer"]);
        expect(change.removed.find((r) => r.id === "lexer")?.label).toBe("Lexer");
        await expect
          .poll(async () => (await inventory()).find((v) => v.id === "pipeline")?.lastChange)
          .toMatchObject({
            by: "agent",
            summary: "merged Lexer into Parser",
          });
      } finally {
        events.close();
      }
    });
  });
}

contractSuite("the TypeScript service", startService);
