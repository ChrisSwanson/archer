import { afterEach, expect, test } from "vitest";
import { appendFileSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connectService, type ServiceClient } from "../../src/service/index.ts";
import { cleanUp, http, project, service, write, apiBase } from "./support.ts";
import { git } from "../accuracy/support.ts";

const clients: ServiceClient[] = [];
afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await cleanUp();
});

async function catalog(root: string) {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  clients.push(client);
  const attached = await client.call("attach", { root });
  const response = await http(`${apiBase(attached.url)}api/projects`);
  expect(response.status).toBe(200);
  return (JSON.parse(response.body) as { projects: { slug: string; description?: string }[] }).projects;
}

function allowReadme(root: string): void {
  if (!readFileSync(join(root, "archer.toml"), "utf8").includes("[discovery]"))
    appendFileSync(join(root, "archer.toml"), '\n[discovery]\nroots = [".archer", "README.md"]\n');
}

test("the root README is summarized by default and omitted only when an exclusion names it", async () => {
  const root = project();
  write(root, "README.md", "# Root notes\n\nThe default discovery scope admits this README.\n");
  expect((await catalog(root))[0]?.description).toBe("The default discovery scope admits this README.");
  const excluded = project();
  write(excluded, "README.md", "# Private root notes\n\nExcluded prose.\n");
  appendFileSync(join(excluded, "archer.toml"), '\n[discovery]\nexclude = ["README.md"]\n');
  expect((await catalog(excluded))[0]).not.toHaveProperty("description");
});

test("catalog derives the README introduction before a later H2", async () => {
  const root = project();
  allowReadme(root);
  write(
    root,
    "README.md",
    "# Sample\n\nThe ledger tracks settlement batches for the finance team.\n\n## Install\n\nInstall steps should not win.\n",
  );
  const [entry] = await catalog(root);
  expect(entry).toMatchObject({
    slug: expect.any(String),
    description: "The ledger tracks settlement batches for the finance team.",
  });
});

test("catalog can summarize prose without any H2 heading", async () => {
  const root = project();
  allowReadme(root);
  write(root, "README.md", "# Sample\n\nThis project maps the billing workflow.\n");
  expect((await catalog(root))[0]?.description).toBe("This project maps the billing workflow.");
});

test("when the introduction has no prose, catalog falls back to the first H2 section", async () => {
  const root = project();
  allowReadme(root);
  write(
    root,
    "README.md",
    "# Sample\n\n## Overview\n\nThe ledger tracks settlement batches.\n\n## Details\n\nLater prose should not win.\n",
  );
  expect((await catalog(root))[0]?.description).toBe("The ledger tracks settlement batches.");
});

test("catalog omits descriptions for missing, oversized, and externally linked READMEs", async () => {
  const missing = project();
  const oversized = project();
  writeFileSync(join(oversized, "README.md"), `## Overview\n\n${"x".repeat(1024 * 1024 + 1)}`);
  const invalidUtf8 = project();
  writeFileSync(
    join(invalidUtf8, "README.md"),
    Buffer.from([0x23, 0x23, 0x20, 0x4f, 0x76, 0x65, 0x72, 0x76, 0x69, 0x65, 0x77, 0x0a, 0x0a, 0xff]),
  );
  const linked = project();
  const outside = write(project(), "README.md", "## Overview\n\nExternal private prose must not be read.");
  symlinkSync(outside, join(linked, "README.md"));

  for (const root of [missing, oversized, invalidUtf8, linked]) {
    allowReadme(root);
    const [entry] = await catalog(root);
    expect(entry).not.toHaveProperty("description");
  }
});

type Entry = { readme?: unknown; facts?: Record<string, unknown> };
async function browserCatalog(root: string): Promise<() => Promise<Entry>> {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  clients.push(client);
  const attached = await client.call("attach", { root });
  return async () => {
    const response = await http(`${apiBase(attached.url)}api/browser-projects`);
    expect(response.status).toBe(200);
    return (JSON.parse(response.body) as { projects: Entry[] }).projects[0]!;
  };
}

test("the catalog names the root README and the project page's title facts", async () => {
  const root = project();
  write(root, "README.md", "# Sample\n\nAbout the sample.\n");
  write(root, ".archer/notes/a.md", "---\nauthor: agent\n---\n# A\n\nNote.\n");
  const read = await browserCatalog(root);
  const entry = await read();
  expect(entry.readme).toEqual({ path: "README.md" });
  expect(entry.facts).toMatchObject({
    diagrams: 2,
    notes: 1,
    openThreads: 0,
    lastEditedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    projectFolder: expect.any(String),
  });
  expect(entry.facts).not.toHaveProperty("git");
});

test("a project without a root README has no readme field", async () => {
  const read = await browserCatalog(project());
  expect(await read()).not.toHaveProperty("readme");
});

test("in a Git checkout the facts gain the branch and short commit once Git has answered", async () => {
  const root = project();
  git(root, "init", "-q", "-b", "trunk");
  git(root, "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "first");
  const short = git(root, "rev-parse", "--short", "HEAD");
  const read = await browserCatalog(root);
  await expect
    .poll(async () => (await read()).facts?.["git"], { timeout: 10_000 })
    .toEqual({ branch: "trunk", commit: short });
}, 15_000);
