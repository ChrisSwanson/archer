import { afterEach, expect, test } from "vitest";
import { connectService, type ServiceClient } from "../../src/service/index.ts";
import {
  BROKEN,
  cleanUp,
  events,
  exactly,
  http,
  json,
  ownerCookie,
  project,
  service,
  tempDir,
  write,
  apiBase,
  serviceBase,
} from "./support.ts";
import { chmodSync, mkdirSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectState } from "../../src/service/project-state.ts";
import { AccountStateStore } from "../../src/state/account.ts";

const clients: ServiceClient[] = [];
afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await cleanUp();
});

test("a new empty project becomes inactive after its persistent ten-minute grace period", async () => {
  let now = Date.parse("2026-10-15T12:00:00.000Z");
  const { svc } = await service({ now: () => now });
  const client = await connectService(svc.socketPath);
  clients.push(client);
  const root = tempDir("archer-empty-");
  write(root, "archer.toml", 'version = 1\nname = "Empty project"\n');

  const attached = await client.call("attach", { root });
  const lifecycle = async () => {
    const catalog = (await json(`${apiBase(attached.url)}api/projects`)) as {
      projects: { slug: string; lifecycle?: unknown }[];
    };
    return catalog.projects.find((project) => project.slug === new URL(attached.url).pathname.split("/").at(-2))
      ?.lifecycle;
  };

  expect(await lifecycle()).toEqual({
    state: "grace",
    visibility: "auto",
    reason: "empty",
    emptySince: "2026-10-15T12:00:00.000Z",
  });
  expect(await client.call("attach", { root })).toEqual(attached);
  expect(await lifecycle()).toMatchObject({ emptySince: "2026-10-15T12:00:00.000Z" });
  now += 10 * 60 * 1_000;
  expect(await lifecycle()).toEqual({
    state: "inactive",
    visibility: "auto",
    reason: "empty",
    emptySince: "2026-10-15T12:00:00.000Z",
  });
});

test("an unreadable default authoring folder is unknown even with implicit lifecycle settings", async () => {
  const root = tempDir("archer-unreadable-");
  write(root, "archer.toml", "version = 1\n");
  const folder = join(root, ".archer");
  mkdirSync(folder);
  const state = await ProjectState.open(root, (slug) => `http://example/${slug}/`);
  chmodSync(folder, 0o000);
  try {
    expect(state.lifecycleContent({})).toBe("unknown");
  } finally {
    chmodSync(folder, 0o700);
    state.close();
  }
});

test("raw admitted sources count as content despite compile failure, while other missing configured roots stay unknown", async () => {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  clients.push(client);
  const broken = tempDir("archer-broken-");
  write(broken, "archer.toml", "version = 1\n");
  write(broken, ".archer/broken.mmd", BROKEN);
  const uncertain = tempDir("archer-uncertain-");
  write(uncertain, "archer.toml", 'version = 1\n[discovery]\nroots = ["docs"]\n');
  const unreadable = tempDir("archer-unreadable-source-");
  write(unreadable, "archer.toml", "version = 1\n");
  writeFileSync(write(unreadable, ".archer/note.md", "placeholder"), Buffer.from([0xff]));
  const linked = tempDir("archer-linked-");
  write(linked, "archer.toml", 'version = 1\n[discovery]\nroots = ["docs"]\n');
  symlinkSync(tempDir("archer-outside-"), join(linked, "docs"));
  const a = await client.call("attach", { root: broken });
  const b = await client.call("attach", { root: uncertain });
  const c = await client.call("attach", { root: unreadable });
  const d = await client.call("attach", { root: linked });
  const catalog = (await json(`${apiBase(a.url)}api/projects`)) as {
    projects: { slug: string; lifecycle: { state: string } }[];
  };
  expect(
    catalog.projects.find((entry) => entry.slug === new URL(a.url).pathname.split("/").at(-2))?.lifecycle.state,
  ).toBe("active");
  expect(
    catalog.projects.find((entry) => entry.slug === new URL(b.url).pathname.split("/").at(-2))?.lifecycle.state,
  ).toBe("unknown");
  expect(
    catalog.projects.find((entry) => entry.slug === new URL(c.url).pathname.split("/").at(-2))?.lifecycle.state,
  ).toBe("active");
  expect(
    catalog.projects.find((entry) => entry.slug === new URL(d.url).pathname.split("/").at(-2))?.lifecycle.state,
  ).toBe("unknown");
});

