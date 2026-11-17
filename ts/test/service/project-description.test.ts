import { afterEach, expect, test } from "vitest";
import { ProjectState } from "../../src/service/project-state.ts";
import { connectService } from "../../src/service/service-client.ts";
import { cleanUp, http, service, tempDir, write, apiBase } from "./support.ts";

afterEach(cleanUp);

test("browser project descriptions prefer archer.toml, then the root README, never the Archer folder's README", async () => {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  const html = '<img src=x onerror="alert(1)">';
  const cases: { manifest: string; expected: string | undefined; readme?: false }[] = [
    { manifest: `description='${html}'\n`, expected: html },
    { manifest: 'description="Explicit"\n[discovery]\nroots=[]\n', expected: "Explicit" },
    { manifest: '[discovery]\nroots=["README.md", ".archer"]\n', expected: "Root context." },
    { manifest: "", expected: "Root context." },
    { manifest: 'folder="knowledge"\n', expected: "Root context." },
    { manifest: "[discovery]\nroots=[]\n", expected: "Root context." },
    { manifest: '[discovery]\nroots=["README.md", ".archer"]\nexclude=["README.md"]\n', expected: undefined },
    { manifest: 'description="   "\n', expected: "Root context." },
    { manifest: "", expected: undefined, readme: false },
  ];
  try {
    for (const [index, entry] of cases.entries()) {
      const root = tempDir();
      write(root, "archer.toml", `version=1\nname="Project ${index}"\n${entry.manifest}`);
      if (entry.readme !== false) write(root, "README.md", "# Root\n\nRoot context.");
      write(root, ".archer/README.md", "# Authoring\n\nAuthoring context.");
      write(root, "knowledge/README.md", "# Custom\n\nCustom authoring context.");
      const attached = await client.call("attach", { root });
      const reply = await http(apiBase(attached.url) + "api/browser-projects");
      expect(reply.status).toBe(200);
      const catalog = JSON.parse(reply.body) as { projects: { name: string; description?: string }[] };
      const project = catalog.projects.find((project) => project.name === `Project ${index}`);
      expect(project).toBeDefined();
      expect(project?.description).toBe(entry.expected);
      if (entry.expected === undefined) expect(project).not.toHaveProperty("description");
    }
  } finally {
    client.close();
  }
});

test("manifest reload updates optional descriptions and preserves other project metadata", async () => {
  const root = tempDir();
  const manifest = (description: string) =>
    `version=1\nname="Named"\ndescription="${description}"\nfolder="knowledge"\n[service]\nname="named"\n[discovery]\nroots=[]\n`;
  write(root, "archer.toml", manifest("Before"));
  const state = await ProjectState.open(root, (slug) => `http://example/${slug}/`);
  try {
    expect(state.description).toBe("Before");
    write(root, "archer.toml", manifest("After"));
    await state.reload();
    expect(state.description).toBe("After");
    expect(state.project).toMatchObject({
      name: "Named",
      folderSetting: "knowledge",
      serviceName: "named",
      discovery: { roots: [] },
    });
    write(root, "archer.toml", manifest("   "));
    await state.reload();
    expect(state.description).toBeUndefined();
  } finally {
    state.close();
  }
});
