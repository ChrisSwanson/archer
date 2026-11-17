// The security inventory tool (tools/devkit/security/inventory.mjs, rubric §8 G2/G3/§5) proven on a
// known pass and a seeded failure before it scores: the static cross-check finds a route nobody
// classified and a removed origin check or body cap; the probes find a write that admits a cross-site
// cookie, a read that admits no credential, and a cap that is not enforced.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  classify,
  expected,
  HTTP_ROUTES,
  metrics,
  staticInventory,
} from "../../../tools/devkit/security/inventory-model.mjs";
import { probeBodyCaps, probeCrossSite, probeMatrix } from "../../../tools/devkit/security/inventory.mjs";
import { registries } from "../../../tools/devkit/security/lib/registries.mts";

const REPO = join(import.meta.dirname, "../../..");
const read = (file: string): string => readFileSync(join(REPO, file), "utf8");
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

test("known pass: every route in v0.8.0's code is classified, no row is stale, and every write has its check and cap", () => {
  const inventory = staticInventory(REPO, registries());
  expect(inventory.unclassified).toEqual([]);
  expect(inventory.stale).toEqual([]);
  const m = metrics(inventory);
  expect(m.inventoryRows.http).toBe(HTTP_ROUTES.length + 8);
  expect(m.inventoryRows.management).toBeGreaterThan(60);
  expect(m.rowsMissingOriginCheck.count).toBe(0);
  expect(m.rowsMissingBodyCap.count).toBe(0);
});

test("seeded: a route literal no row claims, and a socket method nobody classified, are reported, not skipped", () => {
  // The route table is where a route is declared (shared/api-routes.mts).
  const table = read("shared/api-routes.mts").replace(
    `read("compile", ["api", "compile"]),`,
    `read("backdoor", ["api", "backdoor"]),\n  read("compile", ["api", "compile"]),`,
  );
  const socket = read("ts/src/service/socket.ts").replace(/"hello",(\s*)"attach"/, `"hello",$1"evilMethod",$1"attach"`);
  // A seed that no longer applies (the source moved) would pass for the wrong reason.
  expect(table).toContain(`"backdoor"`);
  expect(socket).toContain(`"evilMethod"`);
  const inventory = staticInventory(REPO, registries(), {
    "shared/api-routes.mts": table,
    "ts/src/service/socket.ts": socket,
  });
  expect(inventory.unclassified.map((u: { literal: string }) => u.literal)).toEqual(
    expect.arrayContaining(["backdoor", "evilMethod"]),
  );
  expect(metrics(inventory).unclassified).toBe(2);
});

