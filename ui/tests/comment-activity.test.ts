// @vitest-environment jsdom
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { resources } from "../src/app/resources";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  COMMENT_ACTIVITY_MAX_TARGETS,
  loadCommentActivity,
  parseCommentActivity,
  useCommentActivity,
  type CommentActivityProject,
} from "../src/app/comment-activity";

beforeEach(() => resources.forget());

const answer = (value: unknown, status = 200): Response =>
  ({ ok: status === 200, status, json: async () => value }) as Response;

const valid = {
  schemaVersion: 1,
  targets: {
    "view:checkout": { totalThreads: 5, unresolvedThreads: 2, lastCommentedAt: "2026-10-11T10:15:00.000Z" },
    "note:notes/runbook.md": { totalThreads: 0, unresolvedThreads: 0, lastCommentedAt: null },
  },
};

it("reads the project conversation's own entry (`project:`) instead of refusing the whole answer", () => {
  const withProject = {
    schemaVersion: 1,
    targets: {
      ...valid.targets,
      "project:": { totalThreads: 1, unresolvedThreads: 1, lastCommentedAt: "2026-10-25T10:00:00.000Z" },
    },
  };
  expect(parseCommentActivity(withProject)?.get("project:")).toEqual({
    totalThreads: 1,
    unresolvedThreads: 1,
    lastCommentedAt: "2026-10-25T10:00:00.000Z",
  });
  expect(parseCommentActivity(withProject)?.get("view:checkout")?.totalThreads).toBe(5);
  // Only that exact string: `project:x` is no target.
  expect(
    parseCommentActivity({ schemaVersion: 1, targets: { "project:x": withProject.targets["project:"] } }),
  ).toBeNull();
});

it("parses the complete bounded per-target activity response without turning missing activity into zero", () => {
  expect(parseCommentActivity(valid)).toEqual(
    new Map([
      ["view:checkout", { totalThreads: 5, unresolvedThreads: 2, lastCommentedAt: "2026-10-11T10:15:00.000Z" }],
      ["note:notes/runbook.md", { totalThreads: 0, unresolvedThreads: 0, lastCommentedAt: null }],
    ]),
  );
  expect(parseCommentActivity({ schemaVersion: 1, targets: {} })).toEqual(new Map());
  expect(COMMENT_ACTIVITY_MAX_TARGETS).toBe(256 + 257 * 4_096);
  expect(parseCommentActivity(valid, 2)).not.toBeNull();
  expect(parseCommentActivity(valid, 1)).toBeNull();
});

it.each([
  null,
  [],
  { schemaVersion: 2, targets: {} },
  { schemaVersion: 1, targets: [] },
  { schemaVersion: 1, targets: { checkout: valid.targets["view:checkout"] } },
  { schemaVersion: 1, targets: { "view:": valid.targets["view:checkout"] } },
  { schemaVersion: 1, targets: { "view:x": { totalThreads: -1, unresolvedThreads: 0, lastCommentedAt: null } } },
  { schemaVersion: 1, targets: { "view:x": { totalThreads: 1.5, unresolvedThreads: 0, lastCommentedAt: null } } },
  { schemaVersion: 1, targets: { "view:x": { totalThreads: 1, unresolvedThreads: 2, lastCommentedAt: null } } },
  { schemaVersion: 1, targets: { "view:x": { totalThreads: 1, unresolvedThreads: 1, lastCommentedAt: "not a date" } } },
])("refuses the whole response when any activity entry is malformed: %#", (value) => {
  expect(parseCommentActivity(value)).toBeNull();
});

it("loads one actual endpoint per project with bounded concurrency and keeps failures unavailable", async () => {
  const projects: CommentActivityProject[] = Array.from({ length: 9 }, (_, index) => ({
    slug: `project-${index}`,
    current: index === 0,
  }));
  let active = 0;
  let peak = 0;
  const releases: (() => void)[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active -= 1;
    return url.includes("project-4") ? answer(null, 500) : answer(valid);
  });
  const loaded = loadCommentActivity(projects, "http://localhost:123/projects/project-0/?q=", fetchImpl);
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(4));
  await vi.waitFor(() => {
    while (releases.length > 0) releases.shift()!();
    expect(fetchImpl).toHaveBeenCalledTimes(9);
  });
  while (releases.length > 0) releases.shift()!();
  const result = await loaded;
  expect(peak).toBe(4);
  expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
    "api/comment-activity",
    "http://localhost:123/p/project-1/api/comment-activity",
    "http://localhost:123/p/project-2/api/comment-activity",
    "http://localhost:123/p/project-3/api/comment-activity",
    "http://localhost:123/p/project-4/api/comment-activity",
    "http://localhost:123/p/project-5/api/comment-activity",
    "http://localhost:123/p/project-6/api/comment-activity",
    "http://localhost:123/p/project-7/api/comment-activity",
    "http://localhost:123/p/project-8/api/comment-activity",
  ]);
  expect(result.get("project-0")?.get("view:checkout")?.totalThreads).toBe(5);
  expect(result.has("project-4")).toBe(false);
});

