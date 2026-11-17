// What a running agent session has loaded from Archer: the MCP tools it listed and the server's
// instructions. `archer upgrade` compares it across versions to say whether sessions must restart.
import { expect, test } from "vitest";
import { agentSurface } from "../../src/mcp/surface.ts";
import { main } from "../../src/bin/main.ts";

test("the agent surface lists every MCP tool and the instructions, and its digest is stable", async () => {
  const surface = await agentSurface();
  expect(surface.tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(["read_diagram", "write_diagram", "present_diagram", "start_service"]),
  );
  expect(surface.instructions).toMatch(/instance_choice_needed/);
  expect((await agentSurface()).digest).toBe(surface.digest);
  expect(surface.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
});

// ADR 0036 §8, A7: find_elements is one new tool, so the digest moves and agent sessions restart once on the
// 0.12.0 upgrade. That is expected; this pins what the new tool brings to the surface.
test("find_elements is on the agent surface, read-only, with its query, id and filters", async () => {
  const surface = await agentSurface();
  const tool = surface.tools.find((t) => t.name === "find_elements") as
    | {
        name: string;
        description?: string;
        annotations?: { readOnlyHint?: boolean };
        inputSchema?: {
          properties?: Record<string, { maxLength?: number; maximum?: number; enum?: string[] }>;
          required?: string[];
          additionalProperties?: boolean;
        };
      }
    | undefined;
  expect(tool?.annotations?.readOnlyHint).toBe(true);
  expect(Object.keys(tool?.inputSchema?.properties ?? {}).sort()).toEqual([
    "diagram",
    "id",
    "kind",
    "limit",
    "outputFormat",
    "parent",
    "query",
  ]);
  expect(tool?.inputSchema?.required ?? []).toEqual([]);
  expect(tool?.inputSchema?.additionalProperties).toBe(false);
  expect(tool?.inputSchema?.properties?.["query"]?.maxLength).toBe(200);
  expect(tool?.inputSchema?.properties?.["limit"]?.maximum).toBe(50);
  expect(tool?.inputSchema?.properties?.["kind"]?.enum).toEqual(["person", "system", "container", "component", "code"]);
  expect(tool?.description).toMatch(/reuse a hit's id/i);
});

// ADR 0036 §14, A7, A11: present_diagram's expand and get_presentation_context's exploration change the tool
// descriptions, so the digest moves again in the same release; agent sessions restart once on the upgrade.
test("present_diagram takes expand on the agent surface: {element, source} pairs, bounded", async () => {
  const surface = await agentSurface();
  type Prop = {
    type?: string;
    maxItems?: number;
    description?: string;
    items?: { properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  };
  const present = surface.tools.find((t) => t.name === "present_diagram") as
    | { description?: string; inputSchema?: { properties?: Record<string, Prop>; required?: string[] } }
    | undefined;
  const expand = present?.inputSchema?.properties?.["expand"];
  expect(expand?.type).toBe("array");
  expect(expand?.maxItems).toBe(24);
  expect(expand?.items?.required).toEqual(["element", "source"]);
  expect(expand?.items?.additionalProperties).toBe(false);
  expect(expand?.description).toMatch(/not with walkthrough/);
  expect(present?.inputSchema?.required).toEqual(["viewId"]);
  expect(present?.description).toMatch(/expand adds other diagrams' parts/);
  const context = surface.tools.find((t) => t.name === "get_presentation_context") as
    | { description?: string }
    | undefined;
  expect(context?.description).toMatch(/`exploration`/);
});

test("archer agent-surface prints the digest", async () => {
  let out = "";
  expect(
    await main(["agent-surface"], {
      stdout: (t) => {
        out += t;
      },
      stderr: () => {},
      env: {},
      isTTY: false,
      columns: undefined,
    }),
  ).toBe(0);
  expect(out).toBe(`${(await agentSurface()).digest}\n`);
});
