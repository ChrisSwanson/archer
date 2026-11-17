import { afterEach, expect, test } from "vitest";
import { connectService } from "../../src/service/service-client.ts";
import { cleanUp, service, http, project, events, apiBase, slugOf, pageHttp } from "./support.ts";
import { request, type IncomingMessage } from "node:http";

afterEach(cleanUp);
test("grant and owner bootstrap and presentation events use clean links, without the service token", async () => {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  try {
    const root = project(),
      attached = await client.call("attach", { root });
    const grant = await client.call("issueAccess", { label: "Browser" });
    const origin = new URL(svc.homeUrl).origin,
      slug = slugOf(attached.url);
    const headers = { authorization: `Bearer ${grant.token}` },
      clean = `${origin}/p/${slug}/`,
      page = `${origin}/projects/${slug}/?follow`;
    const stream = await events(`${clean}api/events`, headers);
    try {
      await client.call("present", { root, viewId: "flow", openBrowser: false });
      const payload = await stream.next("presentation");
      expect(JSON.stringify(payload)).not.toContain(svc.token);
      expect(payload).toMatchObject({ ui: { url: page } });
      const bootstrap = await pageHttp(`${clean}api/bootstrap`, { headers });
      expect(bootstrap.body).not.toContain(svc.token);
      expect(JSON.parse(bootstrap.body)).toMatchObject({ ui: { url: page } });
      // The owner's browser (its session cookie) is told the same clean address.
      const owner = await pageHttp(`${apiBase(attached.url)}api/bootstrap`);
      expect(owner.body).not.toContain(svc.token);
      expect(JSON.parse(owner.body)).toMatchObject({ ui: { url: page } });
    } finally {
      stream.close();
    }
  } finally {
    client.close();
  }
}, 15_000);
test("OS-authorized independent access links exchange for clean pages and revoke independently", async () => {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  try {
    const attached = await client.call("attach", { root: project() });
    const first = await client.call("issueAccess", { label: "First browser" });
    const second = await client.call("issueAccess", { label: "Second browser" });
    const origin = new URL(svc.homeUrl).origin;
    const slug = slugOf(attached.url);
    const path = `/projects/${slug}/?q=flow`;
    const exchange = await pageHttp(`${origin}${path}&token=${first.token}`);
    expect(exchange.status).toBe(303);
    expect(exchange.headers.location).toBe(path);
    const cookie = (exchange.headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    const home = await pageHttp(`${origin}/`, { headers: { cookie } });
    expect(home.status).toBe(303);
    expect(home.headers.location).toBe("/projects/");
    expect(home.body).not.toContain(svc.token);
    const bearerHome = await pageHttp(`${origin}/`, { headers: { authorization: `Bearer ${first.token}` } });
    expect(bearerHome.status).toBe(303);
    expect(bearerHome.body).not.toContain(svc.token);
    expect((await pageHttp(`${origin}${path}`, { headers: { cookie } })).status).toBe(200);
    expect((await pageHttp(`${origin}/api/projects`, { headers: { cookie } })).status).toBe(200);
    expect((await pageHttp(`${origin}/api/projects`)).status).toBe(404);
    expect(await client.call("revokeAccess", { grantId: first.id })).toEqual({ revoked: true });
    expect((await pageHttp(`${origin}${path}`, { headers: { cookie } })).status).toBe(404);
    expect(
      (await pageHttp(`${origin}/api/projects`, { headers: { authorization: `Bearer ${second.token}` } })).status,
    ).toBe(200);
    expect((await pageHttp(apiBase(attached.url) + "api/diagrams")).status).toBe(200);
    expect(JSON.stringify(await client.call("listAccess", {}))).not.toContain(second.token);
  } finally {
    client.close();
  }
}, 15_000);

test("cookie writes enforce exact Origin and JSON before changing comments", async () => {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  try {
    const attached = await client.call("attach", { root: project() });
    const grant = await client.call("issueAccess", { label: "Browser" });
    const origin = new URL(svc.homeUrl).origin,
      slug = slugOf(attached.url);
    const exchange = await pageHttp(grant.url);
    const cookie = (exchange.headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    const url = `${origin}/p/${slug}/api/comments`;
    const body = JSON.stringify({ target: "view:flow", anchor: { kind: "view" }, body: "Saved once" });
    for (const headers of [
      { cookie, "content-type": "application/json" },
      { cookie, origin: origin.replace("http:", "https:"), "content-type": "application/json" },
      { cookie, origin, "content-type": "text/plain" },
    ])
      expect((await pageHttp(url, { method: "POST", headers, body })).status).toBe(404);
    const saved = await pageHttp(url, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body,
    });
    expect(saved.status, saved.body).toBe(200);
    const list = await pageHttp(`${url}?target=view%3Aflow`, { headers: { cookie } });
    expect(JSON.parse(list.body).threads).toHaveLength(1);
    expect(
      (await pageHttp(`${origin}/api/projects`, { headers: { cookie, authorization: "Bearer wrong" } })).status,
    ).toBe(404);
    expect((await pageHttp(`${origin}/api/projects`, { headers: { cookie, host: "evil.invalid" } })).status).toBe(404);
  } finally {
    client.close();
  }
}, 15_000);

test("revocation closes only that grant's existing SSE streams and rejects new admissions", async () => {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  const requests: ReturnType<typeof request>[] = [];
  try {
    const attached = await client.call("attach", { root: project() });
    const origin = new URL(svc.homeUrl).origin,
      slug = slugOf(attached.url);
    const first = await client.call("issueAccess", { label: "First" }),
      second = await client.call("issueAccess", { label: "Second" });
    const open = (token: string): Promise<IncomingMessage> =>
      new Promise((resolve, reject) => {
        const req = request(
          `${origin}/p/${slug}/api/events`,
          { headers: { authorization: `Bearer ${token}` } },
          (res) => {
            res.resume();
            resolve(res);
          },
        );
        requests.push(req);
        req.on("error", reject);
        req.end();
      });
    const a = await open(first.token),
      b = await open(second.token);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const ended = new Promise<void>((resolve) => a.once("end", resolve));
    await client.call("revokeAccess", { grantId: first.id });
    await ended;
    expect(b.complete).toBe(false);
    expect(b.destroyed).toBe(false);
    expect(
      (await pageHttp(`${origin}/p/${slug}/api/events`, { headers: { authorization: `Bearer ${first.token}` } }))
        .status,
    ).toBe(404);
    expect(
      (await pageHttp(`${origin}/api/projects`, { headers: { authorization: `Bearer ${second.token}` } })).status,
    ).toBe(200);
  } finally {
    requests.forEach((req) => req.destroy());
    client.close();
  }
}, 15_000);
