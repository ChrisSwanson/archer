// Reading the project model: an element, its relationships both ways, and the roll-up worked out
// when read (ADR 0036 §6, O2), never stored.
import { expect, test } from "vitest";
import { ModelLookup } from "../../src/project-model/lookup.ts";
import { mergeProjectModel } from "../../src/project-model/merge.ts";
import { view } from "./support.ts";

const CONTEXT = `C4Context
Person(user, "Shopper")
System(shop, "Shop")
System_Ext(pay, "Payments")
Rel(user, shop, "buys")
`;
const CONTAINERS = `C4Container
Person(user, "Shopper")
System_Boundary(shop, "Shop") {
  Container(web, "Web")
  ContainerDb(db, "DB")
}
System_Ext(pay, "Payments")
Rel(user, web, "uses")
Rel(web, db, "reads")
Rel(web, pay, "charges")
Rel(pay, web, "calls back")
`;

async function lookup(...extra: string[]): Promise<ModelLookup> {
  const views = [await view("ctx", CONTEXT), await view("cnt", CONTAINERS)];
  for (const [i, source] of extra.entries()) views.push(await view(`x${i}`, source));
  return new ModelLookup(mergeProjectModel(views));
}

test("an element's relationships both ways, and its neighbours", async () => {
  const model = await lookup();
  const web = model.relationshipsOf("web");
  expect(web.out.map((r) => r.to)).toEqual(["db", "pay"]);
  expect(web.in.map((r) => r.from)).toEqual(["pay", "user"]);
  expect(model.neighbours("web")).toEqual(["db", "pay", "user"]);
  expect(model.element("nope")).toBeUndefined();
  expect(model.relationshipsOf("nope")).toEqual({ out: [], in: [] });
});

test("roll-up: an edge between the nearest drawn ancestors, unless the view draws one, carrying what it came from", async () => {
  const model = await lookup();
  const derived = model.rollUp("ctx");
  expect(derived.map((d) => `${d.from}>${d.to}`)).toEqual(["pay>shop", "shop>pay"]);
  expect(derived.find((d) => d.from === "shop")!.derivedFrom.map((r) => `${r.from}>${r.to}`)).toEqual(["web>pay"]);
  // user → web rolls up to user → shop, which ctx already draws; web → db stays inside shop.
  expect(derived.some((d) => d.from === "user")).toBe(false);
});

test("roll-up never draws an edge for an element with more than one parent reading (O2)", async () => {
  const model = await lookup(`C4Container\nSystem_Boundary(other, "Other") {\n  Container(web, "Web")\n}\n`);
  expect(model.element("web")!.parents).toHaveLength(2);
  expect(model.rollUp("ctx")).toEqual([]);
});

test("roll-up of a view the model leaves out is empty", async () => {
  const model = await lookup();
  expect(model.rollUp("nowhere")).toEqual([]);
});
