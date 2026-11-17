import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { parseGlobalConfig } from "../../src/config/index.ts";
import { prepareEvalRun, type EvalRunOptions } from "../../scripts/evals/harness.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(): Promise<EvalRunOptions> {
  const base = await mkdtemp(join(tmpdir(), "archer-eval-"));
  roots.push(base);
  const bundleDir = join(base, "bundle"),
    skillDir = join(base, "skill");
  await mkdir(join(bundleDir, "assets"), { recursive: true });
  await mkdir(join(bundleDir, "docs"));
  await mkdir(join(bundleDir, "chunks"));
  await mkdir(skillDir);
  for (const file of ["archer.js", "api.js", "assets/archer-ui.html", "docs/supported-mermaid.md", "chunks/shared.js"])
    await writeFile(join(bundleDir, file), "fixture");
  await writeFile(join(skillDir, "SKILL.md"), "skill facts");
  return {
    root: join(base, "run"),
    bundleDir,
    skillDir,
    solver: { prompt: "literal prompt $()\n", files: { "facts/source.txt": "literal facts" } },
    caseId: "c1",
    variant: "baseline",
    cohort: "test-cli",
    track: "authoring",
    sourceCommit: "abc",
    port: 45321,
    maxCalls: 2,
  };
}
function run(file: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { env });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
test("prepares literal isolated files and provenance, and refuses reuse before changing files", async () => {
  const input = await fixture();
  const paths = await prepareEvalRun(input);
  expect(await readFile(paths.promptFile, "utf8")).toBe(input.solver.prompt);
  expect(await readFile(join(paths.projectDir, "facts/source.txt"), "utf8")).toBe("literal facts");
  expect(parseGlobalConfig(await readFile(join(paths.root, "config/archer.toml"), "utf8"))).toMatchObject({
    version: 1,
  });
  expect(JSON.parse(await readFile(paths.manifestFile, "utf8"))).toMatchObject({
    caseId: "c1",
    preflight: "filesystem-ready",
    node: { executable: process.execPath },
  });
  await expect(prepareEvalRun(input)).rejects.toThrow(/exist/i);
  expect(await readFile(paths.promptFile, "utf8")).toBe(input.solver.prompt);
});
test("rejects escape and bad port before creating run root", async () => {
  for (const change of [{ solver: { prompt: "x", files: { "../escape": "bad" } } }, { port: 80 }]) {
    const input = { ...(await fixture()), ...change };
    await expect(prepareEvalRun(input)).rejects.toThrow(/relative|confined|port/i);
    await expect(access(input.root)).rejects.toThrow();
  }
});
test("rejects unsupported Node before creating run root", async () => {
  const input = await fixture();
  const prior = process.versions.node;
  Object.defineProperty(process.versions, "node", { value: "22.17.0", configurable: true });
  try {
    await expect(prepareEvalRun(input)).rejects.toThrow(/22\.18/);
  } finally {
    Object.defineProperty(process.versions, "node", { value: prior, configurable: true });
  }
  await expect(access(input.root)).rejects.toThrow();
});
test("runner captures argv without shell expansion, exit, byte counts, private env and project cwd", async () => {
  const paths = await prepareEvalRun(await fixture());
  const result = await run(
    paths.runnerFile,
    [
      process.execPath,
      "-e",
      `console.log(JSON.stringify({cwd:process.cwd(),home:process.env.HOME,secret:process.env.ARCHER_INHERITED_SECRET,node:process.execPath,arg:process.argv[1]})); console.error('failure'); process.exitCode=7;`,
      "$(touch NEVER)",
    ],
    { ...process.env, ARCHER_INHERITED_SECRET: "never-log-this" },
  );
  expect(result.code).toBe(7);
  const value = JSON.parse(result.stdout);
  expect(value).toMatchObject({
    cwd: paths.projectDir,
    home: join(paths.root, "home"),
    node: process.execPath,
    arg: "$(touch NEVER)",
  });
  expect(value.secret).toBeUndefined();
  const events = (await readFile(join(paths.root, "trace.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));
  expect(events.map((e) => e.event)).toEqual(["start", "end"]);
  expect(events[0].cwd).toBe(paths.projectDir);
  expect(events[1]).toMatchObject({
    exitCode: 7,
    stderr: "failure\n",
    stdoutBytes: Buffer.byteLength(result.stdout),
    stderrBytes: 8,
  });
});
test("CLI shim reserves atomic invocation budget and uses actual Node with strict MCP env", async () => {
  const input = await fixture();
  await writeFile(join(input.bundleDir, "archer.js"), `console.log(process.execPath);`);
  const paths = await prepareEvalRun(input);
  const results = await Promise.all([
    run(paths.cliFile, ["one"]),
    run(paths.cliFile, ["two"]),
    run(paths.cliFile, ["three"]),
  ]);
  expect(results.filter((r) => r.code === 0)).toHaveLength(2);
  expect(results.filter((r) => r.code !== 0)[0]?.stderr).toMatch(/budget/);
  const config = JSON.parse(await readFile(paths.mcpConfigFile, "utf8"));
  expect(config.mcpServers.archer).toMatchObject({
    command: process.execPath,
    args: [paths.runnerFile, process.execPath, join(input.bundleDir, "archer.js"), "mcp"],
    env: { ARCHER_FORCE_HTTP: "true", ARCHER_HOST: "127.0.0.1" },
  });
});
test("bounds trace capture while forwarding exact output and records launch errors", async () => {
  const paths = await prepareEvalRun(await fixture());
  const result = await run(paths.runnerFile, [process.execPath, "-e", "process.stdout.write('é'.repeat(40000))"]);
  expect(Buffer.byteLength(result.stdout)).toBe(80000);
  const events = (await readFile(join(paths.root, "trace.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));
  expect(events[1].stdoutBytes).toBe(80000);
  expect(events[1].stdoutTruncated).toBe(true);
  expect(Buffer.byteLength(events[1].stdout)).toBeLessThanOrEqual(65536);
  expect((await run(paths.runnerFile, ["/no/such/command"])).code).not.toBe(0);
});
test("missing bundle input is refused before mutation and hashes include chunks and copied skill", async () => {
  const input = await fixture();
  await rm(join(input.bundleDir, "api.js"));
  await expect(prepareEvalRun(input)).rejects.toThrow(/bundle missing api.js/);
  await expect(access(input.root)).rejects.toThrow();
  await writeFile(join(input.bundleDir, "api.js"), "fixture");
  const paths = await prepareEvalRun(input);
  const manifest = JSON.parse(await readFile(paths.manifestFile, "utf8"));
  expect(manifest.hashes.distribution["chunks/shared.js"]).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(manifest.hashes.skill["SKILL.md"]).toMatch(/^sha256:/);
  expect(await readFile(join(paths.root, "plugin/skills/archer/SKILL.md"), "utf8")).toBe("skill facts");
});
test("path vocabulary and small edits are refused or remain confined without throwing outside validation", async () => {
  const input = await fixture();
  const names = [
    "a",
    "facts/data.txt",
    "../bad",
    "/absolute",
    "a/../../bad",
    "a\\bad",
    "a//b",
    "a/./b",
    "a/../b",
    "a\0b",
    ...Array.from({ length: 32 }, (_, i) => "facts/" + String.fromCharCode(97 + (i % 26)) + i),
  ];
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!;
    const root = input.root + "-" + i;
    const options = { ...input, root, solver: { prompt: "fixture", files: { [name]: "x" } } };
    const valid =
      !name.includes("\\") &&
      !name.includes("\0") &&
      !name.startsWith("/") &&
      name.split("/").every((p) => p && p !== "." && p !== "..");
    if (valid) {
      const paths = await prepareEvalRun(options);
      expect(await readFile(join(paths.projectDir, name), "utf8")).toBe("x");
    } else {
      await expect(prepareEvalRun(options)).rejects.toThrow(/relative/);
      await expect(access(root)).rejects.toThrow();
    }
  }
});
test("artifact nesting accepts exactly 64 directories and refuses 65 by name", async () => {
  const input = await fixture();
  const deep = join(input.skillDir, ...Array.from({ length: 64 }, () => "d"));
  await mkdir(deep, { recursive: true });
  await writeFile(join(deep, "facts"), "x");
  await prepareEvalRun(input);
  await mkdir(join(deep, "extra"));
  await expect(prepareEvalRun({ ...input, root: input.root + "-deeper" })).rejects.toThrow(/nesting exceeds 64/);
});

test("MCP server runner isolates inherited Archer state while client retains operator HOME", async () => {
  const input = await fixture();
  await writeFile(
    join(input.bundleDir, "archer.js"),
    `console.log(JSON.stringify({home:process.env.HOME,state:process.env.ARCHER_STATE_DIR,secret:process.env.ARCHER_INHERITED_SECRET,cwd:process.cwd()}));`,
  );
  const paths = await prepareEvalRun(input);
  const config = JSON.parse(await readFile(paths.mcpConfigFile, "utf8")).mcpServers.archer;
  const operatorHome = process.env.HOME;
  const result = await run(config.args[0], config.args.slice(1), {
    ...process.env,
    ...config.env,
    HOME: operatorHome,
    ARCHER_INHERITED_SECRET: "operator-secret",
  });
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    home: join(paths.root, "home"),
    state: join(paths.root, "state"),
    cwd: paths.projectDir,
  });
  expect(process.env.HOME).toBe(operatorHome);
});
