import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import type { Thread, ThreadList } from "../../src/comments/contract.ts";
import { CommentsError, CommentsStore } from "../../src/comments/store.ts";
import { connectService } from "../../src/service/index.ts";
import {
  cleanUp,
  events,
  exactly,
  http,
  project,
  service,
  tempDir,
  write,
  apiBase,
  serviceBase,
  pageHttp,
} from "./support.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanUp();
});

test("settings GET is service-wide and read-only: PUT is refused without reading the body or touching the file", async () => {
  const config = write(
    tempDir(),
    "archer.toml",
    [
      "version = 1",
      "# keep this comment",
      "[service]",
      'name = "work"',
      'host = "127.0.0.1" # keep this too',
      "[[services]]",
      'name = "other"',
      'comment_submission = "queued"',
      "",
    ].join("\n"),
  );
  const { svc } = await service({ serviceName: "work", env: { ARCHER_CONFIG: config } });
  const client = await connectService(svc.socketPath);
  const root = project();
  const { url } = await client.call("attach", { root });
  const origin = `http://127.0.0.1:${svc.port}`;
  const serviceUrl = `${serviceBase(svc.homeUrl)}api/settings`;
  const initial = JSON.parse((await pageHttp(serviceUrl)).body) as Record<string, unknown>;
  // No absolute path leaves the service (server review S13): outside home, only the file's own name.
  expect(initial).toMatchObject({
    serviceName: "work",
    commentSubmission: "immediate",
    configRevision: expect.stringMatching(/^sha256:/),
    configPath: "\u2026/archer.toml",
    writable: false,
  });
  expect(JSON.stringify(initial)).not.toContain(config);
  expect(JSON.parse((await pageHttp(`${apiBase(url)}api/settings`)).body)).toEqual(initial);
  const before = readFileSync(config);
  for (const target of [serviceUrl, `${apiBase(url)}api/settings`]) {
    const refused = await pageHttp(target, {
      method: "PUT",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ commentSubmission: "immediate", expectedRevision: initial["configRevision"] }),
    });
    expect([refused.status, JSON.parse(refused.body).error.code]).toEqual([403, "settings_read_only"]);
  }
  // Without the browser's credential.
  const uncredentialed = await exactly(serviceUrl, {
    method: "PUT",
    headers: { origin, "content-type": "application/json" },
    body: "{}",
  });
  expect([uncredentialed.status, uncredentialed.body]).toEqual([404, ""]);
  expect(readFileSync(config)).toEqual(before);
  client.close();
});

test("default identity merges the named default record per field when reading comment submission", async () => {
  const config = write(
    tempDir(),
    "archer.toml",
    [
      "version = 1",
      "[service]",
      'comment_submission = "immediate"',
      "[[services]]",
      'name = "default"',
      'host = "127.0.0.1"',
      'comment_submission = "queued"',
      "",
    ].join("\n"),
  );
  const { svc } = await service({ env: { ARCHER_CONFIG: config } });
  const read = JSON.parse((await pageHttp(`${serviceBase(svc.homeUrl)}api/settings`)).body) as Record<string, string>;
  expect(read.commentSubmission).toBe("queued");
});

