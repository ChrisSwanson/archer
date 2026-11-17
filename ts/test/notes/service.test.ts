// The note API with embedded diagrams, through a real service over HTTP.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { connectService, type ServiceClient } from "../../src/service/index.ts";
import { cleanUp, http, json, project, service, write, apiBase } from "../service/support.ts";

afterEach(cleanUp);
const clients: ServiceClient[] = [];
afterEach(() => clients.splice(0).forEach((c) => c.close()));

const AUTH = readFileSync(fileURLToPath(new URL("../../../fixtures/notes/auth.md", import.meta.url)), "utf8");

async function attached() {
  const { svc } = await service();
  const c = await connectService(svc.socketPath);
  clients.push(c);
  const root = project();
  write(root, ".archer/notes/auth.md", AUTH);
  const page = apiBase((await c.call("attach", { root })).url);
  return { root, page: page as string };
}

test("a note's content lists its embedded diagrams under their addresses, and its freshness", async () => {
  const { page } = await attached();
  const content = (await json(`${page}api/notes/content?path=${encodeURIComponent("notes/auth.md")}`)) as Record<
    string,
    unknown
  >;
  expect((content["diagrams"] as { address: string }[]).map((d) => d.address)).toEqual([
    "notes/auth.md#login-flow",
    "notes/auth.md#login-flow-2",
    "notes/auth.md#refresh",
    "notes/auth.md#tokens",
    "notes/auth.md#broken",
  ]);
  // The temp project is in no repository.
  expect(content["freshness"]).toEqual({ status: "not-in-git" });
});

test("a note with no diagrams has none listed", async () => {
  const { page, root } = await attached();
  write(root, ".archer/plain.md", "# Plain\n");
  expect(await json(`${page}api/notes/content?path=plain.md`)).not.toHaveProperty("diagrams");
});

test("an embedded diagram by address: its source, its model and its problems at lines of the note", async () => {
  const { page } = await attached();
  const at = (address: string) => `${page}api/notes/diagram?address=${encodeURIComponent(address)}`;
  const ok = (await json(at("notes/auth.md#login-flow"))) as Record<string, unknown>;
  expect(ok).toMatchObject({
    address: "notes/auth.md#login-flow",
    notePath: "notes/auth.md",
    name: "login-flow",
    kind: "freeform",
    line: 11,
    writable: true,
    source: expect.stringContaining("flowchart LR"),
    sourceRevision: expect.stringMatching(/^sha256:/),
    diagnostics: [],
    envelope: { view: { id: "notes/auth.md#login-flow" }, model: { type: "freeform-graph" } },
    freshness: { status: "not-in-git" },
  });
  const broken = (await json(at("notes/auth.md#broken"))) as {
    envelope: unknown;
    diagnostics: { span: { start: { line: number } } }[];
  };
  expect(broken.envelope).toBeNull();
  expect(broken.diagnostics.map((d) => d.span.start.line)).toContain(45);
  for (const address of ["notes/auth.md#nope", "notes/none.md#x", "../x.md#a", "login-flow", ""]) {
    const reply = await http(at(address));
    expect(reply.status, address).toBe(404);
    expect(JSON.parse(reply.body), address).toMatchObject({ error: { code: "diagram_not_found" } });
  }
});
