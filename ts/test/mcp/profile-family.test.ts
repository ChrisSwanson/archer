// One family's part of the supported-Mermaid profile. The whole profile is ~45 KB (~11k tokens);
// small agents read it in full before every diagram (v1 small-agent evals, 2026-10-21).
import { readFileSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { PROFILE_FAMILIES, profileForFamily } from "../../src/guidance/profile.ts";
import { main, type Io } from "../../src/bin/main.ts";
import { connect, removeTempDirs, tempDir } from "./support.ts";

afterEach(removeTempDirs);

const PROFILE = readFileSync(new URL("../../docs/supported-mermaid.md", import.meta.url), "utf8");
const HEADINGS: Record<string, string> = {
  flowchart: "# Supported Mermaid flowchart profile",
  sequence: "# Supported Mermaid sequence diagram profile",
  state: "# Supported Mermaid state diagram profile",
  er: "# Supported Mermaid ER diagram profile",
  c4: "# Supported Mermaid C4 profile",
  architecture: "# Supported Mermaid architecture profile",
  journey: "# Supported Mermaid user journey profile",
};

test.each(Object.keys(HEADINGS))(
  "the %s part has the overview, that family's profile and the limits, and no other family",
  (family) => {
    expect(PROFILE_FAMILIES).toContain(family);
    const part = profileForFamily(PROFILE, family);
    expect(part.startsWith("# Supported Mermaid\n")).toBe(true);
    expect(part).toContain(`${HEADINGS[family]}\n`);
    expect(part).toContain("\n# Limits\n");
    // Server review S11: the family sections point to "Entity codes", so the part carries it.
    expect(part).toContain("\n# Entity codes\n");
    for (const [other, heading] of Object.entries(HEADINGS))
      if (other !== family) expect(part, other).not.toContain(`${heading}\n`);
    // About half at most: the flowchart part, the largest, is ~52% with entity codes.
    expect(part.length).toBeLessThan(PROFILE.length * 0.55);
  },
);

test("an unknown family is refused with the families there are", () => {
  expect(() => profileForFamily(PROFILE, "class")).toThrow(/flowchart, sequence, state, er, c4, architecture, journey/);
});

test("MCP serves a family's part as archer://docs/supported-mermaid/<family>, listed as a template", async () => {
  const { client, close } = await connect({ cwd: tempDir() });
  try {
    const read = await client.readResource({ uri: "archer://docs/supported-mermaid/c4" });
    expect((read.contents[0] as { text: string }).text).toBe(profileForFamily(PROFILE, "c4"));
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toContain("archer://docs/supported-mermaid/{family}");
  } finally {
    await close();
  }
});

test("archer docs supported-mermaid <family> prints that part", async () => {
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
  expect(await main(["docs", "supported-mermaid", "sequence"], io), stderr).toBe(0);
  expect(stdout).toBe(profileForFamily(PROFILE, "sequence"));
});
