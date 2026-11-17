// @vitest-environment jsdom
//
// A comment edit carries the thread revision the page last saw (O124). Before it, "Save over it" was protected only
// by what the page had seen: with the page's copy stale (an event missed, another device's change not yet read), a
// Save wrote over a change the person never saw. Now the service refuses a stale edit (`thread_changed`); the page
// reads the comment back and, when its text changed, shows what it reads and offers "Save over it" (ThreadCard). When
// only the thread moved (a reply) and the comment reads as the page had it, the edit is sent again at the new
// revision: there is nothing to write over. A landed edit whose answer was lost is still taken as saved.
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, expect, it } from "vitest";
import { createReviewEvents } from "../src/comments/events";
import { useReview } from "../src/comments/useReview";
import { ThreadCard } from "../src/comments/ThreadCard";
import type { Capabilities, Thread } from "../src/comments/contract";
import { memoryTransport } from "./support/memory-transport";
import { NO_CAPABILITIES } from "../src/comments/contract";

const CAPS: Capabilities = { ...NO_CAPABILITIES, comments: true, notes: false };
const anchor = { kind: "view" } as const;
afterEach(cleanup);

function setup() {
  const transport = memoryTransport();
  const sent: (number | undefined)[] = [];
  const edit = transport.edit.bind(transport);
  transport.edit = async (threadId, commentId, body, expectedRevision) => {
    sent.push(expectedRevision);
    return edit(threadId, commentId, body, expectedRevision);
  };
  const made = transport.store.create({ target: "view:v", anchor, body: "Original" });
  return { transport, sent, made, commentId: made.comments[0]!.id };
}
const body = (transport: ReturnType<typeof memoryTransport>): string =>
  transport.store.list("view:v")[0]!.comments[0]!.body;

it("a stale page's Save is refused, nothing is written over the other change, and the page shows it; the next Save is taken", async () => {
  const { transport, sent, made, commentId } = setup();
  const page = renderHook(() =>
    useReview({ transport, capabilities: CAPS, viewId: "v", events: createReviewEvents() }),
  );
  await waitFor(() => expect(page.result.current.threads.get("view:v")).toHaveLength(1));
  // Another device changes the comment; this page does not hear of it.
  transport.store.edit(made.id, commentId, "Changed elsewhere");
  const thread = (): Thread => page.result.current.threads.get("view:v")![0]!;
  expect(thread().comments[0]!.body).toBe("Original");
  let ok = true;
  await act(async () => {
    ok = await page.result.current.actions.edit(thread(), commentId, "Mine");
  });
  expect(ok).toBe(false);
  expect(sent).toEqual([made.revision]);
  expect(body(transport)).toBe("Changed elsewhere");
  expect(thread().comments[0]!.body).toBe("Changed elsewhere");
  expect(page.result.current.error).toMatch(/changed elsewhere, so this change has not been saved/);
  // Save over it: the person has now seen the other text; the page's revision is current, so it is taken.
  await act(async () => {
    ok = await page.result.current.actions.edit(thread(), commentId, "Mine");
  });
  expect(ok).toBe(true);
  expect(body(transport)).toBe("Mine");
  expect(page.result.current.error).toBeNull();
});

it("only the thread moved (a reply elsewhere), the comment reads as the page had it: the edit is sent again and taken", async () => {
  const { transport, sent, made, commentId } = setup();
  const page = renderHook(() =>
    useReview({ transport, capabilities: CAPS, viewId: "v", events: createReviewEvents() }),
  );
  await waitFor(() => expect(page.result.current.threads.get("view:v")).toHaveLength(1));
  transport.store.reply(made.id, "A reply from another tab");
  let ok = false;
  await act(async () => {
    ok = await page.result.current.actions.edit(page.result.current.threads.get("view:v")![0]!, commentId, "Mine");
  });
  expect(ok).toBe(true);
  expect(sent).toEqual([made.revision, made.revision + 1]);
  expect(body(transport)).toBe("Mine");
  expect(page.result.current.error).toBeNull();
});

it("in the editor, the refused Save turns into Save over it with what the comment now reads", async () => {
  const { transport, made, commentId } = setup();
  function Card(): ReactElement | null {
    const review = useReview({ transport, capabilities: CAPS, viewId: "v", events: createReviewEvents() });
    const thread = review.threads.get("view:v")?.[0];
    if (thread === undefined) return null;
    const ok = async () => true;
    return (
      <ThreadCard
        thread={thread}
        scope="view"
        onReply={ok}
        onEdit={(id, text) => review.actions.edit(thread, id, text)}
        onDelete={ok}
        onResolve={ok}
        onDismiss={ok}
      />
    );
  }
  render(<Card />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Edit your comment" }), { target: { value: "Mine" } });
  transport.store.edit(made.id, commentId, "Changed elsewhere");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
  });
  const over = await screen.findByRole("button", { name: "Save over it" });
  expect(screen.getByText(/It now reads: “Changed elsewhere”/)).toBeTruthy();
  expect(body(transport)).toBe("Changed elsewhere");
  await act(async () => {
    fireEvent.click(over);
  });
  await waitFor(() => expect(body(transport)).toBe("Mine"));
});
