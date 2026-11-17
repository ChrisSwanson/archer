// The one small skill (ADR 0035 §5): the heartbeat, the rule and answering by showing, with the
// references opened only when needed, and the plugin's slash commands turned into actions the person
// asks for in words (no hook calls an MCP tool by name).
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { main, type Io } from "../../src/bin/main.ts";

const skill = readFileSync(new URL("../../plugin/skills/archer/SKILL.md", import.meta.url), "utf8");

test("SKILL.md stays small and points at each reference once", () => {
  expect([...skill].length).toBeLessThanOrEqual(8500);
  for (const reference of ["cli", "mcp", "admin", "authoring", "docs-mode", "walkthroughs"])
    expect(skill.split("\n").filter((line) => line.includes(`references/${reference}.md`))).toHaveLength(1);
  expect(skill).toMatch(/## The heartbeat/);
  expect(skill).toMatch(/archer doctor/);
});

test("what the slash commands did is asked for in words and run as archer commands", () => {
  for (const command of [
    "archer present <view>",
    "archer list",
    "archer draw <view>",
    "archer listen --claim",
    "archer wait",
    "archer inbox",
  ])
    expect(skill).toContain(command);
  expect(skill).not.toMatch(/(^|\s)\/(present|draw|diagrams)\b/m);
});

test("nothing in the plugin's hooks calls an MCP tool by name", () => {
  const dir = new URL("../../plugin/hooks/", import.meta.url);
  for (const name of readdirSync(dir)) expect(readFileSync(new URL(name, dir), "utf8")).not.toMatch(/mcp__|tool\.call/);
  expect(JSON.parse(readFileSync(new URL("hooks.json", dir), "utf8"))).toEqual({ modules: [] });
});

test.each(["mcp", "admin"])("archer docs %s prints the skill's reference", async (id) => {
  let out = "";
  const io: Io = {
    stdout: (t) => {
      out += t;
    },
    stderr: () => undefined,
    isTTY: false,
    columns: undefined,
    env: {},
    cwd: "/does-not-exist",
  };
  expect(await main(["docs", id], io)).toBe(0);
  expect(out).toBe(readFileSync(new URL(`../../plugin/skills/archer/references/${id}.md`, import.meta.url), "utf8"));
});

// ADR 0036 §9: look up before you draw, and reuse a hit's id.
test("the skill says to look up each thing with find_elements before drawing it, and reuse its id", () => {
  expect(skill).toMatch(/find_elements[^.\n]*each thing you will draw[^.\n]*reuse a hit's id/);
});

test("the skill says to fix each advice finding, from a validate or a write, or say in one line why not (ADR 0036 §9)", () => {
  expect(skill).toMatch(/fix each\s+`advice` finding \(validate or write\) or say in one line why not/);
});

// ADR 0036 §14: several views on one canvas, not several links.
test("the skill says to show related views by presenting one diagram with expansions", () => {
  expect(skill).toMatch(/To show related views, present one diagram with expansions \(`expand`\)/);
});
