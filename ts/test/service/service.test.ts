// The service end to end: a real process-local service on a temp state
// directory and socket, a temp project attached over the management socket,
// and the data plane read over HTTP exactly as the page reads it.
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  connectService,
  defaultServeCommand,
  ensureService,
  ServiceCallError,
  type ServiceClient,
} from "../../src/service/index.ts";
import {
  isolatedProcessEnv,
  BROKEN,
  cleanUp,
  events,
  FLOW,
  FLOW2,
  http,
  json,
  project,
  service,
  tempDir,
  write,
  apiBase,
  exactly,
  slugOf,
} from "./support.ts";

afterEach(cleanUp);

const clients: ServiceClient[] = [];
afterEach(() => clients.splice(0).forEach((c) => c.close()));

async function client(socketPath: string): Promise<ServiceClient> {
  const c = await connectService(socketPath);
  clients.push(c);
  return c;
}

async function attached() {
  const { svc, state } = await service();
  const c = await client(svc.socketPath);
  const root = project();
  const status = await c.call("attach", { root });
  return { svc, state, c, root, page: status.url, status };
}

describe("the service process", () => {
  test.each([false, true])("opt-in watcher traces bracket real reloads after restoration=%s", async (restore) => {
    const lines: string[] = [];
    const watchTrace = (line: string) => lines.push(line);
    const first = await service({ watchTrace });
    const root = project();
    const initialClient = await client(first.svc.socketPath);
    await initialClient.call("attach", { root });
    let svc = first.svc;
    if (restore) {
      initialClient.close();
      await svc.close();
      lines.length = 0;
      svc = (await service({ stateDir: first.state, watchTrace })).svc;
    }
    const c = await client(svc.socketPath);
    const { url } = await c.call("attach", { root });
    const stream = await events(`${apiBase(url)}api/events`);
    try {
      write(root, ".archer/flow.mmd", FLOW2);
      expect(await stream.next("change")).toMatchObject({ viewId: "flow" });
      // The change is published as the views commit; the reload settles a few turns later (O12's phases).
      await expect.poll(() => lines.some((line) => line.includes("reload:settled"))).toBe(true);
      const registered = lines.findIndex((line) => line.includes("registered path="));
      const received = lines.findIndex((line) => line.includes("event path="));
      const started = lines.findIndex((line) => line.includes("reload:start"));
      const settled = lines.findIndex((line) => line.includes("reload:settled"));
      expect(registered).toBeGreaterThanOrEqual(0);
      expect(received).toBeGreaterThan(registered);
      expect(started).toBeGreaterThan(received);
      expect(settled).toBeGreaterThan(started);
      expect(lines.some((line) => line.includes(svc.token))).toBe(false);
    } finally {
      stream.close();
    }
  });

  test("keeps its token and port in a private state directory, and answers hello", async () => {
    const { svc, state } = await service();
    expect(statSync(state).mode & 0o777).toBe(0o700);
    const saved = join(state, "service.json");
    expect(statSync(saved).mode & 0o777).toBe(0o600);
    expect(svc.homeUrl).toBe(`http://127.0.0.1:${svc.port}/projects/?token=${svc.token}`);
    const hello = await (await client(svc.socketPath)).call("hello", { protocolVersion: 1 });
    expect(hello).toEqual({
      protocolVersion: 1,
      version: expect.any(String),
      homeUrl: svc.homeUrl,
      serviceName: "default",
    });
  });

  test("refuses a client of another protocol version", async () => {
    const { svc } = await service();
    await expect((await client(svc.socketPath)).call("hello", { protocolVersion: 99 })).rejects.toMatchObject({
      error: { code: "protocol_version_mismatch" },
    });
  });

  test("refuses to start while another live service holds the socket", async () => {
    const { svc, state } = await service();
    await expect(service({ stateDir: state, socketPath: svc.socketPath })).rejects.toThrow(/already running/);
  });

  test("comes back at the same token and port after a stop, so open tabs reconnect", async () => {
    const { svc, state } = await service();
    const { token, port } = svc;
    expect(await (await client(svc.socketPath)).call("stop", {})).toEqual({ stopping: true });
    await svc.closed;
    expect(existsSync(svc.socketPath)).toBe(false);
    const again = await service({ stateDir: state });
    expect([again.svc.token, again.svc.port]).toEqual([token, port]);
  });

  test("a remembered port someone else holds is not assumed: a new port, and a new token", async () => {
    const { svc, state } = await service();
    const { token, port } = svc;
    await svc.close();
    // Whatever holds the old port now may have been sent the old token by a reconnecting tab.
    const squatter = createServer();
    await new Promise<void>((ok) => squatter.listen(port, "127.0.0.1", ok));
    try {
      const again = await service({ stateDir: state });
      expect(again.svc.port).not.toBe(port);
      expect(again.svc.token).not.toBe(token);
      expect(JSON.parse(readFileSync(join(state, "service.json"), "utf8"))).toEqual({
        token: again.svc.token,
        port: again.svc.port,
      });
    } finally {
      await new Promise((ok) => squatter.close(ok));
    }
  });

  test("the token never reaches the log", async () => {
    const lines: string[] = [];
    const { svc } = await service({ log: (line) => lines.push(line) });
    const c = await client(svc.socketPath);
    const root = project();
    await c.call("attach", { root });
    await http(`http://127.0.0.1:${svc.port}/${"0".repeat(64)}/`);
    await svc.close();
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.filter((line) => line.includes(svc.token))).toEqual([]);
  }, 15_000); // a real service process: 0.6 s idle, 6.4-7.0 s (timed out) beside a disk writer or under write throttling

  test("replaces a stale socket left by a service that died", async () => {
    const first = await service();
    await first.svc.close();
    // What a killed service leaves: its socket file and its lock, naming a process that is gone.
    writeFileSync(first.svc.socketPath, "");
    writeFileSync(join(first.state, "archer.lock"), "999999999\n");
    const { svc } = await service({ stateDir: first.state });
    expect((await (await client(svc.socketPath)).call("hello", { protocolVersion: 1 })).homeUrl).toBe(svc.homeUrl);
  });

  test("answers a malformed line with an error and keeps the connection", async () => {
    const { svc } = await service();
    const replies = await rawLines(
      svc.socketPath,
      [
        "not json",
        JSON.stringify({ id: 7, method: "nope", params: {} }),
        JSON.stringify({ id: 8, method: "listProjects", params: {} }),
      ],
      3,
    );
    expect(replies).toEqual([
      { id: 0, ok: false, error: expect.objectContaining({ code: "invalid_request" }) },
      { id: 7, ok: false, error: expect.objectContaining({ code: "unknown_method" }) },
      { id: 8, ok: true, result: { projects: [] } },
    ]);
  });
});

