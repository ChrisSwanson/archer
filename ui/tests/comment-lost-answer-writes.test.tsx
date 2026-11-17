// @vitest-environment jsdom
//
// The write sweep (flows-r1 re-score 2): a delete, resolve or dismiss whose answer is lost after it landed is not
// said as "Could not …". The page reads Archer back: the thread (or comment) gone is the outcome the person asked
// for, said as done; still there, the failure is said; unreadable, it is said as not known. A second try is never
// needed to make the first one true. Bulk resolve and clear do the same per thread.
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createReviewEvents } from "../src/comments/events";
import { useReview } from "../src/comments/useReview";
import type { Capabilities, Thread } from "../src/comments/contract";
import { memoryTransport } from "./support/memory-transport";
import { NO_CAPABILITIES } from "../src/comments/contract";

const CAPS: Capabilities = { ...NO_CAPABILITIES, comments: true, notes: false };
const anchor = { kind: "view" } as const;
type Verb = "remove" | "resolve" | "dismiss";

function setup(verb: Verb, { landed = true, readFails = false, readsBeforeFailing = -1 } = {}) {
  const transport = memoryTransport();
  const t = transport.store.create({ target: "view:v", anchor, body: "Root" });
  // Only a thread the agent resolved can be dismissed.
  if (verb === "dismiss") {
    transport.store.submit("view:v", t.id);
    transport.store.agentRead("view:v");
    transport.store.agentResolve(t.id);
  }
  // readsBeforeFailing: after the write, that many listings succeed and every later one fails (codex-601).
  const ctl = { readFails: false, okLeft: -1, lastOkAt: 0 };
  const real = {
    remove: transport.remove.bind(transport),
    resolve: transport.resolve.bind(transport),
    dismiss: transport.dismiss.bind(transport),
  };
  const lose = async <T,>(work: () => Promise<T>): Promise<never> => {
    if (landed) await work();
    ctl.readFails = readFails;
    ctl.okLeft = readsBeforeFailing;
    throw new TypeError("Failed to fetch");
  };
  transport.remove = (threadId, commentId) => lose(() => real.remove(threadId, commentId));
  transport.resolve = (threadId) => lose(() => real.resolve(threadId));
  transport.dismiss = (threadId) => lose(() => real.dismiss(threadId));
  const list = transport.listThreads.bind(transport);
  transport.listThreads = async (target) => {
    if (ctl.readFails || ctl.okLeft === 0) throw new TypeError("Failed to fetch");
    if (ctl.okLeft > 0) ctl.okLeft -= 1;
    const read = await list(target);
    ctl.lastOkAt = Date.now();
    return read;
  };
  const events = createReviewEvents();
  const page = renderHook(() => useReview({ transport, capabilities: CAPS, viewId: "v", events }));
  const act1 = async (): Promise<boolean> => {
    const thread = (): Thread => page.result.current.threads.get("view:v")![0]!;
    let ok = false;
    await act(async () => {
      ok =
        verb === "remove"
          ? await page.result.current.actions.remove(thread(), thread().comments[0]!.id)
          : verb === "resolve"
            ? await page.result.current.actions.resolve(thread())
            : await page.result.current.actions.dismiss(thread());
    });
    return ok;
  };
  return { transport, page, act1, id: t.id, events, ctl };
}

