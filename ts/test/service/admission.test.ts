// ADR 0013's admission, enforced: `admission = "any" | "listed"` and a `[[projects]]` entry's
// `admit`. It governs attach and restore (not offline authoring). `listed` needs a matching entry
// that does not deny admission; `admit = false` denies under either mode. The project rules are
// read fresh at each attach; an unreadable configuration admits nothing.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { connectService, type ServiceClient } from "../../src/service/index.ts";
import { cleanUp, project, service, tempDir, write } from "./support.ts";

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

function config(text: string): string {
  return write(tempDir("archer-admission-config-"), "archer.toml", `version = 1\n${text}`);
}
const rule = (root: string, extra = ""): string => `[[projects]]\npath = ${JSON.stringify(root)}\n${extra}\n`;

async function attachOutcome(root: string, configText: string): Promise<string> {
  const { svc } = await service({ port: 0, env: { ARCHER_CONFIG: config(configText) } });
  const client = await connect(svc.socketPath);
  try {
    await client.call("attach", { root });
    return "attached";
  } catch (error) {
    return (error as { error?: { code?: string } }).error?.code ?? String(error);
  }
}

test.each([
  ["any, no entry", "any", false, "", "attached"],
  ["any, entry without admit", "any", true, "", "attached"],
  ["any, entry admit = false", "any", true, "admit = false", "project_not_admitted"],
  ["listed, no entry", "listed", false, "", "project_not_admitted"],
  ["listed, entry without admit", "listed", true, "", "attached"],
  ["listed, entry admit = true", "listed", true, "admit = true", "attached"],
  ["listed, entry admit = false", "listed", true, "admit = false", "project_not_admitted"],
  ["listed, read_only entry still admits", "listed", true, "read_only = true", "attached"],
])("attach with %s", async (_name, admission, listed, extra, expected) => {
  const root = project();
  const text = `[service]\nadmission = "${admission}"\n${listed ? rule(root, extra) : ""}`;
  expect(await attachOutcome(root, text)).toBe(expected);
});

test("a glob entry admits under listed, and the most specific entry decides", async () => {
  const root = project();
  const parent = join(root, "..");
  expect(await attachOutcome(root, `[service]\nadmission = "listed"\n${rule(`${parent}/*`)}`)).toBe("attached");
  expect(
    await attachOutcome(root, `[service]\nadmission = "listed"\n${rule(`${parent}/*`)}${rule(root, "admit = false")}`),
  ).toBe("project_not_admitted");
});

test("the refusal names the rule and how to change it, and nothing is attached", async () => {
  const root = project();
  const { svc } = await service({ port: 0, env: { ARCHER_CONFIG: config(`[service]\nadmission = "listed"\n`) } });
  const client = await connect(svc.socketPath);
  const failure = await client.call("attach", { root }).then(
    () => null,
    (error: unknown) => (error as { error: { code: string; message: string } }).error,
  );
  expect(failure?.code).toBe("project_not_admitted");
  expect(failure?.message).toMatch(/\[\[projects\]\]/);
  expect((await client.call("listProjects", {})).projects).toEqual([]);
});

test("rules are read fresh at each attach, and an unreadable configuration admits nothing", async () => {
  const root = project();
  const path = config("");
  const { svc } = await service({ port: 0, env: { ARCHER_CONFIG: path } });
  const client = await connect(svc.socketPath);
  writeFileSync(path, `version = 1\n${rule(root, "admit = false")}`);
  await expect(client.call("attach", { root })).rejects.toMatchObject({ error: { code: "project_not_admitted" } });
  writeFileSync(path, "version = 1\n[[projects]\n");
  await expect(client.call("attach", { root })).rejects.toMatchObject({ error: { code: "project_not_admitted" } });
  writeFileSync(path, `version = 1\n${rule(root)}`);
  await expect(client.call("attach", { root })).resolves.toMatchObject({ root });
});

test("attaching an already attached project asks again, without detaching it", async () => {
  const root = project();
  const path = config("");
  const { svc } = await service({ port: 0, env: { ARCHER_CONFIG: path } });
  const client = await connect(svc.socketPath);
  await client.call("attach", { root });
  writeFileSync(path, `version = 1\n${rule(root, "admit = false")}`);
  await expect(client.call("attach", { root })).rejects.toMatchObject({ error: { code: "project_not_admitted" } });
  writeFileSync(path, "version = 1\n[[projects]\n");
  await expect(client.call("attach", { root })).rejects.toMatchObject({ error: { code: "project_not_admitted" } });
  // Admission governs attach; the running attachment stays until detach or the next restore.
  expect((await client.call("listProjects", {})).projects.map((p) => p.root)).toEqual([root]);
});

test("restore skips a project whose admission now fails and marks it detached", async () => {
  const root = project(),
    other = project();
  const path = config("");
  const first = await service({ port: 0, env: { ARCHER_CONFIG: path } });
  const client = await connect(first.svc.socketPath);
  await client.call("attach", { root });
  await client.call("attach", { root: other });
  client.close();
  await first.svc.close();

  writeFileSync(path, `version = 1\n${rule(root, "admit = false")}`);
  const lines: string[] = [];
  const second = await service({
    stateDir: first.state,
    port: 0,
    env: { ARCHER_CONFIG: path },
    log: (line) => lines.push(line),
  });
  const fresh = await connect(second.svc.socketPath);
  expect((await fresh.call("listProjects", {})).projects.map((p) => p.root)).toEqual([other]);
  expect(lines.some((line) => line.includes("not admitted") && line.includes(root))).toBe(true);
  fresh.close();
  await second.svc.close();

  // Detached durably: admitting it again does not bring it back on the next start.
  writeFileSync(path, "version = 1\n");
  const third = await service({ stateDir: first.state, port: 0, env: { ARCHER_CONFIG: path } });
  const last = await connect(third.svc.socketPath);
  expect((await last.call("listProjects", {})).projects.map((p) => p.root)).toEqual([other]);
});
