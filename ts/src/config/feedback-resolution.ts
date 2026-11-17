// Workflow preferences are separate from listener settings and write authority.
import { createHash } from "node:crypto";
import type { GlobalConfig } from "./index.ts";
import type { Project } from "../project/index.ts";
import type { FeedbackChanges, FeedbackDelivery } from "./feedback.ts";
import { configurationSourceRevision } from "./source-revision.ts";

type FeedbackSource = "builtin" | "system" | "user" | "project";
export interface ResolvedFeedbackConfiguration {
  readonly changes: FeedbackChanges;
  readonly delivery: FeedbackDelivery;
  readonly allowNotifications: boolean;
  /** Configuration policy only: a subscription and current authority are still required. */
  readonly notificationPolicy: "not_requested" | "blocked_by_global" | "requires_subscription";
  readonly sources: {
    readonly changes: FeedbackSource;
    readonly delivery: FeedbackSource;
    readonly allowNotifications: Exclude<FeedbackSource, "project">;
  };
  /** Exact parsed-source digests when supplied by a production reader; absent files have null. */
  readonly sourceRevisions: {
    readonly system: string | null;
    readonly user: string | null;
    readonly project: string | null;
  };
  /** Effective read snapshot, not a revision authorizing writes to any one config file. */
  readonly revision: string;
}

export function resolveFeedbackConfiguration(input: {
  readonly system?: GlobalConfig;
  readonly user: GlobalConfig;
  readonly project: Project;
  readonly serviceName: string;
}): ResolvedFeedbackConfiguration {
  let changes: FeedbackChanges = "on_save";
  let delivery: FeedbackDelivery = "next_call";
  let allowNotifications = false;
  const sources: {
    changes: FeedbackSource;
    delivery: FeedbackSource;
    allowNotifications: "builtin" | "system" | "user";
  } = {
    changes: "builtin",
    delivery: "builtin",
    allowNotifications: "builtin",
  };
  for (const [origin, config] of [
    ["system", input.system],
    ["user", input.user],
  ] as const) {
    if (config?.feedback?.changes !== undefined) {
      changes = config.feedback.changes;
      sources.changes = origin;
    }
    if (config?.feedback?.delivery !== undefined) {
      delivery = config.feedback.delivery;
      sources.delivery = origin;
    }
    if (config?.feedback?.allowNotifications !== undefined) {
      allowNotifications = config.feedback.allowNotifications;
      sources.allowNotifications = origin;
    }
  }
  if (input.project.feedback?.changes !== undefined) {
    changes = input.project.feedback.changes;
    sources.changes = "project";
  }
  if (input.project.feedback?.delivery !== undefined) {
    delivery = input.project.feedback.delivery;
    sources.delivery = "project";
  }
  const notificationPolicy =
    delivery === "next_call" ? "not_requested" : allowNotifications ? "requires_subscription" : "blocked_by_global";
  const sourceRevisions = {
    system: input.system === undefined ? null : (configurationSourceRevision(input.system) ?? null),
    user: configurationSourceRevision(input.user) ?? null,
    project: configurationSourceRevision(input.project) ?? null,
  };
  // Layer values cover typed/injected readers without claiming they supplied source bytes.
  // Known production sources additionally preserve comment/format changes in the composite.
  const snapshot = {
    version: 1,
    projectRoot: input.project.root,
    serviceName: input.serviceName,
    sourceRevisions,
    layers: {
      system: input.system?.feedback ?? null,
      user: input.user.feedback ?? null,
      project: input.project.feedback ?? null,
    },
    resolved: { changes, delivery, allowNotifications, notificationPolicy, sources },
  };
  const revision = `sha256:${createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")}`;
  return { changes, delivery, allowNotifications, notificationPolicy, sources, sourceRevisions, revision };
}
