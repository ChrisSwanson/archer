// `archer docs index [--write] [--check] [--json] [question]` and `archer init --docs`: the doc
// pack's CLI (docs/proposals/doc-pack.md). --check exits non-zero on a failure, for CI and release-check.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { main } from "../../src/bin/main.ts";
import { removeTempDirs, tempDir } from "../project/support.ts";

afterEach(removeTempDirs);

async function run(cwd: string, args: string[]) {
  let out = "",
    err = "";
  const code = await main(args, {
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    isTTY: false,
    columns: undefined,
    env: {},
    cwd,
  });
  return { code, out, err };
}

const flow = "flowchart LR\n  a[A] e@--> b[B]\n";
const pack = () =>
  tempDir({
    "archer.toml": 'version = 1\nmode = "docs"\n',
    ".archer/README.md": "---\nauthor: agent\n---\n# Docs\n",
    ".archer/intent.md": "---\ntype: intent\nstatus: proposed\n---\n# Intent\n",
    ".archer/use-cases.md": "---\ntype: use-cases\n---\n# Use cases\n",
    ".archer/architecture.md": "---\ntype: architecture\ndescription: The parts of the shop.\n---\n# Architecture\n",
    ".archer/diagrams/flows/pay.mmd": `%% description: Paying for an order.\n${flow}`,
    ".archer/diagrams/flows/ship.mmd": `%% description: Shipping a parcel.\n${flow}`,
  });

test("init --docs sets the mode, says what to do next, and writes nothing in the folder", async () => {
  const dir = tempDir();
  const result = await run(dir, ["init", "--docs"]);
  expect(result.code).toBe(0);
  expect(readFileSync(join(dir, "archer.toml"), "utf8")).toContain('mode = "docs"');
  expect(result.out).toMatch(/docs mode/i);
  expect(result.out).toContain("set up the architecture docs");
  expect(existsSync(join(dir, ".archer", "index.md"))).toBe(false);
});

test("docs index --check fails until the router is written, then passes", async () => {
  const dir = pack();
  const before = await run(dir, ["docs", "index", "--check"]);
  expect(before.code).toBe(1);
  expect(before.out).toContain("index.md is missing");
  const written = await run(dir, ["docs", "index", "--write", "--check"]);
  expect(written.code).toBe(0);
  expect(written.out).toContain("Wrote index.md.");
  expect(written.out).toContain("Pack health: pass");
  expect(readFileSync(join(dir, ".archer/index.md"), "utf8")).toContain("[architecture.md](architecture.md)");
});

test("docs index without flags prints the router; a question prints at most three files", async () => {
  const dir = pack();
  await run(dir, ["docs", "index", "--write"]);
  expect((await run(dir, ["docs", "index"])).out).toContain("docs: start here");
  const asked = await run(dir, ["docs", "index", "how", "do", "we", "ship", "a", "parcel?"]);
  expect(asked.code).toBe(0);
  expect(asked.out).toContain("diagrams/flows/ship.mmd");
});

test("docs index --check --json prints the structured result and still exits 1 on a failure", async () => {
  const dir = pack();
  writeFileSync(join(dir, ".archer/invariants.md"), `---\ntype: invariants\n---\n${"x".repeat(3100)}`);
  await run(dir, ["docs", "index", "--write"]);
  const result = await run(dir, ["docs", "index", "--check", "--json"]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.out).health.status).toBe("fail");
});

test("docs index refuses unknown flags with usage", async () => {
  const result = await run(pack(), ["docs", "index", "--fix"]);
  expect(result.code).not.toBe(0);
  expect(result.err).toMatch(/usage|unknown/i);
});

test("outside docs mode a missing router is a note, not a word next to 'pass'", async () => {
  const dir = tempDir({
    "archer.toml": "version = 1\n",
    ".archer/architecture.md": "---\ntype: architecture\n---\n# Architecture\n",
  });
  const result = await run(dir, ["docs", "index", "--check"]);
  expect(result.code).toBe(0);
  expect(result.out).toContain("Pack health: pass");
  expect(result.out).not.toMatch(/router missing/);
  expect(result.out).toMatch(/note: .*index\.md.*docs mode.*archer docs index --write/);
});

test("in docs mode a missing router is a failure and exits 1", async () => {
  const result = await run(pack(), ["docs", "index", "--check"]);
  expect(result.code).toBe(1);
  expect(result.out).toContain("fail: index.md is missing");
  expect(result.out).not.toMatch(/router missing/);
});
