/**
 * An isolated project holding slice 1's walkthroughs fixture (`ts/test/fixtures/walkthroughs/`):
 * the Pageturner containers diagram and its sidecar. Never the live service; `startTsProject`
 * runs the real service on a temporary state directory.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FIXTURES = resolve(import.meta.dirname, "../../../ts/test/fixtures/walkthroughs");
export const containersSource = (): string => readFileSync(resolve(FIXTURES, "containers.mmd"), "utf8");
export const containersWalkthroughs = (): string =>
  readFileSync(resolve(FIXTURES, "containers.walkthroughs.json"), "utf8");

export function walkthroughFiles(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "archer.toml":
      'version = 1\n[[views]]\nid = "containers"\nkind = "c4"\ntitle = "Pageturner containers"\nsource = ".archer/containers.mmd"\n',
    ".archer/containers.mmd": containersSource(),
    ".archer/containers.walkthroughs.json": containersWalkthroughs(),
    ...extra,
  };
}
