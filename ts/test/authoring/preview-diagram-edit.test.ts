import { expect, test } from "vitest";
import { previewAuthoring, parseAuthoringPreview } from "../../src/authoring/preview.ts";
import { C4_ELEMENT_FUNCTIONS } from "../../src/authoring/diagram-edit.ts";
import { AuthoringInputError } from "../../../shared/authoring-contract.mts";

const c4 =
  'C4Context\r\n    Person(customer, "Customer")\r\n    System(shop, "Shop")\r\n    Rel(customer, shop, "Buys")\r\n';

test("C4 parameters are accepted on the shared operations", () => {
  for (const element of C4_ELEMENT_FUNCTIONS)
    for (const external of [undefined, true, false]) {
      const edit = { kind: "add-node", id: "n", label: "N", element, ...(external === undefined ? {} : { external }) };
      expect(parseAuthoringPreview({ source: c4, edit }, true).edit).toEqual(edit);
    }
  for (const edit of [
    { kind: "connect", source: "shop", target: "customer", label: "Ships" },
    { kind: "connect", source: "shop", target: "customer", label: "Ships", relation: "birel" },
    { kind: "connect", id: "shop--customer", source: "shop", target: "customer", label: "Ships", relation: "rel" },
    { kind: "relabel-edge", id: "customer--shop", label: "Orders" },
    { kind: "delete-edge", id: "customer--shop" },
  ])
    expect(parseAuthoringPreview({ source: c4, edit }, true).edit).toEqual(edit);
});

test("C4 parameters keep their closed values and their operations", () => {
  for (const edit of [
    { kind: "add-node", id: "n", label: "N", element: "Person_Ext" },
    { kind: "add-node", id: "n", label: "N", element: "Deployment_Node" },
    { kind: "add-node", id: "n", label: "N", element: "__proto__" },
    { kind: "add-node", id: "n", label: "N", element: "System", external: "yes" },
    { kind: "add-node", id: "n", label: "N", element: "System", external: 1 },
    { kind: "add-node", id: "n", label: "N", relation: "rel" },
    { kind: "connect", source: "a", target: "b", label: "x", relation: "Rel" },
    { kind: "connect", source: "a", target: "b", label: "x", relation: "rel_d" },
    { kind: "connect", source: "a", target: "b", element: "System" },
    { kind: "connect", source: "a", label: "x" },
    { kind: "connect", id: "../x", source: "a", target: "b" },
    { kind: "relabel-node", id: "a", label: "x", element: "System" },
    { kind: "delete-node", id: "a", external: true },
  ])
    expect(() => parseAuthoringPreview({ source: c4, edit }, true), JSON.stringify(edit)).toThrow(AuthoringInputError);
});

test("an edit request dispatches by family and keeps the preview response shape", async () => {
  const edited = (await previewAuthoring(
    { source: c4, edit: { kind: "add-node", id: "db", label: 'Orders "DB"', element: "SystemDb", external: true } },
    true,
  )) as any;
  expect(edited.ok).toBe(true);
  expect(edited.source).toBe(c4 + '    SystemDb_Ext(db, "Orders #quot;DB#quot;")\r\n');
  expect(edited.envelope.model.elements.at(-1)).toEqual({
    id: "db",
    kind: "system",
    label: 'Orders "DB"',
    external: true,
    shape: "database",
  });
  expect(
    await previewAuthoring(
      { source: c4, edit: { kind: "connect", source: "customer", target: "shop", label: "Again" } },
      true,
    ),
  ).toEqual({ ok: false, source: c4, code: "edit_relationship_exists", existingId: "customer--shop" });
  expect(await previewAuthoring({ source: c4, edit: { kind: "direction", direction: "tb" } }, true)).toEqual({
    ok: false,
    source: c4,
    code: "edit_unsupported_for_family",
  });
  const flow = "flowchart LR\na[A]\nb[B]";
  expect(await previewAuthoring({ source: flow, edit: { kind: "connect", source: "a", target: "b" } }, true)).toEqual({
    ok: false,
    source: flow,
    code: "edit_id_required",
  });
});
