// Round 1 (UI/UX) pass 4, batch F14 row 8 (D17): a page address that names no project, opened with a valid
// credential, answers a short not-found page with a way back to Projects instead of a blank 404. It is the
// same bytes for every such address, so it says nothing about which projects exist. A request without a
// valid credential keeps what it had: the "open the link" page for a page-shaped GET, the bare 404 otherwise.
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
const GRANTS_DIR = mkdtempSync(join(tmpdir(), "archer-not-found-"));
afterAll(() => rmSync(GRANTS_DIR, { recursive: true, force: true }));
const GRANTS = new AccessGrantStore(GRANTS_DIR);
const OWNER_SESSION = GRANTS.mintOwnerSession(TOKEN);
const COOKIE = { cookie: `archer-40399=${OWNER_SESSION}` };

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

function request(path: string, headers: Record<string, string> = {}) {
  const answer = { status: 0, headers: {} as Record<string, unknown>, body: "" };
  const req = {
    url: path,
    method: "GET",
    headers: { host: HOST, ...headers },
    socket: { remoteAddress: "127.0.0.1" },
    resume() {},
  } as unknown as IncomingMessage;
  const res = {
    headersSent: false,
    writeHead(status: number, head: Record<string, unknown> = {}) {
      answer.status = status;
      answer.headers = head;
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

test("with a valid credential, an unknown project's page is a short not-found page with a link to Projects", () => {
  const answer = request("/projects/nosuch/diagrams/flow.mmd", COOKIE);
  expect(answer.status).toBe(404);
  expect(answer.headers["content-type"]).toBe("text/html; charset=utf-8");
  expect(answer.headers["content-security-policy"]).toContain("default-src 'none'");
  expect(answer.body).toContain("<h1>");
  expect(answer.body).toMatch(/<a href="\/projects\/">[^<]*Projects[^<]*<\/a>/);
  // Archer's own tokens, the same sheet as the pairing and refused pages.
  expect(answer.body).toContain("--accent:");
  expect(answer.body).not.toContain("nosuch");
  expect(answer.body).not.toContain("flow");
  expect(answer.body).not.toContain("<script");
});

test("the not-found page is the same bytes for every address it answers", () => {
  const answers = new Set<string>();
  for (const path of [
    "/projects/nosuch/",
    "/projects/other/notes/a.md",
    "/projects/nosuch/diagrams/flow.mmd?edit",
    "/projects/zzz/-/repo/README.md",
  ]) {
    const answer = request(path, COOKIE);
    expect(answer.status, path).toBe(404);
    answers.add(JSON.stringify([answer.headers, answer.body]));
  }
  expect(answers.size).toBe(1);
});

test("without a valid credential nothing changes: the open-the-link page for a page address, bare 404 for the rest", () => {
  for (const headers of [{}, { cookie: `archer-40399=${WRONG}` }]) {
    const page = request("/projects/nosuch/", headers);
    expect(page.status).toBe(404);
    expect(page.body).toContain("Open the link Archer gave you");
    expect(page.body).not.toContain('href="/projects/"');
    const api = request("/p/nosuch/api/diagrams", headers);
    expect([api.status, api.headers, api.body]).toEqual([
      404,
      {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-length": "0",
      },
      "",
    ]);
  }
});