test("default-scope manifest intent stays unknown, while an explicit empty discovery scope remains eligible", async () => {
  let now = Date.parse("2026-10-15T12:00:00.000Z");
  const { svc } = await service({ now: () => now });
  const client = await connectService(svc.socketPath);
  clients.push(client);
  const missing = tempDir("archer-missing-view-");
  write(
    missing,
    "archer.toml",
    'version=1\n[[views]]\nid="planned"\nkind="freeform"\ntitle="Planned"\nsource=".archer/planned.mmd"\n',
  );
  const malformed = tempDir("archer-malformed-view-");
  write(malformed, "archer.toml", 'version=1\n[[views]]\nid="planned"\n');
  const intentional = tempDir("archer-intentional-empty-");
  write(
    intentional,
    "archer.toml",
    'version=1\n[discovery]\nroots=[]\n[[views]]\nid="planned"\nkind="freeform"\ntitle="Planned"\nsource=".archer/planned.mmd"\n',
  );
  const attachments = await Promise.all(
    [missing, malformed, intentional].map((root) => client.call("attach", { root })),
  );
  now += 10 * 60 * 1_000;
  const catalog = (await json(`${apiBase(attachments[0]!.url)}api/projects`)) as {
    projects: { slug: string; lifecycle: { state: string } }[];
  };
  const state = (index: number) =>
    catalog.projects.find((entry) => entry.slug === new URL(attachments[index]!.url).pathname.split("/").at(-2))
      ?.lifecycle.state;
  expect(state(0)).toBe("unknown");
  expect(state(1)).toBe("unknown");
  expect(state(2)).toBe("inactive");
});

test("a restored legacy empty attachment stays unknown after the deadline and an archive-to-auto round trip", async () => {
  const stateDir = tempDir("archer-legacy-state-");
  const root = tempDir("archer-legacy-project-");
  write(root, "archer.toml", "version = 1\n");
  const account = new AccountStateStore(stateDir);
  const old = await ProjectState.open(
    root,
    () => "http://example/",
    () => {},
    { store: account },
  );
  old.persist();
  account.markAttached(root, true);
  old.close();
  const { svc } = await service({ stateDir, now: () => Date.parse("2030-10-15T12:00:00.000Z") });
  const client = await connectService(svc.socketPath);
  clients.push(client);
  const attached = (await client.call("listProjects", {})).projects[0]!;
  const catalog = (await json(`${apiBase(attached.url)}api/projects`)) as {
    projects: { slug: string; lifecycle: { state: string } }[];
  };
  const slug = new URL(attached.url).pathname.split("/").at(-2)!;
  expect(catalog.projects[0]?.lifecycle.state).toBe("unknown");
  const origin = new URL(attached.url).origin;
  for (const action of ["archive", "auto"] as const) {
    const response = await http(`${serviceBase(svc.homeUrl)}api/project-lifecycle`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ slug, action }),
    });
    expect(response.status).toBe(200);
  }
  const after = (await json(`${apiBase(attached.url)}api/projects`)) as {
    projects: { lifecycle: { state: string; visibility: string } }[];
  };
  expect(after.projects[0]?.lifecycle).toMatchObject({ state: "unknown", visibility: "auto" });
});

