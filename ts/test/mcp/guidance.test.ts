import { readFileSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { connect, removeTempDirs, tempDir } from "./support.ts";

afterEach(removeTempDirs);

test.each(["authoring", "cli", "walkthroughs"])(
  "MCP discovers and reads the canonical %s skill reference",
  async (id) => {
    const { client, close } = await connect({ cwd: tempDir() });
    try {
      const uri = `archer://docs/${id}`;
      const { resources } = await client.listResources();
      expect(resources.find((resource) => resource.uri === uri)).toMatchObject({
        uri,
        mimeType: "text/markdown",
      });
      const result = await client.readResource({ uri });
      const canonical = readFileSync(
        new URL(`../../plugin/skills/archer/references/${id}.md`, import.meta.url),
        "utf8",
      );
      expect(result.contents).toEqual([{ uri, mimeType: "text/markdown", text: canonical }]);
      expect(client.getInstructions()).toContain(uri);
      const tools = (await client.listTools()).tools;
      expect(tools).toHaveLength(41);
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["list_changes", "read_change", "resolve_change", "issue_authoring_access"]),
      );
    } finally {
      await close();
    }
  },
);

// The docs-mode reference (docs/proposals/doc-pack.md, change 1): a resource and `archer docs docs-mode`,
// read on demand. The MCP instructions carry one fixed sentence pointing at it (archer-modes.md, slice 1),
// so an agent that never loads the skill or reads AGENTS.md still reaches it, without detecting the mode.
test("MCP serves the docs-mode reference verbatim, within its 6,000-character budget", async () => {
  const { client, close } = await connect({ cwd: tempDir() });
  try {
    const uri = "archer://docs/docs-mode";
    const canonical = readFileSync(
      new URL("../../plugin/skills/archer/references/docs-mode.md", import.meta.url),
      "utf8",
    );
    expect((await client.readResource({ uri })).contents).toEqual([
      { uri, mimeType: "text/markdown", text: canonical },
    ]);
    expect([...canonical].length).toBeLessThanOrEqual(6000);
    const skill = readFileSync(new URL("../../plugin/skills/archer/SKILL.md", import.meta.url), "utf8");
    expect(skill.split("\n").filter((line) => line.includes("references/docs-mode.md"))).toHaveLength(1);
  } finally {
    await close();
  }
});

// Walkthroughs (ADR 0034 §5): guidance stays small: a reference within 3,000 characters, one skill bullet, one clause.
test("the walkthroughs reference stays within 3,000 characters, with one skill bullet and one instructions clause", async () => {
  const { client, close } = await connect({ cwd: tempDir() });
  try {
    const canonical = readFileSync(
      new URL("../../plugin/skills/archer/references/walkthroughs.md", import.meta.url),
      "utf8",
    );
    expect([...canonical].length).toBeLessThanOrEqual(3000);
    const skill = readFileSync(new URL("../../plugin/skills/archer/SKILL.md", import.meta.url), "utf8");
    expect(skill.split("\n").filter((line) => line.includes("references/walkthroughs.md"))).toHaveLength(1);
    const instructions = client.getInstructions() ?? "";
    expect(instructions.split(/(?<=\.) /).filter((sentence) => sentence.includes("walkthrough"))).toHaveLength(1);
    expect([...instructions].length).toBeLessThanOrEqual(6000);
  } finally {
    await close();
  }
});

test("the MCP instructions name the docs-mode reference in one fixed sentence", async () => {
  const { client, close } = await connect({ cwd: tempDir() });
  try {
    const sentences = (client.getInstructions() ?? "")
      .split(/(?<=\.) /)
      .filter((sentence) => sentence.includes("archer://docs/docs-mode"));
    expect(sentences).toEqual(['If archer.toml sets mode = "docs", read archer://docs/docs-mode first.']);
  } finally {
    await close();
  }
});

test("an unknown resource points to all available guidance without interpreting its path", async () => {
  const { client, close } = await connect({ cwd: tempDir() });
  try {
    await expect(client.readResource({ uri: "archer://docs/../../secret" })).rejects.toMatchObject({
      data: { code: "resource_not_found" },
      message: expect.stringContaining("archer://docs/authoring"),
    });
    await expect(client.readResource({ uri: "archer://docs/unknown" })).rejects.toMatchObject({
      message: expect.stringContaining("archer://docs/cli"),
    });
  } finally {
    await close();
  }
});

test("guidance is lazily read without project inventory or service access", async () => {
  const reads: string[] = [];
  const { client, close } = await connect({
    cwd: tempDir({ "archer.toml": "not valid TOML = [" }),
    guidanceText: (id) => {
      reads.push(id);
      return `# Installed ${id}`;
    },
    profileText: () => "# Existing profile",
    uiHtml: () => "<html>Existing app</html>",
  });
  try {
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri)).toEqual([
      "ui://archer/diagram",
      "archer://docs/supported-mermaid",
      "archer://docs/surfaces",
      "archer://docs/authoring",
      "archer://docs/cli",
      "archer://docs/mcp",
      "archer://docs/admin",
      "archer://docs/docs-mode",
      "archer://docs/walkthroughs",
    ]);
    expect(reads).toEqual([]);
    expect((await client.readResource({ uri: "archer://docs/authoring" })).contents).toEqual([
      { uri: "archer://docs/authoring", mimeType: "text/markdown", text: "# Installed authoring" },
    ]);
    expect(reads).toEqual(["authoring"]);
    expect((await client.readResource({ uri: "archer://docs/supported-mermaid" })).contents[0]).toMatchObject({
      text: "# Existing profile",
    });
    expect((await client.readResource({ uri: "ui://archer/diagram" })).contents[0]).toMatchObject({
      text: "<html>Existing app</html>",
    });
    expect((await client.listResourceTemplates()).resourceTemplates).toMatchObject([
      { uriTemplate: "archer://diagram/{viewId}/source" },
      { uriTemplate: "archer://docs/supported-mermaid/{family}" },
    ]);
  } finally {
    await close();
  }
});

// A setup or access error is the agent's to fix (its `fix`), never a reason to stop or to hand the person a file.
test("the skill and the instructions say to follow an error's fix and ask only for the yes it needs", async () => {
  const { client, close } = await connect({ cwd: tempDir() });
  try {
    const skill = readFileSync(new URL("../../plugin/skills/archer/SKILL.md", import.meta.url), "utf8").replace(
      /\s+/g,
      " ",
    );
    for (const text of [client.getInstructions() ?? "", skill]) {
      expect(text).toMatch(
        /On a setup or access error, follow the `?fix`? it names\. Don't stop or hand config editing to the person; ask only for the yes it requires\./,
      );
      expect(text).not.toMatch(/do not change its settings/);
    }
  } finally {
    await close();
  }
});