it("refreshes aggregate activity after a comment event key or window focus", async () => {
  const fetchImpl = vi.fn(async () => answer(valid));
  const projects: CommentActivityProject[] = [{ slug: "current", current: true, targetKey: "view:checkout" }];
  const { result, rerender } = renderHook(
    ({ refresh }) => useCommentActivity(projects, "http://localhost/projects/current/", fetchImpl, refresh),
    { initialProps: { refresh: 0 } },
  );
  await waitFor(() => expect(result.current.get("current")?.get("view:checkout")?.unresolvedThreads).toBe(2));
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  rerender({ refresh: 1 });
  await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
});

it("does not let an older refresh overwrite newer activity when fetch ignores abort", async () => {
  const newer = {
    schemaVersion: 1,
    targets: {
      "view:checkout": { totalThreads: 5, unresolvedThreads: 1, lastCommentedAt: "2026-10-11T10:20:00.000Z" },
    },
  };
  let resolveOlder!: (response: Response) => void;
  let resolveNewer!: (response: Response) => void;
  const olderResponse = new Promise<Response>((resolve) => {
    resolveOlder = resolve;
  });
  const newerResponse = new Promise<Response>((resolve) => {
    resolveNewer = resolve;
  });
  let request = 0;
  const fetchImpl = vi.fn((_url: string, _init?: RequestInit) => (request++ === 0 ? olderResponse : newerResponse));
  const projects: CommentActivityProject[] = [{ slug: "current", current: true, targetKey: "view:checkout" }];
  const { result, rerender } = renderHook(
    ({ refresh }) => useCommentActivity(projects, "http://localhost/projects/current/", fetchImpl, refresh),
    { initialProps: { refresh: 0 } },
  );

  await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
  rerender({ refresh: 1 });
  await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

  await act(async () => {
    resolveNewer(answer(newer));
    await newerResponse;
  });
  await waitFor(() => expect(result.current.get("current")?.get("view:checkout")?.unresolvedThreads).toBe(1));

  await act(async () => {
    // This request deliberately resolves after its AbortSignal fired.
    resolveOlder(answer(valid));
    await olderResponse;
  });
  expect(result.current.get("current")?.get("view:checkout")).toEqual(newer.targets["view:checkout"]);
});

it("arbitrary values, format vocabulary and small edits never throw or yield invalid activity on a small stack", () => {
  let seed = 23;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const words = [
    "{",
    "}",
    "[",
    "]",
    ":",
    ",",
    "null",
    "schemaVersion",
    "targets",
    "totalThreads",
    "unresolvedThreads",
    "lastCommentedAt",
    "view:x",
    "note:n.md",
  ];
  const text = JSON.stringify(valid);
  const samples: unknown[] = [];
  for (let round = 0; round < 150; round += 1) {
    samples.push(
      Array.from({ length: Math.floor(random() * 120) }, () => String.fromCharCode(Math.floor(random() * 65536))).join(
        "",
      ),
    );
    samples.push(
      Array.from({ length: Math.floor(random() * 30) }, () => words[Math.floor(random() * words.length)]!).join(""),
    );
    const at = Math.floor(random() * text.length);
    samples.push(text.slice(0, at) + words[Math.floor(random() * words.length)]! + text.slice(at + 1));
  }
  samples.push({
    schemaVersion: 1,
    targets: { "view:x": { totalThreads: Number.MAX_SAFE_INTEGER, unresolvedThreads: 0, lastCommentedAt: null } },
  });
  for (const sample of samples) {
    let value = sample;
    if (typeof sample === "string") {
      try {
        value = JSON.parse(sample);
      } catch {
        /* arbitrary text stays text */
      }
    }
    expect(() => parseCommentActivity(value)).not.toThrow();
  }
  const result = execFileSync(
    process.execPath,
    ["--stack_size=256", resolve("tests/support/comment-activity-property-runner.mjs")],
    { timeout: 5_000 },
  );
  expect(result.toString()).toBe("valid");
});
