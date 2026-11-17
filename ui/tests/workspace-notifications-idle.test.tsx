// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  WORKSPACE_NOTIFICATION_POLL_MS,
  WorkspaceNotifications,
  loadWorkspaceNotifications,
  type WorkspaceThreadMemo,
} from "../src/app/workspace-notifications";
const CONNECTION = {
  browserProtocolMajor: 1,
  supportedBrowserProtocolMajors: [1],
  serverEpoch: "12345678-1234-1234-1234-123456789abc",
  capabilities: ["heartbeat"],
  applicationVersion: "0.15.0",
  semanticSchemaVersion: 2,
  heartbeatIntervalMs: 15000,
};

// The bell re-reads a target's threads only when that target's comment activity changed (pass 3, item B).

const answer = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
type Activity = { totalThreads: number; unresolvedThreads: number; lastCommentedAt: string | null };
const comment = (id: string, createdAt = "2026-10-17T00:00:00Z") => ({
  id,
  author: "agent",
  body: `Body ${id}`,
  createdAt,
});
const thread = (target: string, id: string, comments: readonly unknown[]) => ({
  id,
  target,
  anchor: { kind: "view" },
  status: "answered",
  revision: 1,
  comments,
});

/** A project whose activity and threads the test changes between reads. */
function service(initial: Record<string, { activity: Activity; threads: unknown[] }>) {
  const state = { ...initial };
  const failing = new Set<string>();
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.endsWith("api/connection")) return answer(CONNECTION);
    if (url.endsWith("api/bootstrap")) return answer({ capabilities: { comments: true } });
    if (url.endsWith("api/comment-activity")) {
      return answer({
        schemaVersion: 1,
        targets: Object.fromEntries(Object.entries(state).map(([target, value]) => [target, value.activity])),
      });
    }
    const target = new URL(url).searchParams.get("target")!;
    if (failing.has(target)) return answer({}, 500);
    return answer({ schemaVersion: 2, target, threads: state[target]?.threads ?? [] });
  });
  const commentReads = (): string[] =>
    fetchImpl.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes("api/comments?"))
      .map((url) => new URL(url).searchParams.get("target")!);
  return { state, failing, fetchImpl, commentReads };
}

const one = (total = 1, unresolved = 1, at: string | null = "2026-10-17T00:00:00Z"): Activity => ({
  totalThreads: total,
  unresolvedThreads: unresolved,
  lastCommentedAt: at,
});
const options = (fetchImpl: ReturnType<typeof vi.fn>, memo: WorkspaceThreadMemo) => ({
  fetchImpl: fetchImpl as never,
  href: "https://host/projects/demo/?follow",
  memo,
});

/** Testing Library's `waitFor` polls on `setInterval`, which this file's poll test fakes; wait on real timeouts. */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  expect(condition()).toBe(true);
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

it("reads no threads again for targets whose activity is unchanged, and the same items come back", async () => {
  const fake = service({
    "view:a": { activity: one(), threads: [thread("view:a", "ta", [comment("ca")])] },
    "view:b": { activity: one(), threads: [thread("view:b", "tb", [comment("cb")])] },
  });
  const memo: WorkspaceThreadMemo = new Map();
  const first = await loadWorkspaceNotifications({ kind: "project", slug: "demo" }, options(fake.fetchImpl, memo));
  expect(fake.commentReads().sort()).toEqual(["view:a", "view:b"]);
  const second = await loadWorkspaceNotifications({ kind: "project", slug: "demo" }, options(fake.fetchImpl, memo));
  expect(fake.commentReads()).toHaveLength(2);
  expect(second).toEqual(first);
});

