// What a tool's description promises an agent matches what the tool does.
import { expect, test } from "vitest";
import { TOOLS } from "../../src/mcp/tools.ts";

const describe = (name: string) => TOOLS.find((t) => t.name === name)?.description ?? "";

test("find_elements says plain flowchart nodes are not indexed and how to make them findable", () => {
  expect(describe("find_elements")).toMatch(/without (a|one)[^.]*not found[^.]*class/i);
  expect(describe("find_elements")).toContain(":::system");
});

test("write_diagram lists status unchanged among its results", () => {
  expect(describe("write_diagram")).toContain('status "unchanged"');
});
