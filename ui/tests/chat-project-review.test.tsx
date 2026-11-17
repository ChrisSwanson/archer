// @vitest-environment jsdom
// The chat bubble's project conversation through the real review model and an in-memory store (wave 2 review,
// findings 19 and 20): no faked `isUnread` or `markSeen`, and one read of the project's threads, the model's.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ChatBubble } from "../src/chat/ChatBubble";
import { createReviewEvents } from "../src/comments/events";
import { useReview } from "../src/comments/useReview";
import { memoryTransport } from "./support/memory-transport";
import type { TargetRef } from "../src/comments/contract";
import { NO_CAPABILITIES } from "../src/comments/contract";

const TARGETS: readonly TargetRef[] = ["project:"];
const events = createReviewEvents();

function Page({ transport }: { readonly transport: ReturnType<typeof memoryTransport> }) {
  const review = useReview({
    transport,
    events,
    capabilities: { ...NO_CAPABILITIES, comments: true, notes: false },
    viewId: null,
    targets: TARGETS,
    projectIdentity: "demo",
    projectTitle: "Pageturner",
  });
  return (
    <ChatBubble
      review={review}
      transport={transport}
      doc={{ viewId: null, projectOnly: true }}
      title="Pageturner"
      projectTitle="Pageturner"
      context={{ page: "/" }}
      sidebarHost={null}
      dockHost={null}
      openRequest={0}
      closeRequest={0}
      drafts={new Map()}
    />
  );
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("an agent reply on the project conversation shows on the launcher, and reading it there marks it seen", async () => {
  const transport = memoryTransport([]);
  const thread = transport.store.create({ target: "project:", anchor: { kind: "project" }, body: "Where do I start?" });
  transport.store.submit();
  transport.store.agentReply(thread.id, "With the overview.");
  render(<Page transport={transport} />);
  const launcher = await screen.findByRole("button", { name: "Chat with the agent about Pageturner, 1 new reply" });
  fireEvent.click(launcher);
  expect(await screen.findByRole("log")).toHaveTextContent("With the overview.");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Chat with the agent about Pageturner" })).toBeInTheDocument(),
  );
  expect(localStorage.getItem("archer-comments-seen:v1:demo")).toContain("project:");
});

it("opening the chat on the project reads its threads no more than the review model already did", async () => {
  const transport = memoryTransport([]);
  const thread = transport.store.create({ target: "project:", anchor: { kind: "project" }, body: "Where do I start?" });
  transport.store.submit();
  render(<Page transport={transport} />);
  const reads = (): number => transport.calls.filter((call) => call === "listThreads").length;
  await waitFor(() => expect(reads()).toBe(1));
  fireEvent.click(screen.getByRole("button", { name: "Chat with the agent about Pageturner" }));
  expect(await screen.findByRole("log")).toHaveTextContent("Where do I start?");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(reads(), "one read per opening, and the model's covers it").toBe(1);
  expect(thread.id).toBeDefined();
});
