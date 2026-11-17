// The project catalog (api/browser-projects, api/projects) is the page's largest repeated read: every
// 15 s per tab. It goes out compressed when the reader accepts it, carries a validator over its body,
// and an `If-None-Match` that still matches is a 304 with no body, only ever after authentication.
// It stays `no-store` (ADR 0014): the page holds the last body and tag itself.
import { request } from "node:http";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterEach, expect, test } from "vitest";
import { connectService } from "../../src/service/index.ts";
import { apiBase, cleanUp, project, service, write } from "./support.ts";

afterEach(cleanUp);

interface Raw {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
}
function raw(url: string, headers: Record<string, string> = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function attached() {
  const root = project();
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  const { url } = (await client.call("attach", { root })) as { url: string };
  client.close();
  const exchange = await raw(url);
  expect(exchange.status).toBe(303);
  const cookie = (exchange.headers["set-cookie"] as string[])[0]!.split(";")[0]!;
  return { root, cookie, origin: new URL(url).origin, scoped: apiBase(url) };
}

const decode = (reply: Raw): string => {
  const coding = reply.headers["content-encoding"];
  return (
    coding === "br" ? brotliDecompressSync(reply.body) : coding === "gzip" ? gunzipSync(reply.body) : reply.body
  ).toString("utf8");
};

test("the catalog is compressed for a reader that accepts it, and every coding decodes to the same JSON", async () => {
  const { cookie, origin } = await attached();
  for (const path of ["api/browser-projects", "api/projects"]) {
    const plain = await raw(`${origin}/${path}`, { cookie });
    expect(plain.status, path).toBe(200);
    expect(plain.headers["content-encoding"], path).toBeUndefined();
    const text = plain.body.toString("utf8");
    expect(JSON.parse(text).schemaVersion, path).toBe(1);
    for (const coding of ["br", "gzip"]) {
      const reply = await raw(`${origin}/${path}`, {
        cookie,
        "accept-encoding": coding === "br" ? "gzip, deflate, br" : "gzip",
      });
      expect(reply.status, `${path} ${coding}`).toBe(200);
      expect(reply.headers["content-encoding"], `${path} ${coding}`).toBe(coding);
      expect(reply.headers["vary"], path).toBe("accept-encoding");
      expect(Number(reply.headers["content-length"])).toBe(reply.body.length);
      expect(decode(reply), `${path} ${coding}`).toBe(text);
      // The validator is the body's, whatever its coding.
      expect(reply.headers["etag"]).toBe(plain.headers["etag"]);
    }
    // Still kept out of every cache (ADR 0014); the page revalidates by itself.
    expect(plain.headers["cache-control"], path).toBe("no-store");
  }
});

test("a matching If-None-Match is a 304 with no body, only after authentication", async () => {
  const { cookie, origin, scoped } = await attached();
  for (const [name, url, credential] of [
    ["cookie", `${origin}/api/browser-projects`, { cookie }],
    ["cookie, project route", `${scoped}api/browser-projects`, { cookie }],
  ] as const) {
    const first = await raw(url, credential);
    expect(first.status, name).toBe(200);
    const etag = first.headers["etag"] as string;
    expect(etag, name).toMatch(/^W\/"[0-9a-f]{32}"$/);
    const again = await raw(url, { ...credential, "if-none-match": etag, "accept-encoding": "br" });
    expect(again.status, name).toBe(304);
    expect(again.body.length, name).toBe(0);
    expect(again.headers["etag"], name).toBe(etag);
    expect(again.headers["cache-control"], name).toBe("no-store");
    // A stale validator gets the catalog.
    expect((await raw(url, { ...credential, "if-none-match": 'W/"0000"' })).status, name).toBe(200);
  }
  const { etag } = (await raw(`${origin}/api/browser-projects`, { cookie })).headers as { etag: string };
  // Without a credential the validator buys nothing: the bare 404, no oracle.
  const anonymous = await raw(`${origin}/api/browser-projects`, { "if-none-match": etag });
  expect(anonymous.status).toBe(404);
  expect(anonymous.headers["etag"]).toBeUndefined();
  const unknown = `${cookie.split("=")[0]!}=${"0".repeat(32)}`;
  const wrongSession = await raw(`${scoped}api/browser-projects`, { cookie: unknown, "if-none-match": etag });
  expect(wrongSession.status).toBe(404);
  expect(wrongSession.headers["etag"]).toBeUndefined();
});

test("a changed project changes the validator", async () => {
  const { root, cookie, origin } = await attached();
  const url = `${origin}/api/browser-projects`;
  const before = (await raw(url, { cookie })).headers["etag"] as string;
  write(root, ".archer/notes/added.md", "# Added\n");
  let after = before;
  for (let tries = 0; tries < 50 && after === before; tries++) {
    await new Promise((done) => setTimeout(done, 100));
    after = (await raw(url, { cookie })).headers["etag"] as string;
  }
  expect(after).not.toBe(before);
  expect((await raw(url, { cookie, "if-none-match": before })).status).toBe(200);
});