it("re-reads exactly the target whose activity changed and shows its new answer", async () => {
  const fake = service({
    "view:a": { activity: one(), threads: [thread("view:a", "ta", [comment("ca")])] },
    "view:b": { activity: one(), threads: [thread("view:b", "tb", [comment("cb")])] },
  });
  const memo: WorkspaceThreadMemo = new Map();
  await loadWorkspaceNotifications({ kind: "project", slug: "demo" }, options(fake.fetchImpl, memo));
  fake.state["view:b"] = {
    activity: one(1, 1, "2026-10-18T00:00:00Z"),
    threads: [thread("view:b", "tb", [comment("cb"), comment("cb2", "2026-10-18T00:00:00Z")])],
  };
  const next = await loadWorkspaceNotifications({ kind: "project", slug: "demo" }, options(fake.fetchImpl, memo));
  expect(fake.commentReads().sort()).toEqual(["view:a", "view:b", "view:b"]);
  expect("items" in next ? next.items.map((item) => item.comment.id) : []).toEqual(["cb2", "ca", "cb"]);
});

it("drops a target that no longer has threads and forgets targets that are gone", async () => {
  const fake = service({
    "view:a": { activity: one(), threads: [thread("view:a", "ta", [comment("ca")])] },
    "view:b": { activity: one(), threads: [thread("view:b", "tb", [comment("cb")])] },
  });
  const memo: WorkspaceThreadMemo = new Map();
  await loadWorkspaceNotifications({ kind: "project", slug: "demo" }, options(fake.fetchImpl, memo));
  delete fake.state["view:b"];
  const next = await loadWorkspaceNotifications({ kind: "project", slug: "demo" }, options(fake.fetchImpl, memo));
  expect("items" in next ? next.items.map((item) => item.comment.id) : []).toEqual(["ca"]);
  expect([...memo.keys()]).toEqual(["demo\0view:a"]);
});

it("keeps no failed read: the next refresh tries that target again and stays partial until it answers", async () => {
  const fake = service({ "view:a": { activity: one(), threads: [thread("view:a", "ta", [comment("ca")])] } });
  fake.failing.add("view:a");
  const memo: WorkspaceThreadMemo = new Map();
  expect(
    await loadWorkspaceNotifications({ kind: "project", slug: "demo" }, options(fake.fetchImpl, memo)),
  ).toMatchObject({ status: "partial" });
  fake.failing.delete("view:a");
  expect(
    await loadWorkspaceNotifications({ kind: "project", slug: "demo" }, options(fake.fetchImpl, memo)),
  ).toMatchObject({ status: "ready" });
  expect(fake.commentReads()).toEqual(["view:a", "view:a"]);
});

it("an idle bell's poll reads only the activity; the window's focus reads every target again", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  window.history.replaceState(null, "", "/projects/demo/?follow");
  const fake = service({ "view:a": { activity: one(), threads: [thread("view:a", "ta", [comment("ca")])] } });
  render(<WorkspaceNotifications scope={{ kind: "project", slug: "demo" }} fetchImpl={fake.fetchImpl as never} />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^Notifications/ })).toHaveAccessibleName(
      "Notifications, 1 unread agent answer",
    ),
  );
  expect(fake.commentReads()).toHaveLength(1);

  await act(async () => {
    vi.advanceTimersByTime(WORKSPACE_NOTIFICATION_POLL_MS);
  });
  await until(
    () => fake.fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("api/comment-activity")).length === 2,
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(fake.commentReads()).toHaveLength(1);

  // A new answer on the target changes its activity: the next poll reads it, and it counts as unread.
  fake.state["view:a"] = {
    activity: one(1, 1, "2026-10-18T00:00:00Z"),
    threads: [thread("view:a", "ta", [comment("ca"), comment("ca2", "2026-10-18T00:00:00Z")])],
  };
  await act(async () => {
    vi.advanceTimersByTime(WORKSPACE_NOTIFICATION_POLL_MS);
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^Notifications/ })).toHaveAccessibleName(
      "Notifications, 2 unread agent answers",
    ),
  );
  expect(fake.commentReads()).toHaveLength(2);

  // An edited comment changes no activity field; returning to the window reads every target again.
  fake.state["view:a"]!.threads = [
    thread("view:a", "ta", [
      comment("ca"),
      { ...comment("ca2", "2026-10-18T00:00:00Z"), body: "Edited", editedAt: "2026-10-19T00:00:00Z" },
    ]),
  ];
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await until(() => fake.commentReads().length === 3);
  fireEvent.click(screen.getByRole("button", { name: /^Notifications/ }));
  await screen.findByText("Edited");
});