describe.each(["remove", "resolve", "dismiss"] as const)("%s, its answer lost", (verb) => {
  it("it landed: read back and said as done, not 'Could not'", async () => {
    const { page, act1 } = setup(verb);
    await waitFor(() => expect(page.result.current.threads.get("view:v")).toHaveLength(1));
    expect(await act1()).toBe(true);
    expect(page.result.current.error).toBeNull();
    expect(page.result.current.threads.get("view:v") ?? []).toHaveLength(0);
  });
  // claude-405 / claude-407 (O132): not there at the first read-back is not yet "did not": a write can reach Archer
  // late. Said as not known yet, read again at 2, 6 and 15 s; a late arrival is taken as done and the message cleared;
  // after the last check it says what it last saw, still not known (codex-501), and "checks again" is gone.
  it("not there yet: said as not known, read again; never there, it says it did not, with no 'checks again' left", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { page, act1 } = setup(verb, { landed: false });
      await waitFor(() => expect(page.result.current.threads.get("view:v")).toHaveLength(1));
      expect(await act1()).toBe(false);
      expect(page.result.current.error).toMatch(/not known yet/);
      expect(page.result.current.error).toMatch(/checks again/);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_500);
      });
      // codex-501: what was last seen, with its time, and still not known; never "did not" from a read before delivery.
      expect(page.result.current.error).toMatch(
        /not known whether it did .*: when last checked, at .*, the (thread|comment) is still there/,
      );
      expect(page.result.current.error).not.toMatch(/so it did not|checks again/);
      expect(page.result.current.threads.get("view:v")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
  // codex-501: delivered after the last check (18 s): the next listing that shows the effect (here, the event a
  // change sends) settles it as done and clears the message.
  it("it reaches Archer after the last check: the next listing showing it settles it, and the message is cleared", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { page, act1, transport, id, events } = setup(verb, { landed: false });
      await waitFor(() => expect(page.result.current.threads.get("view:v")).toHaveLength(1));
      expect(await act1()).toBe(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_500);
      });
      expect(page.result.current.error).toMatch(/when last checked/);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });
      const t = transport.store.list("view:v").find((x) => x.id === id)!;
      if (verb === "remove") transport.store.remove(id, t.comments[0]!.id);
      else if (verb === "resolve") transport.store.resolve(id);
      else transport.store.dismiss(id);
      act(() => events.emit({ type: "comments", target: "view:v" }));
      await waitFor(() => expect(page.result.current.error).toBeNull());
      expect(page.result.current.threads.get("view:v") ?? []).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("it reaches Archer late: taken as done at the next check, and the message cleared", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { page, act1, transport, id } = setup(verb, { landed: false });
      await waitFor(() => expect(page.result.current.threads.get("view:v")).toHaveLength(1));
      expect(await act1()).toBe(false);
      expect(page.result.current.error).toMatch(/not known yet/);
      // The request arrives 1.5 s late.
      const t = transport.store.list("view:v").find((x) => x.id === id)!;
      if (verb === "remove") transport.store.remove(id, t.comments[0]!.id);
      else if (verb === "resolve") transport.store.resolve(id);
      else transport.store.dismiss(id);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_100);
      });
      expect(page.result.current.error).toBeNull();
      expect(page.result.current.threads.get("view:v") ?? []).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("Archer cannot be read either: said as not known, and after the last check nothing is said as seen", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { page, act1 } = setup(verb, { readFails: true });
      await waitFor(() => expect(page.result.current.threads.get("view:v")).toHaveLength(1));
      expect(await act1()).toBe(false);
      expect(page.result.current.error).toMatch(/not known (yet )?whether/);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_500);
      });
      expect(page.result.current.error).toMatch(/not known whether it did .*Try again once it answers/);
      expect(page.result.current.error).not.toMatch(/when last|still there|checks again/);
    } finally {
      vi.useRealTimers();
    }
  });
  // codex-601: the first read-back succeeds, every later one fails, and the effect is made elsewhere meanwhile. The
  // final words date the thread list to the read that saw it, not to the failed last check, and say that check failed.
  it("read once, then unreadable: the last successful read is dated as itself, and the failed check is said", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { page, act1, transport, id, ctl } = setup(verb, { landed: false, readsBeforeFailing: 1 });
      await waitFor(() => expect(page.result.current.threads.get("view:v")).toHaveLength(1));
      expect(await act1()).toBe(false);
      const seenAt = ctl.lastOkAt;
      const t = transport.store.list("view:v").find((x) => x.id === id)!;
      if (verb === "remove") transport.store.remove(id, t.comments[0]!.id);
      else if (verb === "resolve") transport.store.resolve(id);
      else transport.store.dismiss(id);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_500);
      });
      expect(ctl.lastOkAt).toBe(seenAt);
      const clock = (at: number): string =>
        new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const said = page.result.current.error ?? "";
      expect(said).toMatch(/not known whether it did .*: when last read, at .*, the (thread|comment) is still there/);
      expect(said).toContain(`at ${clock(seenAt)},`);
      expect(said).not.toContain(clock(Date.now()));
      expect(said).toMatch(/the latest check could not reach Archer/);
      expect(said).not.toMatch(/so it did not|checks again/);
    } finally {
      vi.useRealTimers();
    }
  });
});

it("bulk resolve: a thread whose answer was lost after it landed counts as resolved", async () => {
  const transport = memoryTransport();
  transport.store.create({ target: "view:v", anchor, body: "A" });
  transport.store.create({ target: "view:v", anchor: { kind: "view" }, body: "B" });
  const real = transport.resolve.bind(transport);
  let first = true;
  transport.resolve = async (threadId) => {
    await real(threadId);
    if (first) {
      first = false;
      throw new TypeError("Failed to fetch");
    }
  };
  const page = renderHook(() =>
    useReview({ transport, capabilities: CAPS, viewId: "v", events: createReviewEvents() }),
  );
  await waitFor(() => expect(page.result.current.threads.get("view:v")).toHaveLength(2));
  let n = 0;
  await act(async () => {
    n = await page.result.current.actions.resolveAll!(page.result.current.threads.get("view:v")!);
  });
  expect(n).toBe(2);
  expect(page.result.current.announcement?.text).toMatch(/^Resolved 2 /);
});
