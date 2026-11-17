// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  QUIET_PHRASES,
  WORKSPACE_NOTIFICATION_MAX_TARGET_READS,
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

const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const activity = (targets: Record<string, number>) =>
  response({
    schemaVersion: 1,
    targets: Object.fromEntries(
      Object.entries(targets).map(([target, totalThreads]) => [
        target,
        { totalThreads, unresolvedThreads: totalThreads, lastCommentedAt: null },
      ]),
    ),
  });

const answered = (target: string, suffix: string) => ({
  schemaVersion: 2,
  target,
  threads: [
    {
      id: `thread-${suffix}`,
      target,
      anchor: { kind: "view" },
      status: "answered",
      revision: 2,
      comments: [
        { id: `question-${suffix}`, author: "person", body: "Question", createdAt: "2026-10-16T00:00:00Z" },
        { id: `answer-${suffix}`, author: "agent", body: `Answer ${suffix}`, createdAt: "2026-10-17T00:00:00Z" },
      ],
    },
  ],
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("loads every attached project including hidden projects, discovers capability first, and creates canonical project-qualified links", async () => {
  window.history.replaceState(null, "", "/projects/");
  const catalog = {
    schemaVersion: 1,
    projects: [
      {
        slug: "shown-11111111",
        name: "Shown",
        views: [{ id: "system", kind: "freeform", title: "System", registration: "durable", sourcePath: "system.mmd" }],
        notes: [],
        lifecycle: { state: "active", visibility: "auto" },
      },
      {
        slug: "hidden-22222222",
        name: "Hidden",
        views: [{ id: "system", kind: "freeform", title: "System", registration: "durable", sourcePath: "system.mmd" }],
        notes: [],
        lifecycle: { state: "inactive", visibility: "hidden" },
      },
    ],
  };
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    calls.push(url);
    if (url.endsWith("api/browser-projects")) return response(catalog);
    if (url.endsWith("api/connection")) return response(CONNECTION);
    if (url.endsWith("api/bootstrap")) return response({ capabilities: { comments: true } });
    if (url.endsWith("api/comment-activity")) return activity({ "view:system": 1 });
    if (url.includes("api/comments?"))
      return response(answered("view:system", url.includes("hidden") ? "hidden" : "shown"));
    throw new Error(`unexpected ${url}`);
  });
  const result = await loadWorkspaceNotifications({ kind: "service" }, { fetchImpl, href: window.location.href });
  expect(result.status).toBe("ready");
  if (result.status !== "ready") return;
  expect(result.items.map((item) => item.projectSlug)).toEqual(["hidden-22222222", "shown-11111111"]);
  expect(result.items[0]!.href).toBe("http://localhost:3000/projects/hidden-22222222/system.mmd?thread=thread-hidden");
  for (const slug of ["shown-11111111", "hidden-22222222"]) {
    const bootstrap = calls.findIndex((url) => url.includes(`/p/${slug}/api/bootstrap`));
    const comments = calls.findIndex((url) => url.includes(`/p/${slug}/api/comments?`));
    expect(bootstrap).toBeGreaterThan(-1);
    expect(comments).toBeGreaterThan(bootstrap);
  }
});

it("reports zero-project success, a bootstrap without capabilities, access failure, and partial project failures honestly", async () => {
  const empty = await loadWorkspaceNotifications(
    { kind: "service" },
    { fetchImpl: async () => response({ schemaVersion: 1, projects: [] }), href: "https://host/projects/" },
  );
  expect(empty).toMatchObject({ status: "ready", items: [], projects: { total: 0, loaded: 0 } });

  const uncapable = await loadWorkspaceNotifications(
    { kind: "project", slug: "demo" },
    {
      href: "https://host/projects/demo/?follow",
      fetchImpl: async (url) =>
        url.endsWith("api/connection") ? response(CONNECTION) : response({ presentation: {} }),
    },
  );
  expect(uncapable.status).toBe("incompatible");

  const denied = await loadWorkspaceNotifications(
    { kind: "project", slug: "demo" },
    {
      href: "https://host/projects/demo/?follow",
      fetchImpl: async () => response({}, 403),
    },
  );
  expect(denied.status).toBe("access-required");
});

