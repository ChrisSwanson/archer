// The nested view's layout through the page's worker (nest-protocol.ts, nest-worker.ts, the nest
// channel of elk-worker-transport.ts) gives what the in-process engine gives (nest-layout.ts with
// no Worker). The worker here is the production worker dispatcher on a fake scope, with ELK's own
// dispatcher behind it; only delivery is faked (structured clone, a task per message).

import { afterEach, describe, expect, test, vi } from "vitest";
import ElkWorkerModule from "elkjs/lib/elk-worker.min.js";
import type { LayoutResult } from "../src/layout/elk-layout";
import { DEFAULT_TYPEFACE } from "../src/layout/text-measure";
import type { ProjectedView } from "../src/diagrams/projection";
import { nestView } from "../src/nesting/nest-view";
import { LayoutWorkerTransport, resetBackgroundLayout } from "../src/layout/elk-worker-transport";
import { LayoutCancelled } from "../src/layout/layout-cancel";
import { installNestWorker } from "../src/nesting/nest-worker";
import { NEST_STEP_TIMEOUT_MS, type NestRequest } from "../src/nesting/nest-protocol";
import {
  cancelNestPrefetch,
  nestLayout,
  prefetchNest,
  resetNestLayout,
  type NestSession,
} from "../src/nesting/nest-layout";
import { enclosureFaults, viewOf } from "./support/nest-strategies";

vi.unmock("../src/layout/elk-worker-transport");

type Event = { data: unknown };
type ElkFake = { dispatcher: { saveDispatch(event: Event): void }; onmessage: ((event: Event) => void) | null };
const ElkFakeWorker = (ElkWorkerModule as unknown as { Worker: new () => ElkFake }).Worker;

