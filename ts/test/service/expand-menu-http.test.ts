// GET api/expand-menu (ADR 0036 §11–§13, A8, A9; browser contract route 1): the capability, the credential a
// diagram read takes, one snapshot's answer revalidated by a weak ETag, and the refusals.
import { afterEach, expect, test } from "vitest";
import { connectService, type ServiceClient } from "../../src/service/index.ts";
import { encodeExpansions } from "../../../shared/explorations.mts";
import { apiBase, cleanUp, exactly, http, json, service, tempDir, write } from "./support.ts";

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
`;

async function attach() {
  const root = tempDir("archer-proj-");
  write(root, "archer.toml", TOML);
  write(
    root,
    ".archer/context.mmd",
    'C4Context\nPerson(user, "Shopper")\nSystem(shop, "Shop")\nRel(user, shop, "buys from")\n',
  );
  write(
    root,
    ".archer/containers.mmd",
    'C4Container\nPerson(user, "Shopper")\nSystem_Boundary(shop, "Shop") {\n  Container(web, "Web")\n  Container(api, "API")\n}\nRel(user, web, "uses")\nRel(web, api, "calls")\n',
  );
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  clients.push(client);
  const attached = await client.call("attach", { root });
  return { root, base: apiBase(attached.url) };
}

test("the connection names the explorations capability", async () => {
  const { base } = await attach();
  expect(await json(`${base}api/connection`)).toMatchObject({
    browserProtocolMajor: 1,
    capabilities: expect.arrayContaining(["heartbeat", "explorations"]),
  });
});

test("the menu for an element: its entries with pieces, revalidated by a weak ETag", async () => {
  const { base } = await attach();
  const url = `${base}api/expand-menu?viewId=context&element=shop`;
  const first = await http(url, { headers: { "accept-encoding": "identity" } });
  expect(first.status).toBe(200);
  expect(first.headers["cache-control"]).toBe("no-store");
  const etag = first.headers["etag"] as string;
  expect(etag).toMatch(/^W\/"[0-9a-f]{32}"$/);
  const menu = JSON.parse(first.body);
  expect(menu).toMatchObject({
    schemaVersion: 1,
    viewId: "context",
    element: { id: "shop", name: "Shop" },
    canvas: [],
    limits: { maxAddedSources: 5, maxAddedBoxes: 60 },
  });
  expect(menu.diagrams.items).toMatchObject([
    {
      source: "containers",
      title: "Containers",
      relation: "opens",
      adds: { boxes: 2 },
      piece: { opens: true, touches: "shop" },
    },
  ]);
  expect((await http(url, { headers: { "if-none-match": etag } })).status).toBe(304);
  // With the frame on the canvas, the same entry is not offered again.
  const grown = (await json(
    `${base}api/expand-menu?viewId=context&element=shop&expand=${encodeExpansions([{ element: "shop", source: "containers" }])}`,
  )) as { diagrams: { items: unknown[] }; canvas: unknown[] };
  expect(grown.canvas).toEqual([{ element: "shop", source: "containers" }]);
  expect(grown.diagrams.items).toEqual([]);
});

test("an id that is no element is an empty 200; a missing view, a bad request or a bad expand are refused", async () => {
  const { base } = await attach();
  expect(await json(`${base}api/expand-menu?viewId=context&element=nothing`)).toMatchObject({
    element: null,
    diagrams: { items: [] },
  });
  const missing = await http(`${base}api/expand-menu?viewId=nope&element=shop`);
  expect([missing.status, JSON.parse(missing.body).error.code]).toEqual([404, "diagram_not_found"]);
  expect((await http(`${base}api/expand-menu?viewId=context`)).status).toBe(422);
  const bad = await http(`${base}api/expand-menu?viewId=context&element=shop&expand=%21%21`);
  expect([bad.status, JSON.parse(bad.body).error.code]).toEqual([422, "invalid_expand"]);
  const long = await http(`${base}api/expand-menu?viewId=context&element=shop&expand=${"A".repeat(5000)}`);
  expect([long.status, JSON.parse(long.body).error.code]).toEqual([422, "expand_param_too_long"]);
});

test("without a credential it is the bare 404, as every route", async () => {
  const { base } = await attach();
  const wrong = await exactly(`${base}api/expand-menu?viewId=context&element=shop`);
  expect(wrong.status).toBe(404);
  expect(wrong.body).toBe("");
});
