// @vitest-environment jsdom
/**
 * The options the MCP-App bridge hands the SDK are part of what it does.
 *
 * `host-bridge.test.ts` fakes the SDK's `App` with a class that has no
 * constructor, so it accepts and discards whatever it is constructed with.
 * Flipping `autoResize: false` to `true` therefore passed all 1,850 tests
 * (adversarial review 2026-10-02, "Tests that prove less than they appear
 * to"). With `autoResize` on, the SDK watches the document and tells the host
 * to resize the frame to its content; Archer's page is a canvas that fills the
 * frame it is given, so the two would chase each other. This fake keeps what
 * it is constructed with, and the test states it.
 *
 * What this cannot say is what a real host does with either setting: that is
 * the embedded-host smoke test the same review asks for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const constructed = vi.hoisted(() => ({ calls: [] as unknown[][] }));

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class RecordingApp {
    constructor(...args: unknown[]) {
      constructed.calls.push(args);
    }

    addEventListener(): void {}

    callServerTool = (): Promise<unknown> => Promise.resolve({ content: [] });

    close = (): Promise<void> => Promise.resolve();

    connect = (): Promise<void> => Promise.resolve();

    updateModelContext = (): Promise<unknown> => Promise.resolve({});
  },
}));

import { connectBridge } from "../src/app/host-bridge";

describe("the MCP-App bridge's SDK options", () => {
  beforeEach(() => {
    constructed.calls.length = 0;
    // An embedded page: the `ui:` scheme is how the bridge knows it is one.
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      location: { protocol: "ui:" },
      parent: {},
      removeEventListener: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("constructs the App once, with automatic resizing off and strict mode on", async () => {
    const bridge = connectBridge({ onPresent: vi.fn(), onClear: vi.fn() });
    await vi.dynamicImportSettled();

    expect(constructed.calls).toHaveLength(1);
    const [info, capabilities, options] = constructed.calls[0]!;
    expect(info).toMatchObject({ name: "Archer" });
    expect(capabilities).toEqual({});
    expect(options).toEqual({ autoResize: false, strict: true });

    bridge.disconnect();
  });
});
