// @vitest-environment jsdom
//
// An edit of an existing comment whose answer is lost (codex-303, O115). The PATCH commits and its answer never
// arrives ("Failed to fetch"). The page does not say "Could not save the change": it reads the comment back, and
// when it reads as the person's text the change is said as saved; when the outcome cannot be read it is said to be
// uncertain and the text is kept; when it still reads as before the next Save sends it. A Save that is not known
// to have landed is checked before it is sent again, so a landed edit is never written twice. A change made by
// someone else is still told apart: the person's next Save is still "Save over it" (ThreadCard), on an ordinary
// Save and on Save over it.
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createReviewEvents } from "../src/comments/events";
import { useReview } from "../src/comments/useReview";
import type { Capabilities, Thread } from "../src/comments/contract";
import { TransportError } from "../src/comments/transport";
import { memoryTransport } from "./support/memory-transport";
import { NO_CAPABILITIES } from "../src/comments/contract";

const CAPS: Capabilities = { ...NO_CAPABILITIES, comments: true, notes: false };
const anchor = { kind: "view" } as const;

/** A service whose next `lose` edit answers are dropped after commit; `readFails` makes the read-back fail too. */
function service() {
  const transport = memoryTransport();
  const control = { lose: 0, readFails: false, edits: 0 };
  const edit = transport.edit.bind(transport);
  transport.edit = async (threadId, commentId, body) => {
    control.edits += 1;
    const thread = await edit(threadId, commentId, body);
    if (control.lose > 0) {
      control.lose -= 1;
      throw new TypeError("Failed to fetch");
    }
    return thread;
  };
  const list = transport.listThreads.bind(transport);
  transport.listThreads = async (target) => {
    if (control.readFails) throw new TypeError("Failed to fetch");
    return list(target);
  };
  return { transport, control };
}

function mount(transport: ReturnType<typeof memoryTransport>) {
  const events = createReviewEvents();
  return renderHook(() => useReview({ transport, capabilities: CAPS, viewId: "v", events }));
}
const body = (transport: ReturnType<typeof memoryTransport>): string =>
  transport.store.list("view:v")[0]!.comments[0]!.body;

describe.each([
  ["Save", false],
  ["Save over it", true],
] as const)("%s, its answer lost", (_label, overIt) => {
  const setup = async () => {
    const s = service();
    const made = s.transport.store.create({ target: "view:v", anchor, body: "Original" });
    const page = mount(s.transport);
    await waitFor(() => expect(page.result.current.threads.get("view:v")).toHaveLength(1));
    // Save over it: another device changed the comment after the person began, and the page read that.
    if (overIt) {
      s.transport.store.edit(made.id, made.comments[0]!.id, "Changed elsewhere");
      await act(async () => {
        page.result.current.actions.refresh!("view:v");
      });
      await waitFor(() =>
        expect(page.result.current.threads.get("view:v")?.[0]?.comments[0]?.body).toBe("Changed elsewhere"),
      );
    }
    const thread = (): Thread => page.result.current.threads.get("view:v")![0]!;
    return { ...s, page, thread, commentId: made.comments[0]!.id };
  };

  it("committed: read back and said as saved, not 'Could not save'; edited once", async () => {
    const { transport, control, page, thread, commentId } = await setup();
    control.lose = 1;
    let ok = false;
    await act(async () => {
      ok = await page.result.current.actions.edit(thread(), commentId, "Mine");
    });
    expect(ok).toBe(true);
    expect(page.result.current.error).toBeNull();
    expect(page.result.current.announcement?.text).toMatch(/^Comment updated/);
    expect(body(transport)).toBe("Mine");
    expect(page.result.current.threads.get("view:v")![0]!.comments[0]!.body).toBe("Mine");
    expect(control.edits).toBe(1);
  });

  it("the read-back fails too: said as uncertain, text kept; the next Save checks first and does not write it twice", async () => {
    const { transport, control, page, thread, commentId } = await setup();
    control.lose = 1;
    control.readFails = true;
    let ok = true;
    await act(async () => {
      ok = await page.result.current.actions.edit(thread(), commentId, "Mine");
    });
    expect(ok).toBe(false);
    expect(page.result.current.error).toMatch(/may have been saved or not/);
    expect(page.result.current.error).not.toMatch(/could not save/i);
    control.readFails = false;
    const revision = transport.store.list("view:v")[0]!.revision;
    await act(async () => {
      ok = await page.result.current.actions.edit(thread(), commentId, "Mine");
    });
    expect(ok).toBe(true);
    expect(page.result.current.error).toBeNull();
    expect(control.edits).toBe(1);
    expect(transport.store.list("view:v")[0]!.revision).toBe(revision);
  });

  it("not committed (the comment still reads as before): said so, and the next Save sends it once", async () => {
    const { transport, control, page, thread, commentId } = await setup();
    const before = body(transport);
    const edit = transport.edit;
    transport.edit = async () => {
      control.edits += 1;
      throw new TypeError("Failed to fetch");
    };
    let ok = true;
    await act(async () => {
      ok = await page.result.current.actions.edit(thread(), commentId, "Mine");
    });
    expect(ok).toBe(false);
    expect(body(transport)).toBe(before);
    expect(page.result.current.error).toMatch(/has not been saved/);
    expect(page.result.current.error).not.toMatch(/could not save/i);
    transport.edit = edit;
    await act(async () => {
      ok = await page.result.current.actions.edit(thread(), commentId, "Mine");
    });
    expect(ok).toBe(true);
    expect(body(transport)).toBe("Mine");
  });

  it("meanwhile someone else changed it: not taken for the person's save, and nothing is written over it", async () => {
    const { transport, control, page, thread, commentId } = await setup();
    transport.edit = async (threadId, id) => {
      control.edits += 1;
      transport.store.edit(threadId, id, "A third text"); // another device's change lands; the person's does not
      throw new TypeError("Failed to fetch");
    };
    let ok = true;
    await act(async () => {
      ok = await page.result.current.actions.edit(thread(), commentId, "Mine");
    });
    expect(ok).toBe(false);
    expect(body(transport)).toBe("A third text");
    // The page now holds what the comment reads, so the editor says it changed and offers Save over it.
    expect(page.result.current.threads.get("view:v")![0]!.comments[0]!.body).toBe("A third text");
    expect(page.result.current.error).not.toMatch(/could not save/i);
  });

  it("a refusal is still said as one", async () => {
    const { transport, page, thread, commentId } = await setup();
    transport.edit = async () => {
      throw new TransportError("comment is too long", 400);
    };
    await act(async () => {
      await page.result.current.actions.edit(thread(), commentId, "Mine");
    });
    expect(page.result.current.error).toBe("Could not save the change: comment is too long");
  });
});