test.each([
  ["queued", "view:flow"],
  ["queued", "note:readme.md"],
  ["immediate", "view:flow"],
  ["immediate", "note:readme.md"],
] as const)(
  "%s mode applies to create, reply and edit on %s without publishing another draft or agent work",
  async (mode, target) => {
    const config = write(
      tempDir(),
      "archer.toml",
      `version = 1\n[service]\ncomment_submission = ${JSON.stringify(mode)}\n`,
    );
    const { svc } = await service({ env: { ARCHER_CONFIG: config } });
    const client = await connectService(svc.socketPath);
    const root = project();
    write(root, ".archer/readme.md", "# Read me\n");
    const { url } = await client.call("attach", { root });
    const origin = `http://127.0.0.1:${svc.port}`;
    const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
      const reply = await pageHttp(
        `${apiBase(url)}${path}`,
        {
          method,
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        target,
      );
      expect(reply.status, reply.body).toBe(200);
      return JSON.parse(reply.body) as unknown;
    };
    const stream = mode === "immediate" ? await events(`${apiBase(url)}api/events`) : null;
    const first = (await call("POST", "api/comments", { target, anchor: { kind: "view" }, body: "first" })) as Thread;
    expect(first.status).toBe(mode === "immediate" ? "sent" : "draft");
    expect(first.revision).toBe(1);
    // The write and its publish are announced once (O250; counted in operations-http.test.ts, where no fixture
    // written beside the page's writes can add a watcher's event).
    if (stream !== null) expect(await stream.next("comments")).toEqual({ target });

    // Put a separate draft on disk as an agent/test fixture: the HTTP hook must never sweep it up.
    const store = new (await import("../../src/comments/store.ts")).CommentsStore(
      (await import("../../src/project/index.ts")).findProject(root),
    );
    const place = target.startsWith("view:")
      ? { target, path: "flow.comments.json", subject: { kind: "view" as const, elements: null } }
      : { target, path: "readme.comments.json", subject: { kind: "note" as const, text: "# Read me\n" } };
    const held = store.create(place, { anchor: { kind: "view" }, body: "held" }).value;
    const agent = store.createByAgent(place, { anchor: { kind: "view" }, body: "agent" }).value;
    expect(agent.status).toBe("answered");
    const replied = (await call("POST", `api/comments/${first.id}/replies`, { body: "reply" })) as Thread;
    expect(replied.status).toBe(mode === "immediate" ? "sent" : "draft");
    expect(replied.revision).toBe(2);
    if (stream !== null) expect(await stream.next("comments")).toEqual({ target });
    const edited = (await call("PATCH", `api/comments/${first.id}/${first.comments[0]?.id}`, {
      body: "edited",
    })) as Thread;
    expect(edited.status).toBe(mode === "immediate" ? "sent" : "draft");
    expect(edited.revision).toBe(3);
    if (stream !== null) expect(await stream.next("comments")).toEqual({ target });
    const list = (await call("GET", `api/comments?target=${encodeURIComponent(target)}`)) as ThreadList;
    expect(list.threads.find((thread) => thread.id === held.id)?.status).toBe("draft");
    expect(list.threads.find((thread) => thread.id === agent.id)?.status).toBe("answered");
    expect(list.threads.find((thread) => thread.id === first.id)).toEqual(edited);
    stream?.close();
    client.close();
  },
);

test("an immediate publication write failure is reported while the successfully saved thread remains queued", async () => {
  const config = write(tempDir(), "archer.toml", 'version = 1\n[service]\ncomment_submission = "immediate"\n');
  const { svc } = await service({ env: { ARCHER_CONFIG: config } });
  const client = await connectService(svc.socketPath);
  const root = project();
  const { url } = await client.call("attach", { root });
  vi.spyOn(CommentsStore.prototype, "submit").mockImplementation(() => {
    throw new CommentsError("write_conflict", "the publication write failed after the draft was saved");
  });
  const reply = await pageHttp(`${apiBase(url)}api/comments`, {
    method: "POST",
    headers: { origin: `http://127.0.0.1:${svc.port}`, "content-type": "application/json" },
    body: JSON.stringify({ target: "view:flow", anchor: { kind: "view" }, body: "kept queued" }),
  });
  expect(reply.status).toBe(409);
  expect(JSON.parse(reply.body)).toMatchObject({ error: { code: "write_conflict" } });
  vi.restoreAllMocks();
  const list = JSON.parse((await pageHttp(`${apiBase(url)}api/comments?target=view:flow`)).body) as ThreadList;
  expect(list.threads).toMatchObject([
    { status: "draft", revision: 1, comments: [{ author: "person", body: "kept queued" }] },
  ]);
  client.close();
});
