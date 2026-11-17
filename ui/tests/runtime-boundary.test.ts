import { afterEach, describe, expect, it, vi } from "vitest";
import { browserFetch } from "../src/app/browser-resource";
import { runtime } from "../src/app/runtime";
import { createStaticRuntime } from "../src/playground/runtime";

afterEach(() => vi.restoreAllMocks());
describe("page runtime boundary", () => {
  it("routes every browser request through the selected adapter", async () => {
    const request = vi.spyOn(runtime, "request").mockResolvedValue(new Response("local"));
    const native = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network"));
    expect(await (await browserFetch("api/diagrams")).text()).toBe("local");
    expect(request).toHaveBeenCalledOnce();
    expect(native).not.toHaveBeenCalled();
  });
  it("static readiness permits local writes without claiming a live connection", () => {
    const local = createStaticRuntime();
    expect(local.writable("static-ready")).toBe(true);
    expect(local.writable("connected")).toBe(false);
    expect(runtime.writable("static-ready")).toBe(false);
  });
});
it("keeps live readiness separate from static readiness", () => {
  expect(runtime.writable("connected")).toBe(true);
  expect(runtime.writable("lost")).toBe(false);
});
it("lets the live page offer every runtime feature and the static example none", () => {
  expect(Object.values(runtime.features).every((on) => on === true)).toBe(true);
  expect(Object.values(createStaticRuntime().features).every((on) => on === false)).toBe(true);
  expect(Object.keys(createStaticRuntime().features).sort()).toEqual(Object.keys(runtime.features).sort());
});
it("keeps page code deciding by runtime features and vocabulary, never by which runtime it is", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = join(import.meta.dirname, "../src");
  const offenders = (readdirSync(root, { recursive: true }) as string[])
    .filter((file) => /\.tsx?$/.test(file) && !file.startsWith("playground"))
    .filter((file) => /\bruntime\.kind\b/.test(readFileSync(join(root, file), "utf8")));
  expect(offenders).toEqual([]);
});
