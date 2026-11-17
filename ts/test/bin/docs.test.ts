import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { main, type Io } from "../../src/bin/main.ts";

async function run(args: string[]) {
  let stdout = "",
    stderr = "";
  const io: Io = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    isTTY: false,
    columns: undefined,
    env: {},
    cwd: "/does-not-exist",
  };
  const code = await main(args, io);
  return { code, stdout, stderr };
}

test("docs discovers shared guides and reads canonical authoring without a project or service", async () => {
  const listed = await run(["docs", "--json"]);
  expect(listed.code, listed.stderr).toBe(0);
  expect(JSON.parse(listed.stdout).guides).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "authoring", uri: "archer://docs/authoring" }),
      expect.objectContaining({ id: "cli", uri: "archer://docs/cli" }),
      expect.objectContaining({ id: "supported-mermaid", uri: "archer://docs/supported-mermaid" }),
    ]),
  );
  for (const id of ["authoring", "cli"]) {
    const result = await run(["docs", id]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      readFileSync(new URL(`../../plugin/skills/archer/references/${id}.md`, import.meta.url), "utf8"),
    );
  }
  const profile = await run(["docs", "supported-mermaid"]);
  expect(profile.code, profile.stderr).toBe(0);
  expect(profile.stdout).toBe(readFileSync(new URL("../../docs/supported-mermaid.md", import.meta.url), "utf8"));
});

test.each([["../secret"], ["authoring", "extra"], ["--unknown"], ["authoring", "--json"]])(
  "docs refuses unsupported requests: %j",
  async (...args) => {
    const result = await run(["docs", ...args]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("archer docs");
  },
);
