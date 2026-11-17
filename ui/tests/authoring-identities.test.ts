import { expect, test } from "vitest";
import { nextFreeId } from "../src/authoring/identities";
test("one short-ID helper finds the first free node/edge identifier without touching frozen IDs", () => {
  const frozen = ["a", "n1", "n2", "n4", "e1", "e3"];
  expect(nextFreeId("n", frozen)).toBe("n3");
  expect(nextFreeId("e", frozen)).toBe("e2");
  expect(frozen).toEqual(["a", "n1", "n2", "n4", "e1", "e3"]);
});
