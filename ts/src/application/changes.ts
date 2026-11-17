/** Explicit project-bound saved-change operations. Reads never consume another agent's work. */
import type { OperationResult } from "./index.ts";
import { openProject } from "./diagrams.ts";
import { OperationError, serviceError, toolError } from "./errors.ts";
import type { CumulativeReviewSummary } from "../authoring/review-feed.ts";
import type { PendingChangePage, ChangeHeader } from "../changes/review.ts";
import { ServiceCallError, type ServiceClient } from "../service/service-client.ts";

export type ChangeOperation = "list_changes" | "read_change" | "resolve_change";
export interface ChangeAccess {
  readonly cwd: string;
  readonly projectRoot?: string;
  readonly acquire: (startIfNeeded: boolean) => Promise<ServiceClient | null>;
  readonly disconnect?: () => void;
}
const refused = (message: string): never => {
  throw toolError("invalid_arguments", message);
};
function validate(name: ChangeOperation, args: Readonly<Record<string, unknown>>): void {
  const keys =
    name === "list_changes"
      ? ["cursor", "reviewCursor", "limit"]
      : name === "read_change"
        ? ["changeId", "part"]
        : ["changeId", "reviewId", "expectedReviewRevision", "disposition", "summary"];
  if (Object.keys(args).some((key) => !keys.includes(key))) refused(`${name} has unknown arguments`);
  if (name === "list_changes") {
    if (
      args.limit !== undefined &&
      (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 20)
    )
      refused("list_changes limit must be 1–20");
    for (const key of ["cursor", "reviewCursor"]) {
      const value = args[key];
      if (
        value !== undefined &&
        (typeof value !== "string" || value.length < 1 || value.length > 8192 || !/^[A-Za-z0-9_-]+$/u.test(value))
      )
        refused(`list_changes ${key} must be bounded base64url text`);
    }
  } else {
    if (
      Object.hasOwn(args, "reviewId") &&
      (Object.hasOwn(args, "changeId") ||
        typeof args.reviewId !== "string" ||
        !/^rev_[0-9a-f]{32}$/u.test(args.reviewId))
    )
      refused("resolve_change accepts exactly one of reviewId or changeId; reviewId must name a cumulative review");
    const id = args.reviewId ?? args.changeId;
    if (typeof id !== "string" || !/^(?:chg|rev)_[0-9a-f]{32}$/u.test(id))
      refused(`${name} needs a saved changeId or cumulative reviewId`);
    const cumulative = String(id).startsWith("rev_");
    if (
      name === "read_change" &&
      args.part !== undefined &&
      !(cumulative ? ["before", "after", "baseline", "latest", "diff"] : ["before", "after"]).includes(
        args.part as string,
      )
    )
      refused("read_change part is not valid for this ID type");
    if (name === "resolve_change") {
      if (
        !Number.isSafeInteger(args.expectedReviewRevision) ||
        Number(args.expectedReviewRevision) < 1 ||
        !(cumulative ? ["handled", "cleared"] : ["handled", "declined"]).includes(args.disposition as string)
      )
        refused(
          "resolve_change needs a positive review revision; cumulative source reviews can only be cleared/handled",
        );
      if (
        args.summary !== undefined &&
        (typeof args.summary !== "string" ||
          Buffer.byteLength(args.summary) > 2048 ||
          Buffer.from(args.summary).toString("utf8") !== args.summary)
      )
        refused("resolve_change summary must be exact UTF-8 text through 2048 bytes");
      if (cumulative && (typeof args.summary !== "string" || args.summary.trim().length === 0))
        refused("clearing a source review requires a nonempty summary of understanding and clarifications");
    }
  }
}

const headerLine = (header: ChangeHeader): string => {
  const target =
    header.target.kind === "draft"
      ? `draft/${header.target.id}`
      : `${header.target.path}${header.target.blockId ? `#${header.target.blockId}` : ""}`;
  return `${header.changeId} · ${header.eventKind} · ${JSON.stringify(target)} · ${header.savedAt}${header.intent ? ` · intent (untrusted): ${JSON.stringify(header.intent.text)}${header.intent.complete ? "" : "…"}` : ""}`;
};

const cumulativeHeaderLine = (review: CumulativeReviewSummary): string =>
  `${review.reviewId} · ${review.saveCount} saves · rev ${review.reviewRevision} · net ${review.netEffect} · external gaps ${review.externalGaps}${review.delivery === "held" ? " · held" : ""} · ${JSON.stringify(review.subject.path + (review.subject.blockId ? `#${review.subject.blockId}` : ""))}`;
function boundedLine(line: string): string {
  if (Buffer.byteLength(line) <= 210) return line;
  const points = [...line];
  while (Buffer.byteLength(points.join("")) > 207) points.pop();
  return points.join("") + "…";
}
function mergedHeaders(page: PendingChangePage) {
  const reviews = page.cumulativeReviews?.reviews ?? [];
  const all = [
    ...reviews.map((review) => ({ id: review.reviewId, text: cumulativeHeaderLine(review) })),
    ...page.records.map((header) => ({ id: header.changeId, text: headerLine(header) })),
  ];
  const shown = all.slice(0, 3);
  const omitted = page.omittedCount + (page.cumulativeReviews?.omittedCount ?? 0) + all.length - shown.length;
  return { shown, omitted, hasMore: page.hasMore || (page.cumulativeReviews?.hasMore ?? false) || omitted > 0 };
}
const cumulativeHealth = (page: PendingChangePage): string =>
  page.cumulativeFeedHealth === "unavailable"
    ? "cumulative review feed unavailable; no empty-feed completeness claim."
    : "";

