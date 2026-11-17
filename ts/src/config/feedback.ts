import { ProjectError } from "../project/errors.ts";
import type { TomlTable, TomlValue } from "../project/toml.ts";

export type FeedbackChanges = "on_save" | "manual";
export type FeedbackDelivery = "next_call" | "next_call_and_notify";

export interface FeedbackSettings {
  readonly changes?: FeedbackChanges;
  readonly delivery?: FeedbackDelivery;
}

export interface GlobalFeedbackSettings extends FeedbackSettings {
  readonly allowNotifications?: boolean;
}

const SHARED_KEYS = new Set(["changes", "delivery"]);
const GLOBAL_KEYS = new Set([...SHARED_KEYS, "allow_notifications"]);

/** Strict parser shared by the trusted global and project TOML entry points. */
export function parseFeedbackSettings(value: TomlValue, scope: "global" | "project"): GlobalFeedbackSettings {
  if (!isTable(value)) throw refusal("expected one [feedback] table");
  const allowed = scope === "global" ? GLOBAL_KEYS : SHARED_KEYS;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      const reason =
        scope === "project" && key === "allow_notifications"
          ? "allow_notifications is global-only"
          : `unknown setting ${JSON.stringify(key)}`;
      throw refusal(reason);
    }
  }
  const changes = value["changes"];
  if (changes !== undefined && changes !== "on_save" && changes !== "manual")
    throw refusal('changes must be "on_save" or "manual"');
  const delivery = value["delivery"];
  if (delivery !== undefined && delivery !== "next_call" && delivery !== "next_call_and_notify")
    throw refusal('delivery must be "next_call" or "next_call_and_notify"');
  const allowNotifications = value["allow_notifications"];
  if (allowNotifications !== undefined && typeof allowNotifications !== "boolean")
    throw refusal("allow_notifications must be true or false");
  return {
    ...(changes === undefined ? {} : { changes }),
    ...(delivery === undefined ? {} : { delivery }),
    ...(allowNotifications === undefined ? {} : { allowNotifications }),
  };
}

function isTable(value: TomlValue): value is TomlTable {
  return typeof value === "object" && !Array.isArray(value);
}

const refusal = (why: string): ProjectError =>
  new ProjectError("manifest_error", `feedback configuration cannot be used: ${why}`);
