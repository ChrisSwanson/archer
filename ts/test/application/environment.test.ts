import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createApplication, type Application } from "../../src/application/index.ts";
import { connectIfRunning, connectService } from "../../src/service/client.ts";
import { cleanUp, http, openPage, project, service, tempDir } from "../service/support.ts";

const apps: Application[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.close();
  await cleanUp();
});

test("shared environment operations start without attaching a project", async () => {
  const { svc } = await service();
  const app = createApplication({ cwd: tempDir(), ensureService: () => connectService(svc.socketPath) });
  apps.push(app);
  const started = await app.call("start_service");
  expect(started.structured).toMatchObject({ running: true, homeUrl: svc.homeUrl });
  expect((await app.call("list_projects")).structured).toEqual({ running: true, projects: [] });
});

test.each([
  ["stop_service", {}, { running: false, stopped: false }],
  ["list_projects", {}, { running: false, projects: [] }],
  ["detach_project", { root: "missing" }, { running: false, detached: false }],
] as const)("%s does not start an absent service", async (name, args, expected) => {
  const cwd = tempDir();
  let starts = 0;
  const app = createApplication({
    cwd,
    findService: async () => null,
    ensureService: async () => {
      starts++;
      throw new Error("unexpected startup");
    },
  });
  apps.push(app);
  expect((await app.call(name, args)).structured).toMatchObject(expected);
  expect(starts).toBe(0);
});

test("attach/list/detach operate on real project state and detach only the named project", async () => {
  const first = project();
  const second = project();
  const firstSource = readFileSync(join(first, ".archer/flow.mmd"), "utf8");
  const { svc } = await service();
  const app = createApplication({ cwd: first, ensureService: () => connectService(svc.socketPath) });
  apps.push(app);
  const firstAnswer = await app.call("attach_project", { root: "." });
  const firstStatus = firstAnswer.structured["project"] as { root: string; url: string };
  expect(firstStatus.root).toBe(first);
  expect((await openPage(firstStatus.url)).status).toBe(200);
  const secondAnswer = await app.call("attach_project", { root: second });
  const secondStatus = secondAnswer.structured["project"] as { root: string; url: string };
  expect(((await app.call("list_projects")).structured["projects"] as { root: string }[]).map((p) => p.root)).toEqual([
    first,
    second,
  ]);
  expect((await app.call("detach_project", { root: "." })).structured).toEqual({
    running: true,
    root: first,
    detached: true,
  });
  expect((await http(firstStatus.url)).status).toBe(404);
  expect(readFileSync(join(first, ".archer/flow.mmd"), "utf8")).toBe(firstSource);
  expect((await openPage(secondStatus.url)).status).toBe(200);
  expect((await app.call("detach_project", { root: "." })).structured["detached"]).toBe(false);
  expect(((await app.call("list_projects")).structured["projects"] as { root: string }[]).map((p) => p.root)).toEqual([
    second,
  ]);
}, 15_000); // a real service: 0.6 s idle, 2.2 s beside the UI and browser jobs; timed out at 5 s on CI

test("stop_service stops the real listener and releases the connection before subsequent offline queries", async () => {
  const { svc } = await service();
  const app = createApplication({
    cwd: tempDir(),
    findService: () => connectIfRunning({ socketPath: svc.socketPath }),
  });
  apps.push(app);
  expect((await app.call("stop_service")).structured).toEqual({ running: false, stopped: true });
  await svc.closed;
  expect(await connectIfRunning({ socketPath: svc.socketPath })).toBeNull();
  expect((await app.call("list_projects")).structured).toEqual({ running: false, projects: [] });
});

test("an invalid attach target refuses before service startup", async () => {
  let starts = 0;
  const app = createApplication({
    cwd: tempDir(),
    ensureService: async () => {
      starts++;
      throw new Error("unexpected startup");
    },
  });
  apps.push(app);
  await expect(app.call("attach_project", { root: "missing" })).rejects.toMatchObject({ data: { code: "io_failure" } });
  expect(starts).toBe(0);
});

test.each([
  ["attach_project", {}],
  ["detach_project", { root: "" }],
  ["attach_project", { root: 4 }],
  ["start_service", { extra: true }],
  ["stop_service", { root: "." }],
  ["list_projects", { extra: true }],
] as const)("%s refuses malformed arguments before acquiring a connection", async (name, args) => {
  let acquired = 0;
  const app = createApplication({
    cwd: tempDir(),
    findService: async () => {
      acquired++;
      return null;
    },
    ensureService: async () => {
      acquired++;
      throw new Error("unexpected startup");
    },
  });
  apps.push(app);
  await expect(app.call(name, args)).rejects.toMatchObject({ data: { code: "invalid_arguments" } });
  expect(acquired).toBe(0);
});

test("attaching a worktree of an attached repository, or a temporary folder, says so; list_projects shows the worktree", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const run = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@invalid", ...args], { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  const main = join(tempDir(), "pageturner");
  mkdirSync(join(main, ".archer"), { recursive: true });
  writeFileSync(join(main, ".archer", "a.md"), "# A\n");
  run(main, "init", "-q", "-b", "main");
  run(main, "add", "-A");
  run(main, "commit", "-q", "-m", "one");
  const worktree = join(tempDir(), "scratchpad", "order-notes");
  run(main, "worktree", "add", "-q", "-b", "demo/order-notes", worktree);
  const { svc } = await service();
  const app = createApplication({ cwd: main, ensureService: () => connectService(svc.socketPath) });
  apps.push(app);
  const first = await app.call("attach_project", { root: "." });
  expect(first.text).not.toMatch(/same repository/);
  const second = await app.call("attach_project", { root: worktree });
  expect(second.text).toContain("Archer is serving 'pageturner' (worktree order-notes, branch demo/order-notes)");
  expect(second.text).toContain(`same repository as 'pageturner', already attached at ${main}`);
  // Every test folder is under the temporary directory.
  expect(second.text).toMatch(/temporary folder/);
  expect(second.structured["notices"]).toHaveLength(2);
  expect((await app.call("list_projects")).text).toContain(
    "pageturner (worktree order-notes, branch demo/order-notes)",
  );
});
