// ArtifactJobs (service/artifact-jobs.ts): the background refresh of each saved review's derived diff file after
// a project opens. One file per turn of the event loop; a source another writer holds is retried later, a few times.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { REVIEW_SOURCE_BUSY, type ReviewArtifactResult } from "../../src/authoring/review-artifacts.ts";
import type { AuthoringStore } from "../../src/authoring/store.ts";
import {
  ARTIFACT_LOCK_WAIT_MS,
  ARTIFACT_RETRIES,
  ARTIFACT_RETRY_MS,
  ArtifactJobs,
} from "../../src/service/artifact-jobs.ts";
import * as service from "../../src/service/service.ts";
import { cleanUp, tempDir } from "./support.ts";

afterEach(cleanUp);
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const written: ReviewArtifactResult = { status: "written", message: "ok" } as ReviewArtifactResult;
const busy: ReviewArtifactResult = { status: "blocked", message: REVIEW_SOURCE_BUSY };

function harness(
  options: {
    reviews?: Record<string, string[]>;
    opened?: boolean;
    journal?: boolean;
    refresh?: (root: string, reviewId: string) => ReviewArtifactResult;
    listFails?: boolean;
  } = {},
) {
  const stateDir = tempDir("archer-artifacts-");
  if (options.journal === true) {
    mkdirSync(join(stateDir, "runtime", "authoring"), { recursive: true });
    writeFileSync(join(stateDir, "runtime", "authoring", "index.json"), "{}");
  }
  const store = {
    listReviews: (root: string) => {
      if (options.listFails === true) throw new Error("journal unreadable");
      return (options.reviews?.[root] ?? []).map((reviewId) => ({ reviewId }));
    },
  } as unknown as AuthoringStore;
  let open = options.opened ?? true;
  const calls: { root: string; reviewId: string; lockTimeoutMs: number | undefined }[] = [];
  const state = { stopping: false, attached: new Set<string>(Object.keys(options.reviews ?? {})) };
  const jobs = new ArtifactJobs({
    stateDir,
    saved: {
      get: () => {
        open = true;
        return store;
      },
      peek: () => (open ? store : undefined),
    },
    refresh: (root, reviewId, artifactOptions) => {
      calls.push({ root, reviewId, lockTimeoutMs: artifactOptions?.lockTimeoutMs });
      return options.refresh?.(root, reviewId) ?? written;
    },
    hasProject: (root) => state.attached.has(root),
    isStopping: () => state.stopping,
  });
  return { jobs, calls, state };
}

describe("ArtifactJobs", () => {
  test("the constants are the service's own", () => {
    expect(service.ARTIFACT_LOCK_WAIT_MS).toBe(ARTIFACT_LOCK_WAIT_MS);
    expect(service.ARTIFACT_RETRY_MS).toBe(ARTIFACT_RETRY_MS);
    expect(service.ARTIFACT_RETRIES).toBe(ARTIFACT_RETRIES);
  });

  test("refreshes each of a root's reviews, one per turn, with the background lock wait", async () => {
    const { jobs, calls } = harness({ reviews: { "/p": ["r1", "r2", "r3"] } });
    jobs.schedule("/p");
    expect(calls).toEqual([]);
    await vi.advanceTimersToNextTimerAsync();
    expect(calls.map((c) => c.reviewId)).toEqual(["r1"]);
    await vi.runAllTimersAsync();
    expect(calls).toEqual(
      ["r1", "r2", "r3"].map((reviewId) => ({ root: "/p", reviewId, lockTimeoutMs: ARTIFACT_LOCK_WAIT_MS })),
    );
  });

  test("without an open journal or its index on disk nothing is scheduled, and the journal is not opened", async () => {
    const { jobs, calls } = harness({ reviews: { "/p": ["r1"] }, opened: false });
    jobs.schedule("/p");
    await vi.runAllTimersAsync();
    expect(calls).toEqual([]);
  });

  test("an index on disk is enough to open the journal and schedule", async () => {
    const { jobs, calls } = harness({ reviews: { "/p": ["r1"] }, opened: false, journal: true });
    jobs.schedule("/p");
    await vi.runAllTimersAsync();
    expect(calls.map((c) => c.reviewId)).toEqual(["r1"]);
  });

  test("an unreadable journal schedules nothing and does not throw", async () => {
    const { jobs, calls } = harness({ reviews: { "/p": ["r1"] }, listFails: true });
    expect(() => jobs.schedule("/p")).not.toThrow();
    await vi.runAllTimersAsync();
    expect(calls).toEqual([]);
  });

  test("a busy source is retried after ARTIFACT_RETRY_MS, at most ARTIFACT_RETRIES times", async () => {
    const { jobs, calls } = harness({ reviews: { "/p": ["r1"] }, refresh: () => busy });
    jobs.schedule("/p");
    await vi.advanceTimersToNextTimerAsync();
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(ARTIFACT_RETRY_MS - 1);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersToNextTimerAsync();
    expect(calls).toHaveLength(2);
    await vi.runAllTimersAsync();
    expect(calls).toHaveLength(ARTIFACT_RETRIES + 1);
  });

  test("a review of a project no longer attached is dropped, not refreshed", async () => {
    const { jobs, calls, state } = harness({ reviews: { "/p": ["r1"] } });
    jobs.schedule("/p");
    state.attached.delete("/p");
    await vi.runAllTimersAsync();
    // The refresh is skipped for a detached root (the check comes first).
    expect(calls).toEqual([]);
  });

  test("stopping clears the queue and refuses new work, read at each turn", async () => {
    const { jobs, calls, state } = harness({ reviews: { "/p": ["r1", "r2"] } });
    jobs.schedule("/p");
    await vi.advanceTimersToNextTimerAsync();
    expect(calls).toHaveLength(1);
    state.stopping = true;
    await vi.runAllTimersAsync();
    expect(calls).toHaveLength(1);
    jobs.schedule("/p");
    state.stopping = false;
    await vi.runAllTimersAsync();
    expect(calls).toHaveLength(1);
  });

  test("a retry due after a stop does not requeue", async () => {
    const { jobs, calls, state } = harness({ reviews: { "/p": ["r1"] }, refresh: () => busy });
    jobs.schedule("/p");
    await vi.advanceTimersToNextTimerAsync();
    state.stopping = true;
    await vi.runAllTimersAsync();
    state.stopping = false;
    await vi.runAllTimersAsync();
    expect(calls).toHaveLength(1);
  });
});
