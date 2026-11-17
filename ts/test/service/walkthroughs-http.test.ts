// GET api/walkthroughs?viewId= and the `walkthroughs` event (ADR 0034 §6,
// plan slice 1): the route answers with the file and its resolution; the event
// fires on a sidecar edit and on a recompile that changes a status, and not on
// one that changes none. Nothing the service does writes the sidecar.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { connectService, type ServiceClient } from "../../src/service/index.ts";
import { findProject, revisionOf } from "../../src/project/index.ts";
import { QUIET_MS } from "../../src/service/watch.ts";
import type { OldVersionResponse, WalkthroughsForView } from "../../src/walkthroughs/contract.ts";
import { WalkthroughsStore } from "../../src/walkthroughs/store.ts";
import { apiBase, cleanUp, events, http, json, project, service, write } from "./support.ts";

const clients: ServiceClient[] = [];

afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await cleanUp();
});

const REV = `sha256:${"a".repeat(64)}`;
const PLACE = { viewId: "flow", path: "flow.walkthroughs.json" };
const STORED = {
  id: "ask",
  title: "Asking the API",
  steps: [
    { title: "Ask", kind: "sends" as const, what: "A request.", edges: [{ id: "e1", source: "a", target: "b" }] },
    {
      title: "Answer",
      kind: "does" as const,
      what: "It answers.",
      nodes: [{ kind: "node" as const, id: "b", label: "API" }],
      code: ["src/missing.ts"],
    },
  ],
};

async function attach() {
  const root = project();
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  clients.push(client);
  const attached = await client.call("attach", { root });
  return { root, base: apiBase(attached.url), store: new WalkthroughsStore(findProject(root)) };
}

test("the route answers with the walkthroughs and their resolution", async () => {
  const { root, base, store } = await attach();
  expect(await json(`${base}api/walkthroughs?viewId=flow`)).toEqual({
    schemaVersion: 1,
    viewId: "flow",
    walkthroughs: [],
    resolution: [],
    deadCode: [],
  });
  store.write(PLACE, { walkthrough: STORED, modelRevision: REV, author: "agent" });
  const read = (await json(`${base}api/walkthroughs?viewId=flow`)) as WalkthroughsForView;
  expect(read.walkthroughs).toMatchObject([{ id: "ask", revision: 1 }]);
  expect(read.resolution).toMatchObject([{ id: "ask", status: "current", outOfDate: [], changed: [] }]);
  expect(read.deadCode).toEqual([{ id: "ask", step: 2, ref: "src/missing.ts", reason: "does not exist" }]);
  // A sequence diagram cannot host walkthroughs: it says so, and has none.
  expect(await json(`${base}api/walkthroughs?viewId=chat`)).toMatchObject({
    walkthroughs: [],
    unsupported: expect.stringMatching(/graph diagrams/),
  });

  expect((await http(`${base}api/walkthroughs`)).status).toBe(422);
  const missing = await http(`${base}api/walkthroughs?viewId=nope`);
  expect([missing.status, JSON.parse(missing.body).error.code]).toEqual([404, "diagram_not_found"]);
  expect((await http(`${base}api/walkthroughs/extra?viewId=flow`)).status).toBe(404);

  writeFileSync(join(root, ".archer/flow.walkthroughs.json"), "{ broken");
  const malformed = await http(`${base}api/walkthroughs?viewId=flow`);
  expect([malformed.status, JSON.parse(malformed.body).error.code]).toEqual([409, "malformed_walkthroughs_file"]);
  expect(readFileSync(join(root, ".archer/flow.walkthroughs.json"), "utf8")).toBe("{ broken");
});

