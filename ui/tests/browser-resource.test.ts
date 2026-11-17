import { afterEach, describe, expect, it, vi } from "vitest";
import { browserFetch, browserResourceUrl, DROPPED_READ_RETRY_MS } from "../src/app/browser-resource";
it("uses fixed API roots on canonical nested pages and global overview", () => {
  expect(browserResourceUrl("api/events", "https://host/projects/a/notes/deep/")).toBe("https://host/p/a/api/events");
  expect(browserResourceUrl("api/comments?target=note%3Aa", "https://host/projects/a/notes/a.md")).toBe(
    "https://host/p/a/api/comments?target=note%3Aa",
  );
  expect(browserResourceUrl("api/projects", "https://host/projects/")).toBe("https://host/api/projects");
  // An address that is no page (a retired `/p/<name>/` or token-prefixed form, an embedded view) keeps it relative.
  expect(browserResourceUrl("api/events", "https://host/token/p/a/")).toBe("api/events");
  expect(browserResourceUrl("api/events", "https://host/p/a/")).toBe("api/events");
  expect(browserResourceUrl("api/events", "https://host/projects/a/?follow")).toBe("https://host/p/a/api/events");
  expect(browserResourceUrl("https://else/api/events", "https://host/projects/a/")).toBe("https://else/api/events");
});

// E11: Chromium fails every request in flight when the host's network changes (net::ERR_NETWORK_CHANGED,
// loopback included, as a container starting adds an interface). fetch rejects with a TypeError then.
describe("a read the browser dropped unanswered", () => {
  const dropped = () => new TypeError("Failed to fetch");
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  it("is asked once more, and its answer is the answer", async () => {
    vi.useFakeTimers();
    const answer = new Response("{}");
    const fetch = vi.fn().mockRejectedValueOnce(dropped()).mockResolvedValueOnce(answer);
    vi.stubGlobal("fetch", fetch);
    const read = browserFetch("api/notes?viewId=a", { cache: "no-store" });
    await vi.advanceTimersByTimeAsync(DROPPED_READ_RETRY_MS);
    await expect(read).resolves.toBe(answer);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("still fails when the second ask is dropped too", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockRejectedValue(dropped());
    vi.stubGlobal("fetch", fetch);
    const read = browserFetch("api/notes?viewId=a");
    const settled = expect(read).rejects.toBeInstanceOf(TypeError);
    await vi.advanceTimersByTimeAsync(DROPPED_READ_RETRY_MS);
    await settled;
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("is not asked again when it was a write, an answer or an abort", async () => {
    for (const [init, failure] of [
      [{ method: "POST", body: "{}" }, dropped()],
      [{ method: "DELETE" }, dropped()],
      [undefined, new DOMException("aborted", "AbortError")],
      [undefined, new Error("not the network")],
      [undefined, new TypeError("Failed to parse URL from api/x")],
    ] as const) {
      const fetch = vi.fn().mockRejectedValue(failure);
      vi.stubGlobal("fetch", fetch);
      await expect(browserFetch("api/comments", init)).rejects.toBe(failure);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    const refused = vi.fn().mockResolvedValue(new Response("", { status: 503 }));
    vi.stubGlobal("fetch", refused);
    expect((await browserFetch("api/notes")).status).toBe(503);
    expect(refused).toHaveBeenCalledTimes(1);
  });
  it("is not asked again once its caller has given up on it", async () => {
    const controller = new AbortController();
    const fetch = vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.reject(dropped());
    });
    vi.stubGlobal("fetch", fetch);
    await expect(browserFetch("api/notes", { signal: controller.signal })).rejects.toBeInstanceOf(TypeError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
