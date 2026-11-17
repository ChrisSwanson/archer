import type { AuthoringOpen } from "../../../shared/authoring-contract.mts";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { revisionOf } from "../../src/project/index.ts";
import { connectService } from "../../src/service/service-client.ts";
import { cleanUp, FLOW, http, project, service, write, pageHttp } from "./support.ts";

afterEach(cleanUp);
const id = () => randomBytes(16).toString("hex");

async function setup() {
  const { svc, state } = await service();
  const admin = await connectService(svc.socketPath);
  const root = project(),
    other = project();
  const attached = await admin.call("attach", { root });
  const attachedOther = await admin.call("attach", { root: other });
  const grant = await admin.call("issueAuthoringAccess", { label: "Browser contract author", projectRoots: [root] });
  const origin = new URL(svc.homeUrl).origin;
  const exchange = await pageHttp(grant.url);
  expect(exchange.status).toBe(303);
  const cookie = (exchange.headers["set-cookie"] as string[])[0]!.split(";")[0]!;
  const clean = (url: string) => `${origin}/p/${url.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!}/`;
  const base = clean(attached.url),
    otherBase = clean(attachedOther.url);
  const get = (url: string) => pageHttp(url, { headers: { cookie } });
  const journalGeneration = JSON.parse((await get(`${base}api/authoring`)).body).generation;
  const post = (url: string, input: unknown, headers: Record<string, string> = {}) =>
    pageHttp(url, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json", ...headers },
      body: JSON.stringify(
        url.endsWith("api/authoring") && input && typeof input === "object" ? { journalGeneration, ...input } : input,
      ),
    });
  return { svc, state, admin, root, other, grant, origin, cookie, base, otherBase, attached, get, post };
}

test("any admitted browser link may edit any attached project; a draft stays with the project it was saved in (decided 2026-10-28)", async () => {
  const fixture = await setup();
  const { root, other, base, otherBase, post, get, admin } = fixture;
  try {
    const status = await get(`${base}api/authoring`);
    expect(JSON.parse(status.body)).toMatchObject({ authorized: true, drafts: [], operations: [] });
    expect(JSON.parse((await get(`${otherBase}api/authoring`)).body)).toMatchObject({
      authorized: true,
      drafts: [],
      operations: [],
    });
    const draftId = `drf_${id()}`,
      operationId = id(),
      source = "\uFEFFflowchart LR\r\n a[Private draft]\r\n";
    const saved = await post(`${base}api/authoring`, {
      op: "draft.save",
      operationId,
      draftId,
      expectedDraftRevision: null,
      source,
      origin: { kind: "new", path: "future.mmd" },
    });
    expect(saved.status, saved.body).toBe(200);
    expect(JSON.parse(saved.body)).toMatchObject({ state: "terminal", draft: { draftId, draftRevision: 1 } });
    expect(existsSync(join(root, ".archer/future.mmd"))).toBe(false);
    const snapshot = await post(`${base}api/authoring/snapshot`, { draftId, draftRevision: 1 });
    expect(snapshot.status, snapshot.body).toBe(200);
    expect(JSON.parse(snapshot.body)).toMatchObject({ source, valid: true });
    for (const response of [status, saved, snapshot]) {
      expect(response.body).not.toContain(fixture.grant.token);
      expect(response.body).not.toContain(fixture.svc.token);
    }
    const elsewhere = await post(`${otherBase}api/authoring/snapshot`, { draftId, draftRevision: 1 });
    expect(elsewhere.status, elsewhere.body).not.toBe(200);
    expect(elsewhere.body).not.toContain("Private draft");
    expect(JSON.parse((await get(`${otherBase}api/authoring/operations/${operationId}`)).body)).toEqual({
      operation: null,
    });
    expect(existsSync(join(other, ".archer/future.mmd"))).toBe(false);
    expect((await get(`${otherBase}api/diagrams`)).status).toBe(200);
    expect((await get(`${base}api/authoring/operations/${operationId}`)).body).toContain(operationId);
  } finally {
    admin.close();
  }
});

