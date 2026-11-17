import { expect, test } from "vitest";
import { FAMILIES, familyOf, hasContent, readableId, withoutShownTechnology } from "../src/authoring/families";

test.each([
  ["flowchart LR\n a --> b", "flowchart"],
  ['%%{init: {"theme": "dark"}}%%\nsequenceDiagram\n a->>b: x', "sequence"],
  // A directive whose JSON spans lines (codex #8): the header is after it.
  ['%%{init: {\n  "theme": "dark",\n  "flowchart": {"curve": "basis"}\n}}%%\nflowchart TD\n a', "flowchart"],
  ['%%{init: {"theme":"dark"}}%% erDiagram', "er"],
  ["---\ntitle: Orders\n---\nstateDiagram-v2\n [*] --> A", "state"],
  ["%% a comment\n\nC4Container\n", "c4"],
  ['%%{init: {\n "theme": "dark"\n}}%%\n', null],
  ['pie\n "a": 1', null],
] as const)("familyOf(%j) is %j", (source, family) => expect(familyOf(source)).toBe(family));

test("hasContent skips a multi-line directive and the header", () => {
  expect(hasContent('%%{init: {\n "theme": "dark"\n}}%%\nflowchart LR\n')).toBe(false);
  expect(hasContent('%%{init: {\n "theme": "dark"\n}}%%\nflowchart LR\n a[A]\n')).toBe(true);
});

test("readableId: a new entity or state is named by what was typed, de-duplicated (smoke-b#11:b)", () => {
  expect(readableId("Order line", [])).toBe("OrderLine");
  expect(readableId("order line", ["OrderLine", "OrderLine2"])).toBe("OrderLine3");
  expect(readableId("Café crème", [])).toBe("CafeCreme");
  for (const unusable of ["", "  ", "日本", "2 fast", "state", "End"]) expect(readableId(unusable, [])).toBeNull();
});

test("withoutShownTechnology: a C4 label typed back with its shown [technology] sends only the label", () => {
  expect(withoutShownTechnology("Calls [HTTPS]", "HTTPS")).toBe("Calls");
  expect(withoutShownTechnology("Calls [HTTPS]  ", "HTTPS")).toBe("Calls");
  expect(withoutShownTechnology("[HTTPS]", "HTTPS")).toBe("");
  expect(withoutShownTechnology("Calls [gRPC]", "HTTPS")).toBe("Calls [gRPC]");
  expect(withoutShownTechnology("Calls [HTTPS]", undefined)).toBe("Calls [HTTPS]");
});

test("no part is offered that does not exist yet (ux:F17); every type says its gestures (ux:F10)", () => {
  for (const family of Object.values(FAMILIES)) {
    expect(family.parts.flat().filter((part) => part.kind === "group")).toEqual([]);
    expect(family.howTo).not.toBe("");
    expect(family.emptyHint).not.toBe("");
  }
});