it("keeps successful project answers when another project is revoked and refuses malformed snapshots", async () => {
  const catalog = {
    schemaVersion: 1,
    projects: [
      {
        slug: "open-11111111",
        name: "Open",
        views: [{ id: "system", kind: "freeform", title: "System", registration: "durable", sourcePath: "system.mmd" }],
        notes: [],
      },
      { slug: "closed-22222222", name: "Closed", views: [], notes: [] },
    ],
  };
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.endsWith("api/browser-projects")) return response(catalog);
    if (url.endsWith("api/connection")) return response(CONNECTION);
    if (url.includes("closed-22222222") && url.endsWith("api/bootstrap")) return response({}, 403);
    if (url.endsWith("api/bootstrap")) return response({ capabilities: { comments: true } });
    if (url.endsWith("api/comment-activity")) return activity({ "view:system": 1 });
    return response(answered("view:system", "open"));
  });
  const partial = await loadWorkspaceNotifications({ kind: "service" }, { fetchImpl, href: "https://host/projects/" });
  expect(partial).toMatchObject({ status: "partial", projects: { total: 2, loaded: 1 } });
  expect("items" in partial ? partial.items.map((item) => item.comment.body) : []).toEqual(["Answer open"]);

  const malformedCatalog = await loadWorkspaceNotifications(
    { kind: "service" },
    { fetchImpl: async () => response({ schemaVersion: 1, projects: "many" }), href: "https://host/projects/" },
  );
  expect(malformedCatalog.status).toBe("incompatible");
  const malformedActivity = await loadWorkspaceNotifications(
    { kind: "project", slug: "demo" },
    {
      fetchImpl: async (url) =>
        url.endsWith("api/connection")
          ? response(CONNECTION)
          : url.endsWith("api/bootstrap")
            ? response({ capabilities: { comments: true } })
            : response({ schemaVersion: 1, targets: [] }),
      href: "https://host/projects/demo/?follow",
    },
  );
  expect(malformedActivity.status).toBe("error");

  const droppedThread = await loadWorkspaceNotifications(
    { kind: "project", slug: "demo" },
    {
      fetchImpl: async (url) => {
        if (url.endsWith("api/connection")) return response(CONNECTION);
        if (url.endsWith("api/bootstrap")) return response({ capabilities: { comments: true } });
        if (url.endsWith("api/comment-activity")) return activity({ "view:system": 2 });
        const valid = answered("view:system", "valid");
        return response({ ...valid, threads: [...valid.threads, { id: 3 }] });
      },
      href: "https://host/projects/demo/?follow",
    },
  );
  expect(droppedThread.status).toBe("partial");
  expect("items" in droppedThread ? droppedThread.items.map((item) => item.comment.body) : []).toEqual([
    "Answer valid",
  ]);
});

it("links encoded notes and embedded views by their clean addresses with thread selection", async () => {
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.endsWith("api/connection")) return response(CONNECTION);
    if (url.endsWith("api/bootstrap"))
      return response({ capabilities: { comments: true }, project: { name: "Demo project" } });
    if (url.endsWith("api/comment-activity")) return activity({ "note:notes/a b.md": 1, "view:notes/a b.md#flow": 1 });
    const target = new URL(url).searchParams.get("target")!;
    return response(answered(target, target.startsWith("note:") ? "note" : "embedded"));
  });
  const result = await loadWorkspaceNotifications(
    { kind: "project", slug: "demo" },
    { fetchImpl, href: "https://host/projects/demo/" },
  );
  expect(result.status).toBe("ready");
  if (result.status !== "ready") return;
  expect(result.items.map((item) => [item.projectName, item.href])).toEqual([
    ["Demo project", "https://host/projects/demo/notes/a%20b.md?thread=thread-note"],
    ["Demo project", "https://host/projects/demo/notes/a%20b.md?thread=thread-embedded#flow"],
  ]);
});

