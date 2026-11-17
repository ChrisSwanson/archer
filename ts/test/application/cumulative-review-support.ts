import { randomBytes } from "node:crypto";
import { expect } from "vitest";
import type { RunningService } from "../../src/service/service.ts";
import type { ServiceClient } from "../../src/service/service-client.ts";
import type { CumulativeReviewPage } from "../../src/authoring/review-feed.ts";
import { http } from "../service/support.ts";

/** Real authenticated browser writes; never opens a second private-store writer. */
export async function browserAuthor(svc: RunningService, admin: ServiceClient, root: string) {
  const attached = await admin.call("attach", { root }),
    grant = await admin.call("issueAuthoringAccess", { label: "Cumulative tool fixture", projectRoots: [root] });
  const origin = new URL(svc.homeUrl).origin,
    exchange = await http(grant.url);
  expect(exchange.status).toBe(303);
  const cookie = (exchange.headers["set-cookie"] as string[])[0]!.split(";")[0]!;
  const base = origin + "/p/" + attached.url.split(/\/(?:p|projects)\//)[1]!.split("/")[0]! + "/api/authoring";
  const journalGeneration = JSON.parse((await http(base, { headers: { cookie } })).body).generation;
  async function post(input: unknown, suffix = "") {
    const response = await http(base + suffix, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify(suffix === "" ? { ...(input as object), journalGeneration } : input),
    });
    expect(response.status, response.body).toBe(200);
    return JSON.parse(response.body) as Record<string, unknown>;
  }
  return {
    post,
    async save(source: string) {
      const target = { kind: "view", viewId: "flow" },
        opened = await post({ target }, "/open");
      return post({
        op: "document.apply",
        operationId: randomBytes(16).toString("hex"),
        target,
        expectedSourceRevision: opened.sourceRevision,
        ...(opened.targetRevision === undefined ? {} : { expectedTargetRevision: opened.targetRevision }),
        source,
      });
    },
    async publish(path: string, source: string) {
      return post({ op: "document.publish", operationId: randomBytes(16).toString("hex"), path, source });
    },
  };
}
export function cumulativePage(value: unknown): CumulativeReviewPage {
  expect(value).toBeTruthy();
  return value as CumulativeReviewPage;
}
