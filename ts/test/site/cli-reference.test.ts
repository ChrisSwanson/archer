import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { compile } from "@vue/compiler-dom";
import { createMarkdownRenderer } from "vitepress";
import { afterEach, expect, it } from "vitest";
import { cliSyntaxFiles, generateCliReference } from "../../../site/scripts/cli-reference.mts";
import { main } from "../../src/bin/main.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("gives each command a section and nests its subcommands for the page outline", async () => {
  const page = await generateCliReference(repoRoot);
  expect(page).toContain("## setup\n");
  expect(page).toContain("## validate\n");
  expect(page).toContain("## walkthrough\n");
  expect(page).toContain("### walkthrough write\n");
  expect(page).toContain("### docs index\n");
  expect(page).not.toContain("## Command synopsis");
  for (const section of page.split(/\n(?=## )/).slice(1)) {
    expect(section, section.split("\n")[0]).toMatch(/```text\narcher /);
    expect(section, section.split("\n")[0]).toMatch(/```sh\n/);
    expect(section, section.split("\n")[0]).toMatch(/\| Option \| Purpose \||No options\./);
  }
});

it("covers commands and switches from real CLI help, dispatch and package-only syntax", async () => {
  const page = await generateCliReference(repoRoot);
  let help = "";
  expect(
    await main(["--help"], {
      stdout: (value) => {
        help += value;
      },
      stderr: () => {},
      isTTY: false,
      columns: undefined,
      env: {},
    }),
  ).toBe(0);
  for (const match of help.split("\n\n")[0]!.matchAll(/archer (\S+)/g)) {
    const command = match[1]!;
    expect(page, command).toContain(command.startsWith("-") ? command : `## ${command}\n`);
  }
  const source = await readFile(join(repoRoot, "ts/src/bin/main.ts"), "utf8");
  for (const match of source.matchAll(/command === "([a-z][a-z-]*)"/g))
    expect(page, match[1]).toContain(`## ${match[1]}\n`);
  for (const command of ["setup", "upgrade", "uninstall"]) expect(page).toContain(`## ${command}\n`);
  for (const option of ["--help", "-h", "--version", "-v"]) expect(page).toContain(option);
});

it("covers every declared accepted option, including manually parsed and package flags", async () => {
  const page = await generateCliReference(repoRoot);
  const options = new Set<string>();
  for (const path of cliSyntaxFiles) {
    const source = ts.createSourceFile(
      path,
      await readFile(join(repoRoot, path), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node): void => {
      // Read the CLI's parser declaration independently of the site generator.
      if (ts.isCallExpression(node) && node.expression.getText(source) === "parseArgs") {
        const config = node.arguments[0];
        if (config && ts.isObjectLiteralExpression(config)) {
          const declaration = config.properties.find(
            (prop) => ts.isPropertyAssignment(prop) && prop.name.getText(source) === "options",
          );
          if (
            declaration &&
            ts.isPropertyAssignment(declaration) &&
            ts.isObjectLiteralExpression(declaration.initializer)
          ) {
            for (const prop of declaration.initializer.properties)
              if (ts.isPropertyAssignment(prop)) options.add(prop.name.getText(source).replaceAll('"', ""));
          }
        }
      }
      // Custom parsers compare literal switches, including setup/upgrade flag allowlists.
      if (ts.isStringLiteral(node) && /^--[a-z][a-z-]*$/.test(node.text)) {
        const parent = node.parent;
        const compared = ts.isBinaryExpression(parent);
        const indexedArgument =
          ts.isCallExpression(parent) && /^(args|rest)\.(includes|indexOf)$/.test(parent.expression.getText(source));
        const setupAllowlist =
          path.endsWith("setup.mjs") &&
          ts.isArrayLiteralExpression(parent) &&
          ts.isConditionalExpression(parent.parent) &&
          ts.isVariableDeclaration(parent.parent.parent) &&
          parent.parent.parent.name.getText(source) === "allowed";
        const upgradeAllowlist =
          path.endsWith("upgrade.mjs") &&
          ts.isArrayLiteralExpression(parent) &&
          ts.isPropertyAccessExpression(parent.parent) &&
          parent.parent.name.text === "includes";
        if (compared || indexedArgument || setupAllowlist || upgradeAllowlist) options.add(node.text.slice(2));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  // These are parsed solely to return a migration/refusal instruction, and never accepted.
  options.delete("yes");
  options.delete("person-requested");
  for (const option of options) expect(page, `missing accepted --${option}`).toContain(`--${option}`);
});

it("reads option declarations on each generation and fails explicitly when editorial guidance is missing", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "archer-cli-docs-"));
  cleanup.push(scratch);
  for (const path of cliSyntaxFiles) {
    await mkdir(dirname(join(scratch, path)), { recursive: true });
    await writeFile(join(scratch, path), await readFile(join(repoRoot, path)));
  }
  const path = join(scratch, "ts/src/bin/measure.ts");
  const source = await readFile(path, "utf8");
  await writeFile(path, source.replace("options: {", 'options: { references: { type: "boolean" },'));
  const updated = await generateCliReference(scratch);
  expect(updated.split("## measure\n")[1]!.split("\n## ")[0]).toContain("`--references`");
  await writeFile(path, source.replace("options: {", 'options: { "new-reading-mode": { type: "boolean" },'));
  await expect(generateCliReference(scratch)).rejects.toThrow("option description for measure --new-reading-mode");
});

it("compiles the complete reference through VitePress and Vue, including argument placeholders", async () => {
  const renderer = await createMarkdownRenderer(join(repoRoot, "site"));
  const errors: string[] = [];
  compile(renderer.render(await generateCliReference(repoRoot)), { onError: (error) => errors.push(error.message) });
  expect(errors).toEqual([]);
});

it("keeps newly added CLI parser modules inside the documentation coverage boundary", async () => {
  for (const name of await readdir(join(repoRoot, "ts/src/bin"))) {
    if (!name.endsWith(".ts")) continue;
    const path = `ts/src/bin/${name}`;
    if (/\bparseArgs\(/.test(await readFile(join(repoRoot, path), "utf8")))
      expect(cliSyntaxFiles, path).toContain(path);
  }
});

it("places options declared in inline command branches under their owning command", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "archer-cli-inline-"));
  cleanup.push(scratch);
  for (const path of cliSyntaxFiles) {
    await mkdir(dirname(join(scratch, path)), { recursive: true });
    await writeFile(join(scratch, path), await readFile(join(repoRoot, path)));
  }
  const path = join(scratch, "ts/src/bin/main.ts");
  const source = await readFile(path, "utf8");
  await writeFile(
    path,
    source.replace(
      'options: { json: { type: "boolean" } }',
      'options: { references: { type: "boolean" }, json: { type: "boolean" } }',
    ),
  );
  const page = await generateCliReference(scratch);
  expect(page.split("## pair\n")[1]!.split("\n## ")[0]).toContain("`--references`");
});
