import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertLandingBudget, landingBudget } from "../../../site/scripts/landing-budget.mts";
import { budgetViolations, entryFiles, measureBuild, type BuildManifest } from "../../../site/scripts/size-budget.mts";

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const manifest: BuildManifest = {
  "node_modules/vitepress/dist/client/app/index.js": {
    file: "assets/app.js",
    name: "app",
    isEntry: true,
    imports: ["_theme.js", "_framework.js"],
  },
  "_theme.js": { file: "assets/chunks/theme.js", imports: ["_framework.js"], dynamicImports: ["lazy.vue"] },
  "_framework.js": { file: "assets/chunks/framework.js" },
  "lazy.vue": { file: "assets/chunks/lazy.js", isDynamicEntry: true, imports: ["_framework.js"] },
  "index.md": { file: "assets/index.md.js", name: "index.md", isEntry: true, imports: ["_framework.js"] },
  "style.css": { file: "assets/style.css" },
};

async function site(): Promise<string> {
  const output = await mkdtemp(join(tmpdir(), "archer-landing-bytes-"));
  scratch.push(output);
  await mkdir(join(output, "assets/chunks"), { recursive: true });
  await mkdir(join(output, ".vite"), { recursive: true });
  await writeFile(join(output, ".vite/manifest.json"), JSON.stringify(manifest));
  await writeFile(join(output, "index.html"), "<html></html>");
  for (const chunk of Object.values(manifest)) await writeFile(join(output, chunk.file), "export {};");
  return output;
}

it("follows static imports, never dynamic ones, each file once", () => {
  expect(entryFiles(manifest, "node_modules/vitepress/dist/client/app/index.js", "index.md").sort()).toEqual(
    ["assets/app.js", "assets/chunks/framework.js", "assets/chunks/theme.js", "assets/index.md.js"].sort(),
  );
});

it("gates the landing's HTML, app entry, page chunk and stylesheet from the manifest, then unpublishes it", async () => {
  const output = await site();
  const before = await measureBuild(output, manifest, landingBudget(manifest));
  await expect(assertLandingBudget(output)).resolves.toBeUndefined();
  expect(await readdir(output)).not.toContain(".vite");
  // Lazy chunks and fonts are outside the before-activation code budget.
  await writeFile(join(output, "assets/chunks/lazy.js"), randomBytes(150000));
  await writeFile(join(output, "font.woff2"), randomBytes(150000));
  expect((await measureBuild(output, manifest, landingBudget(manifest))).entries).toEqual(before.entries);
  await writeFile(join(output, "assets/chunks/theme.js"), randomBytes(130 * 1024));
  const report = await measureBuild(output, manifest, landingBudget(manifest));
  expect(budgetViolations(report, landingBudget(manifest))).toEqual([
    expect.stringMatching(/^entry landing: \d+ gzip bytes > 122880$/),
    expect.stringMatching(/^chunk assets\/chunks\/theme\.js: \d+ gzip bytes > 65536$/),
    expect.stringMatching(/^chunk assets\/chunks\/lazy\.js: \d+ gzip bytes > 65536$/),
  ]);
  await mkdir(join(output, ".vite"), { recursive: true });
  await writeFile(join(output, ".vite/manifest.json"), JSON.stringify(manifest));
  await expect(assertLandingBudget(output)).rejects.toThrow(/Landing exceeds its size budget/);
});