test("same-origin lifecycle mutations are persistent, idempotent, and available from service and project routes", async () => {
  const { svc, state } = await service();
  const client = await connectService(svc.socketPath);
  clients.push(client);
  const root = project();
  const attached = await client.call("attach", { root });
  const slug = new URL(attached.url).pathname.split("/").at(-2)!;
  const origin = new URL(attached.url).origin;
  const post = (url: string, action: "show" | "archive" | "auto") =>
    http(url, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ slug, action }),
    });
  const endpoint = `${serviceBase(svc.homeUrl)}api/project-lifecycle`;

  expect(JSON.parse((await post(endpoint, "archive")).body)).toEqual({
    lifecycle: { state: "inactive", visibility: "hidden", reason: "manual" },
  });
  const lifecyclePath = join(state, "runtime/project-lifecycle.json");
  const first = statSync(lifecyclePath, { bigint: true }).ino;
  expect((await post(endpoint, "archive")).status).toBe(200);
  expect(statSync(lifecyclePath, { bigint: true }).ino).toBe(first);
  expect(JSON.parse((await post(`${apiBase(attached.url)}api/project-lifecycle`, "show")).body)).toEqual({
    lifecycle: { state: "active", visibility: "visible", reason: "manual" },
  });
  expect(JSON.parse((await post(endpoint, "auto")).body)).toEqual({
    lifecycle: { state: "active", visibility: "auto" },
  });
  for (const path of ["api/projects", "api/browser-projects"]) {
    const catalog = (await json(`${apiBase(attached.url)}${path}`)) as {
      projects: { slug: string; lifecycle: unknown }[];
    };
    expect(catalog.projects.find((entry) => entry.slug === slug)?.lifecycle).toEqual({
      state: "active",
      visibility: "auto",
    });
  }
});

test("lifecycle mutation refuses missing or cross origin, wrong media, malformed bodies, unknown projects, oversize, and bad auth", async () => {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  clients.push(client);
  const attached = await client.call("attach", { root: project() });
  const slug = new URL(attached.url).pathname.split("/").at(-2)!;
  const endpoint = `${serviceBase(svc.homeUrl)}api/project-lifecycle`;
  const origin = new URL(endpoint).origin;
  const request = (body: string, headers: Record<string, string>) => http(endpoint, { method: "POST", headers, body });
  const valid = JSON.stringify({ slug, action: "archive" });

  // The browser's cookie admits a write only from this origin, as JSON: anything else is the bare 404 before the
  // body is read.
  const cookie = (await ownerCookie(endpoint))!;
  const refused = (headers: Record<string, string>) =>
    exactly(endpoint, { method: "POST", headers: { cookie, ...headers }, body: valid });
  expect((await refused({ "content-type": "application/json" })).status).toBe(404);
  expect((await refused({ origin: "http://evil.example", "content-type": "application/json" })).status).toBe(404);
  expect((await refused({ origin, "content-type": "text/plain" })).status).toBe(404);
  expect((await request("{", { origin, "content-type": "application/json" })).status).toBe(422);
  expect((await request("{}", { origin, "content-type": "application/json" })).status).toBe(422);
  expect(
    (await request(JSON.stringify({ slug, action: "detach" }), { origin, "content-type": "application/json" })).status,
  ).toBe(422);
  expect((await client.call("listProjects", {})).projects).toHaveLength(1);
  expect(
    (
      await request(JSON.stringify({ slug: "missing-00000000", action: "archive" }), {
        origin,
        "content-type": "application/json",
      })
    ).status,
  ).toBe(404);
  expect(
    (await request("x".repeat(1025), { origin, "content-type": "application/json", "content-length": "1025" })).status,
  ).toBe(413);
  // Without the browser's credential.
  expect(
    (
      await exactly(endpoint, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: valid,
      })
    ).status,
  ).toBe(404);
});

