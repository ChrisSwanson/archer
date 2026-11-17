// An exploration shared with the agent (ADR 0036 §14, A8, A10, A11, O1, O10; browser contract routes 2–4):
// present with expand through the management socket, what the page reads, the frames in
// one read, the reader's report back to the agent, a source edited and removed under it, and a restart.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { connectService, type ServiceClient } from "../../src/service/index.ts";
import { encodeExpansions } from "../../../shared/explorations.mts";
import { apiBase, cleanUp, events, http, json, service, tempDir, write } from "./support.ts";

const clients: ServiceClient[] = [];
afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await cleanUp();
});

const TOML = `version = 1
[[views]]
id = "context"
kind = "c4"
title = "Context"
source = ".archer/context.mmd"
[[views]]
id = "containers"
kind = "c4"
title = "Containers"
source = ".archer/containers.mmd"
[[views]]
id = "deploy"
kind = "flowchart"
title = "Deploy"
source = ".archer/deploy.mmd"
`;
const CONTAINERS =
  'C4Container\nPerson(user, "Shopper")\nSystem_Boundary(shop, "Shop") {\n  Container(web, "Web")\n  Container(api, "API")\n}\nRel(user, web, "uses")\nRel(web, api, "calls")\n';
const DEPLOY = "flowchart LR\n  api[API]:::container\n  queue[Jobs]:::container\n  api e1@--> queue\n";
const SHOP = { element: "shop", source: "containers" },
  API = { element: "api", source: "deploy" };

async function attach(stateDir?: string, root = tempDir("archer-proj-")) {
  write(root, "archer.toml", TOML);
  write(
    root,
    ".archer/context.mmd",
    'C4Context\nPerson(user, "Shopper")\nSystem(shop, "Shop")\nRel(user, shop, "buys from")\n',
  );
  write(root, ".archer/containers.mmd", CONTAINERS);
  write(root, ".archer/deploy.mmd", DEPLOY);
  const { svc, state } = await service(stateDir === undefined ? {} : { stateDir });
  const client = await connectService(svc.socketPath);
  clients.push(client);
  const attached = await client.call("attach", { root });
  return {
    root,
    client,
    svc,
    state,
    url: attached.url,
    base: apiBase(attached.url),
    origin: new URL(attached.url).origin,
  };
}

const refusal = async (
  p: Promise<unknown>,
): Promise<{ code: string; message: string; details?: { issues?: { index: number; reason: string }[] } }> => {
  try {
    await p;
  } catch (error) {
    return (
      error as { error: { code: string; message: string; details?: { issues?: { index: number; reason: string }[] } } }
    ).error;
  }
  throw new Error("expected a refusal");
};

test("present with expand: the page reads the stamp and the frames, with the caption as the agent wrote it", async () => {
  const { root, client, base } = await attach();
  const shown = await client.call("present", {
    root,
    viewId: "context",
    annotation: "Where orders go",
    expand: [SHOP, API],
  });
  expect(shown.exploration).toEqual({ generation: expect.any(Number), sources: 2, parts: 3 });
  const bootstrap = (await json(`${base}api/bootstrap`)) as { presentation: Record<string, unknown> };
  expect(bootstrap.presentation).toMatchObject({
    presentationId: shown.presentationId,
    viewId: "context",
    annotation: "Where orders go",
    exploration: shown.exploration,
  });
  expect(bootstrap.presentation).not.toHaveProperty("expand");
  // Route 3: every frame in one read, revalidated.
  const url = `${base}api/exploration?viewId=context&presentationId=${shown.presentationId}`;
  const first = await http(url);
  expect(first.status).toBe(200);
  const answer = JSON.parse(first.body);
  expect(answer).toMatchObject({
    origin: "presentation",
    presentationId: shown.presentationId,
    generation: shown.exploration!.generation,
    counts: { sources: 2, boxes: 3 },
  });
  expect(answer.frames.map((f: { source: string }) => f.source)).toEqual(["containers", "deploy"]);
  expect(
    answer.expansions.items.map((i: { status: string; piece?: { source: string } }) => [i.status, i.piece?.source]),
  ).toEqual([
    ["added", "containers"],
    ["added", "deploy"],
  ]);
  expect((await http(url, { headers: { "if-none-match": first.headers["etag"] as string } })).status).toBe(304);
  // An old presentation id is not served.
  expect((await http(`${base}api/exploration?viewId=context&presentationId=present-000000000000`)).status).toBe(404);
  // The agent reads what it presented.
  const context = await client.call("getContext", { root });
  expect(context.exploration).toMatchObject({
    origin: "presentation",
    viewId: "context",
    expand: [SHOP, API],
    frames: [
      { source: "containers", touches: ["shop"] },
      { source: "deploy", touches: ["api"] },
    ],
  });
});

