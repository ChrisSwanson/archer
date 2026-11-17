import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSelectionSender, SELECTION_SEND_INTERVAL_MS } from "../src/app/selection-sender.ts";

describe("selection sender", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const recorder = () => {
    const sent: unknown[] = [];
    const answers: Array<() => void> = [];
    const send = vi.fn((body: string) => {
      sent.push(JSON.parse(body));
      return new Promise<void>((resolve) => answers.push(resolve));
    });
    const answer = async () => {
      answers.shift()?.();
      await vi.advanceTimersByTimeAsync(0);
    };
    return { sent, send, answer };
  };

  it("arrowing through 50 boxes sends a handful of selections, ending on the last one", async () => {
    const { sent, send, answer } = recorder();
    const sender = createSelectionSender(send);
    for (let i = 0; i < 50; i++) {
      sender.update({ nodes: [`n${i}`] });
      await vi.advanceTimersByTimeAsync(20); // a key repeat every 20 ms: 1 s in all
      if (sent.length > 0) await answer();
    }
    await vi.advanceTimersByTimeAsync(SELECTION_SEND_INTERVAL_MS);
    await answer();
    expect(sent.length).toBeLessThanOrEqual(1000 / SELECTION_SEND_INTERVAL_MS + 2);
    expect(sent.at(-1)).toEqual({ nodes: ["n49"] });
  });

  it("a change after a quiet moment goes at once; the last of a burst goes when the window closes", async () => {
    const { sent, send, answer } = recorder();
    const sender = createSelectionSender(send);
    sender.update({ nodes: ["a"] });
    expect(sent).toEqual([{ nodes: ["a"] }]);
    await answer();
    sender.update({ nodes: ["b"] });
    sender.update({ nodes: ["c"] });
    expect(sent).toEqual([{ nodes: ["a"] }]);
    await vi.advanceTimersByTimeAsync(SELECTION_SEND_INTERVAL_MS);
    expect(sent).toEqual([{ nodes: ["a"] }, { nodes: ["c"] }]);
  });

  it("a selection in another view or revision goes at once, even inside a window", async () => {
    const { sent, send, answer } = recorder();
    const sender = createSelectionSender(send);
    sender.update({ viewId: "a", nodes: ["x"] }, "a@1");
    await answer();
    sender.update({ viewId: "b", nodes: [] }, "b@1");
    expect(sent).toEqual([
      { viewId: "a", nodes: ["x"] },
      { viewId: "b", nodes: [] },
    ]);
    await answer();
    sender.update({ viewId: "b", nodes: ["y"] }, "b@2");
    expect(sent.at(-1)).toEqual({ viewId: "b", nodes: ["y"] });
  });

  it("one request at a time, in the order the person chose: a change made while one is out follows it", async () => {
    const { sent, send, answer } = recorder();
    const sender = createSelectionSender(send);
    sender.update({ nodes: ["a"] });
    sender.flush();
    sender.update({ nodes: ["b"] });
    sender.flush(); // still out: b waits for a's answer
    expect(sent).toEqual([{ nodes: ["a"] }]);
    await answer();
    expect(sent).toEqual([{ nodes: ["a"] }, { nodes: ["b"] }]);
  });

  it("re-sends an unchanged selection: the page republishes on purpose (a redraw, a restarted service)", async () => {
    const { sent, send, answer } = recorder();
    const sender = createSelectionSender(send);
    sender.update({ nodes: ["a"] });
    await answer();
    await vi.advanceTimersByTimeAsync(SELECTION_SEND_INTERVAL_MS);
    sender.update({ nodes: ["a"] });
    expect(sent).toEqual([{ nodes: ["a"] }, { nodes: ["a"] }]);
  });

  it("a send that failed goes again with the next flush", async () => {
    const sent: unknown[] = [];
    let fail = true;
    const send = vi.fn(async (body: string) => {
      sent.push(JSON.parse(body));
      if (fail) throw new Error("offline");
    });
    const sender = createSelectionSender(send);
    sender.update({ nodes: ["a"] });
    sender.flush();
    await vi.advanceTimersByTimeAsync(0);
    fail = false;
    sender.update({ nodes: ["a"] });
    sender.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([{ nodes: ["a"] }, { nodes: ["a"] }]);
  });

  it("dispose sends what is pending, then nothing more", async () => {
    const { sent, send } = recorder();
    const sender = createSelectionSender(send);
    sender.update({ nodes: ["a"] });
    sender.dispose();
    expect(sent).toEqual([{ nodes: ["a"] }]);
    sender.update({ nodes: ["b"] });
    await vi.advanceTimersByTimeAsync(SELECTION_SEND_INTERVAL_MS * 2);
    expect(sent).toEqual([{ nodes: ["a"] }]);
  });
});