test("Bearer, the retired path token and revoked credentials cannot perform browser source effects; an ordinary link can", async () => {
  const { svc, admin, root, grant, origin, cookie, base, post, get } = await setup();
  try {
    const ordinary = await admin.call("issueAccess", { label: "Ordinary browser" });
    const exchange = await pageHttp(ordinary.url),
      ordinaryCookie = (exchange.headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    const path = join(root, ".archer/flow.mmd"),
      before = readFileSync(path);
    const candidate = {
      op: "document.apply",
      operationId: id(),
      target: { kind: "view", viewId: "flow" },
      expectedSourceRevision: revisionOf(before),
      source: FLOW.replace("Client", "Forbidden"),
    };
    for (const [url, headers] of [
      [`${base}api/authoring`, { authorization: `Bearer ${grant.token}`, origin, "content-type": "application/json" }],
      // The service token in the path (a 0.14 address) is no credential at all.
      [
        `${origin}/${svc.token}/p/${base.split("/p/")[1]!}api/authoring`,
        { origin, "content-type": "application/json" },
      ],
      [`${base}api/authoring`, { origin, "content-type": "application/json" }],
      [
        `${base}api/authoring`,
        { cookie, authorization: `Bearer ${grant.token}`, origin, "content-type": "application/json" },
      ],
    ] as const)
      expect((await pageHttp(url, { method: "POST", headers, body: JSON.stringify(candidate) })).status).toBe(404);
    expect(readFileSync(path)).toEqual(before);
    expect(
      JSON.parse((await pageHttp(`${base}api/authoring`, { headers: { cookie: ordinaryCookie } })).body),
    ).toMatchObject({ authorized: true });
    expect((await pageHttp(`${base}api/diagrams`, { headers: { cookie: ordinaryCookie } })).status).toBe(200);
    await admin.call("revokeAccess", { grantId: grant.id });
    expect((await get(`${base}api/authoring`)).status).toBe(404);
    expect((await post(`${base}api/authoring`, { ...candidate, operationId: id() })).status).toBe(404);
    expect(readFileSync(path)).toEqual(before);
    expect((await pageHttp(`${base}api/diagrams`, { headers: { cookie: ordinaryCookie } })).status).toBe(200);
  } finally {
    admin.close();
  }
});

// Links no longer carry editing rights, so the old per-link entitlement file cannot take editing or comments away.
test.each(["missing", "corrupt", "public"] as const)(
  "a %s entitlement file leaves editing and comments as they were",
  async (kind) => {
    const { state, admin, root, base, post, get } = await setup();
    try {
      const before = readFileSync(join(root, ".archer/flow.mmd"));
      expect(JSON.parse((await get(`${base}api/authoring`)).body)).toMatchObject({ authorized: true });
      const entitlements = join(state, "authoring-grants.json");
      if (kind === "missing") unlinkSync(entitlements);
      if (kind === "corrupt") writeFileSync(entitlements, "{broken");
      if (kind === "public") chmodSync(entitlements, 0o644);
      expect(JSON.parse((await get(`${base}api/authoring`)).body)).toMatchObject({ authorized: true });
      expect((await post(`${base}api/authoring/open`, { target: { kind: "view", viewId: "flow" } })).status).toBe(200);
      expect(readFileSync(join(root, ".archer/flow.mmd"))).toEqual(before);
      expect((await get(`${base}api/diagrams`)).status).toBe(200);
      const comment = `reader comment after ${kind} entitlement`;
      const created = await post(`${base}api/comments`, {
        target: "view:flow",
        anchor: { kind: "view" },
        body: comment,
      });
      expect(created.status, created.body).toBe(200);
      const comments = await get(`${base}api/comments?target=view%3Aflow`);
      expect(comments.status).toBe(200);
      expect(comments.body).toContain(comment);
      if (kind === "corrupt") expect(readFileSync(entitlements, "utf8")).toBe("{broken");
    } finally {
      admin.close();
    }
  },
);

test("embedded Apply preserves exact surrounding Markdown/BOM/CRLF and stale source CAS refuses effects", async () => {
  const { admin, root, base, post, get } = await setup();
  try {
    const original =
      "\uFEFF---\r\nauthor: person\r\n---\r\n# Decision\r\n\r\nKeep this prose.\r\n\r\n```mermaid\r\n%% archer-id: named\r\nflowchart LR\r\n  a[Before]\r\n```\r\n\r\nKeep this ending.\r\n";
    const path = write(root, ".archer/decision.md", original),
      target = { kind: "embedded", address: "decision.md#named" };
    const opened = await post(`${base}api/authoring/open`, { target });
    expect(opened.status, opened.body).toBe(200);
    const source = JSON.parse(opened.body) as AuthoringOpen;
    expect(source.writable).toBe(true);
    const operationId = id();
    const applied = await post(`${base}api/authoring`, {
      op: "document.apply",
      operationId,
      target,
      expectedTargetRevision: source.targetRevision,
      expectedSourceRevision: source.sourceRevision,
      source: source.source.replace("[Before]", "[After]"),
    });
    expect(applied.status, applied.body).toBe(200);
    expect(JSON.parse(applied.body)).toMatchObject({
      state: "terminal",
      outcome: "applied",
      document: { path: ".archer/decision.md", blockId: "named" },
    });
    const expected = Buffer.from(original.replace("[Before]", "[After]"));
    expect(readFileSync(path)).toEqual(expected);
    const stale = await post(`${base}api/authoring`, {
      op: "document.apply",
      operationId: id(),
      target,
      expectedTargetRevision: source.targetRevision,
      expectedSourceRevision: source.sourceRevision,
      source: source.source.replace("[Before]", "[Another]"),
    });
    expect(stale.status, stale.body).toBe(200);
    expect(JSON.parse(stale.body)).toMatchObject({ outcome: "conflict", conflict: { kind: "source" } });
    expect(readFileSync(path)).toEqual(expected);
    const receipt = await get(`${base}api/authoring/operations/${operationId}`);
    expect(JSON.parse(receipt.body)).toMatchObject({ operation: { operationId, outcome: "applied" } });
  } finally {
    admin.close();
  }
});

test("Publish creates exact bytes once and refuses overwrite collisions", async () => {
  const { admin, root, base, post } = await setup();
  try {
    const source = "\uFEFFflowchart LR\r\n  a[Published]\r\n",
      path = join(root, ".archer/diagrams/published.mmd");
    const created = await post(`${base}api/authoring`, {
      op: "document.publish",
      operationId: id(),
      path: "diagrams/published.mmd",
      source,
    });
    expect(created.status, created.body).toBe(200);
    expect(JSON.parse(created.body)).toMatchObject({
      outcome: "created",
      document: { path: ".archer/diagrams/published.mmd", sourceRevision: revisionOf(Buffer.from(source)) },
    });
    expect(readFileSync(path)).toEqual(Buffer.from(source));
    const collision = await post(`${base}api/authoring`, {
      op: "document.publish",
      operationId: id(),
      path: "diagrams/published.mmd",
      source: source.replace("Published", "Overwritten"),
    });
    expect(collision.status, collision.body).toBe(200);
    expect(JSON.parse(collision.body)).toMatchObject({ outcome: "conflict", conflict: { kind: "exists" } });
    expect(readFileSync(path)).toEqual(Buffer.from(source));
  } finally {
    admin.close();
  }
});

test("strict actual HTTP mutation input refuses malformed UTF-8, unknown fields and invalid source without file effects", async () => {
  const { admin, root, origin, cookie, base, post } = await setup();
  try {
    const path = join(root, ".archer/flow.mmd"),
      before = readFileSync(path);
    const candidate = {
      op: "document.apply",
      operationId: id(),
      target: { kind: "view", viewId: "flow" },
      expectedSourceRevision: revisionOf(before),
      source: FLOW.replace("Client", "Changed"),
    };
    for (const body of [
      { ...candidate, root: "/other/project" },
      { ...candidate, operationId: "invalid" },
      { ...candidate, source: 5 },
      { ...candidate, source: "not Mermaid" },
      null,
      [],
    ]) {
      const result = await post(`${base}api/authoring`, body);
      expect(result.status, result.body).toBe(422);
      expect(readFileSync(path)).toEqual(before);
    }
    for (const headers of [{ origin: "https://foreign.invalid" }, { "content-type": "text/plain" }, { origin: "" }])
      expect((await post(`${base}api/authoring`, candidate, headers)).status).toBe(404);
    const malformed = await new Promise<number>((resolve, reject) => {
      const req = request(
        `${base}api/authoring`,
        { method: "POST", headers: { cookie, origin, "content-type": "application/json" } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        },
      );
      req.on("error", reject);
      req.end(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]));
    });
    expect(malformed).toBe(400);
    expect(readFileSync(path)).toEqual(before);
  } finally {
    admin.close();
  }
});

