// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { browserStateKey, configureStaticAddress, encodeAddress } from "../src/playground/address";
import { commentDraftScope, keepCommentDraft, latestCommentDraft } from "../src/comments/comment-draft";
import { loadSeenState, seenStorageKey, storeSeenState } from "../src/comments/review-seen";
import { readRecents, RECENTS_KEY, useRecents } from "../src/app/recents";
import { decodeAddress as runtimeDecode } from "../src/runtime/address.ts";
import { projectResourceBase } from "../src/app/browser-routes";
import type { CommentOperation } from "../src/comments/contract";
import { operationHold } from "../src/comments/operations";

vi.hoisted(() => vi.resetModules());
vi.mock("../src/runtime/address.ts", async () => await import("../src/playground/address"));

const documentUrl = () => `${window.location.origin}/playground/app/index.html`;
const configure = (digest: string) => {
  configureStaticAddress({ documentUrl: documentUrl(), digest });
  window.history.replaceState(null, "", encodeAddress("/projects/tour/?follow"));
};
beforeEach(() => {
  localStorage.clear();
  configure("sha256:first");
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

it("keeps demo drafts, read state and operation receipts away from live keys and changed snapshots", () => {
  const liveSeenKey = "archer-comments-seen:v1:tour";
  const liveScope = `${window.location.origin}/p/tour/`;
  localStorage.setItem(liveSeenKey, "live seen sentinel");
  localStorage.setItem("archer.comment-draft.v1:live", "live draft sentinel");
  expect(runtimeDecode(window.location.href)).toBe(`${window.location.origin}/projects/tour/?follow`);
  expect(projectResourceBase(window.location.href)).toBe(liveScope);
  const scope = commentDraftScope();
  expect(scope).toBe(browserStateKey(liveScope));
  expect(
    keepCommentDraft(localStorage, {
      version: 1,
      scope,
      target: "view:containers",
      anchor: { kind: "view" },
      body: "Local question",
      baseRevision: null,
      savedAt: 1,
    }),
  ).toBe(true);
  storeSeenState(
    "tour",
    { entries: [{ target: "view:containers", threadId: "thread", commentId: "comment" }] },
    localStorage,
  );
  const hold = operationHold<CommentOperation>(localStorage, scope);
  hold.set("operation", {
    id: "a".repeat(32),
    issuedAt: Date.now(),
    name: "comment.create",
    target: "view:containers",
  });
  expect(latestCommentDraft(localStorage, scope, "view:containers")?.body).toBe("Local question");
  expect(loadSeenState("tour", localStorage).entries).toHaveLength(1);
  expect(
    Object.keys(localStorage)
      .filter((key) => !key.includes("live") && key !== liveSeenKey)
      .every((key) => key.startsWith(browserStateKey(""))),
  ).toBe(true);
  configure("sha256:changed");
  expect(latestCommentDraft(localStorage, commentDraftScope(), "view:containers")).toBeNull();
  expect(loadSeenState("tour", localStorage).entries).toEqual([]);
  expect(localStorage.getItem(liveSeenKey)).toBe("live seen sentinel");
  expect(localStorage.getItem("archer.comment-draft.v1:live")).toBe("live draft sentinel");
});

it("reads, writes and listens for recents only in the current demo namespace", () => {
  const liveRecents = [{ slug: "live", projectName: "Live", kind: "project", id: "", title: "Live", at: 1 }];
  localStorage.setItem(RECENTS_KEY, JSON.stringify(liveRecents));
  expect(readRecents()).toEqual([]);
  const { result } = renderHook(() => useRecents());
  act(() =>
    result.current.remember({ slug: "tour", projectName: "Tour", kind: "view", id: "containers", title: "Containers" }),
  );
  expect(result.current.items.map((item) => item.id)).toEqual(["containers"]);
  expect(localStorage.getItem(RECENTS_KEY)).toBe(JSON.stringify(liveRecents));
  localStorage.setItem(
    browserStateKey(RECENTS_KEY),
    JSON.stringify([{ ...liveRecents[0], slug: "ipoac", id: "flight", title: "Flight" }]),
  );
  act(() => window.dispatchEvent(new StorageEvent("storage", { key: RECENTS_KEY })));
  expect(result.current.items.map((item) => item.id)).toEqual(["containers"]);
  act(() => window.dispatchEvent(new StorageEvent("storage", { key: browserStateKey(RECENTS_KEY) })));
  expect(result.current.items.map((item) => item.id)).toEqual(["flight"]);
  configure("sha256:changed");
  expect(readRecents()).toEqual([]);
  expect(seenStorageKey("tour")).toBe(browserStateKey("archer-comments-seen:v1:tour"));
});