test("the event fires on a file edit and on a recompile that changes a status, not on one that changes none", async () => {
  const { root, base, store } = await attach();
  const stream = await events(`${base}api/events`);
  store.write(PLACE, { walkthrough: STORED, modelRevision: REV, author: "agent" });
  expect(await stream.next("walkthroughs")).toEqual({ viewId: "flow" });
  const sidecar = readFileSync(join(root, ".archer/flow.walkthroughs.json"), "utf8");

  // A recompile that leaves every reference as it was: the diagram changed, the walkthrough did not.
  write(root, ".archer/flow.mmd", "flowchart LR\n  a[Client] e1@--> b[API]\n  c[Cache]\n");
  await stream.next("change");
  await expect(stream.next("walkthroughs", QUIET_MS * 4)).rejects.toThrow(/no walkthroughs event/);
  // A timed-out wait stays subscribed and would take the next event: listen afresh (as note-emphasis-http does).
  stream.close();
  const after = await events(`${base}api/events`);

  // The line goes: step 1 is out of date.
  write(root, ".archer/flow.mmd", "flowchart LR\n  a[Client]\n  b[API]\n  c[Cache]\n");
  expect(await after.next("walkthroughs")).toEqual({ viewId: "flow" });
  const read = (await json(`${base}api/walkthroughs?viewId=flow`)) as WalkthroughsForView;
  expect(read.resolution).toMatchObject([{ status: "partly-out-of-date", outOfDate: [1] }]);

  // It comes back: current again, and the file was never rewritten.
  write(root, ".archer/flow.mmd", "flowchart LR\n  a[Client] e1@--> b[API]\n");
  expect(await after.next("walkthroughs")).toEqual({ viewId: "flow" });
  expect(((await json(`${base}api/walkthroughs?viewId=flow`)) as WalkthroughsForView).resolution).toMatchObject([
    { status: "current" },
  ]);
  expect(readFileSync(join(root, ".archer/flow.walkthroughs.json"), "utf8")).toBe(sidecar);
  after.close();
}, 30_000);

// GET api/walkthroughs/old?viewId=&id= (plan slice 7a): the model a walkthrough was written on, from Git.
function gitIn(root: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      ...args,
    ],
    { cwd: root, encoding: "utf8" },
  ).trim();
}

test("the old route answers with the model the walkthrough was written on, and says when Git has none", async () => {
  const { root, base, store } = await attach();
  const old = readFileSync(join(root, ".archer/flow.mmd"), "utf8");
  gitIn(root, "init", "-q");
  gitIn(root, "add", "-A");
  gitIn(root, "commit", "-qm", "one");
  store.write(PLACE, { walkthrough: STORED, modelRevision: revisionOf(Buffer.from(old)), author: "agent" });
  writeFileSync(join(root, ".archer/flow.mmd"), "flowchart LR\n  a[Client]\n  b[API]\n  c[Cache]\n");
  gitIn(root, "add", "-A");
  gitIn(root, "commit", "-qm", "two");
  const found = (await json(`${base}api/walkthroughs/old?viewId=flow&id=ask`)) as OldVersionResponse;
  expect(found).toMatchObject({
    schemaVersion: 1,
    viewId: "flow",
    id: "ask",
    status: "found",
    how: "search",
    envelope: { view: { id: "flow" }, revision: revisionOf(Buffer.from(old)) },
  });
  expect(found.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(found.committedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  expect(found.envelope?.model).toMatchObject({ edges: expect.anything() });

  // A walkthrough written on a model that was never committed.
  store.write(PLACE, {
    walkthrough: { ...STORED, id: "lost" },
    modelRevision: `sha256:${"b".repeat(64)}`,
    author: "agent",
  });
  expect(await json(`${base}api/walkthroughs/old?viewId=flow&id=lost`)).toMatchObject({
    status: "not-in-history",
    reason: "not_found",
  });

  for (const [query, status, code] of [
    ["viewId=flow", 422, "invalid_request"],
    ["id=ask", 422, "invalid_request"],
    ["viewId=nope&id=ask", 404, "diagram_not_found"],
    ["viewId=flow&id=none", 404, "walkthrough_not_found"],
  ] as const) {
    const refused = await http(`${base}api/walkthroughs/old?${query}`);
    expect([refused.status, JSON.parse(refused.body).error.code]).toEqual([status, code]);
  }
});
