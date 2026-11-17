// Clean page addresses (ADR 0017, amended 2026-10-18): the service serves /projects/<name>/…,
// redirects every legacy page form there, and exchanges a token query for the access cookie.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { connectService } from "../../src/service/service-client.ts";
import { createHash } from "node:crypto";
import { cleanUp, FLOW, http, service, tempDir, write, pageHttp } from "./support.ts";

afterEach(cleanUp);

/** A project named "shop": a durable view, a note with an embedded diagram, and a shadowed README. */
function shop(): string {
  const root = join(tempDir(), "Shop");
  mkdirSync(root);
  write(
    root,
    "archer.toml",
    'version = 1\n[discovery]\nroots = [".archer", "README.md", "docs"]\n\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "The flow"\nsource = ".archer/diagrams/flow.mmd"\n',
  );
  write(root, ".archer/diagrams/flow.mmd", FLOW);
  write(
    root,
    ".archer/notes/a.md",
    "# A\n\n## Login\n\n```mermaid\n%% archer-id: login\nflowchart LR\n  a[A] -->|e| b[B]\n```\n",
  );
  write(root, ".archer/docs/guide.md", "# Archer guide\n");
  write(root, "docs/guide.md", "# Repo guide\n");
  write(root, "docs/only.md", "# Only outside\n");
  write(root, "README.md", "# Readme\n");
  return root;
}

async function attached(log?: (line: string) => void) {
  const { svc } = await service(log === undefined ? {} : { log });
  const client = await connectService(svc.socketPath);
  const root = shop();
  const status = await client.call("attach", { root });
  const origin = new URL(svc.homeUrl).origin;
  return { svc, client, root, status, origin, retired: `${origin}/${svc.token}` };
}

/** One exchange: the cookie a token query sets. */
async function cookieFor(url: string): Promise<string> {
  const reply = await pageHttp(url);
  expect(reply.status, reply.body).toBe(303);
  return (reply.headers["set-cookie"] as string[])[0]!.split(";")[0]!;
}

test("agent-facing URLs carry the service token once on the clean follow address and mint no grant", async () => {
  const { svc, client, root, status, origin } = await attached();
  try {
    expect(status.url).toBe(`${origin}/projects/shop/?follow&token=${svc.token}`);
    expect((await client.call("present", { root, viewId: "flow", openBrowser: false })).url).toBe(status.url);
    expect((await client.call("setEmphasis", { root, viewId: "flow", emphases: [] })).url).toBe(status.url);
    expect((await client.call("listProjects", {})).projects[0]!.url).toBe(status.url);
    expect((await client.call("listAccess", {})).grants).toEqual([]);
  } finally {
    client.close();
  }
});

test("the service token query exchanges for the HttpOnly SameSite=Strict cookie and a clean redirect", async () => {
  const { svc, client, status, origin } = await attached();
  try {
    const exchange = await pageHttp(status.url);
    expect(exchange.status).toBe(303);
    expect(exchange.headers.location).toBe("/projects/shop/?follow");
    expect(exchange.headers["cache-control"]).toBe("no-store");
    expect(exchange.headers["referrer-policy"]).toBe("no-referrer");
    const set = (exchange.headers["set-cookie"] as string[])[0]!;
    expect(set).toMatch(/^archer-\d+=[a-f0-9]{32}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+$/);
    expect(set).not.toContain("Secure");
    const cookie = set.split(";")[0]!;
    for (const path of [
      "/projects/",
      "/projects/shop/?follow",
      "/projects/shop/",
      "/projects/shop/notes/",
      "/projects/shop/notes/a.md",
      "/projects/shop/diagrams/flow.mmd",
      "/projects/shop/-/repo/README.md",
      "/projects/shop/docs/only.md",
    ]) {
      const page = await pageHttp(`${origin}${path}`, { headers: { cookie } });
      expect(page.status, path).toBe(200);
      expect(page.headers["content-type"], path).toBe("text/html; charset=utf-8");
      expect(page.headers["cache-control"], path).toBe("private, no-cache");
      expect(page.headers["referrer-policy"], path).toBe("no-referrer");
    }
    expect((await pageHttp(`${origin}/p/shop/api/diagrams`, { headers: { cookie } })).status).toBe(200);
    // Other query parameters survive the exchange, in their order and spelling.
    const kept = await pageHttp(`${origin}/projects/shop/notes/?q=a+b&token=${svc.token}&sort=-name`);
    expect(kept.headers.location).toBe("/projects/shop/notes/?q=a+b&sort=-name");
    // Without a credential, every page is the same 404 page asking for a new link and every API a bare 404.
    const refused = new Set<string>();
    for (const path of ["/projects/", "/projects/shop/", "/projects/shop/notes/a.md", "/projects/nosuch/notes/a.md"]) {
      const page = await pageHttp(`${origin}${path}`);
      expect(page.status, path).toBe(404);
      expect(page.body, path).toContain("Open the link Archer gave you");
      refused.add(page.body);
    }
    expect(refused.size).toBe(1);
    const bare = await pageHttp(`${origin}/p/shop/api/diagrams`);
    expect(bare.status).toBe(404);
    expect(bare.body).toBe("");
  } finally {
    client.close();
  }
});

