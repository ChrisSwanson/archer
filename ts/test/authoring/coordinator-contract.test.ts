import { expect, test } from "vitest";
import { AuthoringInputError, parseAuthoringRequest } from "../../../shared/authoring-contract.mts";
const valid = {
  op: "draft.save",
  operationId: "1".repeat(32),
  draftId: "drf_" + "1".repeat(32),
  expectedDraftRevision: null,
  origin: { kind: "new" },
  source: "flowchart LR\na[A]\n",
};
test("strict DTO refuses unknown fields, credentials, malformed IDs, traversal, accessors and oversized source", () => {
  const hostile: unknown[] = [
    null,
    [],
    7,
    { ...valid, token: "secret" },
    { ...valid, operationId: "bad" },
    { ...valid, draftId: "1".repeat(32) },
    { ...valid, source: "a".repeat(262145) },
    { ...valid, origin: { kind: "new", path: "../escape.mmd" } },
    {
      ...valid,
      origin: { kind: "document", target: { kind: "view", viewId: "a" }, expectedSourceRevision: "invalid" },
    },
    Object.defineProperty({ ...valid }, "source", {
      get() {
        throw new Error("getter must not execute");
      },
    }),
  ];
  for (const input of hostile) expect(() => parseAuthoringRequest(input)).toThrow(AuthoringInputError);
  expect(parseAuthoringRequest(valid)).toEqual(valid);
});
test("bounded parser trust properties: arbitrary values, vocabulary objects and small valid mutations refuse by name or round-trip valid DTO", () => {
  let state = 123;
  const random = (n: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % n;
  };
  const words = [
    "draft.save",
    "document.apply",
    "document.publish",
    "draft.send",
    "operation.send",
    "operation.resolve_uncertain",
    "source",
    "operationId",
    "origin",
    "new",
    "document",
    "../escape",
    "flowchart LR",
    "\u0000",
    "🐦",
  ];
  const check = (input: unknown) => {
    try {
      const parsed = parseAuthoringRequest(input);
      expect(parseAuthoringRequest(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    } catch (error) {
      expect(error).toBeInstanceOf(AuthoringInputError);
    }
  };
  for (let i = 0; i < 500; i++) {
    check(Array.from({ length: random(80) }, () => String.fromCharCode(random(65536))).join(""));
    check(
      Object.fromEntries(
        Array.from({ length: random(10) }, () => [words[random(words.length)], words[random(words.length)]]),
      ),
    );
    const altered: Record<string, unknown> = { ...valid };
    altered[Object.keys(valid)[random(Object.keys(valid).length)]!] = words[random(words.length)];
    check(altered);
  }
  const cycle: Record<string, unknown> = { ...valid };
  cycle.origin = cycle;
  check(cycle);
}, 10_000);
