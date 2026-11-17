// The project's name arrives with the server's capabilities on bootstrap;
// the Rust server sends neither, and the page then names no project.
import { expect, test } from "vitest";
import { parseCapabilities } from "../src/comments/parse";

test("exposes shared settings only when the service explicitly supports them", () => {
  expect(parseCapabilities({ capabilities: { instanceSettings: true } })).toHaveProperty("instanceSettings", true);
  for (const value of [undefined, false, "true", 1, null]) {
    expect(parseCapabilities({ capabilities: { instanceSettings: value } })).not.toHaveProperty(
      "instanceSettings",
      true,
    );
  }
});

test("bootstrap names the project", () => {
  expect(parseCapabilities({ capabilities: { comments: true }, project: { name: "Pageturner" } }).projectName).toBe(
    "Pageturner",
  );
  expect(parseCapabilities({ capabilities: { comments: true } }).projectName).toBeUndefined();
  expect(parseCapabilities(null).projectName).toBeUndefined();
  expect(parseCapabilities({ project: { name: 7 } }).projectName).toBeUndefined();
});