function rawLines(socketPath: string, lines: string[], count: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const got: unknown[] = [];
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        got.push(JSON.parse(buffer.slice(0, end)));
        buffer = buffer.slice(end + 1);
      }
      if (got.length >= count) {
        socket.end();
        resolve(got);
      }
    });
    socket.on("error", reject);
    socket.write(lines.map((l) => `${l}\n`).join(""));
  });
}

describe("projects", () => {
  test("attach gives the project a page at projects/<name>/ and lists it", async () => {
    const { svc, c, root, status } = await attached();
    expect(status).toEqual({
      root,
      name: expect.stringMatching(/^archer-proj-/),
      url: expect.stringMatching(
        new RegExp(`^http://127\\.0\\.0\\.1:${svc.port}/projects/archer-proj-[a-z0-9]+/\\?follow&token=${svc.token}$`),
      ),
    });
    expect(await c.call("listProjects", {})).toEqual({ projects: [status] });
    // Attaching again, or from a folder inside it, is the same project.
    expect(await c.call("attach", { root: join(root, ".archer") })).toEqual(status);
    expect((await c.call("listProjects", {})).projects).toHaveLength(1);
  });

  test("detach removes the page", async () => {
    const { c, root, page } = await attached();
    expect(await c.call("detach", { root })).toEqual({ detached: true });
    expect((await http(page)).status).toBe(404);
    expect(await c.call("detach", { root })).toEqual({ detached: false });
  });

  test("a method naming a project that is not attached is refused by name", async () => {
    const { svc } = await service();
    const c = await client(svc.socketPath);
    await expect(c.call("present", { root: "/nowhere", viewId: "x" })).rejects.toMatchObject({
      error: { code: "project_not_attached" },
    });
  });
});