test("restart and catalog polling preserve the empty deadline; watcher content resurfaces only automatic archives", async () => {
  let now = Date.parse("2026-10-15T12:00:00.000Z");
  const first = await service({ now: () => now });
  let client = await connectService(first.svc.socketPath);
  clients.push(client);
  const root = tempDir("archer-empty-");
  write(root, "archer.toml", "version = 1\n");
  const attached = await client.call("attach", { root });
  await json(`${apiBase(attached.url)}api/projects`);
  await json(`${apiBase(attached.url)}api/projects`);
  await first.svc.close();
  client.close();

  now += 10 * 60 * 1_000;
  const second = await service({ stateDir: first.state, now: () => now });
  client = await connectService(second.svc.socketPath);
  clients.push(client);
  const getLifecycle = async () => {
    const catalog = (await json(`${apiBase(attached.url)}api/projects`)) as {
      projects: { lifecycle: { state: string; visibility: string } }[];
    };
    return catalog.projects[0]!.lifecycle;
  };
  expect(await getLifecycle()).toMatchObject({ state: "inactive", visibility: "auto" });

  const stream = await events(`${apiBase(attached.url)}api/events`);
  write(root, ".archer/broken.mmd", BROKEN);
  await stream.next("documents");
  expect(await getLifecycle()).toEqual({ state: "active", visibility: "auto" });
  unlinkSync(join(root, ".archer/broken.mmd"));
  await stream.next("documents");
  expect(await getLifecycle()).toEqual({ state: "active", visibility: "auto" });

  const origin = new URL(attached.url).origin;
  const slug = new URL(attached.url).pathname.split("/").at(-2)!;
  const archived = await http(`${serviceBase(second.svc.homeUrl)}api/project-lifecycle`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ slug, action: "archive" }),
  });
  expect(archived.status).toBe(200);
  write(root, ".archer/return.md", "# Returned\n");
  await stream.next("documents");
  expect(await getLifecycle()).toMatchObject({ state: "inactive", visibility: "hidden", reason: "manual" });
  stream.close();
});

test("a lifecycle write failure returns 500 without stopping the service or skipping watcher resubscription", async () => {
  const lines: string[] = [];
  const { svc, state } = await service({ log: (line) => lines.push(line) });
  const client = await connectService(svc.socketPath);
  clients.push(client);
  const root = tempDir("archer-lifecycle-failure-");
  write(root, "archer.toml", "version = 1\n");
  const attached = await client.call("attach", { root });
  const lifecyclePath = join(state, "runtime/project-lifecycle.json");
  unlinkSync(lifecyclePath);
  mkdirSync(lifecyclePath);
  const stream = await events(`${apiBase(attached.url)}api/events`);
  write(root, ".archer/nested/note.md", "# First\n");
  await stream.next("documents");
  await expect.poll(() => lines.some((line) => line.includes("lifecycle observation failed"))).toBe(true);
  const failed = await http(`${apiBase(attached.url)}api/projects`);
  expect([failed.status, JSON.parse(failed.body).error.code]).toEqual([500, "internal"]);
  expect((await client.call("hello", { protocolVersion: 1 })).homeUrl).toBe(svc.homeUrl);

  rmdirSync(lifecyclePath);
  write(root, ".archer/nested/note.md", "# Second\n");
  await stream.next("documents");
  const recovered = (await json(`${apiBase(attached.url)}api/projects`)) as { projects: { lifecycle: unknown }[] };
  expect(recovered.projects[0]?.lifecycle).toEqual({ state: "active", visibility: "auto" });
  stream.close();
});

test("the implicit root README is not Archer content: a project with only a README stays empty", async () => {
  const root = tempDir("archer-readme-only-");
  write(root, "archer.toml", "version = 1\n");
  write(root, "README.md", "# Code project\n\nNot Archer content.\n");
  const state = await ProjectState.open(root, (slug) => `http://example/${slug}/`);
  try {
    expect(state.lifecycleContent({})).toBe("empty");
    expect(state.lifecycleContent({ roots: [".archer", "README.md"] })).toBe("content");
  } finally {
    state.close();
  }
});
