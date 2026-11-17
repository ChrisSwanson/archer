// The background refresh of saved reviews' derived diff files (review-artifacts.ts), queued when a project opens.
// Derived files never decide whether a source write or clear committed; this only keeps them current.
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  REVIEW_SOURCE_BUSY,
  type ReviewArtifactOptions,
  type ReviewArtifactResult,
} from "../authoring/review-artifacts.ts";
import type { AuthoringStore } from "../authoring/store.ts";
import type { LazyStore } from "./lazy-store.ts";

/** Background review-artifact refresh: lock wait per attempt, retry delay and attempts per review. */
export const ARTIFACT_LOCK_WAIT_MS = 20,
  ARTIFACT_RETRY_MS = 1_000,
  ARTIFACT_RETRIES = 10;

export interface ArtifactJobsDeps {
  readonly stateDir: string;
  /** The authoring journal: scheduling opens it only when it is open already or its index is on disk. */
  readonly saved: Pick<LazyStore<AuthoringStore>, "get" | "peek">;
  /** Refreshes one review's derived file (the service's reviewArtifact). */
  readonly refresh: (root: string, reviewId: string, options?: ReviewArtifactOptions) => ReviewArtifactResult;
  readonly hasProject: (root: string) => boolean;
  /** Read at each turn: a stopping service drops its queue. */
  readonly isStopping: () => boolean;
}

export class ArtifactJobs {
  readonly #deps: ArtifactJobsDeps;
  readonly #jobs = new Map<string, { root: string; reviewId: string; tries: number }>();
  #scheduled = false;

  constructor(deps: ArtifactJobsDeps) {
    this.#deps = deps;
  }

  /** Queues a refresh of every saved review of `root`. */
  schedule(root: string): void {
    const deps = this.#deps;
    if (
      deps.isStopping() ||
      (!deps.saved.peek() && !existsSync(join(deps.stateDir, "runtime", "authoring", "index.json")))
    )
      return;
    try {
      // Journal capacity bounds this queue. Yield after each file so agent reads stay responsive.
      for (const review of deps.saved.get().listReviews(root))
        this.#jobs.set(review.reviewId, { root, reviewId: review.reviewId, tries: 0 });
      if (this.#jobs.size && !this.#scheduled) {
        this.#scheduled = true;
        setImmediate(this.#drain);
      }
    } catch {
      /* Review-feed health reports an unavailable journal; never reset it. */
    }
  }

  readonly #drain = (): void => {
    const deps = this.#deps;
    this.#scheduled = false;
    if (deps.isStopping()) {
      this.#jobs.clear();
      return;
    }
    const next = this.#jobs.entries().next().value;
    if (!next) return;
    this.#jobs.delete(next[0]);
    // Background refresh barely waits for a source another writer holds: it
    // runs on the event loop, so it retries later instead of stalling attach.
    const job = next[1];
    if (
      deps.hasProject(job.root) &&
      deps.refresh(job.root, job.reviewId, { lockTimeoutMs: ARTIFACT_LOCK_WAIT_MS }).message === REVIEW_SOURCE_BUSY &&
      job.tries < ARTIFACT_RETRIES
    )
      setTimeout(() => {
        if (deps.isStopping() || this.#jobs.has(job.reviewId)) return;
        this.#jobs.set(job.reviewId, { ...job, tries: job.tries + 1 });
        if (!this.#scheduled) {
          this.#scheduled = true;
          setImmediate(this.#drain);
        }
      }, ARTIFACT_RETRY_MS).unref();
    if (this.#jobs.size) {
      this.#scheduled = true;
      setImmediate(this.#drain);
    }
  };
}
