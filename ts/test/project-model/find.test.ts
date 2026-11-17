// find_elements' matching over the project model (ADR 0036 §8, A3, O2): trigram similarity over the
// id, every label and C4 technology, a short synonym list, prefix matching under 3 characters,
// exact filters, and kinds and parents as lists.
import { expect, test } from "vitest";
import { findElements } from "../../src/project-model/find.ts";
import { ModelLookup } from "../../src/project-model/lookup.ts";
import { mergeProjectModel } from "../../src/project-model/merge.ts";
import { view } from "./support.ts";

const CONTAINERS = `C4Container
Person(shopper, "Shopper")
System_Boundary(shop, "Web Shop") {
  Container(webApp, "Storefront", "React")
  ContainerDb(ordersDb, "Orders", "PostgreSQL")
  Container(worker, "Fulfilment Worker", "Kubernetes job")
}
Rel(shopper, webApp, "browses")
Rel(webApp, ordersDb, "reads")
Rel(worker, ordersDb, "updates")
`;
const COMPONENTS = `C4Component
Container_Boundary(webApp, "Storefront") {
  Component(cart, "Cart")
}
`;
const ADMIN = `C4Component
Container_Boundary(admin, "Admin") {
  Component(cart, "Cart")
}
`;

async function lookup(): Promise<ModelLookup> {
  return new ModelLookup(
    mergeProjectModel([
      await view("containers", CONTAINERS),
      await view("components", COMPONENTS),
      await view("admin", ADMIN),
    ]),
  );
}
const hitIds = (found: { elements: readonly { id: string }[] }): string[] => found.elements.map((e) => e.id);

test("a query matches ids split into words, labels and technology, typo- and order-tolerant", async () => {
  const model = await lookup();
  expect(hitIds(findElements(model, { query: "orders db" }))[0]).toBe("ordersDb");
  expect(hitIds(findElements(model, { query: "fulfillment worker" }))[0]).toBe("worker");
  expect(hitIds(findElements(model, { query: "shop web" }))[0]).toBe("shop");
  const react = findElements(model, { query: "react" }).elements[0]!;
  expect(react).toMatchObject({ id: "webApp", matched: "technology" });
});

test("built-in synonyms: database finds a db id, postgres a PostgreSQL technology, k8s Kubernetes", async () => {
  const model = await lookup();
  expect(findElements(model, { query: "orders database" }).elements[0]).toMatchObject({
    id: "ordersDb",
    matched: "synonym",
  });
  expect(hitIds(findElements(model, { query: "postgres" }))[0]).toBe("ordersDb");
  expect(hitIds(findElements(model, { query: "k8s" }))[0]).toBe("worker");
});

test("a query under 3 characters matches by prefix", async () => {
  const model = await lookup();
  expect(hitIds(findElements(model, { query: "or" }))).toEqual(["ordersDb"]);
  expect(hitIds(findElements(model, { query: "ca" }))).toEqual(["cart"]);
});

test("a query under 3 characters matches a technology word by prefix, below ids and names: Go, R, C", async () => {
  const model = new ModelLookup(
    mergeProjectModel([
      await view(
        "pay",
        `C4Container\nSystem_Boundary(pay, "Payments") {\n  Container(gift, "Gift card service", "Go")\n  Container(stats, "Fraud stats", "R")\n}\nContainer(fw, "Terminal firmware", "C")\n`,
      ),
      await view(
        "shop",
        `C4Component\nContainer_Boundary(store, "Store") {\n  Component(cart, "Cart")\n  Component(gopher, "Gopher")\n}\n`,
      ),
    ]),
  );
  expect(findElements(model, { query: "Go" }).elements.map((e) => [e.id, e.matched])).toEqual([
    ["gopher", "id"],
    ["gift", "technology"],
  ]);
  expect(findElements(model, { query: "R" }).elements.map((e) => [e.id, e.matched])).toEqual([["stats", "technology"]]);
  expect(hitIds(findElements(model, { query: "c" }))).toEqual(["cart", "gift", "fw"]);
  // With each filter.
  expect(hitIds(findElements(model, { query: "Go", kind: "container" }))).toEqual(["gift"]);
  expect(hitIds(findElements(model, { query: "Go", parent: "pay" }))).toEqual(["gift"]);
  expect(hitIds(findElements(model, { query: "C", diagram: "pay", kind: "container" }))).toEqual(["gift", "fw"]);
  expect(hitIds(findElements(model, { query: "C", parent: "store" }))).toEqual(["cart"]);
});

test("an exact id returns that element alone, with its relationships both ways", async () => {
  const model = await lookup();
  const found = findElements(model, { id: "ordersDb" });
  expect(found.total).toBe(1);
  expect(found.elements[0]).toMatchObject({
    id: "ordersDb",
    name: "Orders",
    kinds: ["container"],
    parents: ["shop"],
    path: ["shop"],
    technology: "PostgreSQL",
    labels: [{ viewId: "containers", label: "Orders" }],
    drawnIn: ["containers"],
    opensIn: [],
    relationships: {
      out: 0,
      in: 2,
      list: [
        { from: "webApp", to: "ordersDb" },
        { from: "worker", to: "ordersDb" },
      ],
    },
  });
  expect(findElements(model, { id: "nothing" }).elements).toEqual([]);
});

test("filters are exact; a parent filter matches any reading, and parents come as a list (O2, A3)", async () => {
  const model = await lookup();
  expect(hitIds(findElements(model, { kind: "person" }))).toEqual(["shopper"]);
  expect(hitIds(findElements(model, { parent: "admin" }))).toEqual(["cart"]);
  expect(hitIds(findElements(model, { parent: "webApp" }))).toEqual(["cart"]);
  expect(hitIds(findElements(model, { diagram: "components" }))).toEqual(["cart", "webApp"]);
  const cart = findElements(model, { id: "cart" }).elements[0]!;
  expect(cart.parents).toEqual(["admin", "webApp"]);
  expect(cart.path).toBeUndefined();
  expect(cart.conflicts).toEqual([expect.objectContaining({ code: "element_parent_conflict" })]);
  expect(hitIds(findElements(model, { query: "cart", kind: "container" }))).toEqual([]);
});

test("limit caps the hits and total counts them all", async () => {
  const model = await lookup();
  const found = findElements(model, { limit: 2 });
  expect(found.elements).toHaveLength(2);
  expect(found.total).toBe(7);
});