test("an invalid explicit credential never falls back to a valid cookie", async () => {
  const { svc, client, status, origin } = await attached();
  try {
    const cookie = await cookieFor(status.url);
    const wrong = "0".repeat(64);
    for (const [path, headers] of [
      [`/projects/shop/?token=${wrong}`, { cookie }],
      [`/projects/shop/?token=${svc.token}&token=${svc.token}`, { cookie }],
      [`/projects/shop/?token=${svc.token}`, { cookie, authorization: `Bearer ${svc.token}` }],
      [`/p/shop/api/diagrams?token=${svc.token}`, { cookie }],
      [`/${wrong}/p/shop/`, { cookie }],
      ["/p/shop/api/diagrams", { cookie, authorization: "Bearer wrong" }],
      ["/projects/shop/", { cookie, host: "evil.invalid" }],
    ] as const)
      expect((await pageHttp(`${origin}${path}`, { headers })).status, path).toBe(404);
    // A token query on a write or an unknown page is not an exchange.
    expect((await pageHttp(`${origin}/projects/shop/?token=${svc.token}`, { method: "POST" })).status).toBe(404);
    expect((await pageHttp(`${origin}/projects/nobody/?token=${svc.token}`)).status).toBe(404);
  } finally {
    client.close();
  }
});

test("an owner session cookie keeps the exact Origin and JSON rule for writes", async () => {
  const { client, status, origin } = await attached();
  try {
    const cookie = await cookieFor(status.url);
    const url = `${origin}/p/shop/api/comments`;
    const body = JSON.stringify({ target: "view:flow", anchor: { kind: "view" }, body: "Saved once" });
    for (const headers of [
      { cookie, "content-type": "application/json" },
      { cookie, origin: origin.replace("http:", "https:"), "content-type": "application/json" },
      { cookie, origin, "content-type": "text/plain" },
    ])
      expect((await pageHttp(url, { method: "POST", headers, body })).status).toBe(404);
    expect(
      (await pageHttp(url, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body }))
        .status,
    ).toBe(200);
  } finally {
    client.close();
  }
});

test("a project address without its slash redirects to the clean address, keeping the query", async () => {
  const { client, root, status, origin } = await attached();
  try {
    const cookie = await cookieFor(status.url);
    for (const [path, location] of [
      ["/projects/shop", "/projects/shop/"],
      ["/projects/shop?follow", "/projects/shop/?follow"],
    ] as const) {
      const reply = await pageHttp(`${origin}${path}`, { headers: { cookie } });
      expect(reply.status, path).toBe(303);
      expect(reply.headers.location, path).toBe(location);
      expect(reply.headers["set-cookie"], path).toBeUndefined();
      expect(reply.headers["cache-control"], path).toBe("no-store");
    }
    // A 0.14 hash slug (the name and a short hash of the root) is no alias any more: the signed-in not-found page.
    const hashed = `shop-${createHash("sha256").update(root).digest("hex").slice(0, 8)}`;
    for (const path of [`/projects/${hashed}/`, `/projects/${hashed}/?follow`, `/projects/${hashed}/-/edit/`]) {
      const reply = await pageHttp(`${origin}${path}`, { headers: { cookie } });
      expect(reply.status, path).toBe(404);
      expect(reply.headers.location, path).toBeUndefined();
    }
    // The retired `/p/<name>/…` page forms (0.15.0) are no pages: `/p/<name>/` is the API base only.
    for (const path of [
      "/p/shop/",
      "/p/shop",
      "/p/shop/browse/",
      "/p/shop/views/flow/",
      "/p/shop/notes/notes/a.md",
      "/p/shop/documents/README.md",
      "/p/shop/edit/",
    ]) {
      const reply = await pageHttp(`${origin}${path}`, { headers: { cookie } });
      expect(reply.status, path).toBe(404);
      expect(reply.headers.location, path).toBeUndefined();
    }
    // Redirects are for reading pages only.
    expect((await pageHttp(`${origin}/projects/shop`, { method: "POST", headers: { cookie } })).status).toBe(404);
  } finally {
    client.close();
  }
});

