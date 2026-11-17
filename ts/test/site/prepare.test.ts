import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { prepareDocs } from "../../../site/scripts/prepare.ts";

const scratch: string[] = [];
afterAll(async () => {
  await Promise.all(scratch.map((path) => rm(path, { recursive: true, force: true })));
});

it("publishes only admitted reference pages and their machine-readable source", async () => {
  const siteRoot = await mkdtemp(join(tmpdir(), "archer-docs-ia-"));
  scratch.push(siteRoot);
  await prepareDocs({ siteRoot });
  const files = await readdir(siteRoot, { recursive: true });
  // The docs pass writes the Examples bridges and nothing of the Playground app or the retired gallery.
  expect(files).toContain("generated/examples/archer-tour/diagrams/heartbeat.md");
  expect(files).toContain("generated/examples/rfc-2324-htcpcp/notice.md");
  expect(
    files.filter((file) => /^public\/(?:playground|generated)\b|\.svg$|sidebar\.json$|hero\.json$/.test(file)),
  ).toEqual([]);
  expect(files).not.toContain("security/known-limits.md");
  expect(files).not.toContain("security/index.md");
  expect(files).toContain("supported-mermaid/flowchart.md");
  expect(files).toContain("public/llms.txt");
  expect(files).toContain("public/llms-full.txt");
  const cli = await readFile(join(siteRoot, "generated/cli.md"), "utf8");
  expect(cli).toMatch(/^## setup$/m);
  expect(cli).toMatch(/^### walkthrough write$/m);
  expect(cli).not.toContain("## Command synopsis");
  const index = await readFile(join(siteRoot, "public/llms.txt"), "utf8");
  expect(index).toContain("/archer/install");
  expect(index).toContain("/archer/supported-mermaid/flowchart");
  expect(index).not.toMatch(/known-limits|Security & Network Access/);
  const full = await readFile(join(siteRoot, "public/llms-full.txt"), "utf8");
  expect(full).toContain("archer setup");
  expect(full).toContain("Common problems and fixes");
  expect(full).not.toContain("Generated from");
}, 30_000);
