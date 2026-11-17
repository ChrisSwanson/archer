import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const src = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

/** Every module under ui/src the export painter loads, following relative static imports. */
function closure(entry: string): Set<string> {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/^(?:import|export)\s(?!type\b)[^;]*?from\s+"(\.[^"]+)"/gms)) {
      const base = resolve(dirname(file), match[1]);
      const found = ["", ".ts", ".tsx", "/index.ts"]
        .map((ext) => base + ext)
        .find((path) => existsSync(path) && !path.endsWith("/"));
      if (found?.startsWith(src)) pending.push(found);
    }
  }
  return seen;
}

test("the export painter loads no page UI: no chat, app shell or Diagram key component", () => {
  const loaded = [...closure(resolve(src, "export/painter.ts"))].map((path) => path.slice(src.length + 1));
  expect(
    loaded.filter((path) => path.startsWith("chat/") || path.startsWith("app/") || path === "diagrams/DiagramKey.tsx"),
  ).toEqual([]);
});
