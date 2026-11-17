// @vitest-environment jsdom
// PF-2 (review evidence performance-2026-11-02-draft, private, not published): the bell read the threads of every target with an agent
// comment on every page load, to count unread answers: on the projects page, a pageturner note's comments (9 → 10
// requests); on a diagram, a note's. The comment activity now names each target's agent comments, so the count needs
// no thread read; the threads are read once the reader shows they want the panel (pointer over or focus on the bell).
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceNotifications } from "../src/app/workspace-notifications";
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
const NOTE = "note:notes/0001-hosted-payment-page.md";
const activity = response.bind(null, {
  schemaVersion: 1,
  agentCommentsListed: true,
  targets: {
    [NOTE]: {
      totalThreads: 1,
      unresolvedThreads: 1,
      lastCommentedAt: "2026-10-17T00:00:00.000Z",
      agentComments: [{ thread: "thread-a", comment: "answer-a" }],
    },
    "view:system": { totalThreads: 1, unresolvedThreads: 1, lastCommentedAt: "2026-10-16T00:00:00.000Z" },
  },
});
const threads = {
  schemaVersion: 2,
  target: NOTE,
  threads: [
    {
      id: "thread-a",
      target: NOTE,
      anchor: { kind: "view" },
      status: "answered",
      revision: 2,
      comments: [
        { id: "question-a", author: "person", body: "Question", createdAt: "2026-10-16T00:00:00Z" },
        { id: "answer-a", author: "agent", body: "Answer a", createdAt: "2026-10-17T00:00:00Z" },
      ],
    },
  ],
};

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function service() {
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.endsWith("api/connection")) return response(CONNECTION);
    if (url.endsWith("api/bootstrap")) return response({ capabilities: { comments: true } });
    if (url.endsWith("api/comment-activity")) return activity();
    if (url.includes("api/comments?")) return response(threads);
    throw new Error(`unexpected ${url}`);
  });
  return {
    fetchImpl,
    threadReads: () =>
      fetchImpl.mock.calls.map(([url]) => url as string).filter((url) => url.includes("api/comments?")),
  };
}

it("counts unread agent answers from the comment activity, reading no thread on page load", async () => {
  window.history.replaceState(null, "", "/projects/demo/?follow");
  const { fetchImpl, threadReads } = service();
  render(<WorkspaceNotifications scope={{ kind: "project", slug: "demo" }} fetchImpl={fetchImpl} />);
  const bell = screen.getByRole("button", { name: "Notifications" });
  await waitFor(() => expect(bell).toHaveAccessibleName("Notifications, 1 unread agent answer"));
  await act(async () => {
    await new Promise((done) => setTimeout(done, 50));
  });
  expect(threadReads()).toEqual([]);
});

it("reads the threads once the reader shows they want the panel, and the panel opens on them", async () => {
  window.history.replaceState(null, "", "/projects/demo/?follow");
  const { fetchImpl, threadReads } = service();
  render(<WorkspaceNotifications scope={{ kind: "project", slug: "demo" }} fetchImpl={fetchImpl} />);
  const bell = screen.getByRole("button", { name: "Notifications" });
  await waitFor(() => expect(bell).toHaveAccessibleName("Notifications, 1 unread agent answer"));
  fireEvent.pointerEnter(bell);
  // Only the target with an agent comment is read; a target with none (view:system) has nothing for the bell.
  await waitFor(() => expect(threadReads()).toHaveLength(1));
  expect(threadReads()[0]).toContain(encodeURIComponent(NOTE));
  fireEvent.click(bell);
  expect(await screen.findByText("Answer a")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
  expect(bell).toHaveAccessibleName("Notifications");
});

it("a seen answer is not counted, with no thread read", async () => {
  window.history.replaceState(null, "", "/projects/demo/?follow");
  const { fetchImpl, threadReads } = service();
  const first = render(<WorkspaceNotifications scope={{ kind: "project", slug: "demo" }} fetchImpl={fetchImpl} />);
  fireEvent.focus(screen.getByRole("button", { name: "Notifications" }));
  fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
  fireEvent.click(await screen.findByRole("button", { name: "Mark read" }));
  first.unmount();
  const reads = threadReads().length;
  render(<WorkspaceNotifications scope={{ kind: "project", slug: "demo" }} fetchImpl={fetchImpl} />);
  const bell = screen.getByRole("button", { name: "Notifications" });
  await waitFor(() => expect(bell).toHaveAttribute("aria-description", expect.stringContaining("Last checked")));
  expect(bell).toHaveAccessibleName("Notifications");
  expect(threadReads()).toHaveLength(reads);
});