test("an Archer-folder file named by its project path redirects to its clean address in one hop (perf #3)", async () => {
  const { client, status, origin } = await attached();
  try {
    const cookie = await cookieFor(status.url);
    for (const [path, location] of [
      ["/projects/shop/.archer/diagrams/flow.mmd", "/projects/shop/diagrams/flow.mmd"],
      ["/projects/shop/.archer/diagrams/flow.mmd?edit", "/projects/shop/diagrams/flow.mmd?edit"],
      ["/projects/shop/.archer/notes/a.md?thread=t1", "/projects/shop/notes/a.md?thread=t1"],
    ] as const) {
      const reply = await pageHttp(`${origin}${path}`, { headers: { cookie } });
      expect(reply.status, path).toBe(303);
      expect(reply.headers.location, path).toBe(location);
    }
    // Clean addresses, project documents and shadowed Archer files are served as they are.
    for (const path of [
      "/projects/shop/diagrams/flow.mmd",
      "/projects/shop/README.md",
      "/projects/shop/docs/only.md",
      "/projects/shop/docs/guide.md",
      "/projects/shop/nothing/here.md",
    ])
      expect((await pageHttp(`${origin}${path}`, { headers: { cookie } })).status, path).toBe(200);
  } finally {
    client.close();
  }
});

test("clean bootstrap and presentation links name the follow address without a credential", async () => {
  const { svc, client, root, status, origin } = await attached();
  try {
    const grant = await client.call("issueAccess", { label: "Browser" });
    const headers = { authorization: `Bearer ${grant.token}` };
    await client.call("present", { root, viewId: "flow", openBrowser: false });
    const bootstrap = await pageHttp(`${origin}/p/shop/api/bootstrap`, { headers });
    expect(bootstrap.body).not.toContain(svc.token);
    expect(JSON.parse(bootstrap.body)).toMatchObject({ ui: { url: `${origin}/projects/shop/?follow` } });
    // The owner's browser (signed in with the agent link) is told the same clean address.
    const owner = await pageHttp(`${origin}/p/shop/api/bootstrap`, {
      headers: { cookie: await cookieFor(status.url) },
    });
    expect(owner.body).not.toContain(svc.token);
    expect(JSON.parse(owner.body)).toMatchObject({ ui: { url: `${origin}/projects/shop/?follow` } });
  } finally {
    client.close();
  }
});

test("credentials never reach the service log across exchanges, redirects and refusals", async () => {
  const lines: string[] = [];
  const { svc, client, status, origin, retired } = await attached((line) => lines.push(line));
  try {
    const grant = await client.call("issueAccess", { label: "Browser" });
    await pageHttp(status.url);
    await pageHttp(grant.url);
    // A 0.14 address with the service token in its path: refused, and the token still never logged.
    await pageHttp(`${retired}/p/shop/browse/`);
    for (let i = 0; i < 5; i++) await pageHttp(`${origin}/${"f".repeat(64)}/p/shop/?token=${grant.token}`);
    await pageHttp(`${origin}/projects/shop/?token=${"0".repeat(64)}`);
    expect(lines.join("\n")).not.toContain(svc.token);
    expect(lines.join("\n")).not.toContain(grant.token);
  } finally {
    client.close();
  }
});