test("a bad expand refuses the call whole and changes nothing; present without expand is unchanged", async () => {
  const { root, client, base } = await attach();
  const plain = await client.call("present", { root, viewId: "context" });
  expect(plain).not.toHaveProperty("exploration");
  const before = await json(`${base}api/bootstrap`);
  expect((before as { presentation: object }).presentation).not.toHaveProperty("exploration");
  const refused = await refusal(
    client.call("present", {
      root,
      viewId: "context",
      annotation: "x",
      expand: [API, { element: "ghost", source: "containers" }, { element: "shop", source: "context" }],
    }),
  );
  expect(refused.code).toBe("invalid_expand");
  expect(refused.details?.issues?.map((i) => [i.index, i.reason])).toEqual([
    [0, "element_not_on_canvas"],
    [1, "element_unknown"],
    [2, "source_is_base"],
  ]);
  expect(await json(`${base}api/bootstrap`)).toEqual(before);
  expect(
    (
      await refusal(
        client.call("present", { root, viewId: "context", expand: [SHOP], walkthrough: { id: "w", step: 1 } }),
      )
    ).code,
  ).toBe("invalid_params");
});

test("route 2: a link's list is replayed best-effort, each drop with its reason", async () => {
  const { base } = await attach();
  const answer = (await json(
    `${base}api/exploration?viewId=context&expand=${encodeExpansions([SHOP, { element: "shop", source: "nowhere" }, API])}`,
  )) as { origin: string; expansions: { items: { status: string; reason?: string }[] }; counts: { sources: number } };
  expect(answer.origin).toBe("link");
  expect(answer.expansions.items.map((i) => i.reason ?? i.status)).toEqual(["added", "source_unknown", "added"]);
  expect(answer.counts.sources).toBe(2);
  expect((await http(`${base}api/exploration?viewId=context&expand=%21`)).status).toBe(422);
  expect((await http(`${base}api/exploration?viewId=nope&expand=`)).status).toBe(404);
});

