import { createServer, request } from "node:http";
import { afterEach, expect, test } from "vitest";
import { AccessGrantStore } from "../../src/service/access-grants.ts";
import { AuthoringGrantStore } from "../../src/service/authoring-grants.ts";
import {
  handleAuthoringHttp,
  type AuthoringAction,
  type AuthoringAdmission,
} from "../../src/service/authoring-http.ts";
import { JOURNAL_FULL } from "../../src/authoring/store.ts";
import { cleanUp, tempDir, http } from "./support.ts";
afterEach(cleanUp);
test("only a currently entitled cookie admits authoring and every effect can recheck revocation", async () => {
  const state = tempDir(),
    grants = new AccessGrantStore(state),
    entitlements = new AuthoringGrantStore(state);
  const first = grants.issue("author"),
    ordinary = grants.issue("reader"),
    root = "/projects/one";
  const issued = entitlements.issue(first.id, [root]);
  let seen: AuthoringAdmission | undefined,
    executions = 0;
  const server = createServer(
    (req, res) =>
      void handleAuthoringHttp(
        {
          serviceToken: "a".repeat(64),
          grants,
          cookieName: "archer",
          secure: false,
          allowedHosts: new Set([req.headers.host!]),
        },
        {
          entitlement: (id, r) => entitlements.entitlement(id, r),
          request: async (admission, action, input) => {
            seen = admission;
            executions++;
            return { action, input, authority: admission.authority() };
          },
        },
        root,
        (req.url === "/preview" ? "preview" : req.method === "GET" ? "status" : "mutate") as AuthoringAction,
        req,
        res,
      ),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const author = { cookie: `archer=${grants.mintGrantSession(first.id)}` },
      reader = { cookie: `archer=${grants.mintGrantSession(ordinary.id)}` };
    const status = await http(url, { headers: author });
    expect(status.status).toBe(200);
    expect(JSON.parse(status.body)).toMatchObject({
      authorized: true,
      action: "status",
      authority: { grantId: first.id, entitlementId: issued.entitlementId },
    });
    for (const headers of [reader, { authorization: `Bearer ${first.token}` }]) {
      const result = await http(url, { headers });
      expect(result.status).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ authorized: false });
    }
    expect(executions).toBe(1);
    // The owner's session cookie authors as the owner (G3).
    const owner = await http(url, { headers: { cookie: `archer=${grants.mintOwnerSession("a".repeat(64))}` } });
    expect(JSON.parse(owner.body)).toMatchObject({
      authorized: true,
      authority: { grantId: "owner", entitlementId: "owner" },
    });
    expect(JSON.parse((await http(url, { headers: { authorization: `Bearer ${"a".repeat(64)}` } })).body)).toEqual({
      authorized: false,
    });
    executions = 1;
    const mutation = await http(url, {
      method: "POST",
      headers: { ...author, origin: url, "content-type": "application/json" },
      body: '{"source":"x"}',
    });
    expect(mutation.status).toBe(200);
    expect(JSON.parse(mutation.body)).toMatchObject({ action: "mutate", input: { source: "x" } });
    expect(seen!.authority()).toEqual({ grantId: first.id, entitlementId: issued.entitlementId });
    grants.revoke(first.id);
    expect(() => seen!.authority()).toThrow();
    expect(
      (
        await http(url, {
          method: "POST",
          headers: { ...author, origin: url, "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(404);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("authoring HTTP refuses cross-origin, non-JSON, oversized and malformed bodies before execution", async () => {
  const grants = new AccessGrantStore(tempDir()),
    grant = grants.issue("author");
  let calls = 0;
  const server = createServer(
    (req, res) =>
      void handleAuthoringHttp(
        {
          serviceToken: "a".repeat(64),
          grants,
          cookieName: "archer",
          secure: false,
          allowedHosts: new Set([req.headers.host!]),
        },
        {
          entitlement: () => ({ entitlementId: "ent" }),
          request: async () => {
            calls++;
            return { ok: true };
          },
        },
        "/projects/one",
        "preview",
        req,
        res,
      ),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const valid = {
    cookie: `archer=${grants.mintGrantSession(grant.id)}`,
    origin: url,
    "content-type": "application/json",
  };
  const raw = (body: Buffer) =>
    new Promise<number>((resolve, reject) => {
      const req = request(url, { method: "POST", headers: valid }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      });
      req.on("error", reject);
      req.end(body);
    });
  try {
    for (const headers of [
      { ...valid, origin: "https://evil.invalid" },
      { cookie: valid.cookie, "content-type": "application/json" },
      { ...valid, "content-type": "text/plain" },
      { ...valid, authorization: `Bearer ${grant.token}` },
    ])
      expect((await http(url, { method: "POST", headers, body: "{}" })).status).toBe(404);
    expect((await http(url, { method: "POST", headers: valid, body: "broken" })).status).toBe(400);
    expect(await raw(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]))).toBe(400);
    expect((await http(url, { method: "POST", headers: valid, body: " ".repeat(1024 * 1024 + 1) })).status).toBe(413);
    expect(calls).toBe(0);
    expect((await http(url, { method: "POST", headers: valid, body: '{"source":"exact\\r\\nbytes"}' })).status).toBe(
      200,
    );
    expect(calls).toBe(1);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("an unserializable backend result fails safely without a rejected HTTP handler", async () => {
  const grants = new AccessGrantStore(tempDir()),
    grant = grants.issue("author");
  const failures: unknown[] = [];
  const cyclic: { next?: unknown } = {};
  cyclic.next = cyclic;
  const server = createServer(
    (req, res) =>
      void handleAuthoringHttp(
        {
          serviceToken: "a".repeat(64),
          grants,
          cookieName: "archer",
          secure: false,
          allowedHosts: new Set([req.headers.host!]),
        },
        { entitlement: () => ({ entitlementId: "ent" }), request: async () => cyclic },
        "/projects/one",
        "preview",
        req,
        res,
      ).catch((error) => {
        failures.push(error);
        res.destroy();
      }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const response = await http(url, {
      method: "POST",
      headers: {
        cookie: `archer=${grants.mintGrantSession(grant.id)}`,
        origin: url,
        "content-type": "application/json",
      },
      body: "{}",
    }).catch(() => ({ status: 0, body: "" }));
    expect(response.status).toBe(503);
    expect(failures).toEqual([]);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: "authoring_unavailable" } });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// The status came from substrings of the code: a corrupt private store
// ("invalid") answered 422 as if the request were at fault.
test("refusal codes map to deliberate statuses, and OS refusals never reflect their paths", async () => {
  const grants = new AccessGrantStore(tempDir()),
    grant = grants.issue("author");
  let next: Error = new Error("unset");
  const server = createServer(
    (req, res) =>
      void handleAuthoringHttp(
        {
          serviceToken: "a".repeat(64),
          grants,
          cookieName: "archer",
          secure: false,
          allowedHosts: new Set([req.headers.host!]),
        },
        {
          entitlement: () => ({ entitlementId: "ent" }),
          request: async () => {
            throw next;
          },
        },
        "/projects/one",
        "mutate",
        req,
        res,
      ),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const session = grants.mintGrantSession(grant.id);
  const refuse = async (code: string, message = "refused /private/state/path") => {
    next = Object.assign(new Error(message), { code });
    const response = await http(url, {
      method: "POST",
      headers: { cookie: `archer=${session}`, origin: url, "content-type": "application/json" },
      body: "{}",
    });
    return { status: response.status, body: JSON.parse(response.body) as { error: { code: string; message: string } } };
  };
  try {
    for (const code of [
      "authoring_store_invalid",
      "invalid_authoring_store",
      "change_store_invalid",
      "authoring_store_limit",
      "authoring_store_unavailable",
      "authoring_operation_uncertain",
      "some_future_code",
    ]) {
      const r = await refuse(code);
      expect([code, r.status]).toEqual([code, 503]);
      expect(r.body.error.message).not.toContain("/private");
    }
    for (const [code, status] of [
      ["authoring_invalid_request", 422],
      ["path_outside_archer_folder", 422],
      ["authoring_source_limit", 413],
      ["authoring_not_found", 404],
      ["revision_conflict", 409],
      ["authoring_generation_retired", 409],
      ["source_busy", 429],
      ["authoring_store_capacity", 429],
      ["authoring_grant_capacity", 429],
    ] as const)
      expect([code, (await refuse(code)).status]).toEqual([code, status]);
    const missing = await refuse("ENOENT", "ENOENT: no such file or directory, open '/home/someone/.archer/a.mmd'");
    expect(missing.status).toBe(404);
    expect(missing.body.error.message).not.toContain("/home");
    const exists = await refuse("EEXIST", "EEXIST: file already exists, link '/home/someone/.archer/a.mmd'");
    expect(exists.status).toBe(409);
    expect(exists.body.error.message).not.toContain("/home");
    const full = await refuse("authoring_store_capacity", JOURNAL_FULL);
    expect(full.body.error.message).toContain("runtime/authoring");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