describe("the data plane", () => {
  test("serves the page with Rust's security headers", async () => {
    const { page } = await attached();
    // The agent's link exchanges its token for the access cookie, then the clean page is served.
    const exchange = await http(page);
    expect(exchange.status).toBe(303);
    expect(exchange.headers).toMatchObject({ "cache-control": "no-store", "referrer-policy": "no-referrer" });
    const cookie = (exchange.headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    const reply = await http(new URL(exchange.headers.location as string, page).href, { headers: { cookie } });
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(reply.headers).toMatchObject({
      // Revalidated on every load (a reload is a 304), never kept by a shared cache (EX-S1-01, D8).
      "cache-control": "private, no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      // `'self'` images: the gallery's thumbnails are this service's own api/thumbnails route. Scripts run
      // only by the hash of each inline script served (page-csp.ts): no 'unsafe-inline', no 'unsafe-eval'.
      "content-security-policy": expect.stringMatching(
        /^default-src 'none'; script-src 'sha256-[A-Za-z0-9+/]{43}='( 'sha256-[A-Za-z0-9+/]{43}=')*; worker-src 'self' blob:; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'$/,
      ),
    });
    expect(reply.body).toContain("<html");
  });

  test("anything without the token is a bare 404, whatever the path; a page address gets the ask-for-a-new-link 404 page; the base address, the pairing form", async () => {
    const { svc, page } = await attached();
    const wrong = page.replace(svc.token, "0".repeat(64));
    const api = `${apiBase(page)}api/diagrams`;
    const base = await exactly(`http://127.0.0.1:${svc.port}/`);
    expect(base.status).toBe(200);
    expect(base.body).toContain("Enter your pairing code");
    for (const url of [
      api,
      `${api}?token=${"0".repeat(64)}`,
      `http://127.0.0.1:${svc.port}/?x`,
      `http://127.0.0.1:${svc.port}/favicon.ico`,
      // The retired path-token form is no credential at all.
      `http://127.0.0.1:${svc.port}/${svc.token}/p/${slugOf(page)}/api/diagrams`,
    ]) {
      const reply = await exactly(url);
      expect([url, reply.status, reply.body]).toEqual([url, 404, ""]);
    }
    const refused = await exactly(wrong);
    expect(refused.status).toBe(404);
    expect(refused.body).toContain("Open the link Archer gave you");
    expect((await exactly(`${apiBase(page)}api/selection`, { method: "POST", body: "{}" })).status).toBe(404);
  });

  test("the home link signs this browser in and lands on Projects", async () => {
    const { svc } = await attached();
    const reply = await exactly(svc.homeUrl);
    expect(reply.status).toBe(303);
    expect(reply.headers.location).toBe("/projects/");
    const cookie = (reply.headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    expect(cookie).not.toContain(svc.token);
    const projects = await exactly(new URL("/projects/", svc.homeUrl).href, { headers: { cookie } });
    expect([projects.status, projects.body]).toEqual([200, expect.stringContaining("<html")]);
  });

  test("inventory, envelope, compile status and an empty bootstrap", async () => {
    const { page } = await attached();
    expect(await json(`${apiBase(page)}api/diagrams`)).toEqual({
      schemaVersion: 1,
      // The painter's version, which every thumbnail address carries.
      thumbnailVersion: expect.stringMatching(/^[0-9a-f]{12}$/),
      thumbnailFormat: "png",
      views: [
        expect.objectContaining({
          id: "flow",
          kind: "freeform",
          title: "The flow",
          registration: "durable",
          group: "system",
        }),
        expect.objectContaining({
          id: "chat",
          kind: "sequence",
          title: "chat",
          registration: "durable",
          group: "behaviour",
        }),
      ],
    });
    expect(await json(`${apiBase(page)}api/diagrams/flow`)).toMatchObject({
      schemaVersion: 2,
      view: { id: "flow" },
      model: { type: "freeform-graph" },
    });
    const missing = await http(`${apiBase(page)}api/diagrams/nope`);
    expect([missing.status, JSON.parse(missing.body)]).toEqual([
      404,
      { schemaVersion: 1, error: { code: "diagram_not_found", message: expect.any(String) } },
    ]);
    expect(await json(`${apiBase(page)}api/compile`)).toEqual({ schemaVersion: 1, failures: [] });
    expect(await json(`${apiBase(page)}api/bootstrap`)).toEqual({
      capabilities: {
        comments: true,
        notes: true,
        noteEmphasis: true,
        instanceSettings: true,
        listeners: true,
        commentOperations: 1,
      },
      project: { name: expect.any(String) },
    });
    expect(await json(`${apiBase(page)}api/emphasis/flow`)).toEqual({ schemaVersion: 1, viewId: "flow", emphases: [] });
  });

  test("present puts the view and its caption in bootstrap and on the stream", async () => {
    const { c, root, page } = await attached();
    const stream = await events(`${apiBase(page)}api/events`);
    const presented = await c.call("present", { root, viewId: "flow", annotation: "Where requests go" });
    expect(presented.url).toBe(page);
    const event = await stream.next("presentation");
    const boot = await json(`${apiBase(page)}api/bootstrap`);
    expect(event).toEqual(boot);
    expect(boot).toMatchObject({
      presentation: {
        presentationId: presented.presentationId,
        viewId: "flow",
        revision: expect.stringMatching(/^sha256:/),
        viewport: "fit-all",
        annotation: "Where requests go",
      },
      envelope: { view: { id: "flow" } },
      diagnostics: [],
    });
    stream.close();
  });

  test("present refuses an unknown view and an over-long caption", async () => {
    const { c, root } = await attached();
    await expect(c.call("present", { root, viewId: "nope" })).rejects.toMatchObject({
      error: { code: "diagram_not_found" },
    });
    await expect(c.call("present", { root, viewId: "flow", annotation: "x".repeat(501) })).rejects.toMatchObject({
      error: { code: "invalid_params" },
    });
  });

  // present_diagram's emphasis: set and presented in one transaction, against the reloaded model.
  test("present with emphases sets them and presents together, or neither", async () => {
    const { c, root, page } = await attached();
    const group = { id: "g", label: "g", style: "highlight", nodes: ["a"] };
    const shown = await c.call("present", { root, viewId: "flow", emphases: [{ id: "x", groups: [group] }] });
    expect(shown).toMatchObject({
      url: page,
      emphasis: { schemaVersion: 1, viewId: "flow", emphases: [expect.objectContaining({ id: "x" })] },
    });
    const boot = await json(`${apiBase(page)}api/bootstrap`);
    expect(boot).toMatchObject({ presentation: { presentationId: shown.presentationId, viewId: "flow" } });
    const stored = await json(`${apiBase(page)}api/emphasis/flow`);
    // A refused emphasis presents nothing; a refused presentation keeps no emphasis.
    await expect(
      c.call("present", {
        root,
        viewId: "flow",
        annotation: "never",
        emphases: [{ id: "y", groups: [{ ...group, nodes: ["zz"] }] }],
      }),
    ).rejects.toMatchObject({
      error: {
        code: "invalid_emphasis",
        message: expect.stringMatching(
          /^present_diagram's emphasis argument was rejected: 1 problem\. Nothing was presented/,
        ),
      },
    });
    await expect(
      c.call("present", {
        root,
        viewId: "flow",
        annotation: "x".repeat(501),
        emphases: [{ id: "z", groups: [group] }],
      }),
    ).rejects.toMatchObject({ error: { code: "invalid_params" } });
    expect(await json(`${apiBase(page)}api/bootstrap`)).toEqual(boot);
    expect(await json(`${apiBase(page)}api/emphasis/flow`)).toEqual(stored);
    // Without emphases the reply is as before.
    expect(await c.call("present", { root, viewId: "flow" })).not.toHaveProperty("emphasis");
  });

  test("setEmphasis publishes the view's list, and refuses a bad payload with every issue", async () => {
    const { c, root, page } = await attached();
    const stream = await events(`${apiBase(page)}api/events`);
    const group = { id: "g", label: "g", style: "highlight", nodes: ["a"] };
    expect(await c.call("setEmphasis", { root, viewId: "flow", emphases: [{ id: "x", groups: [group] }] })).toEqual({
      url: page,
      snapshot: expect.objectContaining({
        schemaVersion: 1,
        viewId: "flow",
        emphases: [expect.objectContaining({ id: "x" })],
      }),
    });
    const payload = await json(`${apiBase(page)}api/emphasis/flow`);
    expect(payload).toMatchObject({
      viewId: "flow",
      emphases: [{ id: "x", viewId: "flow", groups: [{ id: "g", nodes: ["a"] }] }],
    });
    expect(await stream.next("emphasis")).toEqual(payload);
    const refused = c.call("setEmphasis", {
      root,
      viewId: "flow",
      emphases: [{ id: "y", groups: [{ ...group, nodes: ["zz"], palette: "red" }] }],
    });
    await expect(refused).rejects.toBeInstanceOf(ServiceCallError);
    await expect(refused).rejects.toMatchObject({
      error: {
        code: "invalid_emphasis",
        details: {
          issues: expect.arrayContaining([expect.objectContaining({ problem: 'no node "zz" in this diagram' })]),
        },
      },
    });
    expect(await json(`${apiBase(page)}api/emphasis/flow`)).toEqual(payload);
    await expect(
      c.call("setEmphasis", { root, viewId: "nope", emphases: [{ id: "x", groups: [] }] }),
    ).rejects.toMatchObject({ error: { code: "invalid_emphasis" } });
    stream.close();
  });
});

describe("live reload", () => {
  test("an edit republishes the presented view; a break keeps the last good model and says so", async () => {
    const { c, root, page } = await attached();
    await c.call("present", { root, viewId: "flow" });
    const stream = await events(`${apiBase(page)}api/events`);
    const first = (await json(`${apiBase(page)}api/diagrams/flow`)) as { revision: string };

    write(root, ".archer/flow.mmd", FLOW2);
    const redrawn = (await stream.next("presentation")) as {
      presentation: { revision: string };
      envelope: { model: { nodes: unknown[] } };
    };
    expect(redrawn.presentation.revision).not.toBe(first.revision);
    expect(redrawn.envelope.model.nodes).toHaveLength(3);

    write(root, ".archer/flow.mmd", BROKEN);
    const status = (await stream.next("compile")) as {
      failures: {
        viewId: string;
        lastValidRevision: string;
        sourceRevision: string;
        diagnostics: { code: string; span?: unknown }[];
      }[];
    };
    expect(status.failures).toEqual([
      expect.objectContaining({
        viewId: "flow",
        lastValidRevision: redrawn.presentation.revision,
        sourceRevision: expect.stringMatching(/^sha256:/),
      }),
    ]);
    expect(status.failures[0]?.diagnostics[0]).toMatchObject({
      code: expect.any(String),
      message: expect.any(String),
      span: { start: { line: expect.any(Number) } },
    });
    expect(await json(`${apiBase(page)}api/compile`)).toEqual(status);
    expect(((await json(`${apiBase(page)}api/diagrams/flow`)) as { revision: string }).revision).toBe(
      redrawn.presentation.revision,
    );

    write(root, ".archer/flow.mmd", FLOW);
    expect(await stream.next("compile")).toEqual({ schemaVersion: 1, failures: [] });
    stream.close();
  });

  test("a presented, emphasised view whose file is deleted leaves bootstrap and its emphases", async () => {
    const { c, root, page } = await attached();
    await c.call("present", { root, viewId: "chat" });
    await c.call("setEmphasis", {
      root,
      viewId: "chat",
      emphases: [{ id: "x", groups: [{ id: "g", label: "g", style: "highlight", nodes: ["A"] }] }],
    });
    const stream = await events(`${apiBase(page)}api/events`);
    unlinkSync(join(root, ".archer/chat.mmd"));
    expect(await stream.next("emphasis")).toEqual({ schemaVersion: 1, viewId: "chat", emphases: [] });
    expect(await stream.next("inventory")).toMatchObject({ views: [{ id: "flow" }] });
    expect(await json(`${apiBase(page)}api/bootstrap`)).toEqual({
      capabilities: {
        comments: true,
        notes: true,
        noteEmphasis: true,
        instanceSettings: true,
        listeners: true,
        commentOperations: 1,
      },
      project: { name: expect.any(String) },
    });
    stream.close();
  });

  test("a new file and a removed file change the inventory", async () => {
    const { root, page } = await attached();
    const stream = await events(`${apiBase(page)}api/events`);
    write(root, ".archer/more/extra.mmd", FLOW);
    expect(await stream.next("inventory")).toMatchObject({ views: [{ id: "flow" }, { id: "chat" }, { id: "extra" }] });
    write(
      root,
      "archer.toml",
      'version = 1\n\n[[views]]\nid = "renamed"\nkind = "freeform"\ntitle = "Renamed"\nsource = ".archer/flow.mmd"\n',
    );
    expect(await stream.next("inventory")).toMatchObject({
      views: [{ id: "renamed", title: "Renamed" }, { id: "chat" }, { id: "extra" }],
    });
    stream.close();
  });

  // A9: the page re-reads a view it shows when, and only when, the inventory names a new model revision for it, and
  // asks nothing on a timer. So every model revision a view gets reaches the stream, its first compile included.
  test("a view's every new model revision is announced on the inventory, its first compile included", async () => {
    const { root, page } = await attached();
    write(root, ".archer/flow.mmd", BROKEN);
    const before = (await json(`${apiBase(page)}api/diagrams`)) as { views: { id: string; modelRevision?: string }[] };
    const was = before.views.find((view) => view.id === "flow")?.modelRevision;
    const stream = await events(`${apiBase(page)}api/events`);
    write(root, ".archer/fresh.mmd", BROKEN);
    const broken = (await stream.next("inventory")) as { views: { id: string; modelRevision?: string }[] };
    expect(broken.views.find((view) => view.id === "fresh")).not.toHaveProperty("modelRevision");
    write(root, ".archer/fresh.mmd", FLOW2);
    for (;;) {
      const inventory = (await stream.next("inventory")) as { views: { id: string; modelRevision?: string }[] };
      const fresh = inventory.views.find((view) => view.id === "fresh");
      if (fresh?.modelRevision === undefined) continue;
      expect(fresh.modelRevision).toMatch(/^sha256:[0-9a-f]{64}$/);
      break;
    }
    write(root, ".archer/flow.mmd", FLOW2);
    for (;;) {
      const inventory = (await stream.next("inventory")) as { views: { id: string; modelRevision?: string }[] };
      const flow = inventory.views.find((view) => view.id === "flow")?.modelRevision;
      if (flow === was) continue;
      expect(flow).toMatch(/^sha256:[0-9a-f]{64}$/);
      break;
    }
    stream.close();
  });

  test("the folder can appear after the project is attached", async () => {
    const { svc } = await service();
    const c = await client(svc.socketPath);
    const root = tempDir("archer-proj-");
    const { url } = await c.call("attach", { root });
    const stream = await events(`${apiBase(url)}api/events`);
    write(root, ".archer/late.mmd", FLOW);
    expect(await stream.next("inventory")).toMatchObject({ views: [{ id: "late" }] });
    stream.close();
  });
});

describe("selection", () => {
  async function presentedFlow() {
    const setup = await attached();
    const { presentationId } = await setup.c.call("present", { root: setup.root, viewId: "flow" });
    const { revision } = (await json(`${apiBase(setup.page)}api/diagrams/flow`)) as { revision: string };
    const body = (extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        schemaVersion: 1,
        viewId: "flow",
        revision,
        presentationId,
        selectionRevision: 1,
        nodes: [{ id: "a", label: "ignored" }],
        edges: [],
        ...extra,
      });
    return { ...setup, presentationId, revision, body };
  }

  test("a same-origin POST is stored as the model says, and read back as the agent reads it (getContext)", async () => {
    const { c, root, page, body, presentationId } = await presentedFlow();
    const host = new URL(page).host;
    const reply = await http(`${apiBase(page)}api/selection`, {
      method: "POST",
      headers: { origin: `http://${host}`, host, "content-type": "application/json" },
      body: body(),
    });
    expect(reply.status).toBe(204);
    expect(await c.call("getContext", { root })).toMatchObject({
      selection: expect.objectContaining({
        viewId: "flow",
        presentationId,
        nodes: [{ id: "a", label: "Client" }],
        edges: [],
      }),
    });
  });

  test("a cross-origin POST is refused, an oversized one too, and a stale one is a conflict", async () => {
    const { c, root, page, body } = await presentedFlow();
    const post = (b: string, headers: Record<string, string> = {}) =>
      http(`${apiBase(page)}api/selection`, { method: "POST", headers, body: b });
    // Another origin's write cannot use the browser's cookie: refused before anything is read (ADR 0017).
    expect((await post(body(), { origin: "http://evil.example" })).status).toBe(404);
    expect((await post(body({ pad: "x".repeat(70_000) }))).status).toBe(413);
    expect((await post(body({ presentationId: "old" }))).status).toBe(409);
    expect((await post("{not json")).status).toBe(422);
    const ghost = await post(body({ nodes: [{ id: "ghost" }] }));
    expect([ghost.status, JSON.parse(ghost.body).error.code]).toEqual([422, "invalid_selection"]);
    expect((await c.call("getContext", { root })).selection).toBeNull();
  });

  test("an edit to the presented view retires the selection", async () => {
    const { c, root, page, body } = await presentedFlow();
    const stream = await events(`${apiBase(page)}api/events`);
    expect((await http(`${apiBase(page)}api/selection`, { method: "POST", body: body() })).status).toBe(204);
    write(root, ".archer/flow.mmd", FLOW2);
    await stream.next("presentation");
    expect((await c.call("getContext", { root })).selection).toBeNull();
    stream.close();
  });
});

describe("event streams", () => {
  test("open with a comment, and the 33rd at once is refused with too_many_connections", async () => {
    const { page } = await attached();
    const streams = await Promise.all(Array.from({ length: 32 }, () => events(`${apiBase(page)}api/events`)));
    expect(streams.every((s) => s.status === 200)).toBe(true);
    await expect.poll(() => streams[0]?.comments).toContain("open");
    const refused = await http(`${apiBase(page)}api/events`);
    expect([refused.status, JSON.parse(refused.body).error.code]).toEqual([503, "too_many_connections"]);
    streams[0]?.close();
    await expect.poll(async () => (await events(`${apiBase(page)}api/events`)).status).toBe(200);
    streams.forEach((s) => s.close());
  });
});

describe("ensureService", () => {
  test("starts a detached service when none answers, finds it the second time, and `stop` ends the process", {
    timeout: 30_000,
  }, async () => {
    const state = tempDir("archer-state-");
    // At normal priority (O30): at the lowest priority a heavily loaded host gave the child a tiny
    // share of a core, and it took close to a minute to answer; at normal priority, a few seconds.
    const command = defaultServeCommand();
    expect(existsSync(join(state, "archer.sock"))).toBe(false);
    const first = await ensureService({
      stateDir: state,
      env: isolatedProcessEnv(state, { ARCHER_FORCE_HTTP: "true" }),
      timeoutMs: 20_000,
      command,
    });
    clients.push(first);
    const hello = await first.call("hello", { protocolVersion: 1 });
    expect(hello.homeUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/projects\/\?token=[0-9a-f]{32}$/);
    const pid = Number(readFileSync(join(state, "archer.lock"), "utf8").split(" ")[0]);
    expect(pid).not.toBe(process.pid);

    // The second time it is found, not started: the same process, the same URL.
    const second = await ensureService({ stateDir: state, command: ["false"] });
    clients.push(second);
    expect((await second.call("hello", { protocolVersion: 1 })).homeUrl).toBe(hello.homeUrl);
    expect(Number(readFileSync(join(state, "archer.lock"), "utf8").split(" ")[0])).toBe(pid);

    expect(await first.call("stop", {})).toEqual({ stopping: true });
    await expect.poll(() => processAlive(pid), { timeout: 10_000 }).toBe(false);
    expect(existsSync(join(state, "archer.sock"))).toBe(false);
  });
});

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
