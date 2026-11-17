// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  WORKSPACE_NOTIFICATION_DEADLINE_MS,
  WORKSPACE_NOTIFICATION_MAX_ITEMS,
  WorkspaceNotifications,
  loadWorkspaceNotifications,
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

const answer = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const activity = (targets: readonly string[]): Response =>
  answer({
    schemaVersion: 1,
    targets: Object.fromEntries(
      targets.map((target) => [target, { totalThreads: 1, unresolvedThreads: 1, lastCommentedAt: null }]),
    ),
  });
const comment = (id: string, author: "person" | "agent" = "agent") => ({
  id,
  author,
  body: `Body ${id}`,
  createdAt: "2026-10-17T00:00:00Z",
});
const thread = (target: string, id: string, comments = [comment(`c-${id}`)]) => ({
  id,
  target,
  anchor: { kind: "view" },
  status: "answered",
  revision: 1,
  comments,
});
const list = (target: string, threads: readonly unknown[]) => ({ schemaVersion: 2, target, threads });

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

it("keeps comment reads at concurrency four", async () => {
  const targets = Array.from({ length: 9 }, (_, index) => `view:v${index}`);
  let active = 0;
  let peak = 0;
  const releases: Array<() => void> = [];
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.endsWith("api/connection")) return answer(CONNECTION);
    if (url.endsWith("api/bootstrap")) return answer({ capabilities: { comments: true } });
    if (url.endsWith("api/comment-activity")) return activity(targets);
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active -= 1;
    const target = new URL(url).searchParams.get("target")!;
    return answer(list(target, []));
  });
  const pending = loadWorkspaceNotifications(
    { kind: "project", slug: "demo" },
    { fetchImpl, href: "https://host/projects/demo/?follow" },
  );
  await vi.waitFor(() => expect(releases).toHaveLength(4));
  while (fetchImpl.mock.calls.filter(([url]) => String(url).includes("api/comments?")).length < 9) {
    while (releases.length > 0) releases.shift()!();
    await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
  }
  while (releases.length > 0) releases.shift()!();
  await expect(pending).resolves.toMatchObject({ status: "ready" });
  expect(peak).toBe(4);
});

it("bounds a stalled response body by the whole-snapshot deadline", async () => {
  vi.useFakeTimers();
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.endsWith("api/connection")) return answer(CONNECTION);
    return new Response(
      new ReadableStream({
        start() {
          /* Deliberately never closes. */
        },
      }),
      { status: 200 },
    );
  });
  const pending = loadWorkspaceNotifications(
    { kind: "project", slug: "demo" },
    { fetchImpl, href: "https://host/projects/demo/?follow" },
  );
  await vi.advanceTimersByTimeAsync(WORKSPACE_NOTIFICATION_DEADLINE_MS);
  await expect(pending).resolves.toMatchObject({ status: "error" });
});

it("an aborted scope with a fetcher that ignores cancellation schedules no later reads", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
  const pending = loadWorkspaceNotifications(
    { kind: "project", slug: "demo" },
    {
      fetchImpl,
      href: "https://host/projects/demo/?follow",
      signal: controller.signal,
    },
  );
  controller.abort();
  await vi.advanceTimersByTimeAsync(WORKSPACE_NOTIFICATION_DEADLINE_MS);
  await expect(pending).resolves.toMatchObject({ status: "error" });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it("caps agent comments at the exact item ceiling and reports the omitted suffix", async () => {
  const targets = Array.from({ length: 9 }, (_, index) => `view:v${index}`);
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.endsWith("api/connection")) return answer(CONNECTION);
    if (url.endsWith("api/bootstrap")) return answer({ capabilities: { comments: true } });
    if (url.endsWith("api/comment-activity")) return activity(targets);
    const target = new URL(url).searchParams.get("target")!;
    const threads = Array.from({ length: 500 }, (_, index) => thread(target, `t-${target.slice(6)}-${index}`));
    return answer(list(target, threads));
  });
  const result = await loadWorkspaceNotifications(
    { kind: "project", slug: "demo" },
    { fetchImpl, href: "https://host/projects/demo/?follow" },
  );
  expect(result.status).toBe("partial");
  expect("items" in result ? result.items : []).toHaveLength(WORKSPACE_NOTIFICATION_MAX_ITEMS);
});

it.each([
  ["target mismatch", (target: string) => list("view:elsewhere", [thread(target, "t-good")])],
  ["thread target mismatch", (target: string) => list(target, [thread("view:elsewhere", "t-wrong-target")])],
  [
    "malformed comment",
    (target: string) =>
      list(target, [
        thread(target, "t-good"),
        thread(target, "t-bad", [{ id: "c-bad", author: "agent", body: 7, createdAt: "now" } as never]),
      ]),
  ],
  [
    "non-ISO timestamp",
    (target: string) => list(target, [thread(target, "t-non-iso", [{ ...comment("c-non-iso"), createdAt: "1" }])]),
  ],
  [
    "impossible calendar date",
    (target: string) =>
      list(target, [
        thread(target, "t-impossible", [{ ...comment("c-impossible"), createdAt: "2026-02-30T00:00:00Z" }]),
      ]),
  ],
  [
    "invalid comment timestamp",
    (target: string) =>
      list(target, [thread(target, "t-bad-date", [{ ...comment("c-bad-date"), createdAt: "not-a-date" }])]),
  ],
])("reports %s as partial rather than a complete empty snapshot", async (_name, payload) => {
  const target = "view:system";
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.endsWith("api/connection")) return answer(CONNECTION);
    if (url.endsWith("api/bootstrap")) return answer({ capabilities: { comments: true } });
    if (url.endsWith("api/comment-activity")) return activity([target]);
    return answer(payload(target));
  });
  const result = await loadWorkspaceNotifications(
    { kind: "project", slug: "demo" },
    { fetchImpl, href: "https://host/projects/demo/?follow" },
  );
  expect(result.status).toBe("partial");
});

