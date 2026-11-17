// set_emphasis takes an embedded diagram's address up to the address limit other tools accept
// (server review S5: a 137-character nested address was refused at the 128-character id limit).

import { expect, test } from "vitest";
import { parse } from "../../src/application/emphasis.ts";
import { MAX_ID_CHARS } from "../../src/model/index.ts";
import { MAX_ADDRESS_CHARS } from "../../../shared/note-diagrams.mts";

const group = { id: "g", label: "g", style: "highlight", nodes: ["a"] };
const args = (viewId: string) => ({ id: "e", viewId, groups: [group] });

test("an embedded address longer than an id is accepted", () => {
  const address = `notes/${"deep/".repeat(24)}worker.md#flow`;
  expect([...address].length).toBeGreaterThan(MAX_ID_CHARS);
  const draft = parse(args(address));
  expect(draft.issues).toEqual([]);
  expect(draft.viewId).toBe(address);
});

test("an address past the address limit is refused", () => {
  const address = `notes/${"d/".repeat(MAX_ADDRESS_CHARS)}worker.md#flow`;
  expect(parse(args(address)).issues.map((i) => i.where)).toContain("viewId");
});

test("a plain view id still has the id limit", () => {
  expect(parse(args("v".repeat(MAX_ID_CHARS + 1))).issues.map((i) => i.where)).toContain("viewId");
  expect(parse(args("v".repeat(MAX_ID_CHARS))).issues).toEqual([]);
});
