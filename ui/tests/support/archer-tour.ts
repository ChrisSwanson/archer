/**
 * Isolated projects holding the shipped examples (`examples/<name>`), read from this checkout. Never the live service.
 */
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const EXAMPLES = resolve(import.meta.dirname, "../../../examples");

function walk(root: string, dir: string, into: Record<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) walk(root, path, into);
    else if (entry.isFile()) into[relative(root, path)] = readFileSync(path, "utf8");
  }
}

/** Every file of the example `name`, by its path in the example. */
export function exampleFiles(name: string): Record<string, string> {
  const root = resolve(EXAMPLES, name);
  const files: Record<string, string> = {};
  walk(root, root, files);
  return files;
}

/** The Archer Tour example (`examples/archer-tour`): its `archer.toml` and every file under its `.archer` folder. */
export function archerTourFiles(): Record<string, string> {
  const root = resolve(EXAMPLES, "archer-tour");
  const files: Record<string, string> = { "archer.toml": readFileSync(resolve(root, "archer.toml"), "utf8") };
  walk(root, resolve(root, ".archer"), files);
  return files;
}
