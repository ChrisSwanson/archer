// @vitest-environment jsdom
// Poll provenance is passed, not ambient (Codex pass-2): a tick hands its own tag down the fetch path of the reads it
// makes, and only those carry `x-archer-poll`. The release check counts one copy of each request per tick.
import { afterEach, expect, it, vi } from "vitest";
import { POLL_HEADER, pollTag, schedulePoll, withPollTag } from "../src/app/polls";
import { forgetProjectCatalogs, loadProjectCatalog } from "../src/app/project-directory";
import { invalidateCommentActivity, readCommentActivity } from "../src/app/comment-activity";
import { loadWorkspaceNotifications } from "../src/app/workspace-notifications";
import { CONNECTION } from "./app-harness";

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const tagOf = (init?: RequestInit): string | null => new Headers(init?.headers).get(POLL_HEADER);
afterEach(() => {
  vi.useRealTimers();
  forgetProjectCatalogs();
  invalidateCommentActivity();
});

it("each tick has its own tag, and the tag is added to a request's headers without dropping the others", () => {
  const a = pollTag("notifications"),
    b = pollTag("notifications");
  expect(a[POLL_HEADER]).toMatch(/^notifications#\d+$/);
  expect(b[POLL_HEADER]).not.toBe(a[POLL_HEADER]);
  expect(withPollTag({ cache: "no-store", headers: { "if-none-match": '"t"' } }, a)).toEqual({
    cache: "no-store",
    headers: { "if-none-match": '"t"', [POLL_HEADER]: a[POLL_HEADER] },
  });
  const untagged = { cache: "no-store" } as const;
  expect(withPollTag(untagged, undefined)).toBe(untagged);
});

it("a production build (and vitest) hands its ticks no tag", () => {
  vi.useFakeTimers();
  const tick = vi.fn();
  const stop = schedulePoll("project-catalog", tick);
  vi.advanceTimersByTime(30_000);
  stop();
  expect(tick.mock.calls).toEqual([[undefined], [undefined]]);
});

it("the catalog read carries the tick's tag; an untagged read carries none", async () => {
  const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => json({ schemaVersion: 1, projects: [] }));
  await loadProjectCatalog(fetchImpl, { [POLL_HEADER]: "project-catalog#7" });
  forgetProjectCatalogs();
  await loadProjectCatalog(fetchImpl);
  expect(fetchImpl.mock.calls.map(([, init]) => tagOf(init))).toEqual(["project-catalog#7", null]);
});

it("the shared comment-activity read carries the tick's tag", async () => {
  const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => json({ schemaVersion: 1, targets: {} }));
  await readCommentActivity("demo", "api/comment-activity", fetchImpl, { [POLL_HEADER]: "notifications#3" });
  expect(fetchImpl.mock.calls.map(([, init]) => tagOf(init))).toEqual(["notifications#3"]);
});

it("every read of one bell tick carries that tick's tag", async () => {
  const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith("api/browser-projects"))
      return json({
        schemaVersion: 1,
        projects: [
          {
            slug: "demo",
            name: "Demo",
            views: [{ id: "a", kind: "freeform", title: "A", registration: "durable" }],
            notes: [],
          },
        ],
      });
    if (url.endsWith("api/connection")) return new Response(JSON.stringify(CONNECTION));
    if (url.endsWith("api/bootstrap")) return json({ capabilities: { comments: true } });
    if (url.endsWith("api/comment-activity"))
      return json({
        schemaVersion: 1,
        targets: { "view:a": { totalThreads: 1, unresolvedThreads: 1, lastCommentedAt: null } },
      });
    return json({ schemaVersion: 2, target: "view:a", threads: [] });
  });
  await loadWorkspaceNotifications(
    { kind: "service" },
    { fetchImpl, href: "https://host/projects/", poll: { [POLL_HEADER]: "notifications#9" } },
  );
  expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(5);
  expect(new Set(fetchImpl.mock.calls.map(([, init]) => tagOf(init)))).toEqual(new Set(["notifications#9"]));
});
