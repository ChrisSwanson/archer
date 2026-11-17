// Before a credential is authenticated, a page request costs only a syntactic route check and a
// project-name lookup: no catalog, inventory or note reads (DoS amplification guard, ADR 0017).
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AccessGrantStore } from "../../src/service/access-grants.ts";
import { handleRequest, type DataPlane } from "../../src/service/http.ts";
import type { ProjectState } from "../../src/service/project-state.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const TOKEN = "a".repeat(64);
const HOST = "127.0.0.1:40399";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "archer-preauth-"));
  dirs.push(dir);
  const grants = new AccessGrantStore(dir);
  const reads = { catalog: 0, inventory: 0, notes: 0 };
  const project = {
    slug: "shop",
    url: `http://${HOST}/projects/shop/?follow&token=${TOKEN}`,
    documentCatalog: () => {
      reads.catalog++;
      return {
        documents: [
          { source: { path: "README.md" } },
          { source: { path: ".archer/flow.mmd" }, legacy: { viewId: "flow" } },
        ],
        complete: true,
        diagnostics: [],
      };
    },
    inventory: () => {
      reads.inventory++;
      return { schemaVersion: 1, views: [{ id: "flow", registration: "durable", sourcePath: "flow.mmd" }] };
    },
    allNotes: () => {
      reads.notes++;
      return { notes: [] };
    },
  } as unknown as ProjectState;
  const plane = {
    grantStreams: new Map(),
    isStopping: () => false,
    page: () => Buffer.from("<html>"),
    log: () => {},
    project: (slug: string) => (slug === "shop" ? project : undefined),
    projects: () => [project],
    authority: {
      serviceToken: TOKEN,
      grants,
      cookieName: "archer-40399",
      secure: false,
      allowedHosts: new Set([HOST]),
    },
  } as unknown as DataPlane;
  return { plane, reads };
}

function get(plane: DataPlane, path: string): { status: number; headers: Record<string, unknown> } {
  const answer = { status: 0, headers: {} as Record<string, unknown> };
  const req = {
    url: path,
    method: "GET",
    headers: { host: HOST },
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
    end() {
      return this;
    },
  } as unknown as ServerResponse;
  handleRequest(plane, req, res);
  return answer;
}

test("an invalid credential on a legacy page never reads the catalog, inventory or notes", () => {
  const { plane, reads } = fixture();
  const wrong = "0".repeat(64);
  for (const path of [
    `/p/shop/views/flow/?token=${wrong}`,
    `/p/shop/documents/README.md?token=${wrong}`,
    `/projects/shop-1a2b3c4d/x.md?token=${wrong}`,
    `/${wrong}/p/shop/views/flow/`,
    `/${wrong}/p/shop/documents/README.md`,
    "/p/shop/views/flow/",
    "/p/shop/documents/README.md",
  ])
    expect(get(plane, path).status, path).toBe(404);
  expect(reads).toEqual({ catalog: 0, inventory: 0, notes: 0 });
});

test("a valid token still lands on the canonical clean address in one hop", () => {
  const { plane, reads } = fixture();
  // The diagram named by its project path: the exchange lands on its file address, not on a page that redirects again.
  const exchanged = get(plane, `/projects/shop/.archer/flow.mmd?token=${TOKEN}`);
  expect(exchanged.status).toBe(303);
  expect(exchanged.headers["location"]).toBe("/projects/shop/flow.mmd");
  // The retired path-token form is no credential: refused, never exchanged.
  expect(get(plane, `/${TOKEN}/p/shop-1a2b3c4d/documents/README.md`).status).toBe(404);
  expect(reads.inventory + reads.catalog).toBeGreaterThan(0);
});
