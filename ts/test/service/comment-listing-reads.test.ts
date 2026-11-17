// Listing a note's comments reads its comments file, never the note: the note's text is what a new anchor is
// checked against, so only creating a thread needs it (efficiency review 2026-10-25, project-state #threads).
import { afterEach, expect, test, vi } from "vitest";
import type { Thread } from "../../src/comments/contract.ts";
import { connectService, type ServiceClient } from "../../src/service/index.ts";
import { apiBase, cleanUp, http, json, project, service, write, pageHttp } from "./support.ts";

const noteReads = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../src/comments/notes.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/comments/notes.ts")>();
  return {
    ...actual,
    noteMarkdown: (...args: Parameters<typeof actual.noteMarkdown>) => {
      noteReads.count++;
      return actual.noteMarkdown(...args);
    },
  };
});

const clients: ServiceClient[] = [];
afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await cleanUp();
});

test("listing a note's comments and the comment activity read no note text; creating a thread still checks its anchor", async () => {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  clients.push(client);
  const root = project();
  write(root, ".archer/auth.md", "# Auth flow\n\nHow authentication works.\n");
  const { url } = await client.call("attach", { root });
  const origin = `http://127.0.0.1:${svc.port}`;
  const post = async (path: string, body: unknown): Promise<{ status: number; body: string }> =>
    pageHttp(`${apiBase(url)}${path}`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  noteReads.count = 0;
  const created = await post("api/comments", {
    target: "note:auth.md",
    anchor: { kind: "passage", quote: "authentication", prefix: "How ", suffix: " works." },
    body: "Which provider?",
  });
  expect(created.status).toBe(200);
  expect(noteReads.count, "creating a passage anchor checks it against the note").toBeGreaterThan(0);
  // An anchor the note does not hold is still refused.
  expect(
    (
      await post("api/comments", {
        target: "note:auth.md",
        anchor: { kind: "passage", quote: "not in the note", prefix: "", suffix: "" },
        body: "?",
      })
    ).status,
  ).toBe(422);

  noteReads.count = 0;
  const listed = (await json(`${apiBase(url)}api/comments?target=${encodeURIComponent("note:auth.md")}`)) as {
    threads: Thread[];
  };
  expect(listed.threads.map((t) => t.id)).toEqual([(JSON.parse(created.body) as Thread).id]);
  const activity = (await json(`${apiBase(url)}api/comment-activity`)) as {
    targets: Record<string, { totalThreads: number }>;
  };
  expect(activity.targets["note:auth.md"]?.totalThreads).toBe(1);
  expect(noteReads.count, "note reads while listing").toBe(0);
});
