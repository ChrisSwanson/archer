import { afterEach, expect, test } from "vitest";
import { connectService, type ServiceClient } from "../../src/service/index.ts";
import { cleanUp, exactly, http, json, project, service, write, apiBase } from "./support.ts";
import { homeRelative } from "../../src/service/project-facts.ts";
const clients: ServiceClient[] = [];
afterEach(async () => {
  clients.splice(0).forEach((c) => c.close());
  await cleanUp();
});
async function setup() {
  const { svc, state } = await service();
  const client = await connectService(svc.socketPath);
  clients.push(client);
  const first = project(),
    second = project(),
    unattached = project();
  // Only the note's description (its first paragraph, bounded) is listed; the body after it is not.
  write(first, ".archer/notes/decision.md", "# Decision\n\nWe chose the ledger.\n\nPRIVATE_NOTE_BODY\n");
  write(first, ".archer/reconciliation-ledger.mmd", "flowchart LR\n  ledger[Settlement quartzneedle]\n");
  write(second, ".archer/reconciliation-ledger.mmd", "flowchart LR\n  ledger[Different obsidianneedle]\n");
  write(first, "outside.mmd", "flowchart LR\n  outside[boundaryneedle]\n");
  write(first, ".archer/.hidden.mmd", "flowchart LR\n  hidden[hiddenneedle]\n");
  const a = await client.call("attach", { root: first }),
    b = await client.call("attach", { root: second });
  return { svc, state, client, first, second, unattached, a, b };
}
test("catalog exposes only attached metadata and existing inventories", async () => {
  const { svc, state, client, first, second, unattached, a, b } = await setup();
  const reply = await http(`${apiBase(a.url)}api/projects`);
  expect(reply.status).toBe(200);
  expect(reply.headers["cache-control"]).toBe("no-store");
  const catalog = JSON.parse(reply.body);
  expect(Object.keys(catalog)).toEqual(["schemaVersion", "thumbnailVersion", "thumbnailFormat", "projects"]);
  expect(catalog.schemaVersion).toBe(1);
  expect(catalog.projects).toHaveLength(2);
  for (const [index, attached] of [a, b].entries()) {
    const entry = catalog.projects[index];
    expect(Object.keys(entry)).toEqual(["slug", "name", "lifecycle", "views", "notes", "facts"]);
    // The project page shows where the project is: only its display form, home-relative when it can be.
    expect(entry.facts.projectFolder).toBe(homeRelative(index === 0 ? first : second));
    expect(entry.lifecycle).toEqual({ state: "active", visibility: "auto" });
    expect(entry.slug).toBe(new URL(attached.url).pathname.split("/").at(-2));
    expect(entry.name).toBe(attached.name);
    expect(entry.views).toEqual(((await json(`${apiBase(attached.url)}api/diagrams`)) as { views: unknown[] }).views);
    expect(entry.notes).toEqual(((await json(`${apiBase(attached.url)}api/notes/all`)) as { notes: unknown[] }).notes);
  }
  expect(catalog.projects[0].notes).toEqual([
    expect.objectContaining({
      path: "notes/decision.md",
      title: "Decision",
      description: "We chose the ledger.",
      descriptionFrom: "derived",
    }),
  ]);
  for (const secret of [
    first,
    second,
    unattached,
    state,
    svc.token,
    svc.socketPath,
    "PRIVATE_NOTE_BODY",
    "boundaryneedle",
    "hiddenneedle",
  ])
    expect(reply.body).not.toContain(secret);
  // An attached project appears once as its display folder; never as an absolute path.
  for (const root of [first, second])
    expect(reply.body.split(JSON.stringify(homeRelative(root)).slice(1, -1)).length - 1).toBe(1);
  expect(await json(`${apiBase(b.url)}api/projects`)).toEqual(catalog);
  await client.call("detach", { root: second });
  expect(((await json(`${apiBase(a.url)}api/projects`)) as { projects: unknown[] }).projects).toHaveLength(1);
  expect((await http(`${apiBase(b.url)}api/projects`)).status).toBe(404);
});
test("catalog preserves authenticated exact GET routing and adds no mutations", async () => {
  const { svc, a } = await setup();
  const uncredentialed = await exactly(`${apiBase(a.url)}api/projects`);
  expect([uncredentialed.status, uncredentialed.body]).toEqual([404, ""]);
  for (const url of [`${apiBase(a.url)}api/projects/extra`, `${apiBase(a.url)}api/projects/`]) {
    const reply = await http(url);
    expect([reply.status, reply.body]).toEqual([404, ""]);
  }
  for (const method of ["POST", "PUT", "DELETE", "HEAD"])
    for (const headers of [{}, { origin: "http://evil.example" }]) {
      const reply = await http(`${apiBase(a.url)}api/projects`, { method, headers });
      expect([method, reply.status, reply.body]).toEqual([method, 404, ""]);
    }
  expect((await exactly(svc.homeUrl)).status).toBe(303);
  expect((await http(`${apiBase(a.url)}api/projects`)).headers["access-control-allow-origin"]).toBeUndefined();
});
test("search matches registered filenames and contents within the requested project and Archer folder", async () => {
  const { a, b } = await setup();
  expect(await json(`${apiBase(a.url)}api/search?q=reconciliation-ledger.mmd`)).toEqual({
    query: "reconciliation-ledger.mmd",
    results: [
      {
        target: "view:reconciliation-ledger",
        title: "reconciliation-ledger",
        where: ["title"],
        matches: [{ field: "path", text: "reconciliation-ledger.mmd" }],
      },
    ],
  });
  expect(await json(`${apiBase(a.url)}api/search?q=ledger.mmd%20quartzneedle`)).toEqual({
    query: "ledger.mmd quartzneedle",
    results: [
      {
        target: "view:reconciliation-ledger",
        title: "reconciliation-ledger",
        where: ["title", "diagram"],
        matches: [
          { field: "path", text: "reconciliation-ledger.mmd" },
          { field: "node", text: "Settlement quartzneedle", elementId: "ledger" },
        ],
      },
    ],
  });
  for (const term of ["obsidianneedle", "boundaryneedle", "hiddenneedle"])
    expect(await json(`${apiBase(a.url)}api/search?q=${term}`)).toEqual({ query: term, results: [] });
  expect(await json(`${apiBase(b.url)}api/search?q=quartzneedle`)).toEqual({ query: "quartzneedle", results: [] });
});

test("search joins an independent registered view ID with source body words", async () => {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  clients.push(client);
  const root = project();
  write(
    root,
    "archer.toml",
    'version = 1\n[[views]]\nid = "settlement-identifier"\nkind = "freeform"\ntitle = "Book records"\nsource = ".archer/accounts.mmd"\n',
  );
  write(root, ".archer/accounts.mmd", "flowchart LR\n  ledger[Quartzneedle balance]\n");
  const attached = await client.call("attach", { root });
  expect(await json(`${apiBase(attached.url)}api/search?q=settlement-identifier%20quartzneedle`)).toEqual({
    query: "settlement-identifier quartzneedle",
    results: [
      {
        target: "view:settlement-identifier",
        title: "Book records",
        where: ["title", "diagram"],
        matches: [
          { field: "path", text: "accounts.mmd" },
          { field: "node", text: "Quartzneedle balance", elementId: "ledger" },
        ],
      },
    ],
  });
});
