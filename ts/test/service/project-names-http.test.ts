// Readable project names: allocated per root, persisted service-wide; a 0.14 hash slug is no alias (0.15.0).
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { connectService } from "../../src/service/service-client.ts";
import { createHash } from "node:crypto";
import { cleanUp, http, json, service, serviceBase, tempDir, write } from "./support.ts";

afterEach(cleanUp);

function twin(parent: string): string {
  const root = join(parent, "Web Shop");
  mkdirSync(root, { recursive: true });
  write(root, "archer.toml", "version = 1\n");
  write(root, ".archer/notes/a.md", "# A\n");
  return root;
}

test("two roots of one folder name get web-shop and web-shop-2, kept across restarts and re-attach", async () => {
  const state = tempDir("archer-state-");
  const first = twin(tempDir()),
    second = twin(tempDir());
  let { svc } = await service({ stateDir: state });
  let client = await connectService(svc.socketPath);
  try {
    const a = await client.call("attach", { root: first });
    const b = await client.call("attach", { root: second });
    expect(new URL(a.url).pathname).toBe("/projects/web-shop/");
    expect(new URL(b.url).pathname).toBe("/projects/web-shop-2/");
    // Detach the first and re-attach: the name stays with its root, never with the other one.
    await client.call("detach", { root: first });
    expect(new URL((await client.call("attach", { root: first })).url).pathname).toBe("/projects/web-shop/");
  } finally {
    client.close();
  }
  await svc.close();
  ({ svc } = await service({ stateDir: state }));
  client = await connectService(svc.socketPath);
  try {
    const b = await client.call("attach", { root: second });
    expect(new URL(b.url).pathname).toBe("/projects/web-shop-2/");
  } finally {
    client.close();
  }
});

test("the catalog names projects by name; a 0.14 hash slug is no alias", async () => {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  try {
    const root = twin(tempDir());
    await client.call("attach", { root });
    const base = serviceBase(svc.homeUrl);
    const catalog = (await json(`${base}api/projects`)) as { projects: { slug: string; formerSlugs?: string[] }[] };
    expect(catalog.projects).toEqual([expect.objectContaining({ slug: "web-shop" })]);
    expect(catalog.projects[0]).not.toHaveProperty("formerSlugs");
    expect((await http(`${base}p/web-shop/api/diagrams`)).status).toBe(200);
    // The address 0.14 and earlier also accepted: the name and a short hash of the root.
    const hashed = `web-shop-${createHash("sha256").update(root).digest("hex").slice(0, 8)}`;
    expect((await http(`${base}p/${hashed}/api/diagrams`)).status).toBe(404);
    expect((await http(`${base}p/web-shop-zz/api/diagrams`)).status).toBe(404);
  } finally {
    client.close();
  }
});

// A 0.14 machine may hold an attached project with no recorded name (attached before names were kept): its first
// start of 0.15 records one, the readable name, and serves it there. There is no hash-slug fallback to land on.
test("a saved project with no recorded name is named on its first start, once", async () => {
  const root = twin(tempDir());
  const first = await service();
  let client = await connectService(first.svc.socketPath);
  await client.call("attach", { root });
  client.close();
  await first.svc.close();
  rmSync(join(first.state, "project-names.json"));

  const second = await service({ stateDir: first.state });
  client = await connectService(second.svc.socketPath);
  try {
    const deadline = Date.now() + 20_000;
    let listed: readonly { root: string; url: string }[] = [];
    while (Date.now() < deadline) {
      listed = (await client.call("listProjects", {})).projects;
      if (listed.some((project) => project.root === root)) break;
      await new Promise((done) => setTimeout(done, 50));
    }
    expect(listed.map((project) => new URL(project.url).pathname)).toEqual(["/projects/web-shop/"]);
    const recorded = JSON.parse(readFileSync(join(first.state, "project-names.json"), "utf8")) as {
      names: { root: string; name: string }[];
    };
    expect(recorded.names).toEqual([{ root, name: "web-shop" }]);
  } finally {
    client.close();
  }
});
