// The skill folder this installation ships: `skills/archer` beside a package version's dist/ (the
// bundle may sit in dist/ or dist/chunks/), `plugin/skills/archer` in a checkout or a development
// plugin build. `archer skill`, `archer doctor` and the guides kept only in the skill read it here.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function bundledSkillDir(from: string = import.meta.url): string {
  for (const relative of [
    "../skills/archer/",
    "../../skills/archer/",
    "../plugin/skills/archer/",
    "../../plugin/skills/archer/",
  ]) {
    const dir = fileURLToPath(new URL(relative, from));
    if (existsSync(join(dir, "SKILL.md"))) return dir;
  }
  throw new Error("this Archer installation has no skill folder (skills/archer); reinstall the package");
}