test("browser mutations require the opened journal generation and refuse stale generations before effects", async () => {
  const f = await setup();
  try {
    const file = join(f.root, ".archer/stale.mmd");
    for (const journalGeneration of [undefined, "gen_" + "f".repeat(32)]) {
      const response = await pageHttp(`${f.base}api/authoring`, {
        method: "POST",
        headers: { cookie: f.cookie, origin: f.origin, "content-type": "application/json" },
        body: JSON.stringify({
          op: "document.publish",
          operationId: id(),
          path: "diagrams/stale.mmd",
          source: FLOW,
          ...(journalGeneration ? { journalGeneration } : {}),
        }),
      });
      expect(response.status, response.body).toBeGreaterThanOrEqual(400);
      expect(JSON.parse(response.body).error.code).toBe(
        journalGeneration ? "authoring_generation_retired" : "authoring_generation_required",
      );
      expect(existsSync(file)).toBe(false);
    }
  } finally {
    f.admin.close();
  }
});

// G3 (security round 1, X-14/C-17): the service token's Edit cell is "as cookie". The owner's browser, signed
// in with an owner session, opens, saves and publishes like a grant cookie; the journal names the owner.
// Bearer, the path token and a cookie holding the service token itself never author.
test("the owner's browser authors as the owner; the service token as Bearer or in the path does not", async () => {
  const { svc, state, admin, root, origin, base } = await setup();
  const tokenPath = `${origin}/${svc.token}/p/${base.split("/p/")[1]!}api/authoring`;
  try {
    const exchange = await pageHttp(`${origin}/projects/${base.split("/p/")[1]!}?token=${svc.token}`);
    expect(exchange.status).toBe(303);
    const session = (exchange.headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    const path = join(root, ".archer/flow.mmd");
    // A cookie holding the service token itself is no credential (only sessions are cookies).
    expect(
      (await pageHttp(`${base}api/authoring`, { headers: { cookie: `${session.split("=")[0]!}=${svc.token}` } }))
        .status,
    ).toBe(404);
    for (const [name, cookie] of [["owner session", session]] as const) {
      const status = await pageHttp(`${base}api/authoring`, { headers: { cookie } });
      expect(status.status, name).toBe(200);
      const access = JSON.parse(status.body);
      expect(access, name).toMatchObject({ authorized: true });
      const post = (url: string, input: Record<string, unknown>) =>
        pageHttp(url, {
          method: "POST",
          headers: { cookie, origin, "content-type": "application/json" },
          body: JSON.stringify(
            url.endsWith("api/authoring") ? { journalGeneration: access.generation, ...input } : input,
          ),
        });
      const opened = await post(`${base}api/authoring/open`, { target: { kind: "view", viewId: "flow" } });
      expect(opened.status, opened.body).toBe(200);
      const source = JSON.parse(opened.body) as AuthoringOpen;
      const operationId = id();
      const applied = await post(`${base}api/authoring`, {
        op: "document.apply",
        operationId,
        target: { kind: "view", viewId: "flow" },
        expectedTargetRevision: source.targetRevision,
        expectedSourceRevision: source.sourceRevision,
        source: source.source.replace(/a\[[^\]]*\]/, `a[Owner ${name}]`),
      });
      expect(applied.status, applied.body).toBe(200);
      expect(readFileSync(path, "utf8")).toContain(`Owner ${name}`);
      const published = await post(`${base}api/authoring`, {
        op: "document.publish",
        operationId: id(),
        path: `diagrams/${name.replace(/\W+/g, "-")}.mmd`,
        source: FLOW,
      });
      expect(published.status, published.body).toBe(200);
      // The operation is attributed to the owner, never to a grant.
      const operation = await pageHttp(`${base}api/authoring/operations/${operationId}`, { headers: { cookie } });
      expect(operation.status, operation.body).toBe(200);
      for (const response of [status, opened, applied, published, operation])
        expect(response.body).not.toContain(svc.token);
      const journal = journalText(state);
      expect(journal).toContain(operationId);
      expect(journal).toContain('"authority":{"grantId":"owner","entitlementId":"owner"}');
    }
    const before = readFileSync(path);
    const candidate = JSON.stringify({
      op: "draft.save",
      operationId: id(),
      draftId: `drf_${id()}`,
      expectedDraftRevision: null,
      source: FLOW,
      origin: { kind: "new", path: "x.mmd" },
    });
    for (const [url, headers] of [
      [`${base}api/authoring`, { authorization: `Bearer ${svc.token}`, origin, "content-type": "application/json" }],
      [tokenPath, { origin, "content-type": "application/json" }],
    ] as const) {
      expect((await pageHttp(url, { method: "POST", headers, body: candidate })).status).toBe(404);
    }
    // The service token is no Bearer credential at all, nor a path credential (retired with 0.14's page addresses).
    expect((await pageHttp(`${base}api/authoring`, { headers: { authorization: `Bearer ${svc.token}` } })).status).toBe(
      404,
    );
    expect((await pageHttp(tokenPath)).status).toBe(404);
    expect(readFileSync(path)).toEqual(before);
  } finally {
    admin.close();
  }
});

/** Every saved-authoring record under the state directory, as text (the journal names who acted). */
function journalText(state: string): string {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(readFileSync(full, "utf8"));
    }
  };
  walk(state);
  return out.join("\n");
}
