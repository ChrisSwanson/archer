import { beforeAll, afterEach, expect, it, vi } from "vitest";
import { exampleSnapshot } from "./support/playground-snapshot";
import type { PlaygroundSnapshot } from "../../shared/playground-snapshot.mts";
import { createStaticRuntime } from "../src/playground/runtime";
import { parseInventory } from "../src/app/inventory";
let snapshot: PlaygroundSnapshot;
beforeAll(async () => {
  snapshot = exampleSnapshot();
}, 30000);
afterEach(() => vi.restoreAllMocks());
it("reads the generated production inventory without network and owns independent response bodies", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
  const runtime = createStaticRuntime({
    snapshot,
    href: () => "https://demo.test/projects/archer-tour/?follow",
    storage: null,
  });
  const first = await runtime.request("api/diagrams");
  expect(first.ok).toBe(true);
  const inventory = parseInventory(await first.json());
  expect(inventory?.length).toBe(8);
  expect((await runtime.request("api/diagrams")).ok).toBe(true);
  expect(network).not.toHaveBeenCalled();
});
it("fails closed on foreign targets, unknown reads, unsupported writes and cancelled reads", async () => {
  const runtime = createStaticRuntime({
    snapshot,
    href: () => "https://demo.test/projects/archer-tour/?follow",
    storage: null,
  });
  expect((await runtime.request("https://evil.test/api/diagrams")).status).toBe(403);
  expect((await runtime.request("api/not-real")).status).toBe(404);
  expect((await runtime.request("api/selection", { method: "DELETE" })).status).toBe(405);
  const controller = new AbortController();
  controller.abort();
  await expect(runtime.request("api/diagrams", { signal: controller.signal })).rejects.toMatchObject({
    name: "AbortError",
  });
});
it("publishes parsed bootstrap/inventory before static readiness and cleans up pending delivery", async () => {
  const runtime = createStaticRuntime({
    snapshot,
    href: () => "https://demo.test/projects/archer-tour/?follow",
    storage: null,
  });
  const order: string[] = [];
  const onInventory = vi.fn((_views: unknown) => order.push("inventory"));
  const callbacks = {
    onPresent: vi.fn(),
    onClear: vi.fn(),
    onInventory,
    onCapabilities: vi.fn(),
    onConnection: vi.fn((status) => order.push(status)),
  };
  const bridge = runtime.connect!(callbacks);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(onInventory.mock.calls[0]?.[0]).toHaveLength(8);
  expect(order.at(-1)).toBe("static-ready");
  expect(callbacks.onCapabilities).toHaveBeenCalledWith(
    // Example settings (owner, 2026-11-15): the static runtime answers them itself (examples.ts).
    expect.objectContaining({ comments: true, listeners: false, instanceSettings: true }),
  );
  bridge.disconnect();
  const discarded = runtime.connect!(callbacks);
  discarded.disconnect();
  callbacks.onConnection.mockClear();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(callbacks.onConnection).not.toHaveBeenCalled();
});
it("validates local selection and walkthrough reports instead of accepting malformed writes", async () => {
  const runtime = createStaticRuntime({
    snapshot,
    href: () => "https://demo.test/projects/archer-tour/",
    storage: null,
  });
  for (const path of ["api/selection", "api/walkthrough-position"]) {
    expect(
      (await runtime.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))
        .status,
    ).toBe(422);
  }
});
it("does not substitute Tour for an unknown project address", async () => {
  const runtime = createStaticRuntime({
    snapshot,
    href: () => "https://demo.test/projects/private-project/",
    storage: null,
  });
  expect((await runtime.request("api/diagrams")).status).toBe(404);
});
it("discards outstanding bridge reads when the App unsubscribes", async () => {
  const runtime = createStaticRuntime({
    snapshot,
    href: () => "https://demo.test/projects/archer-tour/",
    storage: null,
  });
  const bridge = runtime.connect!({ onPresent: () => {}, onClear: () => {} });
  const reading = bridge.fetchView("containers");
  bridge.disconnect();
  await expect(reading).rejects.toMatchObject({ name: "AbortError" });
});
it("loads another example project's data on demand before answering for it, and retries a failed download", async () => {
  const tour = snapshot.projects.find((project) => project.slug === "archer-tour")!;
  const teapot = snapshot.projects.find((project) => project.slug === "rfc-2324-htcpcp")!;
  let href = "https://demo.test/projects/archer-tour/";
  let fail = true;
  const load = vi.fn(async (slug: string) => {
    if (fail) throw new Error("offline");
    return snapshot.projects.find((project) => project.slug === slug);
  });
  const runtime = createStaticRuntime({
    snapshot: { ...snapshot, projects: [tour] },
    href: () => href,
    storage: null,
    load,
  });
  expect((await runtime.request("api/diagrams")).ok).toBe(true);
  expect(load).not.toHaveBeenCalled();
  href = "https://demo.test/projects/rfc-2324-htcpcp/";
  const failed = await runtime.request("api/diagrams");
  expect(failed.status).toBe(503);
  fail = false;
  // Failed stays failed (no download per read) until the person retries.
  expect(runtime.loadFailed("rfc-2324-htcpcp")).toBe(true);
  expect((await runtime.request("api/diagrams")).status).toBe(503);
  expect(load).toHaveBeenCalledTimes(1);
  runtime.retry();
  expect(runtime.loadFailed("rfc-2324-htcpcp")).toBe(false);
  const inventory = parseInventory(await (await runtime.request("api/diagrams")).json());
  expect(inventory).toEqual(parseInventory(teapot.responses["api/diagrams"]));
  // A project-addressed request, and a connection, for a project not yet downloaded.
  const ipoac = await runtime.request("/p/rfc-1149-ipoac/api/diagrams");
  expect(ipoac.ok).toBe(true);
  href = "https://demo.test/projects/rfc-1149-ipoac/";
  const onInventory = vi.fn();
  const onBootstrapError = vi.fn();
  runtime.connect!({ onPresent: vi.fn(), onClear: vi.fn(), onInventory, onBootstrapError });
  await vi.waitFor(() => expect(onInventory).toHaveBeenCalled());
  expect(onBootstrapError).not.toHaveBeenCalled();
  expect(load.mock.calls.map(([slug]) => slug)).toEqual(["rfc-2324-htcpcp", "rfc-2324-htcpcp", "rfc-1149-ipoac"]);
});
