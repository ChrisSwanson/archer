import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { expect, test } from "vitest";

function sources(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    return entry.isDirectory() ? sources(path) : path.endsWith(".tsx") ? [path] : [];
  });
}

// An architectural guard on production sources, paired with real page/browser behavior tests.
// Shared action policy is migrated separately; page roots must not copy the web frame again.
test("one shared web component owns the web frame and document header", () => {
  const root = resolve("src");
  const files = sources(root);
  for (const pattern of [/className="archer-web-shell primary-shell"/, /<header\s+className="primary-document-bar"/]) {
    const owners = files.filter((path) => pattern.test(readFileSync(path, "utf8"))).map((path) => relative(root, path));
    expect(owners).toEqual(["app/WebShell.tsx"]);
  }
});