it("keeps identical target, thread, and comment IDs independent by project and syncs storage events", async () => {
  window.history.replaceState(null, "", "/projects/");
  const projects = ["alpha-11111111", "beta-22222222"];
  const catalog = {
    schemaVersion: 1,
    projects: projects.map((slug) => ({
      slug,
      name: slug.startsWith("alpha") ? "Alpha" : "Beta",
      views: [{ id: "system", kind: "freeform", title: "System", registration: "durable" }],
      notes: [],
    })),
  };
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.endsWith("api/browser-projects")) return answer(catalog);
    if (url.endsWith("api/connection")) return answer(CONNECTION);
    if (url.endsWith("api/bootstrap")) return answer({ capabilities: { comments: true } });
    if (url.endsWith("api/comment-activity")) return activity(["view:system"]);
    return answer(list("view:system", [thread("view:system", "same-thread", [comment("same-answer")])]));
  });
  render(<WorkspaceNotifications scope={{ kind: "service" }} fetchImpl={fetchImpl} />);
  fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
  await waitFor(() => expect(screen.getAllByRole("button", { name: "Mark read" })).toHaveLength(2));
  fireEvent.click(screen.getAllByRole("button", { name: "Mark read" })[0]!);
  expect(screen.getByRole("button", { name: /^Notifications/ })).toHaveAccessibleName(
    "Notifications, 1 unread agent answer",
  );
  const unreadRow = screen
    .getAllByRole("listitem")
    .find((row) => within(row).queryByRole("button", { name: "Mark read" }) !== null)!;
  expect(unreadRow).toHaveTextContent(/Alpha|Beta/);
  const unreadProject = unreadRow.textContent!.includes("Alpha") ? projects[0]! : projects[1]!;
  localStorage.setItem(
    `archer-comments-seen:v1:${unreadProject}`,
    JSON.stringify({
      version: 1,
      entries: [{ target: "view:system", threadId: "same-thread", commentId: "same-answer" }],
    }),
  );
  act(() => window.dispatchEvent(new StorageEvent("storage", { key: `archer-comments-seen:v1:${unreadProject}` })));
  expect(screen.getByRole("button", { name: /^Notifications/ })).toHaveAccessibleName("Notifications");
});

it("orders valid offset timestamps by their actual instant", async () => {
  const target = "view:system";
  const fetchImpl = async (url: string) =>
    url.endsWith("api/connection")
      ? answer(CONNECTION)
      : url.endsWith("api/bootstrap")
        ? answer({ capabilities: { comments: true } })
        : url.endsWith("api/comment-activity")
          ? activity([target])
          : answer(
              list(target, [
                thread(target, "t-order", [
                  { ...comment("earlier"), createdAt: "2026-10-17T02:00:00+03:00" },
                  { ...comment("later"), createdAt: "2026-10-17T00:00:00Z" },
                ]),
              ]),
            );
  const result = await loadWorkspaceNotifications(
    { kind: "project", slug: "demo" },
    { href: "https://host/projects/demo/?follow", fetchImpl },
  );
  expect(result.status).toBe("ready");
  expect("items" in result ? result.items.map((item) => item.comment.id) : []).toEqual(["later", "earlier"]);
});

it.each(["Mark read"])("retains panel focus after %s replaces a focused control", async (action) => {
  window.history.replaceState(null, "", "/projects/demo/?follow");
  const target = "view:system";
  const fetchImpl = async (url: string) =>
    url.endsWith("api/connection")
      ? answer(CONNECTION)
      : url.endsWith("api/bootstrap")
        ? answer({ capabilities: { comments: true } })
        : url.endsWith("api/comment-activity")
          ? activity([target])
          : answer(list(target, [thread(target, "t-focus")]));
  render(<WorkspaceNotifications scope={{ kind: "project", slug: "demo" }} fetchImpl={fetchImpl} />);
  fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
  const control = await screen.findByRole("button", { name: action });
  control.focus();
  fireEvent.click(control);
  const panel = screen.getByRole("dialog", { name: "Notifications" });
  expect(panel).toHaveFocus();
  fireEvent.keyDown(panel, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
});

it("lists the answers of the good projects when another project in the catalog is too large or malformed", async () => {
  window.history.replaceState(null, "", "/projects/");
  const good = (slug: string, name: string) => ({
    slug,
    name,
    views: [{ id: "system", kind: "freeform", title: "System", registration: "durable" }],
    notes: [],
  });
  const catalog = {
    schemaVersion: 1,
    projects: [
      good("alpha-11111111", "Alpha"),
      {
        ...good("huge-33333333", "Huge"),
        notes: Array.from({ length: 50_001 }, (_, i) => ({ path: `notes/n${i}.md`, title: `N${i}`, viewIds: [] })),
      },
      { ...good("odd-44444444", "Odd"), views: "nope" },
      good("beta-22222222", "Beta"),
    ],
  };
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.endsWith("api/browser-projects")) return answer(catalog);
    if (url.endsWith("api/connection")) return answer(CONNECTION);
    if (url.endsWith("api/bootstrap")) return answer({ capabilities: { comments: true } });
    if (url.endsWith("api/comment-activity")) return activity(["view:system"]);
    return answer(list("view:system", [thread("view:system", "t1")]));
  });
  render(<WorkspaceNotifications scope={{ kind: "service" }} fetchImpl={fetchImpl} />);
  fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
  await waitFor(() => expect(screen.getAllByRole("button", { name: "Mark read" })).toHaveLength(2));
  expect(screen.queryByText(/incompatible/i)).toBeNull();
});
