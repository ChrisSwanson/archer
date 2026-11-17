import { afterEach, expect, test, vi } from "vitest";
import { callAccuracyOperation } from "../src/accuracy/client";
afterEach(() => vi.unstubAllGlobals());
test("page client delegates the exact named operation and returns shared structured JSON", async () => {
  const result = { sourceChanged: false };
  const fetch = vi.fn(async () => ({ ok: true, json: async () => result }));
  vi.stubGlobal("fetch", fetch);
  expect(await callAccuracyOperation("compare_diagrams", { viewId: "flow", from: "HEAD~1", to: "HEAD" })).toBe(result);
  expect(fetch).toHaveBeenCalledExactlyOnceWith("api/operations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "compare_diagrams", arguments: { viewId: "flow", from: "HEAD~1", to: "HEAD" } }),
  });
});
test("page operation refusal displays the server's named explanation", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: false,
      status: 422,
      json: async () => ({ error: { code: "invalid_request", message: "Commit name is required." } }),
    })),
  );
  await expect(callAccuracyOperation("compare_diagrams", {})).rejects.toThrow("Commit name is required.");
});
test("unreadable responses are a visible actionable error", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => {
        throw new Error("invalid JSON");
      },
    })),
  );
  await expect(callAccuracyOperation("compare_diagrams", {})).rejects.toThrow("unreadable response");
});
test("page operation refusal retains stable code and revision details", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: false,
      status: 422,
      json: async () => ({
        error: {
          code: "revision_conflict",
          message: "Changed source",
          details: { expected: "sha256:old", actual: "sha256:new" },
        },
      }),
    })),
  );
  await expect(callAccuracyOperation("export_diagram", {})).rejects.toMatchObject({
    code: "revision_conflict",
    details: { expected: "sha256:old", actual: "sha256:new" },
  });
});
test("oversized refusal detail nesting is discarded without recursive traversal", async () => {
  let details: Record<string, unknown> = { actual: "sha256:new" };
  for (let i = 0; i < 33; i++) details = { child: details };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: false,
      status: 422,
      json: async () => ({ error: { code: "revision_conflict", message: "Changed source", details } }),
    })),
  );
  await expect(callAccuracyOperation("export_diagram", {})).rejects.toMatchObject({
    code: "revision_conflict",
    details: undefined,
  });
});
