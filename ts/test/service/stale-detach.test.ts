import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, expect, test } from "vitest";
import { connectService, type ServiceClient } from "../../src/service/index.ts";
import { cleanUp, http, project, service, tempDir, write } from "./support.ts";

const clients: ServiceClient[] = [];
afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await cleanUp();
});

async function connect(socketPath: string): Promise<ServiceClient> {
  const client = await connectService(socketPath);
  clients.push(client);
  return client;
}

test("detaches a known missing root durably without touching another project's files", async () => {
  const root = project(),
    other = project();
  const untouched = readFileSync(join(other, ".archer", "flow.mmd"));
  const first = await service({ port: 0 });
  const client = await connect(first.svc.socketPath);
  const attached = await client.call("attach", { root });
  await client.call("attach", { root: other });
  rmSync(root, { recursive: true });

  expect(await client.call("detach", { root })).toEqual({ detached: true });
  expect(await client.call("detach", { root })).toEqual({ detached: false });
  expect((await http(attached.url)).status).toBe(404);
  expect((await client.call("listProjects", {})).projects.map((p) => p.root)).toEqual([other]);
  expect(readFileSync(join(other, ".archer", "flow.mmd"))).toEqual(untouched);

  client.close();
  await first.svc.close();
  // Recreate the original source: absence after restart must come from the durable
  // detach flag, rather than recovery merely skipping a still-missing directory.
  write(root, ".archer/flow.mmd", "flowchart LR\n a[Restored]\n");
  const second = await service({ stateDir: first.state, port: 0 });
  const fresh = await connect(second.svc.socketPath);
  expect((await fresh.call("listProjects", {})).projects.map((p) => p.root)).toEqual([other]);
  expect(readFileSync(join(other, ".archer", "flow.mmd"))).toEqual(untouched);
});

test("an exact attached root wins over a newly introduced ancestor project", async () => {
  const parent = tempDir(),
    root = join(parent, "child");
  mkdirSync(root);
  const { svc } = await service({ port: 0 });
  const client = await connect(svc.socketPath);
  await client.call("attach", { root });
  write(parent, "archer.toml", 'version = 1\nname = "Ancestor"\n');
  await client.call("attach", { root: parent });

  expect(await client.call("detach", { root })).toEqual({ detached: true });
  expect((await client.call("listProjects", {})).projects.map((p) => p.root)).toEqual([parent]);
  expect(existsSync(join(parent, "archer.toml"))).toBe(true);
  expect(existsSync(root)).toBe(true);
});

test("a new nested project does not detach the attached ancestor", async () => {
  const root = project(),
    nested = join(root, "nested");
  const { svc } = await service({ port: 0 });
  const client = await connect(svc.socketPath);
  await client.call("attach", { root });
  write(nested, "archer.toml", 'version = 1\nname = "Nested"\n');

  expect(await client.call("detach", { root: nested })).toEqual({ detached: false });
  expect((await client.call("listProjects", {})).projects.map((p) => p.root)).toEqual([root]);
  await client.call("attach", { root: nested });
  expect(await client.call("detach", { root: nested })).toEqual({ detached: true });
  expect((await client.call("listProjects", {})).projects.map((p) => p.root)).toEqual([root]);
});

test.each(["canonical", "relative", "symlink", "inside"] as const)(
  "keeps live-root resolution for %s input",
  async (kind) => {
    const root = project();
    const { svc } = await service({ port: 0 });
    const client = await connect(svc.socketPath);
    await client.call("attach", { root });
    const link = join(tempDir(), "linked-project");
    symlinkSync(root, link, "dir");
    const input = {
      canonical: root,
      relative: relative(process.cwd(), root),
      symlink: link,
      inside: join(root, ".archer"),
    }[kind];

    expect(await client.call("detach", { root: input })).toEqual({ detached: true });
    expect((await client.call("listProjects", {})).projects).toEqual([]);
    expect(existsSync(join(root, ".archer", "flow.mmd"))).toBe(true);
  },
);
