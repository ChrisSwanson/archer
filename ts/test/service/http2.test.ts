// ARCHER_HTTP2=1 on a TLS service: one port answers HTTP/2 and HTTP/1.1 (ALPN), and the routes
// that differ between node:http and the HTTP/2 compatibility layer (Host from :authority,
// connection headers, streams, encodings, redirects, revalidation, shutdown) answer the same.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { connect, type ClientHttp2Session } from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { brotliDecompressSync } from "node:zlib";
import { connectService } from "../../src/service/service-client.ts";
import { startService } from "../../src/service/service.ts";
import { apiBase, cleanUp, project, write } from "./support.ts";

const dirs: string[] = [];
const sessions: ClientHttp2Session[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) session.destroy();
  await cleanUp();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const directory = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "archer-h2-"));
  dirs.push(dir);
  return dir;
};
function certificate(): { tlsCert: string; tlsKey: string } {
  const dir = directory(),
    tlsCert = join(dir, "cert.pem"),
    tlsKey = join(dir, "key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      tlsKey,
      "-out",
      tlsCert,
      "-days",
      "2",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore", timeout: 10_000 },
  );
  return { tlsCert, tlsKey };
}

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | number | undefined>;
  readonly body: Buffer;
  readonly version: string;
}
type Get = (
  url: string,
  options?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Reply>;

async function serve(env: Record<string, string> = { ARCHER_HTTP2: "1", ARCHER_THUMBNAIL_FORMAT: "png" }) {
  const material = certificate(),
    state = directory();
  // A small page keeps its compression quick.
  const pagePath = join(state, "page.html");
  writeFileSync(pagePath, `<!doctype html><html><body>${"Archer page ".repeat(2000)}</body></html>`);
  const svc = await startService({
    ...material,
    pagePath,
    stateDir: state,
    socketPath: join(state, "archer.sock"),
    warmStart: false,
    prefetchThumbnails: false,
    log: () => {},
    env: { HOME: state, ARCHER_OPEN_BROWSER: "never", ...env },
  });
  const ca = readFileSync(material.tlsCert);
  const root = project();
  write(
    root,
    ".archer/auth.md",
    "# Auth\n\n```mermaid\n%% archer-id: login\nflowchart LR\n  user[User] e1@--> app[App]\n```\n",
  );
  const client = await connectService(svc.socketPath);
  let page: string;
  try {
    page = (await client.call("attach", { root })).url;
  } finally {
    client.close();
  }
  const h1: Get = (url, options = {}) =>
    new Promise((resolve, reject) => {
      const req = httpsRequest(
        url,
        { ca, agent: false, servername: "localhost", method: options.method ?? "GET", headers: options.headers ?? {} },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
              version: res.httpVersion,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(options.body);
    });
  const origin = new URL(svc.homeUrl).origin;
  const session = connect(origin, { ca });
  session.on("error", () => {}); // a failed negotiation is asserted by the test, not thrown at it
  sessions.push(session);
  const h2: Get = (url, options = {}) =>
    new Promise((resolve, reject) => {
      const target = new URL(url);
      const stream = session.request({
        ":method": options.method ?? "GET",
        ":path": `${target.pathname}${target.search}`,
        ...(options.headers ?? {}),
      });
      let headers: Record<string, string | string[] | number | undefined> = {};
      const chunks: Buffer[] = [];
      stream.on("response", (received) => {
        headers = received as typeof headers;
      });
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () =>
        resolve({ status: Number(headers[":status"]), headers, body: Buffer.concat(chunks), version: "2.0" }),
      );
      stream.on("error", reject);
      stream.end(options.body);
    });
  // The owner's browser signs in once: the agent link's token exchanged for its session cookie.
  const signedIn = await h1(page);
  const cookie = (signedIn.headers["set-cookie"] as string[])[0]!.split(";")[0]!;
  return { svc, page, api: apiBase(page), origin, h1, h2, session, ca, cookie };
}

test("one TLS port speaks HTTP/2 and HTTP/1.1, and the key routes answer the same over both", async () => {
  const { svc, page, api, origin, h1, h2, session } = await serve();
  expect((await h2(svc.homeUrl)).status).toBe(303);
  expect(session.alpnProtocol).toBe("h2");
  const host = new URL(origin).host;
  for (const [name, get] of [
    ["h1", h1],
    ["h2", h2],
  ] as const) {
    // Host comes from :authority over HTTP/2: the authority checks pass. The home link signs in at Projects.
    const home = await get(svc.homeUrl);
    expect([home.status, home.headers["location"]], name).toEqual([303, "/projects/"]);
    expect(home.version).toBe(name === "h1" ? "1.1" : "2.0");
    // The page's token exchange: 303 with a cookie, then the page itself, compressed, then a 304.
    const exchange = await get(page);
    expect(exchange.status, name).toBe(303);
    const cookie = (exchange.headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    const clean = new URL(exchange.headers["location"] as string, page).href;
    // The compressed copies are made on the first request that would use them.
    let shell = await get(clean, { headers: { cookie, "accept-encoding": "br" } });
    for (let n = 0; n < 100 && shell.headers["content-encoding"] !== "br"; n++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      shell = await get(clean, { headers: { cookie, "accept-encoding": "br" } });
    }
    expect(shell.status, name).toBe(200);
    expect(shell.headers["content-encoding"]).toBe("br");
    expect(brotliDecompressSync(shell.body).toString()).toContain("<html");
    expect(
      (await get(clean, { headers: { cookie, "if-none-match": shell.headers["etag"] as string } })).status,
      name,
    ).toBe(304);
    // JSON, by the cookie at the project's API base; without it, nothing.
    const inventory = JSON.parse((await get(`${api}api/diagrams`, { headers: { cookie } })).body.toString()) as {
      views: { id: string; modelRevision: string }[];
      thumbnailVersion: string;
      thumbnailFormat: string;
    };
    expect(inventory.thumbnailFormat).toBe("png");
    expect((await get(`${api}api/diagrams`)).status, name).toBe(404);
    // Thumbnails: a 302 to the current address, the SVG br-encoded, its 304, the PNG.
    const rev = inventory.views.find((view) => view.id === "auth.md#login")!.modelRevision;
    const stale = await get(
      `${api}api/thumbnails/${encodeURIComponent("auth.md#login")}?rev=${rev}&theme=dark&format=png`,
      { headers: { cookie } },
    );
    expect(stale.status, name).toBe(302);
    const address = `${api}api/thumbnails/${encodeURIComponent("auth.md#login")}?rev=${rev}&theme=dark&v=${inventory.thumbnailVersion}`;
    const svg = await get(address, { headers: { cookie, "accept-encoding": "gzip, br" } });
    expect(svg.status, name).toBe(200);
    expect(svg.headers["content-encoding"]).toBe("br");
    expect(svg.headers["vary"]).toBe("accept-encoding");
    expect(brotliDecompressSync(svg.body).toString()).toContain('data-element-id="user"');
    expect(
      (await get(address, { headers: { cookie, "if-none-match": svg.headers["etag"] as string } })).status,
      name,
    ).toBe(304);
    const png = await get(`${address}&format=png`, { headers: { cookie } });
    expect(png.headers["content-type"], name).toBe("image/png");
    // A write by the cookie names this origin exactly: another is refused before anything is read.
    expect(
      (
        await get(`${api}api/selection`, {
          method: "POST",
          headers: { cookie, origin: "https://elsewhere.test", "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      name,
    ).toBe(404);
    expect(
      (
        await get(`${api}api/selection`, {
          method: "POST",
          headers: { cookie, origin: `https://${host}`, "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      name,
    ).toBe(422);
    // A wrong Host (h1) or :authority (h2) gets the bare 404.
    const wrongHost = name === "h1" ? { host: "elsewhere.test" } : { ":authority": "elsewhere.test" };
    expect((await get(`${api}api/diagrams`, { headers: { cookie, ...wrongHost } })).status, name).toBe(404);
  }
}, 30_000);

test("the event stream opens over HTTP/2 beside other requests on the same connection", async () => {
  const { api, session, h2, cookie } = await serve();
  const stream = session.request({ ":path": `${new URL(api).pathname}api/events`, cookie });
  const first = await new Promise<string>((resolve, reject) => {
    stream.on("response", (headers) => {
      if (headers[":status"] !== 200) reject(new Error(String(headers[":status"])));
    });
    stream.setEncoding("utf8");
    stream.once("data", (chunk: string) => resolve(chunk));
    stream.on("error", reject);
  });
  expect(first).toContain(": open");
  // The stream holds no connection of its own: requests share the session meanwhile.
  expect((await h2(`${api}api/diagrams`, { headers: { cookie } })).status).toBe(200);
  stream.close();
});

test("a debug service's health route answers over HTTP/2 from loopback", async () => {
  const { origin, h1, h2 } = await serve({ ARCHER_HTTP2: "1", ARCHER_DEBUG: "1" });
  for (const get of [h1, h2]) {
    const reply = await get(`${origin}/-/debug/health`);
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body.toString())).toBeTypeOf("object");
  }
});

test("stopping the service ends open HTTP/2 sessions and streams", async () => {
  const { svc, api, session, cookie } = await serve();
  const stream = session.request({ ":path": `${new URL(api).pathname}api/events`, cookie });
  await new Promise<void>((resolve) => stream.once("data", () => resolve()));
  const closed = new Promise<void>((resolve) => session.once("close", () => resolve()));
  const started = Date.now();
  await svc.close();
  await closed;
  expect(Date.now() - started).toBeLessThan(5_000);
});

test("without ARCHER_HTTP2 a TLS service offers HTTP/1.1 only", async () => {
  const { origin, ca, h1 } = await serve({});
  expect((await h1(`${origin}/`)).version).toBe("1.1");
  const refused = await new Promise<string>((resolve) => {
    const session = connect(origin, { ca });
    sessions.push(session);
    session.on("error", (failure) => resolve(failure.message));
    session.on("connect", () => resolve(`connected: ${session.alpnProtocol}`));
  });
  expect(refused).not.toBe("connected: h2");
});

test("ARCHER_HTTP2 is refused unless 1 or 0", async () => {
  const state = directory(),
    material = certificate();
  await expect(
    startService({
      ...material,
      stateDir: state,
      socketPath: join(state, "archer.sock"),
      warmStart: false,
      log: () => {},
      env: { HOME: state, ARCHER_OPEN_BROWSER: "never", ARCHER_HTTP2: "yes" },
    }),
  ).rejects.toThrow(/ARCHER_HTTP2/);
});
