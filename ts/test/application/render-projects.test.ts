import { expect, test } from "vitest";
import { renderOperation } from "../../src/application/render.ts";

test("the readable project list is the list, not a second dump of its fields with other links", () => {
  const readable = "1 attached project(s).\ndemo\n  /r\n  http://127.0.0.1:9/projects/demo/";
  const text = renderOperation("list_projects", {
    text: readable,
    structured: {
      running: true,
      projects: [{ root: "/r", name: "demo", url: "http://127.0.0.1:9/projects/demo/?follow&token=abc" }],
    },
  });
  expect(text).toBe(readable);
  expect(text).not.toContain("running true");
  expect(text).not.toContain("?follow");
});
