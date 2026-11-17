import { afterEach, expect, test } from "vitest";
import { connectService, type ServiceClient } from "../../src/service/index.ts";
import { cleanUp, http, json, project, service, write, apiBase, pageHttp } from "./support.ts";

let client: ServiceClient | undefined;
afterEach(async () => {
  client?.close();
  await cleanUp();
});

test("note listings and the project catalog include the note's open comment counts", async () => {
  const { svc } = await service({}, { comments: "queued" });
  client = await connectService(svc.socketPath);
  const root = project();
  write(root, ".archer/notes/decision.md", "# Decision\n\nA durable decision.\n");
  const { url } = await client.call("attach", { root });
  const created = await pageHttp(`${apiBase(url)}api/comments`, {
    method: "POST",
    headers: { origin: new URL(url).origin, "content-type": "application/json" },
    body: JSON.stringify({ target: "note:notes/decision.md", anchor: { kind: "view" }, body: "Why this decision?" }),
  });
  expect(created.status).toBe(200);
  const counts = { draft: 1, sent: 0, read: 0, answered: 0, resolved: 0 };
  expect(await json(`${apiBase(url)}api/notes/all`)).toMatchObject({
    notes: [{ path: "notes/decision.md", threads: counts }],
  });
  expect(await json(`${apiBase(url)}api/projects`)).toMatchObject({
    projects: [{ notes: [{ path: "notes/decision.md", threads: counts }] }],
  });
});

test("note listings carry the note's author from its front matter, and only agent or person", async () => {
  const { svc } = await service();
  client = await connectService(svc.socketPath);
  const root = project();
  write(root, ".archer/notes/by-agent.md", "---\nauthor: agent\n---\n# By agent\n");
  write(root, ".archer/notes/by-person.md", "---\nauthor: person\n---\n# By person\n");
  write(root, ".archer/notes/unknown.md", "---\nauthor: someone else\n---\n# Unknown\n");
  write(root, ".archer/notes/none.md", "# None\n");
  const { url } = await client.call("attach", { root });
  const { notes } = (await json(`${apiBase(url)}api/notes/all`)) as { notes: { path: string; author?: string }[] };
  const authors = Object.fromEntries(notes.map((note) => [note.path, note.author]));
  expect(authors).toEqual({
    "notes/by-agent.md": "agent",
    "notes/by-person.md": "person",
    "notes/unknown.md": undefined,
    "notes/none.md": undefined,
  });
});