test("the reader's own additions and frame selection reach the agent (O1, A10); a later present takes over", async () => {
  const { root, client, base, origin } = await attach();
  const shown = await client.call("present", { root, viewId: "context", expand: [SHOP] });
  const revision = (await client.call("getModel", { root, viewId: "context" })).envelope!.revision;
  const post = (body: unknown, headers: Record<string, string> = { origin }) =>
    http(`${base}api/reader-exploration`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  expect(
    (
      await post({
        viewId: "context",
        revision,
        expand: [SHOP, API],
        selection: [
          { source: "deploy", kind: "node", id: "queue" },
          { source: "deploy", kind: "node", id: "nope" },
        ],
      })
    ).status,
  ).toBe(204);
  const context = await client.call("getContext", { root });
  expect(context.exploration).toMatchObject({
    origin: "reader",
    expand: [SHOP, API],
    selection: [{ source: "deploy", kind: "node", id: "queue", label: "Jobs" }],
  });
  // Nothing another page shows changes: the presentation is the agent's.
  expect(
    (
      (await json(`${base}api/bootstrap`)) as {
        presentation: { presentationId: string; exploration: { sources: number } };
      }
    ).presentation,
  ).toMatchObject({ presentationId: shown.presentationId, exploration: { sources: 1 } });
  // Refusals: another origin (the owner's cookie admits no write from it: the bare 404), a stale revision, a malformed body.
  expect((await post({ viewId: "context", revision, expand: [] }, { origin: "http://elsewhere.example" })).status).toBe(
    404,
  );
  expect((await post({ viewId: "context", revision: `sha256:${"1".repeat(64)}`, expand: [] })).status).toBe(422);
  expect((await post({ viewId: "context", revision, expand: [{ element: "shop" }] })).status).toBe(422);
  await client.call("present", { root, viewId: "context", expand: [API, SHOP].slice(1) });
  expect((await client.call("getContext", { root })).exploration).toMatchObject({ origin: "presentation" });
  // An empty report after that is the reader clearing their own: nothing is reported.
  expect((await post({ viewId: "context", revision, expand: [] })).status).toBe(204);
  expect((await client.call("getContext", { root })).exploration).toBeUndefined();
});

test("a source edited and a source removed under a presented exploration: refreshed, then dropped with a line", async () => {
  const { root, client, base } = await attach();
  const stream = await events(`${base}api/events`);
  try {
    const shown = await client.call("present", { root, viewId: "context", expand: [SHOP, API] });
    const g0 = shown.exploration!.generation;
    await stream.next("presentation");
    write(
      root,
      ".archer/deploy.mmd",
      "flowchart LR\n  api[API]:::container\n  queue[Jobs]:::container\n  cache[Cache]:::container\n  api e1@--> queue\n  api e2@--> cache\n",
    );
    const edited = (await stream.next("presentation")) as {
      presentation: { exploration: { generation: number; parts: number } };
    };
    expect(edited.presentation.exploration.generation).toBeGreaterThan(g0);
    expect(edited.presentation.exploration.parts).toBe(4);
    rmSync(join(root, ".archer/deploy.mmd"));
    const removed = (await stream.next("presentation")) as {
      presentation: { presentationId: string; exploration: { generation: number; sources: number } };
    };
    expect(removed.presentation.exploration).toMatchObject({ sources: 1 });
    expect(removed.presentation.exploration.generation).toBeGreaterThan(edited.presentation.exploration.generation);
    const frames = (await json(`${base}api/exploration?viewId=context&presentationId=${shown.presentationId}`)) as {
      frames: { source: string }[];
      notices: string[];
    };
    expect(frames.frames.map((f) => f.source)).toEqual(["containers"]);
    expect(frames.notices).toEqual(["deploy was removed, so its frame is gone"]);
    expect((await client.call("getContext", { root })).exploration).toMatchObject({
      expand: [SHOP],
      notices: ["deploy was removed, so its frame is gone"],
    });
  } finally {
    stream.close();
  }
});

// codex-12-01 (O254): a neighbour entry keeps its neighbour through a present, a reader's report, a link and a restart.
test("a neighbour entry's neighbour travels with the exploration (P41)", async () => {
  const first = await attach();
  const QUEUE = { element: "api", source: "deploy", neighbour: "queue" };
  const shown = await first.client.call("present", { root: first.root, viewId: "context", expand: [SHOP, QUEUE] });
  expect(shown.exploration).toMatchObject({ sources: 2 });
  const revision = (await first.client.call("getModel", { root: first.root, viewId: "context" })).envelope!.revision;
  const post = (body: unknown) =>
    http(`${first.base}api/reader-exploration`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: first.origin },
      body: JSON.stringify(body),
    });
  expect((await post({ viewId: "context", revision, expand: [SHOP, QUEUE] })).status).toBe(204);
  expect((await first.client.call("getContext", { root: first.root })).exploration).toMatchObject({
    origin: "reader",
    expand: [SHOP, QUEUE],
  });
  const link = (await json(
    `${first.base}api/exploration?viewId=context&expand=${encodeExpansions([SHOP, QUEUE])}`,
  )) as { expansions: { items: { neighbour?: string; status: string }[] } };
  expect(link.expansions.items.map((i) => [i.neighbour, i.status])).toEqual([
    [undefined, "added"],
    ["queue", "added"],
  ]);
  await first.client.call("present", { root: first.root, viewId: "context", expand: [SHOP, QUEUE] });
  first.client.close();
  await first.svc.close();
  const { svc } = await service({ stateDir: first.state });
  const fresh = await connectService(svc.socketPath);
  clients.push(fresh);
  expect((await fresh.call("getContext", { root: first.root })).exploration).toMatchObject({
    origin: "presentation",
    expand: [SHOP, QUEUE],
  });
});

test("a presented exploration survives a service restart (A11)", async () => {
  const first = await attach();
  const shown = await first.client.call("present", { root: first.root, viewId: "context", expand: [SHOP, API] });
  const before = await first.client.call("getContext", { root: first.root });
  expect(before.exploration).toMatchObject({ origin: "presentation", expand: [SHOP, API] });
  first.client.close();
  await first.svc.close();
  const { svc } = await service({ stateDir: first.state });
  const fresh = await connectService(svc.socketPath);
  clients.push(fresh);
  expect((await fresh.call("getContext", { root: first.root })).exploration).toEqual(before.exploration);
  const attached = await fresh.call("attach", { root: first.root });
  const bootstrap = (await json(`${apiBase(attached.url)}api/bootstrap`)) as {
    presentation: { presentationId: string; exploration: unknown };
  };
  expect(bootstrap.presentation).toMatchObject({
    presentationId: shown.presentationId,
    exploration: shown.exploration,
  });
  const frames = (await json(
    `${apiBase(attached.url)}api/exploration?viewId=context&presentationId=${shown.presentationId}`,
  )) as { frames: unknown[] };
  expect(frames.frames).toHaveLength(2);
});
