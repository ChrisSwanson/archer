import { afterEach, expect, test } from "vitest";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { connectService, type ServiceClient } from "../../src/service/index.ts";
import { cleanUp, FLOW, http, service, tempDir, write, apiBase } from "./support.ts";
const clients: ServiceClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await cleanUp();
});
async function attach(root: string): Promise<string> {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  clients.push(client);
  return (await client.call("attach", { root })).url;
}
test("default document catalog covers only legacy folder and preserves alias", async () => {
  const root = tempDir();
  write(root, ".archer/a.md", "# Legacy");
  write(root, "docs/a.md", "# Outside");
  const url = await attach(root),
    response = await http(`${apiBase(url)}api/documents`);
  expect(response.status).toBe(200);
  expect(JSON.parse(response.body)).toMatchObject({
    complete: true,
    documents: [{ source: { path: ".archer/a.md" }, legacy: { notePath: "a.md" }, title: "Legacy" }],
  });
  expect((await http(`${apiBase(url)}api/documents/content?path=docs%2Fa.md`)).status).toBe(404);
});
test("expanded catalog/read keeps colliding namespaces distinct without authorizing writes", async () => {
  const root = tempDir();
  write(root, "archer.toml", 'version=1\n[discovery]\nroots=[".archer","docs"]\n');
  write(root, ".archer/docs/a.md", "# Old");
  write(root, "docs/a.md", "# New");
  write(root, "docs/flow.mmd", FLOW);
  const url = await attach(root),
    response = await http(`${apiBase(url)}api/documents`);
  expect(response.status).toBe(200);
  const catalog = JSON.parse(response.body);
  expect(catalog.documents).toHaveLength(3);
  expect(
    catalog.documents.find((entry: { source: { path: string } }) => entry.source.path === "docs/a.md"),
  ).toMatchObject({ capabilities: { comments: false, emphasis: false, sourceWrite: false } });
  const old = await http(`${apiBase(url)}api/documents/content?path=${encodeURIComponent(".archer/docs/a.md")}`);
  const external = await http(`${apiBase(url)}api/documents/content?path=${encodeURIComponent("docs/a.md")}`);
  expect(JSON.parse(old.body)).toMatchObject({ markdown: "# Old" });
  expect(JSON.parse(external.body)).toMatchObject({ markdown: "# New" });
  const diagram = await http(`${apiBase(url)}api/documents/content?path=${encodeURIComponent("docs/flow.mmd")}`);
  expect(JSON.parse(diagram.body).model).not.toBeNull();
  expect((await http(`${apiBase(url)}api/documents/content?path=..%2Foutside.md`)).status).toBe(404);
  expect((await http(`${apiBase(url)}api/documents/content?path=%2Fetc%2Fpasswd`)).status).toBe(404);
});
test("outside symlink and unknown sources never produce content", async () => {
  const root = tempDir(),
    outside = tempDir();
  write(root, ".archer/a.md", "# Inside");
  write(outside, "private.md", "PRIVATE");
  symlinkSync(join(outside, "private.md"), join(root, ".archer/escape.md"));
  const url = await attach(root);
  for (const path of [".archer/escape.md", "missing.md"]) {
    const response = await http(`${apiBase(url)}api/documents/content?path=${encodeURIComponent(path)}`);
    expect(response.status).toBe(404);
    expect(response.body).not.toContain("PRIVATE");
  }
});
