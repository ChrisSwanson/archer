import { afterEach, expect, test } from "vitest";
import { parseGlobalConfig } from "../../src/config/index.ts";
import { findProject } from "../../src/project/project.ts";
import { resolveDiscoverySettings } from "../../src/project/discovery.ts";
import { removeTempDirs, tempDir } from "./support.ts";
afterEach(removeTempDirs);
test("global discovery accepts the strict shared section and project fields replace it", () => {
  const global = parseGlobalConfig('version=1\n[discovery]\nroots=["docs"]\nexclude=["**/generated/**"]\n');
  expect(global).toMatchObject({ discovery: { roots: ["docs"], exclude: ["**/generated/**"] } });
  const project = findProject(tempDir({ "archer.toml": 'version=1\n[discovery]\nroots=[".archer"]\n' }));
  expect(resolveDiscoverySettings(project, { user: global.discovery ?? {} })).toEqual({
    roots: [".archer"],
    exclude: ["**/generated/**"],
  });
});