it("reads in the background, opens on the answer already read, and marks project-qualified answers read", async () => {
  window.history.replaceState(null, "", "/projects/demo/?follow");
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.endsWith("api/connection")) return response(CONNECTION);
    if (url.endsWith("api/bootstrap")) return response({ capabilities: { comments: true } });
    if (url.endsWith("api/comment-activity")) return activity({ "view:system": 1 });
    return response(answered("view:system", "demo"));
  });
  const view = render(<WorkspaceNotifications scope={{ kind: "project", slug: "demo" }} fetchImpl={fetchImpl} />);
  const bell = screen.getByRole("button", { name: "Notifications" });
  expect(bell).toHaveClass("archer-notification-toggle");
  expect(bell).not.toHaveTextContent("0");
  await waitFor(() => expect(bell).toHaveAccessibleName("Notifications, 1 unread agent answer"));
  const reads = fetchImpl.mock.calls.length;
  fireEvent.click(bell);
  expect(screen.getByText("Answer demo")).toBeVisible();
  expect(fetchImpl).toHaveBeenCalledTimes(reads);
  expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Close notifications" })).toBeNull();
  fireEvent.click(bell);
  expect(bell).toHaveAccessibleName("Notifications, 1 unread agent answer");
  expect(bell).toHaveAttribute("aria-description", expect.stringContaining("Last checked"));
  fireEvent.click(bell);
  expect(await screen.findByText("Answer demo")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
  expect(bell).toHaveAccessibleName("Notifications");
  view.unmount();
  render(<WorkspaceNotifications scope={{ kind: "project", slug: "demo" }} fetchImpl={fetchImpl} />);
  fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
  await waitFor(() => expect(screen.getByText("Answer demo")).toBeVisible());
  expect(screen.getByRole("button", { name: "Notifications" })).toHaveAccessibleName("Notifications");
});

it("caps target requests, reports truncation as partial, and aborts an open read when unmounted", async () => {
  const targets = Object.fromEntries(
    Array.from({ length: WORKSPACE_NOTIFICATION_MAX_TARGET_READS + 1 }, (_, index) => [`view:v${index}`, 1]),
  );
  let commentReads = 0;
  const boundedFetch = vi.fn(async (url: string) => {
    if (url.endsWith("api/connection")) return response(CONNECTION);
    if (url.endsWith("api/bootstrap")) return response({ capabilities: { comments: true } });
    if (url.endsWith("api/comment-activity")) return activity(targets);
    commentReads += 1;
    return response({ schemaVersion: 2, target: new URL(url).searchParams.get("target"), threads: [] });
  });
  const bounded = await loadWorkspaceNotifications(
    { kind: "project", slug: "demo" },
    { fetchImpl: boundedFetch, href: "https://host/projects/demo/?follow" },
  );
  expect(bounded.status).toBe("partial");
  expect(commentReads).toBe(WORKSPACE_NOTIFICATION_MAX_TARGET_READS);

  let signal: AbortSignal | undefined;
  const stalled = vi.fn((_url: string, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  });
  window.history.replaceState(null, "", "/projects/demo/?follow");
  const mounted = render(<WorkspaceNotifications scope={{ kind: "project", slug: "demo" }} fetchImpl={stalled} />);
  await waitFor(() => expect(signal).toBeDefined());
  mounted.unmount();
  expect(signal!.aborted).toBe(true);
});

it("shows a rotating quiet phrase, with steady text for assistive technology, when empty and closes on a press outside the panel", async () => {
  window.history.replaceState(null, "", "/projects/demo/?follow");
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.endsWith("api/connection")) return response(CONNECTION);
    if (url.endsWith("api/bootstrap")) return response({ capabilities: { comments: true } });
    return activity({});
  });
  render(<WorkspaceNotifications scope={{ kind: "project", slug: "demo" }} fetchImpl={fetchImpl} />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Notifications" })).toHaveAttribute(
      "aria-description",
      expect.stringContaining("Last checked"),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
  const panel = screen.getByRole("dialog", { name: "Notifications" });
  expect(panel).toHaveAttribute("data-empty", "true");
  expect(screen.getByText("No notifications.")).toHaveClass("archer-visually-hidden");
  const phrase = panel.querySelector(".archer-workspace-notifications-phrase");
  expect(phrase).toHaveAttribute("aria-hidden", "true");
  expect(QUIET_PHRASES).toContain(phrase?.textContent);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
});

it("keeps every quiet phrase short enough for one line", () => {
  expect(QUIET_PHRASES.length).toBeGreaterThanOrEqual(24);
  expect(new Set(QUIET_PHRASES).size).toBe(QUIET_PHRASES.length);
  for (const phrase of QUIET_PHRASES) expect(phrase.length, phrase).toBeLessThanOrEqual(32);
});
