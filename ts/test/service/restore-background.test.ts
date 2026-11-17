// A start answers `hello` before it opens saved projects (server review S2). Opening compiles
// every diagram; a client gives a starting service 15 s to answer, so one slow file, or many
// projects, made every auto-start fail. Now the socket answers at once, projects open in the
// background, and a request naming one still opening waits a moment, then answers project_loading.

import { afterEach, expect, test } from "vitest";
import { connectService, type ServiceCallError } from "../../src/service/service-client.ts";
import { cleanUp, http, project, service, slugOf, write, serviceBase } from "./support.ts";

afterEach(cleanUp);

// Linear but slow in Mermaid (a config copy per statement): about 12 s in one thread. Each test writes it once the
// first service, there only to save the projects, has stopped: written before, that attach compiled it to its budget
// too, seconds of setup no assertion reads. The restore under test opens the projects from disk and meets it all
// the same.
const SLOW = `sequenceDiagram\n  participant a\n${"loop l\n  a->>a: x\nend\n".repeat(8000)}`;

test("many projects and one slow file: hello answers at once, the rest open in the background", async () => {
  const roots = Array.from({ length: 12 }, () => project());
  const slowRoot = roots[0]!;
  const options = { compileInWorkers: true, compileBudgetMs: 8_000 } as const;
  const first = await service(options);
  const setup = await connectService(first.svc.socketPath);
  const slugs = new Map<string, string>();
  for (const root of roots) slugs.set(root, slugOf((await setup.call("attach", { root })).url));
  setup.close();
  await first.svc.close();
  write(slowRoot, ".archer/diagrams/slow.mmd", SLOW);

  const started = performance.now();
  const second = await service({ ...options, stateDir: first.state });
  const client = await connectService(second.svc.socketPath);
  try {
    expect(
      (
        await client.call("hello", {
          protocolVersion: (await import("../../src/service/protocol.ts")).PROTOCOL_VERSION,
        })
      ).serviceName,
    ).toBe("default");
    expect(performance.now() - started).toBeLessThan(4_000);
    // The HTTP side answers meanwhile.
    expect((await http(`${serviceBase(second.svc.homeUrl)}api/connection`)).status).toBe(200);
    // A project still opening answers "loading" over HTTP, not 404.
    const early = await http(`${serviceBase(second.svc.homeUrl)}p/${slugs.get(slowRoot)}/api/diagrams`);
    if (early.status !== 200) {
      expect(early.status).toBe(503);
      expect(early.headers["retry-after"]).toBe("1");
      expect(JSON.parse(early.body).error.code).toBe("project_loading");
    }
    // A request for the slow project waits a moment, then answers project_loading, or the project once open.
    try {
      await client.call("getModel", { root: slowRoot, viewId: "flow" });
    } catch (failure) {
      expect((failure as ServiceCallError).error.code).toBe("project_loading");
    }
    // Every saved project is listed at once, with the URL it keeps once open.
    const listed = (await client.call("listProjects", {})).projects;
    expect(listed.map((p) => p.root).sort()).toEqual([...roots].sort());
    expect(listed.map((p) => slugOf(p.url)).sort()).toEqual([...slugs.values()].sort());
    // The slow project opens, its slow view refused at the compile budget.
    let model: unknown = null;
    for (let tries = 0; tries < 10 && model === null; tries++) {
      model = await client.call("getModel", { root: slowRoot, viewId: "flow" }).then(
        (r) => r.envelope,
        () => null,
      );
    }
    expect(model).not.toBeNull();
  } finally {
    client.close();
  }
}, 120_000);

test("a detach while the project is still opening holds: it is not registered when the open finishes", async () => {
  const root = project();
  const options = { compileInWorkers: true, compileBudgetMs: 4_000 } as const;
  const first = await service(options);
  const setup = await connectService(first.svc.socketPath);
  await setup.call("attach", { root });
  setup.close();
  await first.svc.close();
  write(root, ".archer/diagrams/slow.mmd", SLOW);

  const second = await service({ ...options, stateDir: first.state });
  const client = await connectService(second.svc.socketPath);
  try {
    expect((await client.call("listProjects", {})).projects.map((p) => p.root)).toEqual([root]);
    expect(await client.call("detach", { root })).toEqual({ detached: true });
    expect((await client.call("listProjects", {})).projects).toEqual([]);
    // Past the open (the slow view's budget): still detached.
    await new Promise((done) => setTimeout(done, 6_000));
    expect((await client.call("listProjects", {})).projects).toEqual([]);
    await expect(client.call("getModel", { root, viewId: "flow" })).rejects.toMatchObject({
      error: { code: "project_not_attached" },
    });
  } finally {
    client.close();
  }
  await second.svc.close();
  // And durably: the next start does not restore it.
  const third = await service({ ...options, stateDir: first.state });
  const again = await connectService(third.svc.socketPath);
  try {
    expect((await again.call("listProjects", {})).projects).toEqual([]);
  } finally {
    again.close();
  }
}, 120_000);

test("a stop during the restore takes no further projects, and the opens under way stay in the workers", async () => {
  const roots = Array.from({ length: 8 }, () => project());
  const options = { compileInWorkers: true, compileBudgetMs: 1_500 } as const;
  const first = await service(options);
  const setup = await connectService(first.svc.socketPath);
  for (const root of roots) await setup.call("attach", { root });
  setup.close();
  await first.svc.close();
  for (const root of roots) write(root, ".archer/diagrams/slow.mmd", SLOW);

  const logs: string[] = [];
  const second = await service({ ...options, stateDir: first.state, log: (line) => logs.push(line) });
  const started = performance.now();
  await second.svc.close();
  // Four lanes' opens at most, each slow view stopped at its budget; never the other four, nor a compile in this thread.
  expect(performance.now() - started).toBeLessThan(30_000);
  expect(logs.filter((line) => line.includes("recovery:"))).toEqual([]);
  // Nothing goes on compiling after the stop: the event loop stays free.
  let last = performance.now(),
    worst = 0;
  const ticker = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 20);
  await new Promise((done) => setTimeout(done, 4_000));
  clearInterval(ticker);
  expect(worst).toBeLessThan(1_000);
}, 180_000);
