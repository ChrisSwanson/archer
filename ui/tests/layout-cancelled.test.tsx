// @vitest-environment jsdom
//
// A layout still in the worker when the page is left (`pagehide`) is stopped by the page, not failed:
// the stage shows no error, and a page restored from the back/forward cache (`pageshow`) draws it (O23).
// Through the real transport, with a fake worker running ELK in process.
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api";

vi.unmock("../src/layout/elk-worker-transport");

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class MockApp {
    addEventListener(): void {}
    callServerTool = vi.fn(() => Promise.resolve({ content: [] }));
    close = vi.fn(() => Promise.resolve());
    connect = vi.fn(() => Promise.resolve());
    updateModelContext = vi.fn(() => Promise.resolve({}));
  },
}));

import { App } from "../src/app/App";
import { resetBackgroundLayout } from "../src/layout/elk-worker-transport";
import { MockEventSource, mountAgentPresented, restoreLocation, settle } from "./app-harness";

const elk = new ELK();
type Request = { id: number; cmd: string; graph?: ElkNode };
const workers: Kernel[] = [];
/** While true, a worker takes layouts and answers none: the page is left with one waiting. */
let holding = true;
class Kernel {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly layouts: Request[] = [];
  terminated = false;
  constructor() {
    workers.push(this);
  }
  terminate() {
    this.terminated = true;
  }
  postMessage(message: Request) {
    if (message.cmd === "register" || message.cmd === "algorithms") {
      queueMicrotask(() => this.onmessage?.({ data: { id: message.id, data: [] } } as MessageEvent));
      return;
    }
    this.layouts.push(message);
    if (!holding)
      void elk.layout(message.graph!).then((data) => {
        if (!this.terminated) this.onmessage?.({ data: { id: message.id, data } } as MessageEvent);
      });
  }
}

const drawn = (container: HTMLElement): number => container.querySelectorAll(".react-flow__node").length;

beforeEach(() => {
  MockEventSource.instances.length = 0;
  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal("Worker", Kernel);
  workers.length = 0;
  holding = true;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  restoreLocation();
  resetBackgroundLayout();
});

it("a layout stopped as the page is left shows no error, and is drawn when the page is shown again", async () => {
  const { container } = await mountAgentPresented(<App />, { ready: () => expect(workers[0]?.layouts.length).toBe(1) });
  expect(drawn(container)).toBe(0);

  await act(async () => {
    window.dispatchEvent(new Event("pagehide"));
    await settle();
  });
  expect(workers[0]!.terminated).toBe(true);
  expect(container.textContent, "the page's own stop is not a failure to show").not.toMatch(
    /page is closing|stopped|Layout computation failed/i,
  );
  // Nothing asks for a worker while the page is gone.
  expect(workers).toHaveLength(1);

  holding = false;
  await act(async () => {
    window.dispatchEvent(new Event("pageshow"));
    await settle();
  });
  await waitFor(() => expect(drawn(container)).toBe(2));
  expect(workers).toHaveLength(2);
});
