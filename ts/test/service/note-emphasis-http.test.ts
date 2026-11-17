import { existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { connectService, type ServiceClient } from "../../src/service/index.ts";
import { NoteEmphasisStore } from "../../src/notes/emphasis.ts";
import { findProject } from "../../src/project/index.ts";
import { QUIET_MS } from "../../src/service/watch.ts";
import type { NoteEmphasisRead } from "../../../shared/note-emphasis.mts";
import { cleanUp, events, exactly, http, json, project, service, write, apiBase } from "./support.ts";

const clients: ServiceClient[] = [];

afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await cleanUp();
});

const request = (url: string, method: string, body?: unknown) =>
  http(url, {
    method,
    headers: {
      origin: new URL(url).origin,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

test("the page reads and replaces durable note emphasis under CAS without changing the note", async () => {
  const root = project();
  const note = write(root, ".archer/auth.md", "# Auth\n\nAlpha café 😀 beta.\n");
  const original = readFileSync(note);
  const first = await service();
  const client = await connectService(first.svc.socketPath);
  clients.push(client);
  const attached = await client.call("attach", { root });
  const endpoint = `${apiBase(attached.url)}api/note-emphases?path=${encodeURIComponent("auth.md")}`;

  expect(await json(`${apiBase(attached.url)}api/bootstrap`)).toMatchObject({ capabilities: { noteEmphasis: true } });
  expect(await json(endpoint)).toEqual({
    snapshot: { schemaVersion: 1, notePath: "auth.md", revision: 0, emphases: [] },
    orphans: [],
  });
  expect(existsSync(`${note}.emphases.json`)).toBe(false);

  const input = {
    notePath: "auth.md",
    id: "review",
    title: "Review",
    groups: [
      {
        id: "risk",
        label: "Risk",
        passages: [{ kind: "passage", quote: "Alpha café 😀 beta.", prefix: "", suffix: "" }],
      },
    ],
    expectedRevision: 0,
  };
  const posted = await request(endpoint, "POST", input);
  expect(posted.status).toBe(200);
  const read = JSON.parse(posted.body) as NoteEmphasisRead;
  expect(read).toMatchObject({
    snapshot: { revision: 1, emphases: [{ id: "review", author: "person" }] },
    orphans: [],
  });
  expect(readFileSync(note)).toEqual(original);
  expect(JSON.parse(readFileSync(join(root, ".archer/auth.md.emphases.json"), "utf8"))).toEqual(read.snapshot);

  const conflict = await request(endpoint, "POST", input);
  expect(conflict.status).toBe(409);
  expect(JSON.parse(conflict.body)).toMatchObject({
    error: { code: "note_emphasis_conflict", details: { actualSnapshot: read.snapshot } },
  });

  client.close();
  await first.svc.close();
  const second = await service({ stateDir: first.state });
  const fresh = await connectService(second.svc.socketPath);
  clients.push(fresh);
  const restored = await fresh.call("attach", { root });
  expect(await json(`${apiBase(restored.url)}api/note-emphases?path=auth.md`)).toEqual(read);
});

test("the real watcher publishes agent sidecar changes and note drift without duplicate HTTP events", async () => {
  const root = project();
  const note = write(root, ".archer/auth.md", "# Auth\n\nAlpha beta.\n");
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  clients.push(client);
  const attached = await client.call("attach", { root });
  const endpoint = `${apiBase(attached.url)}api/note-emphases?path=auth.md`;
  const group = {
    id: "risk",
    label: "Risk",
    passages: [{ kind: "passage" as const, quote: "Alpha beta.", prefix: "", suffix: "" }],
  };

  const startup = await events(`${apiBase(attached.url)}api/events`);
  await expect(startup.next("note-emphasis", QUIET_MS * 4)).rejects.toThrow(/no note-emphasis event/);
  startup.close();

  const stream = await events(`${apiBase(attached.url)}api/events`);
  const store = new NoteEmphasisStore(findProject(root));
  store.upsert({ notePath: "auth.md", id: "agent", groups: [group], expectedRevision: 0 }, "agent");
  expect(await stream.next("note-emphasis")).toEqual({ notePath: "auth.md" });
  store.upsert({ notePath: "auth.md", id: "agent", title: "Updated", groups: [group], expectedRevision: 1 }, "agent");
  expect(await stream.next("note-emphasis")).toEqual({ notePath: "auth.md" });

  const posted = await request(endpoint, "POST", {
    notePath: "auth.md",
    id: "person",
    groups: [group],
    expectedRevision: 2,
  });
  expect(posted.status).toBe(200);
  expect(await stream.next("note-emphasis")).toEqual({ notePath: "auth.md" });
  await expect(stream.next("note-emphasis", QUIET_MS * 4)).rejects.toThrow(/no note-emphasis event/);
  stream.close();

  const driftStream = await events(`${apiBase(attached.url)}api/events`);
  writeFileSync(note, "# Auth\n\nThe passage moved away.\n");
  expect(await driftStream.next("note-emphasis")).toEqual({ notePath: "auth.md" });
  const drifted = (await json(endpoint)) as NoteEmphasisRead;
  expect(drifted.orphans).toEqual([
    { emphasisId: "agent", groupId: "risk", passageIndex: 0 },
    { emphasisId: "person", groupId: "risk", passageIndex: 0 },
  ]);

  unlinkSync(`${note}.emphases.json`);
  expect(await driftStream.next("note-emphasis")).toEqual({ notePath: "auth.md" });
  expect(await json(endpoint)).toMatchObject({ snapshot: { revision: 0, emphases: [] } });
  driftStream.close();

  const unrelated = await events(`${apiBase(attached.url)}api/events`);
  write(root, ".archer/flow.mmd", "flowchart LR\n  a[A] e1@--> b[B]\n");
  await expect(unrelated.next("note-emphasis", QUIET_MS * 4)).rejects.toThrow(/no note-emphasis event/);
  unrelated.close();
}, 30_000);

test("the HTTP boundary refuses spoofing, unsafe paths, malformed state and oversized input without partial writes", async () => {
  const root = project();
  const note = write(root, ".archer/auth.md", "# Auth\n\nAlpha beta.\n");
  write(root, ".archer/target.md", "# Target\n");
  symlinkSync("auth.md", join(root, ".archer/link.md"));
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  clients.push(client);
  const attached = await client.call("attach", { root });
  const endpoint = `${apiBase(attached.url)}api/note-emphases?path=auth.md`;
  const valid = {
    notePath: "auth.md",
    id: "review",
    groups: [
      {
        id: "risk",
        label: "Risk",
        passages: [{ kind: "passage", quote: "Alpha beta.", prefix: "", suffix: "" }],
      },
    ],
    expectedRevision: 0,
  };
  const structured = async (body: unknown) => {
    const reply = await request(endpoint, "POST", body);
    return { reply, parsed: reply.body === "" ? null : (JSON.parse(reply.body) as { error?: { code?: string } }) };
  };

  // No credential, or another origin's write with the browser's cookie: the bare 404 before anything is read.
  expect(await exactly(endpoint)).toMatchObject({ status: 404, body: "" });
  expect(await exactly(endpoint, { method: "POST", body: "{}" })).toMatchObject({ status: 404, body: "" });
  expect(await http(`${apiBase(attached.url)}api/note-emphases/extra`)).toMatchObject({ status: 404, body: "" });
  expect(await http(endpoint, { method: "PATCH", body: "{}" })).toMatchObject({ status: 404, body: "" });
  expect(
    await http(endpoint, { method: "POST", headers: { origin: "http://evil.example" }, body: JSON.stringify(valid) }),
  ).toMatchObject({ status: 404, body: "" });

  const malformed = await http(endpoint, {
    method: "POST",
    headers: { origin: new URL(endpoint).origin },
    body: "{broken",
  });
  expect([malformed.status, JSON.parse(malformed.body).error.code]).toEqual([422, "invalid_note_emphasis"]);
  expect((await structured({ ...valid, author: "agent" })).parsed).toMatchObject({
    error: { code: "invalid_note_emphasis" },
  });
  expect((await structured({ ...valid, groups: [{ ...valid.groups[0], palette: "teal" }] })).parsed).toMatchObject({
    error: { code: "invalid_note_emphasis" },
  });
  expect(
    (
      await structured({
        ...valid,
        groups: Array.from({ length: 7 }, (_, index) => ({ ...valid.groups[0], id: `g${index}` })),
      })
    ).parsed,
  ).toMatchObject({ error: { code: "invalid_note_emphasis" } });
  expect((await structured({ ...valid, notePath: "../outside.md" })).parsed).toMatchObject({
    error: { code: "note_not_found" },
  });
  expect((await http(`${apiBase(attached.url)}api/note-emphases?path=missing.md`)).status).toBe(404);
  expect(
    (await http(`${apiBase(attached.url)}api/note-emphases?path=${encodeURIComponent("../outside.md")}`)).status,
  ).toBe(404);
  expect((await http(`${apiBase(attached.url)}api/note-emphases?path=link.md`)).status).toBe(404);
  expect(existsSync(`${note}.emphases.json`)).toBe(false);

  const tooLarge = JSON.stringify({ pad: "x".repeat(2 * 1024 * 1024) });
  expect(
    (await http(endpoint, { method: "POST", headers: { origin: new URL(endpoint).origin }, body: tooLarge })).status,
  ).toBe(413);
  expect(existsSync(`${note}.emphases.json`)).toBe(false);

  writeFileSync(`${note}.emphases.json`, "{ broken");
  const corruptRead = await http(endpoint);
  expect([corruptRead.status, JSON.parse(corruptRead.body).error.code]).toEqual([409, "malformed_note_emphasis_file"]);
  expect((await structured(valid)).parsed).toMatchObject({ error: { code: "malformed_note_emphasis_file" } });
  expect(readFileSync(`${note}.emphases.json`, "utf8")).toBe("{ broken");

  writeFileSync(
    `${note}.emphases.json`,
    JSON.stringify({ schemaVersion: 1, notePath: "target.md", revision: 0, emphases: [] }),
  );
  const collision = await http(endpoint);
  expect([collision.status, JSON.parse(collision.body).error.code]).toEqual([409, "note_emphasis_file_conflict"]);

  unlinkSync(`${note}.emphases.json`);
  write(root, ".archer/held.json", "{}");
  symlinkSync("held.json", `${note}.emphases.json`);
  const linked = await http(endpoint);
  expect([linked.status, JSON.parse(linked.body).error.code]).toEqual([409, "malformed_note_emphasis_file"]);
});
