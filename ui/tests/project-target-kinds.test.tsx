// @vitest-environment jsdom
// The project conversation (`project:`) is a target of its own kind everywhere the page branches on a target's
// kind (wave 2 review, findings 4, 5 and 18): seen state, the workspace bell, titles and links.
import { afterEach, expect, it, vi } from "vitest";
import type { Thread } from "../src/comments/contract";
import {
  EMPTY_SEEN_STATE,
  isSeen,
  loadSeenState,
  rememberSeen,
  seenEntryIndex,
  storeSeenState,
} from "../src/comments/review-seen";
import { anchorScope, onTarget, readTargetRef, targetParts } from "../src/comments/target";
import { loadWorkspaceNotifications } from "../src/app/workspace-notifications";
import { CONNECTION } from "./app-harness";

afterEach(() => localStorage.clear());

const projectThread: Thread = {
  id: "t-project",
  target: "project:",
  anchor: { kind: "project" },
  status: "answered",
  revision: 2,
  comments: [
    { id: "c-q", author: "person", body: "Where do I start?", createdAt: "2026-10-16T00:00:00Z" },
    { id: "c-a", author: "agent", body: "Read the overview.", createdAt: "2026-10-17T00:00:00Z" },
  ],
};

it("reads every kind of target, and nothing else", () => {
  expect(
    [
      ["view:flow", { kind: "view", viewId: "flow" }],
      ["note:a/b.md", { kind: "note", path: "a/b.md" }],
      ["project:", { kind: "project" }],
    ].map(([t]) => targetParts(t as never)),
  ).toEqual([{ kind: "view", viewId: "flow" }, { kind: "note", path: "a/b.md" }, { kind: "project" }]);
  for (const bad of ["project", "project:x", "view:", "note:", "other:x", 3, null])
    expect(readTargetRef(bad), String(bad)).toBeNull();
  for (const good of ["view:x", "note:x.md", "project:"]) expect(readTargetRef(good)).toBe(good);
  expect(onTarget("project:", { view: () => 1, note: () => 2, project: () => 3 })).toBe(3);
  expect(["view:x", "note:x.md", "project:"].map((t) => anchorScope(t as never))).toEqual(["view", "note", "view"]);
});

it("a project reply can be marked seen, and stays seen after a reload", () => {
  const seen = rememberSeen(EMPTY_SEEN_STATE, [projectThread]);
  expect(isSeen(seenEntryIndex(seen), projectThread, "c-a")).toBe(true);
  storeSeenState("demo", seen, localStorage);
  expect(isSeen(seenEntryIndex(loadSeenState("demo", localStorage)), projectThread, "c-a")).toBe(true);
});

it("the bell lists a project reply, titled with the project and linked to its page with the thread", async () => {
  const response = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const catalog = { schemaVersion: 1, projects: [{ slug: "demo-11111111", name: "Demo", views: [], notes: [] }] };
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.endsWith("api/browser-projects")) return response(catalog);
    if (url.endsWith("api/connection")) return response(CONNECTION);
    if (url.endsWith("api/bootstrap")) return response({ capabilities: { comments: true } });
    if (url.endsWith("api/comment-activity"))
      return response({
        schemaVersion: 1,
        targets: { "project:": { totalThreads: 1, unresolvedThreads: 1, lastCommentedAt: null } },
      });
    if (url.includes("api/comments?"))
      return response({ schemaVersion: 2, target: "project:", threads: [projectThread] });
    throw new Error(`unexpected ${url}`);
  });
  const result = await loadWorkspaceNotifications({ kind: "service" }, { fetchImpl, href: "https://host/projects/" });
  expect(result.status).toBe("ready");
  if (result.status !== "ready") return;
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({
    target: "project:",
    targetTitle: "Demo",
    href: "https://host/projects/demo-11111111/?thread=t-project",
  });
});
