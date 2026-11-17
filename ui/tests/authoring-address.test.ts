// @vitest-environment jsdom
import { expect, test } from "vitest";
import { editorAddress, editorHref } from "../src/authoring/address";
test("canonical and private checkpoint contexts round-trip independently of browser storage", () => {
  const target = { kind: "view" as const, viewId: "flow" },
    draftId = "drf_" + "a".repeat(32);
  for (const checkpoint of ["document", "draft"] as const) {
    const href = editorHref("example-12345678", target, draftId, checkpoint)!;
    expect(editorAddress(new URL(href, location.origin).search)).toEqual({ target, draftId, checkpoint });
  }
  expect(() => editorAddress("?checkpoint=document")).toThrow();
  expect(() => editorAddress("?checkpoint=other")).toThrow();
  expect(() => editorAddress("?checkpoint=draft&checkpoint=document")).toThrow();
});