/** A worker made of the production entry's dispatcher; messages are cloned and delivered a task later. */
class PairedWorker {
  static made: PairedWorker[] = [];
  onmessage: ((event: Event) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  readonly received: unknown[] = [];
  /** The nest replies the worker posted, as "id:kind". */
  readonly replies: string[] = [];
  readonly scope: { onmessage: ((event: Event) => void) | null; postMessage(message: unknown): void };
  terminated = false;
  /** Set to make the worker fail as a nest request arrives. */
  crashOnNest = false;
  constructor() {
    const elk = new ElkFakeWorker();
    this.scope = {
      onmessage: (event) => elk.dispatcher.saveDispatch(event),
      postMessage: (message) => {
        if (typeof message === "object" && message !== null && "nest" in message) {
          const reply = (message as { nest: { id: number; kind: string } }).nest;
          this.replies.push(`${reply.id}:${reply.kind}`);
        }
        const copy = structuredClone(message);
        setTimeout(() => {
          if (!this.terminated) this.onmessage?.({ data: copy });
        }, 0);
      },
    };
    // ELK's dispatcher answers through the scope, as `self.postMessage` does in the real worker.
    elk.onmessage = (event) => this.scope.postMessage(event.data);
    installNestWorker(this.scope);
    PairedWorker.made.push(this);
  }
  postMessage(message: unknown): void {
    this.received.push(message);
    const copy = structuredClone(message);
    if (this.crashOnNest && typeof copy === "object" && copy !== null && "nest" in copy) {
      setTimeout(() => this.onerror?.({}), 0);
      return;
    }
    setTimeout(() => {
      if (!this.terminated) this.scope.onmessage?.({ data: copy });
    }, 0);
  }
  terminate(): void {
    this.terminated = true;
  }
  get nestOps(): string[] {
    return this.received.flatMap((m) =>
      typeof m === "object" && m !== null && "nest" in m ? [(m as { nest: NestRequest }).nest.op] : [],
    );
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetBackgroundLayout();
  resetNestLayout();
  PairedWorker.made = [];
});

const session = (full: ProjectedView, revision = "r1"): NestSession => ({ full, typeface: DEFAULT_TYPEFACE, revision });

/** The same presses, through whichever client `nestLayout` picks. */
async function scenario(full: ProjectedView): Promise<{ firsts: LayoutResult[]; completes: LayoutResult[] }> {
  const s = session(full);
  const firsts: LayoutResult[] = [];
  const completes: LayoutResult[] = [];
  const press = async (open: string[], step?: { from: string[]; toggled: string }, at: NestSession = s) => {
    const answer = nestLayout(at, open, step);
    firsts.push(await answer.first);
    completes.push(await answer.complete);
  };
  await press([]);
  await press(["shop"], { from: [], toggled: "shop" });
  prefetchNest(s, ["shop"], ["api"]);
  await press(["api", "shop"], { from: ["shop"], toggled: "api" });
  await press(["shop"], { from: ["api", "shop"], toggled: "api" });
  await press([], { from: ["shop"], toggled: "shop" });
  await press(["api", "shop"], undefined, session(full, "r2"));
  return { firsts, completes };
}

describe("nest protocol", () => {
  test("the worker path gives what the in-process engine gives", async () => {
    const full = await viewOf("ts/test/fixtures/c4/nested.mmd");
    vi.stubGlobal("Worker", undefined);
    const local = await scenario(full);
    resetNestLayout();
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    vi.stubGlobal("Worker", PairedWorker);
    const worker = await scenario(full);
    expect(worker.completes).toEqual(local.completes);
    expect(worker.firsts).toEqual(local.firsts);
    expect(PairedWorker.made).toHaveLength(1);
    expect(PairedWorker.made[0]!.nestOps).toContain("prefetch");
    // The press that grew sent its first picture before the routed one; the base sent only one.
    const replies = PairedWorker.made[0]!.replies;
    expect(replies.slice(0, 3)).toEqual(["1:complete", "2:first", "2:complete"]);
    for (const layout of worker.completes.slice(0, 3)) expect(layout.nodes.length).toBeGreaterThan(0);
    // Return to an open set: the same object on the page too.
    expect(worker.completes[3]).toBe(worker.completes[1]);
    expect(worker.completes[4]).toBe(worker.completes[0]);
  }, 60_000);

  test("a session the worker has forgotten is sent again", async () => {
    const full = await viewOf("ts/test/fixtures/c4/nested.mmd");
    const worker = new PairedWorker();
    const transport = new LayoutWorkerTransport(() => worker as unknown as Worker);
    const first = await transport.nest.layout(session(full, "r0"), []).complete;
    // The worker keeps four sessions: r0 is gone after four more.
    for (const revision of ["r1", "r2", "r3", "r4"]) await transport.nest.layout(session(full, revision), []).complete;
    expect(await transport.nest.layout(session(full, "r0"), []).complete).toEqual(first);
    transport.close();
  }, 30_000);

  test("a worker that fails a press is replaced and the press is laid out by the fallback there", async () => {
    const full = await viewOf("ts/test/fixtures/c4/nested.mmd");
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    vi.stubGlobal("Worker", PairedWorker);
    const s = session(full);
    await nestLayout(s, []).complete;
    PairedWorker.made[0]!.crashOnNest = true;
    const answer = nestLayout(s, ["shop"], { from: [], toggled: "shop" });
    const laid = await answer.complete;
    expect(await answer.first).toBe(laid);
    expect(PairedWorker.made).toHaveLength(2);
    expect(PairedWorker.made[0]!.terminated).toBe(true);
    expect(PairedWorker.made[1]!.nestOps).toEqual(["fallback"]);
    const view = nestView(full, ["shop"]).view;
    expect(laid.nodes.map((n) => n.id).sort()).toEqual(view.nodes.map((n) => n.id).sort());
    expect(enclosureFaults(laid, view)).toBe(0);
  }, 30_000);

  test("a press still waiting as the page goes is refused, and its fallback starts no worker (O23)", async () => {
    const full = await viewOf("ts/test/fixtures/c4/nested.mmd");
    const page = new EventTarget();
    vi.stubGlobal("window", page);
    vi.stubGlobal("Worker", PairedWorker);
    const s = session(full);
    await nestLayout(s, []).complete;
    const answer = nestLayout(s, ["shop"], { from: [], toggled: "shop" });
    page.dispatchEvent(new Event("pagehide"));
    // The page's own stop, which the stage does not show as a failure (`layout-cancelled.test.tsx`).
    await expect(answer.complete).rejects.toBeInstanceOf(LayoutCancelled);
    await expect(answer.first).rejects.toThrow(/page is closing/);
    expect(PairedWorker.made).toHaveLength(1);
    expect(PairedWorker.made[0]!.terminated).toBe(true);
  }, 30_000);

  test("a press past its time limit closes the worker and is refused", async () => {
    vi.useFakeTimers();
    const full = await viewOf("ts/test/fixtures/c4/nested.mmd");
    const sent: unknown[] = [];
    const silent = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      postMessage: (m: unknown) => sent.push(m),
      terminate: vi.fn(),
    };
    const transport = new LayoutWorkerTransport(() => silent as unknown as Worker);
    const answer = transport.nest.layout(session(full), []);
    const refused = expect(answer.complete).rejects.toThrow("time limit");
    const firstRefused = expect(answer.first).rejects.toThrow("time limit");
    await vi.advanceTimersByTimeAsync(NEST_STEP_TIMEOUT_MS);
    await refused;
    await firstRefused;
    expect(transport.closed).toBe(true);
    expect(silent.terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("ELK's own replies still reach ELK through the nest channel's router", async () => {
    const worker = new PairedWorker();
    const transport = new LayoutWorkerTransport(() => worker as unknown as Worker);
    const full = await viewOf("ts/test/fixtures/c4/nested.mmd");
    const [plain, nested] = await Promise.all([
      transport.layout(nestView(full, []).view, DEFAULT_TYPEFACE),
      transport.nest.layout(session(full), []).complete,
    ]);
    expect(nested).toEqual(plain);
    transport.close();
  }, 30_000);

  test("prefetch is skipped when the reader asked to save data, and cancel reaches the worker", async () => {
    const full = await viewOf("ts/test/fixtures/c4/nested.mmd");
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    vi.stubGlobal("Worker", PairedWorker);
    vi.stubGlobal("navigator", { connection: { saveData: true } });
    const s = session(full);
    await nestLayout(s, []).complete;
    prefetchNest(s, [], ["shop"]);
    cancelNestPrefetch();
    expect(PairedWorker.made[0]!.nestOps).toEqual(["layout", "cancel"]);
  });
});