test("seeded: removing a handler's sameOrigin and a body cap is counted in the §5 metrics", () => {
  const http = read("ts/src/service/http.ts")
    .replace(/(async function commentWrite[\s\S]*?)if \(!sameOrigin\(req\.headers\)\) \{/, "$1if (false) {")
    .replace("readBody(req, res, MAX_NOTE_EMPHASIS_FILE_BYTES)", "readBody(req, res, Infinity)");
  const m = metrics(staticInventory(REPO, registries(), { "ts/src/service/http.ts": http }));
  expect(m.rowsMissingOriginCheck.ids).toEqual(expect.arrayContaining(["p-comments-create", "p-comments-delete"]));
  expect(m.rowsMissingBodyCap.ids).toEqual(["p-note-emphases-post"]);
});

test("classify tells an admitted handler's answer from a refusal", () => {
  const reply = (status: number, body = "", type = "application/json") => ({
    status,
    body,
    headers: { "content-type": type },
  });
  expect(classify(reply(404, "", "")).class).toBe("refused");
  expect(classify(reply(403, "", "")).class).toBe("refused");
  expect(classify(reply(404, '{"error":{"code":"authoring_forbidden"}}')).class).toBe("refused");
  expect(classify(reply(200, '{"authorized":false}')).class).toBe("refused");
  expect(classify(reply(422, '{"error":{"code":"invalid_comment"}}')).class).toBe("admitted");
  expect(classify(reply(404, '{"error":{"code":"thread_not_found"}}')).class).toBe("admitted");
  expect(classify(reply(413, "", "")).class).toBe("admitted");
  expect(expected({ access: "read" }, "none")).toBe("refuse");
  expect(expected({ access: "edit" }, "grant-cookie", { edit: false })).toBe("refuse");
  expect(expected({ access: "edit" }, "grant-bearer")).toBe("refuse");
});

/** A stand-in service: `good` routes check the cookie, exact Origin and JSON and cap bodies; `bad` routes do none of it. */
async function stub(): Promise<string> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const origin = `http://${req.headers.host}`;
    const cookie = req.headers.cookie === "c=grant";
    const good = req.url?.startsWith("/good") === true;
    if (req.method === "GET") {
      if (!good || cookie) return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return void res.writeHead(404, { "content-length": "0" }).end();
    }
    if (good && Number(req.headers["content-length"] ?? 0) > 64) {
      res.writeHead(413, { "content-length": "0", connection: "close" }).end(() => req.destroy());
      return;
    }
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (good && size > 64) {
        res.writeHead(413, { connection: "close" }).end(() => req.destroy());
      }
    });
    req.on("end", () => {
      if (res.headersSent) return;
      if (good && (!cookie || req.headers.origin !== origin || req.headers["content-type"] !== "application/json"))
        return void res.writeHead(404, { "content-length": "0" }).end();
      if (!good && !cookie) return void res.writeHead(404, { "content-length": "0" }).end();
      res.writeHead(422, { "content-type": "application/json" }).end('{"error":{"code":"invalid"}}');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const rows = [
  { id: "good-write", method: "POST", path: "/good/write", access: "comment", state: true, cap: "CAP", body: "{}" },
  { id: "bad-write", method: "POST", path: "/bad/write", access: "comment", state: true, cap: "CAP", body: "{}" },
  { id: "good-read", method: "GET", path: "/good/read", access: "read" },
  { id: "bad-read", method: "GET", path: "/bad/read", access: "read" },
];

test("seeded: the probes flag a cross-site cookie write, an unauthenticated read and an unenforced cap; the good routes pass", async () => {
  const origin = await stub();
  const target = {
    origin,
    ownerToken: "owner",
    params: {},
    credentials: { none: { headers: {} }, "grant-cookie": { headers: { cookie: "c=grant" } } },
  };
  const cross = await probeCrossSite(target, rows, []);
  expect(cross["good-write"]!.every((v: { class: string }) => v.class === "refused")).toBe(true);
  expect(
    cross["bad-write"]!.filter((v: { class: string }) => v.class === "admitted").map(
      (v: { variant: string }) => v.variant,
    ),
  ).toEqual([
    "foreign Origin",
    "Origin: null",
    "cookie without Origin",
    "simple content type",
    "Sec-Fetch-Site: cross-site",
  ]);
  const cells = await probeMatrix(target, rows, { columns: ["none", "grant-cookie"] });
  expect(cells["good-read"]).toMatchObject({ none: { verdict: "pass" }, "grant-cookie": { verdict: "pass" } });
  expect(cells["bad-read"]!["none"]!.verdict).toBe("over-admit");
  const caps = await probeBodyCaps(target, rows, { CAP: 64 });
  expect(caps["good-write"]!.map((p: { refused: boolean }) => p.refused)).toEqual([true, true]);
  expect(caps["bad-write"]!.map((p: { refused: boolean }) => p.refused)).toEqual([false, false]);
  const m = metrics({
    rows: rows.map((row) => ({
      ...row,
      cookieWrites: "",
      originCheck: "",
      capInCode: true,
      crossSite: cross[row.id],
      bodyCap: caps[row.id],
      cells: { edit_on: cells[row.id] },
    })),
    management: [],
    unclassified: [],
    stale: [],
  });
  expect(m.rowsMissingOriginCheck.ids).toEqual(["bad-write"]);
  expect(m.rowsMissingBodyCap.ids).toEqual(["bad-write"]);
  expect(m.rowsMissingAdmission.ids).toEqual(["bad-read"]);
});
