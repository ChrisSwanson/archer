// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connectBridge, type Bridge, type BridgeCallbacks } from "../src/app/host-bridge";
import { createStaticRuntime } from "../src/playground/runtime";
import { httpCommentsTransport, type CommentsTransport } from "../src/comments/transport";
import type { CommentsChanged, ThreadList } from "../src/comments/contract";
import type { PlaygroundSnapshot } from "../../shared/playground-snapshot.mts";
import { exampleSnapshot } from "./support/playground-snapshot";
import { pageOnService, type PageOnService } from "./support/page-on-service";
import { startTsProject, type TsProject } from "./support/ts-service";
import { commentWrites } from "./support/comment-writes";

/** Exact public fixture files; both transports compile this corpus through production code. */
function tourFiles(): Record<string, string> {
  const root = resolve(import.meta.dirname, "../../examples/archer-tour");
  const files: Record<string, string> = {};
  const visit = (folder: string): void => {
    for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
      const path = folder === "" ? entry.name : `${folder}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files[path] = readFileSync(join(root, path), "utf8");
      else throw new Error(`Example source must be a plain file: ${path}`);
    }
  };
  visit("");
  return files;
}

let project: TsProject;
let snapshot: PlaygroundSnapshot;
beforeAll(async () => {
  snapshot = exampleSnapshot();
  project = await startTsProject({ files: tourFiles(), nestedView: true });
}, 30000);
afterAll(async () => project?.stop());

describe.each(["live", "static"] as const)("%s subscription contract", (kind) => {
  let page: PageOnService | undefined;
  let connect: (callbacks: BridgeCallbacks) => Bridge;
  let comments: CommentsTransport;
  let network: ReturnType<typeof vi.fn<() => never>>;
  const bridges: Bridge[] = [];
  const ready = kind === "live" ? "connected" : "static-ready";

  beforeEach(async () => {
    if (kind === "live") {
      page = await pageOnService(project);
      connect = connectBridge;
      comments = httpCommentsTransport((url, init) => project.fetch(url, init));
    } else {
      page = undefined;
      const runtime = createStaticRuntime({
        snapshot,
        href: () => "https://demo.test/projects/archer-tour/?follow",
        storage: null,
      });
      connect = runtime.connect!;
      comments = httpCommentsTransport((url, init) => runtime.request(url, init));
      network = vi.fn(() => {
        throw new Error("Static subscriptions must not reach the network");
      });
      vi.stubGlobal("fetch", network);
      vi.stubGlobal(
        "EventSource",
        class {
          constructor() {
            network();
          }
        },
      );
    }
  });
  afterEach(async () => {
    for (const bridge of bridges.splice(0)) bridge.disconnect();
    await page?.close();
    if (kind === "static") expect(network).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  const attach = (callbacks: BridgeCallbacks): Bridge => {
    const bridge = connect(callbacks);
    bridges.push(bridge);
    return bridge;
  };
  const callbacks = () => ({
    onPresent: vi.fn(),
    onClear: vi.fn(),
    onInventory: vi.fn(),
    onCapabilities: vi.fn(),
    onConnection: vi.fn(),
    onComments: vi.fn(),
  });
  const awaitReady = async (observer: ReturnType<typeof callbacks>): Promise<void> => {
    await waitFor(() => expect(observer.onConnection).toHaveBeenCalledWith(ready));
  };

  it("applies parsed inventory and capabilities before declaring readiness", async () => {
    const observer = callbacks();
    const order: string[] = [];
    observer.onInventory.mockImplementation(() => order.push("inventory"));
    observer.onCapabilities.mockImplementation(() => order.push("capabilities"));
    observer.onConnection.mockImplementation((status: string) => order.push(status));
    attach(observer);
    await awaitReady(observer);
    expect(observer.onInventory).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: "containers", title: "Archer Containers" })]),
    );
    expect(observer.onCapabilities).toHaveBeenCalledWith(expect.objectContaining({ comments: true, notes: true }));
    const readyAt = order.indexOf(ready);
    expect(order.indexOf("inventory")).toBeLessThan(readyAt);
    expect(order.indexOf("capabilities")).toBeLessThan(readyAt);
  });

  it("notifies after a comment commits, so a callback reads the committed thread", async () => {
    const observer = callbacks();
    const reads: Promise<ThreadList>[] = [];
    observer.onComments.mockImplementation((changed: CommentsChanged) => {
      reads.push(comments.listThreads(changed.target));
    });
    attach(observer);
    await awaitReady(observer);
    const thread = await commentWrites(comments).createThread({
      target: "view:containers",
      anchor: { kind: "view" },
      body: `Committed before ${kind} notification`,
    });
    await waitFor(() => expect(reads.length).toBeGreaterThan(0));
    const snapshots = await Promise.all(reads);
    expect(
      snapshots.some((read) =>
        read.threads.some(
          (held) =>
            held.id === thread.id &&
            held.comments.some((comment) => comment.body === `Committed before ${kind} notification`),
        ),
      ),
    ).toBe(true);
  });

  it("immediate disconnect suppresses queued bootstrap callbacks", async () => {
    const observer = callbacks();
    attach(observer).disconnect();
    if (page) await page.close();
    else await Promise.resolve();
    for (const callback of Object.values(observer)) expect(callback).not.toHaveBeenCalled();
  });

  it("rejects an outstanding view read after disconnect rather than returning a stale answer", async () => {
    const observer = callbacks();
    const bridge = attach(observer);
    await awaitReady(observer);
    const pending = bridge.fetchView("containers");
    bridge.disconnect();
    await expect(pending).rejects.toMatchObject({ message: expect.any(String) });
  });

  it("releases comment subscriptions on disconnect", async () => {
    const observer = callbacks();
    const bridge = attach(observer);
    await awaitReady(observer);
    bridge.disconnect();
    if (page) await page.close();
    observer.onComments.mockClear();
    await commentWrites(comments).createThread({
      target: "view:containers",
      anchor: { kind: "view" },
      body: `Written after ${kind} disconnect`,
    });
    expect(observer.onComments).not.toHaveBeenCalled();
  });
});
