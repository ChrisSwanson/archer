import { afterEach, expect, test } from "vitest";
import { findProject, historicalRegistry } from "../../src/project/project.ts";
import { removeTempDirs, tempDir } from "./support.ts";
afterEach(removeTempDirs);
test("strict project manifest accepts discovery while retaining legacy registry sources", () => {
  const text = 'version=1\n[discovery]\nroots=[".archer", "docs"]\nexclude=["docs/generated/**"]\n';
  expect(historicalRegistry(text, "/project")).toMatchObject({
    discovery: { roots: [".archer", "docs"], exclude: ["docs/generated/**"] },
  });
  expect(findProject(tempDir({ "archer.toml": text }))).toMatchObject({
    discovery: { roots: [".archer", "docs"], exclude: ["docs/generated/**"] },
  });
});
