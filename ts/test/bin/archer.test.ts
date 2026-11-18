// The `archer` command line, run in-process against a fake terminal.
import { join } from "node:path";
import { expect, test } from "vitest";
import { main, type Io } from "../../src/bin/main.ts";
import { REPO } from "../terminal/models.ts";

const MINIMAL = join(REPO, "fixtures", "flowchart", "minimal.json");
const PIPELINE = join(REPO, "ts", "test", "terminal", "fixtures", "compile-pipeline.json");

interface Run {
  code: number;
  out: string;
  err: string;
}

async function run(args: string[], io: Partial<Io> = {}): Promise<Run> {
  let out = "",
    err = "";
  const code = await main(args, {
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    isTTY: false,
    columns: undefined,
    env: {},
    ...io,
  });
  return { code, out, err };
}

test("--version prints the version", async () => {
  const { code, out } = await run(["--version"]);
  expect(code).toBe(0);
  expect(out).toMatch(/^\d+\.\d+\.\d+\S*\n$/);
});

test("draw prints the model's drawing under its file name", async () => {
  const { code, out, err } = await run(["draw", "--model", MINIMAL, "--width", "100"]);
  expect(err).toBe("");
  expect(code).toBe(0);
  expect(out.split("\n")[0]).toBe("minimal.json");
  for (const label of ["User", "Web App", "API Service", "Backend", "uses", "HTTP"]) expect(out).toContain(label);
  expect(out).not.toContain("\u001b");
});

test("draw fits the width given, or the terminal's, or 80 columns", async () => {
  const widest = (s: string): number => Math.max(...s.split("\n").map((l) => [...l].length));
  expect(widest((await run(["draw", "--model", PIPELINE, "--width", "60"])).out)).toBeLessThanOrEqual(60);
  expect(widest((await run(["draw", "--model", PIPELINE], { columns: 70 })).out)).toBeLessThanOrEqual(70);
  expect(widest((await run(["draw", "--model", PIPELINE])).out)).toBeLessThanOrEqual(80);
});

test("colour is on for a terminal unless NO_COLOR is set, and the flags override", async () => {
  const esc = (r: Run): boolean => r.out.includes("\u001b[");
  expect(esc(await run(["draw", "--model", MINIMAL], { isTTY: true }))).toBe(true);
  expect(esc(await run(["draw", "--model", MINIMAL], { isTTY: true, env: { NO_COLOR: "1" } }))).toBe(false);
  expect(esc(await run(["draw", "--model", MINIMAL, "--no-color"], { isTTY: true }))).toBe(false);
  expect(esc(await run(["draw", "--model", MINIMAL, "--color"]))).toBe(true);
});

test("a model that is not there, not JSON or not a graph is a sentence and exit 1", async () => {
  const missing = await run(["draw", "--model", join(REPO, "nope.json")]);
  expect(missing.code).toBe(1);
  expect(missing.err).toMatch(/nope\.json/);
  const notJson = await run(["draw", "--model", join(REPO, "fixtures", "flowchart", "minimal.mmd")]);
  expect(notJson.code).toBe(1);
  expect(notJson.err).toMatch(/not JSON/);
  const sequence = await run(["draw", "--model", join(REPO, "fixtures", "sequence", "minimal.json")]);
  expect(sequence.code).toBe(1);
  expect(sequence.err).toMatch(/sequence diagrams cannot be drawn/);
  expect(sequence.out).toBe("");
});

test.each([
  [["draw"], /--model/],
  [["draw", "--model"], /--model/],
  [["draw", "--model", MINIMAL, "--width", "wide"], /--width/],
  [["draw", "--model", MINIMAL, "--width", "0"], /--width/],
  [["draw", "--model", MINIMAL, "--shout"], /--shout/],
])("misuse %j is a usage error, exit 2", async (args, message) => {
  const { code, err } = await run(args);
  expect(code).toBe(2);
  expect(err).toMatch(message);
});

test("--help prints the usage and exits 0", async () => {
  const { code, out } = await run(["--help"]);
  expect(code).toBe(0);
  expect(out).toMatch(/^usage: archer init/);
  for (const command of ["list", "validate", "compile", "draw", "mcp", "serve", "stop"])
    expect(out).toMatch(new RegExp(`^\\s+archer ${command}( |$)`, "m"));
  // Only commands that work here: the package's own commands are listed by the package.
  for (const command of ["setup", "upgrade", "uninstall"]) expect(out).not.toMatch(new RegExp(`archer ${command}\\b`));
});

test("a command Archer does not have is refused, exit 2", async () => {
  const { code, err } = await run(["frobnicate"]);
  expect(code).toBe(2);
  expect(err).toBe("archer frobnicate: unknown command; archer --help lists them\n");
});

// setup, upgrade and uninstall belong to the package (ts/pkg/bin/archer.mjs). A development or
// source install reaches this CLI with them, and says how to move to the package.
test.each(["setup", "upgrade", "uninstall"])(
  "archer %s outside a package install says how to install the package",
  async (command) => {
    const { code, out, err } = await run([command, "archer-0.4.0.tgz"]);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain(`archer ${command}: this Archer was installed for development (or from source)`);
    expect(err).toMatch(/npx --yes \.\/archer-\S+\.tgz setup/);
    expect(err).toContain("archer upgrade <archer-x.y.z.tgz>");
    expect(err).not.toContain("not yet implemented");
  },
);

// Whatever a person or a file puts in an argument or an id comes back in an
// error as text: no C0/C1 control or bidi override reaches the terminal.
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;
test("an unknown command is echoed without its control characters", async () => {
  const { code, err } = await run(["\u001b]0;pwned\u0007\u009b31m‮"]);
  expect(code).toBe(2);
  expect(err).not.toMatch(UNSAFE);
});

test("no command prints the usage as help and exits 0", async () => {
  const { code, out, err } = await run([]);
  expect(code).toBe(0);
  expect(err).toBe("");
  expect(out).toContain("usage: archer init");
});

test("setup --help prints setup's usage and exits 0, even from a development install", async () => {
  const { code, out, err } = await run(["setup", "--help"]);
  expect(code).toBe(0);
  expect(err).toBe("");
  expect(out).toContain("archer setup [--mcp] [--no-claude] [--no-codex]");
});

test("a command that takes no arguments says so, and an unknown flag to status is named", async () => {
  const list = await run(["list", "bogus"]);
  expect(list.code).toBe(2);
  expect(list.err).toContain("list takes no arguments");
  expect(list.err).not.toContain("at most 0");
  const status = await run(["status", "--help"]);
  expect(status.code).toBe(2);
  expect(status.err).toContain("status takes only --json (got --help)");
});
