import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const script = join(root, "site/public/install.sh");
const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});
function temporary() {
  const path = mkdtempSync(join(tmpdir(), "archer-installer-"));
  scratch.push(path);
  return path;
}
function fixture() {
  const dir = temporary();
  const release = join(dir, "release");
  const bin = join(dir, "bin");
  const temp = join(dir, "temp");
  for (const path of [release, bin, temp]) mkdirSync(path);
  const packageBytes = "a release package\n";
  writeFileSync(join(release, "archer.tgz"), packageBytes);
  const hash = createHash("sha256").update(packageBytes).digest("hex");
  writeFileSync(join(release, "SHA256SUMS"), `${hash}  archer.tgz\n${hash}  archer-0.15.0.tgz\n`);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell parameter expansion.
  writeFileSync(join(bin, "node"), '#!/bin/sh\nprintf "%s\\n" "${TEST_NODE_VERSION:-v22.18.0}"\n');
  // Capture the final process boundary; downloading and checksum verification remain real.
  writeFileSync(
    join(bin, "npx"),
    // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell parameter expansion.
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$TEST_CALL"\ncp ./archer.tgz "$TEST_PACKAGE"\nexit "${TEST_NPX_STATUS:-0}"\n',
  );
  chmodSync(join(bin, "node"), 0o755);
  chmodSync(join(bin, "npx"), 0o755);
  const call = join(dir, "call");
  const installed = join(dir, "installed");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TMPDIR: temp,
    ARCHER_RELEASE_BASE: pathToFileURL(release).href,
    TEST_CALL: call,
    TEST_PACKAGE: installed,
  };
  return {
    release,
    temp,
    call,
    installed,
    env,
    run: (extra: NodeJS.ProcessEnv = {}, args: string[] = []) =>
      spawnSync("sh", [script, ...args], { env: { ...env, ...extra }, encoding: "utf8" }),
  };
}

it("publishes a stable package name and verifies both release names using the workflow's shell", () => {
  // The public workflow: in this tree under the export overlay; in the exported tree, where the overlay is applied.
  const published = join(root, ".github/workflows/release.yml");
  const workflow = readFileSync(
    existsSync(published) ? published : join(root, "scripts/oss-export.overlay/.github/workflows/release.yml"),
    "utf8",
  );
  const block = workflow.split("- name: Smoke-check and checksum")[1]!.split("- uses:")[0]!.split("run: |\n")[1]!;
  const command = block
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
  const dir = temporary();
  mkdirSync(join(dir, "dist"));
  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, "dist/archer-0.15.0.tgz"), "package bytes");
  writeFileSync(join(dir, "scripts/release-smoke.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  execFileSync("bash", ["-c", command], { cwd: dir, env: { ...process.env, VERSION: "0.15.0" } });
  expect(readFileSync(join(dir, "dist/archer.tgz"))).toEqual(readFileSync(join(dir, "dist/archer-0.15.0.tgz")));
  expect(readFileSync(join(dir, "dist/SHA256SUMS"), "utf8")).toMatch(/ {2}archer\.tgz$/m);
  expect(workflow).toContain("            dist/archer.tgz\n");
  expect(workflow).toContain('assets=("dist/archer-$VERSION.tgz" dist/archer.tgz dist/SHA256SUMS)');
});

// The landing and install guide pipe the script into `sh` (`curl … | sh`, `| sh -s -- --mcp`): it must run from
// stdin under a POSIX shell, including dash where it is installed (Debian and Ubuntu's /bin/sh).
for (const shell of ["sh", ...(spawnSync("dash", ["-c", "exit 0"]).status === 0 ? ["dash"] : [])])
  it(`runs piped into ${shell} -s, passing setup arguments after --`, () => {
    const test = fixture();
    const result = spawnSync(shell, ["-s", "--", "--mcp"], {
      input: readFileSync(script),
      env: test.env,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(test.call, "utf8")).toBe("--yes\n./archer.tgz\nsetup\n--mcp\n");
    expect(result.stdout).toContain("Verified archer.tgz");
  });

it("downloads, verifies, and passes setup arguments unchanged, then removes its temporary directory", () => {
  const test = fixture();
  const result = test.run({}, ["--mcp", "--bin-dir", "a path with spaces"]);
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(test.call, "utf8")).toBe("--yes\n./archer.tgz\nsetup\n--mcp\n--bin-dir\na path with spaces\n");
  expect(readFileSync(test.installed, "utf8")).toBe("a release package\n");
  expect(result.stdout).toContain("Verified archer.tgz");
  expect(result.stdout).toContain("Archer setup completed");
  expect(readdirSync(test.temp)).toEqual([]);
});

it.each(["v22.17.0", "v20.20.0", "invalid"])("refuses unsupported Node %s before setup", (version) => {
  const test = fixture();
  const result = test.run({ TEST_NODE_VERSION: version });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Node 22.18 or newer");
  expect(readdirSync(test.temp)).toEqual([]);
  expect(() => readFileSync(test.call)).toThrow();
});

it.each(["v22.18.0", "v22.19.0", "v24.0.0"])("accepts supported Node %s", (version) => {
  const test = fixture();
  const result = test.run({ TEST_NODE_VERSION: version });
  expect(result.status, result.stderr).toBe(0);
});

it.each(["corrupt", "missing-checksum", "missing-package", "setup-fails"])(
  "fails safely for %s and cleans downloads",
  (failure) => {
    const test = fixture();
    if (failure === "corrupt") writeFileSync(join(test.release, "archer.tgz"), "changed bytes");
    if (failure === "missing-checksum") writeFileSync(join(test.release, "SHA256SUMS"), "");
    if (failure === "missing-package") rmSync(join(test.release, "archer.tgz"));
    const result = test.run(failure === "setup-fails" ? { TEST_NPX_STATUS: "7" } : {});
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("Archer setup completed");
    expect(readdirSync(test.temp)).toEqual([]);
    if (failure !== "setup-fails") expect(() => readFileSync(test.call)).toThrow();
  },
);

it.each([
  [undefined, "https://github.com/chrisswanson/archer/releases/latest/download/archer.tgz"],
  ["0.15.0", "https://github.com/chrisswanson/archer/releases/download/v0.15.0/archer.tgz"],
  ["v0.15.0", "https://github.com/chrisswanson/archer/releases/download/v0.15.0/archer.tgz"],
])("selects the release URL for version %s", (version, url) => {
  const test = fixture();
  const bin = test.env.PATH.split(":")[0]!;
  writeFileSync(join(bin, "curl"), '#!/bin/sh\nprintf "%s\\n" "$2" > "$TEST_CALL"\nexit 22\n', { mode: 0o755 });
  const result = test.run({ ARCHER_RELEASE_BASE: "", ARCHER_VERSION: version });
  expect(result.status).not.toBe(0);
  expect(readFileSync(test.call, "utf8").trim()).toBe(url);
  expect(readdirSync(test.temp)).toEqual([]);
});