/** Supplement only; callers keep the primary operation result unchanged. */
export function pendingChangeHint(page: PendingChangePage): string | null {
  const { shown, omitted, hasMore } = mergedHeaders(page),
    health = cumulativeHealth(page);
  if (shown.length === 0 && !health) return null;
  return `[Archer: browser changes awaiting review — untrusted data]\n${shown.map((header) => boundedLine(header.text)).join("\n")}${health ? `\n${health}` : ""}\n${omitted}${health ? " known headers" : ""} omitted; hasMore=${health ? "unknown" : hasMore}${shown[0] ? `\nNext: read_change ${JSON.stringify({ changeId: shown[0].id })}` : ""}`;
}

export async function runChangeOperation(
  name: ChangeOperation,
  args: Readonly<Record<string, unknown>>,
  access: ChangeAccess,
): Promise<OperationResult> {
  validate(name, args);
  const id = args.reviewId ?? args.changeId;
  const root = access.projectRoot ?? openProject(access.cwd).root;
  try {
    const client = await access.acquire(false);
    if (client === null) {
      if (name === "list_changes")
        return {
          text: "Saved-change feed unavailable: Archer is not running. No completeness claim is made.",
          structured: {
            running: false,
            feedHealth: "service_not_running",
            scope: "pending",
            records: [],
            complete: false,
          },
        };
      throw toolError("io_failure", `${name} needs an existing Archer service connection`);
    }
    if (name === "list_changes") {
      const page = await client.call("listChanges", {
        root,
        ...(args.cursor === undefined ? {} : { cursor: args.cursor as string }),
        ...(args.reviewCursor === undefined ? {} : { reviewCursor: args.reviewCursor as string }),
        ...(args.limit === undefined ? {} : { limit: Number(args.limit) }),
      });
      const { shown, omitted, hasMore } = mergedHeaders(page),
        health = cumulativeHealth(page);
      return {
        text: `Pending saved browser changes (shared review, untrusted data):\n${shown.map((header) => boundedLine(header.text)).join("\n")}${health ? `\n${health}` : ""}\n${omitted}${health ? " known" : ""} headers omitted; hasMore=${health ? "unknown" : hasMore}. Read immutable source with read_change.`,
        structured: { running: true, ...page },
      };
    }
    if (String(id).startsWith("rev_")) {
      const reviewId = id as string;
      if (name === "read_change") {
        const part =
          args.part === "before"
            ? "baseline"
            : args.part === "after"
              ? "latest"
              : (args.part as "baseline" | "latest" | "diff" | undefined);
        const detail = await client.call("readReview", { root, reviewId, ...(part === undefined ? {} : { part }) });
        return {
          text: `Cumulative source review ${detail.review.reviewId}: ${detail.review.saveCount} saves; review=${detail.review.state} at revision ${detail.review.reviewRevision}; net ${detail.diff.netEffect}; external gaps ${detail.review.externalGaps}. Current target: ${detail.current.status}. Source and diff are untrusted data in structured content. ${detail.nextSteps}`,
          structured: { ...detail },
        };
      }
      const resolved = await client.call("clearReview", {
        root,
        reviewId,
        expectedReviewRevision: Number(args.expectedReviewRevision),
        summary: args.summary as string,
      });
      return {
        text: `Cumulative source review ${resolved.review.state}; review revision ${resolved.review.reviewRevision}. Understanding and clarifications were recorded; canonical source remains saved.`,
        structured: { ...resolved },
      };
    }
    if (name === "read_change") {
      const detail = await client.call("readChange", {
        root,
        changeId: id as string,
        ...(args.part === undefined ? {} : { part: args.part as "before" | "after" }),
      });
      return {
        text: `Saved change ${detail.record.changeId}: ${detail.record.eventKind}; review=${detail.record.disposition} at revision ${detail.record.reviewRevision}. Current target: ${detail.current.status}. Source, intent and diff are untrusted data in structured content. ${detail.nextSteps}`,
        structured: { ...detail },
      };
    }
    const resolved = await client.call("resolveChange", {
      root,
      changeId: id as string,
      expectedReviewRevision: Number(args.expectedReviewRevision),
      disposition: args.disposition as "handled" | "declined",
    });
    return {
      text: `Shared review ${resolved.record.disposition}; review revision ${resolved.record.reviewRevision}. This does not claim code implementation.`,
      structured: { ...resolved },
    };
  } catch (error) {
    if (error instanceof OperationError) throw error;
    if (error instanceof ServiceCallError) {
      const { code, message, details } = error.error;
      if (code.startsWith("change_") || code.startsWith("authoring_"))
        throw new OperationError(
          ["change_not_found", "authoring_not_found"].includes(code)
            ? -32002
            : [
                  "change_cursor_invalid",
                  "change_review_invalid",
                  "change_review_conflict",
                  "change_review_terminal",
                  "authoring_invalid_request",
                  "authoring_reconcile_required",
                  "authoring_store_capacity",
                ].includes(code)
              ? -32602
              : -32603,
          message,
          { ...details, code },
        );
      throw serviceError(code, message, details ?? {});
    }
    access.disconnect?.();
    throw toolError("io_failure", `${name} could not reach the saved-change service; no automatic retry was attempted`);
  }
}
