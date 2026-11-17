// `archer skill [--references] [--write <dir>]` (ADR 0035 §5): the Archer skill this CLI ships, printed
// or written as a folder, so an agent without the installed skill can learn it or install it in a pinch.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { bundledSkillDir } from "../guidance/skill-folder.ts";
import { safe, UsageError, usage, type Io } from "./main.ts";

export { bundledSkillDir };

/** The skill's files, relative to its folder: SKILL.md first, then references/*.md by name. */
export function skillFiles(dir = bundledSkillDir()): { path: string; text: string }[] {
  const references = join(dir, "references");
  const names = existsSync(references)
    ? readdirSync(references)
        .filter((name) => name.endsWith(".md"))
        .sort()
    : [];
  return [
    { path: "SKILL.md", text: readFileSync(join(dir, "SKILL.md"), "utf8") },
    ...names.map((name) => ({ path: `references/${name}`, text: readFileSync(join(references, name), "utf8") })),
  ];
}

const isArcherSkill = (text: string): boolean => /^---\n(?:[^\n]*\n)*?name: archer\n/.test(text);

export async function runSkill(args: readonly string[], io: Io): Promise<number> {
  const { values } = usage(() =>
    parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: false,
      options: { references: { type: "boolean" }, write: { type: "string" } },
    }),
  );
  const files = skillFiles();
  if (values.write === undefined) {
    const shown = values.references === true ? files : files.slice(0, 1);
    io.stdout(
      shown.map((file, index) => (index === 0 ? file.text : `\n--- ${file.path} ---\n\n${file.text}`)).join(""),
    );
    return 0;
  }
  if (values.write === "") throw new UsageError("--write needs a folder, for example ~/.claude/skills/archer");
  const dir = resolve(io.cwd ?? process.cwd(), values.write);
  let linked = false;
  try {
    linked = lstatSync(dir).isSymbolicLink();
  } catch {
    /* new */
  }
  if (linked) {
    io.stderr(
      `archer skill: ${safe(dir)} is a link (to an installed Archer's skill, normally); nothing was written. archer upgrade refreshes what it points at.\n`,
    );
    return 1;
  }
  // Only an empty folder or an Archer skill is written over: never someone's other skill.
  const existing = join(dir, "SKILL.md");
  if (existsSync(existing) && !isArcherSkill(readFileSync(existing, "utf8"))) {
    io.stderr(
      `archer skill: ${safe(dir)} holds another skill (its SKILL.md is not named archer); nothing was written. Choose another folder.\n`,
    );
    return 1;
  }
  if (!existsSync(existing) && existsSync(dir) && readdirSync(dir).length > 0) {
    io.stderr(
      `archer skill: ${safe(dir)} is not empty and holds no Archer skill; nothing was written. Choose an empty or new folder.\n`,
    );
    return 1;
  }
  for (const file of files) {
    const path = join(dir, file.path);
    mkdirSync(join(path, ".."), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, file.text);
    renameSync(temporary, path);
  }
  // A reference an older skill had and this one does not would otherwise linger in the folder.
  const kept = new Set(files.map((file) => file.path));
  for (const name of existsSync(join(dir, "references")) ? readdirSync(join(dir, "references")) : [])
    if (name.endsWith(".md") && !kept.has(`references/${name}`)) rmSync(join(dir, "references", name), { force: true });
  io.stdout(`Wrote the Archer skill to ${safe(dir)} (${files.length} files). A session loads it when it starts.\n`);
  return 0;
}
