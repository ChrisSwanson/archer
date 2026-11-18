// The package ships through GitHub Releases, never npm: `private: true` stays (a guard in install.test.ts),
// but the words a reader sees must not call the release a "private build".
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { packageManifest } from "../../scripts/package.ts";

test("the package description and README say it is not published to npm, not that it is a private build", () => {
  const manifest = packageManifest("1.0.0") as { private: boolean; description: string };
  expect(manifest.private).toBe(true);
  expect(manifest.description).not.toMatch(/private build/i);
  const readme = readFileSync(resolve(import.meta.dirname, "../../pkg/README.md"), "utf8");
  expect(readme).not.toMatch(/private build|never publish/i);
  expect(readme).toMatch(/not published to npm/);
});
