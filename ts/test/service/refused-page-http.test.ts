// A person opening a page address without a valid credential (an old or mistyped link, a fresh
// browser) gets a short page saying to ask for a new link, still with status 404. Which page it is
// decides nothing: the answer is the same for every page-shaped address, whether its project
// exists or not, so it is no oracle for attached projects (ADR 0014, ADR 0017). API routes,
// unknown routes, path tokens and foreign Hosts keep the bare 404.
import { afterAll, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AccessGrantStore } from "../../src/service/access-grants.ts";
import { handleRequest, type DataPlane } from "../../src/service/http.ts";
import type { ProjectState } from "../../src/service/project-state.ts";

const TOKEN = "a".repeat(64),
  WRONG = "0".repeat(64);
const HOST = "127.0.0.1:40399";

// One grant store for the file, so a session minted from it (the owner's cookie) admits every request.
const GRANTS_DIR = mkdtempSync(join(tmpdir(), "archer-refused-"));
afterAll(() => rmSync(GRANTS_DIR, { recursive: true, force: true }));
const GRANTS = new AccessGrantStore(GRANTS_DIR);
const OWNER_SESSION = GRANTS.mintOwnerSession(TOKEN);

function plane(): DataPlane {
  const project = {
    slug: "shop",
    documentCatalog: () => ({ documents: [], complete: true, diagnostics: [] }),
    inventory: () => ({ schemaVersion: 1, views: [] }),
    allNotes: () => ({ notes: [] }),
  } as unknown as ProjectState;
  return {
    token: TOKEN,
    grantStreams: new Map(),
    isStopping: () => false,
    page: () => Buffer.from("<html>app"),
    log: () => {},
    project: (slug: string) => (slug === "shop" ? project : undefined),
    projects: () => [project],
    authority: {
      serviceToken: TOKEN,
      grants: GRANTS,
      cookieName: "archer-40399",
      secure: false,
      allowedHosts: new Set([HOST]),
    },
  } as unknown as DataPlane;
}

function request(path: string, options: { method?: string; headers?: Record<string, string> } = {}) {
  const answer = { status: 0, headers: {} as Record<string, unknown>, body: "" };
  const req = {
    url: path,
    method: options.method ?? "GET",
    headers: { host: HOST, ...options.headers },
    socket: { remoteAddress: "127.0.0.1" },
    resume() {},
  } as unknown as IncomingMessage;
  const res = {
    headersSent: false,
    writeHead(status: number, headers: Record<string, unknown> = {}) {
      answer.status = status;
      answer.headers = headers;
      return this;
    },
    end(body?: string | Buffer) {
      if (body !== undefined) answer.body = body.toString();
      return this;
    },
  } as unknown as ServerResponse;
  handleRequest(plane(), req, res);
  return answer;
}

test("a page address without a valid credential answers 404 with a page asking for a new link", () => {
  const answer = request("/projects/shop/diagrams/flow.mmd?edit");
  expect(answer.status).toBe(404);
  expect(answer.headers["content-type"]).toBe("text/html; charset=utf-8");
  expect(answer.headers["cache-control"]).toBe("no-store");
  expect(answer.headers["content-security-policy"]).toContain("default-src 'none'");
  // A fresh browser (no cookie at all) lands here too, so it says what to open, not only "expired".
  expect(answer.body).toContain("Open the link Archer gave you");
  expect(answer.body).toContain("for a new one");
  expect(answer.body).not.toContain("shop");
  expect(answer.body).not.toContain("flow");
  expect(answer.body).not.toContain("<script");
});

test("the refused page is the same whether the project exists, and for every kind of refusal", () => {
  const bodies = new Set<string>();
  for (const [path, headers] of [
    ["/projects/shop/", {}],
    ["/projects/nosuch/", {}],
    ["/projects/nosuch/notes/x.md", {}],
    ["/projects/", {}],
    [`/projects/shop/?follow&token=${WRONG}`, {}],
    [`/projects/nosuch/?token=${WRONG}`, {}],
    ["/projects/shop/", { cookie: `archer-40399=${WRONG}` }],
    ["/projects/nosuch/", { cookie: `archer-40399=${WRONG}` }],
  ] as const) {
    const answer = request(path, { headers });
    expect(answer.status, path).toBe(404);
    bodies.add(JSON.stringify([answer.headers, answer.body]));
  }
  expect(bodies.size).toBe(1);
});

test("API routes, unknown routes, path tokens, writes and foreign Hosts keep the bare 404", () => {
  for (const [path, options] of [
    ["/p/shop/api/diagrams", {}],
    ["/p/nosuch/api/diagrams", {}],
    // The retired `/p/<name>/` page forms (0.15.0) are not page-shaped any more.
    ["/p/shop/views/flow/", {}],
    ["/p/nosuch/browse/", {}],
    ["/api/projects", {}],
    ["/nothing/here", {}],
    [`/${WRONG}/p/shop/views/flow/`, {}],
    [`/${WRONG}/projects/shop/`, {}],
    ["/projects/shop/", { method: "POST" }],
    ["/projects/shop/", { headers: { host: "evil.invalid" } }],
    ["/projects/shop/", { headers: { authorization: "Bearer wrong" } }],
  ] as const) {
    const answer = request(path, options);
    expect(answer.status, path).toBe(404);
    expect(answer.headers, path).toEqual({
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-length": "0",
    });
    expect(answer.body, path).toBe("");
  }
});

test("a valid credential still opens the page", () => {
  const answer = request("/projects/shop/", { headers: { cookie: `archer-40399=${OWNER_SESSION}` } });
  expect(answer.status).toBe(200);
  expect(answer.body).toBe("<html>app");
});
