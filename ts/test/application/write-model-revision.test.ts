import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { connectService } from "../../src/service/service-client.ts";
import { cleanUp, service, tempDir, write } from "../service/support.ts";

afterEach(cleanUp);

const initial = "%% archer-id: policy\nflowchart LR\n  a[Audit]\n";
const changed = initial.replace("[Audit]", "[Retained audit]");
const cases = [
  { name: "standalone", viewId: "policy", path: ".archer/policy.mmd", wrap: (source: string) => source },
  {
    name: "embedded",
    viewId: "policy.md#policy",
    path: ".archer/policy.md",
    wrap: (source: string) => `# Retention\n\n\`\`\`mermaid\n${source}\`\`\`\n`,
  },
];

for (const fixture of cases) {
  test.each([
    { name: "changed", source: changed },
    { name: "unchanged", source: initial },
  ])(`${fixture.name} $name compiled write returns its fresh actual model revision`, async ({ source }) => {
    const cwd = tempDir();
    write(cwd, fixture.path, fixture.wrap(initial));
    const app = createApplication({ cwd });
    try {
      const before = await app.call("read_diagram", { viewId: fixture.viewId });
      const written = await app.call("write_diagram", {
        viewId: fixture.viewId,
        source,
        expectedRevision: before.structured.sourceRevision,
      });
      expect(written.structured.modelRevision).toMatch(/^sha256:[0-9a-f]{64}$/);
      const after = await app.call("read_diagram", { viewId: fixture.viewId });
      expect(written.structured.modelRevision).toBe(after.structured.modelRevision);
      expect(written.structured.sourceRevision).toBe(after.structured.sourceRevision);
      expect(written.structured.revision).toBe(written.structured.sourceRevision);
      if (fixture.name === "embedded")
        expect(written.structured.modelRevision).not.toBe(written.structured.sourceRevision);
    } finally {
      app.close();
    }
  });

  test(`${fixture.name} failed write omits modelRevision while preserving its source revision`, async () => {
    const cwd = tempDir();
    write(cwd, fixture.path, fixture.wrap(initial));
    const app = createApplication({ cwd });
    try {
      const before = await app.call("read_diagram", { viewId: fixture.viewId });
      const written = await app.call("write_diagram", {
        viewId: fixture.viewId,
        source: "%% archer-id: policy\nflowchart LR\n a[Broken\n",
        expectedRevision: before.structured.sourceRevision,
      });
      expect(written.structured.status).toBe("failed");
      expect(written.structured).not.toHaveProperty("modelRevision");
      expect(written.structured.revision).toBe(written.structured.sourceRevision);
      const after = await app.call("read_diagram", { viewId: fixture.viewId });
      expect(after.structured.sourceRevision).toBe(written.structured.sourceRevision);
      if (fixture.name === "standalone") expect(after.structured.modelRevision).toBe(before.structured.modelRevision);
    } finally {
      app.close();
    }
  });

  test(`${fixture.name} fresh write modelRevision guards real presentation without a follow-up read`, async () => {
    const cwd = tempDir();
    write(cwd, fixture.path, fixture.wrap(initial));
    const { svc } = await service();
    const app = createApplication({
      cwd,
      ensureService: () => connectService(svc.socketPath),
      findService: () => connectService(svc.socketPath),
    });
    try {
      const before = await app.call("read_diagram", { viewId: fixture.viewId });
      const written = await app.call("write_diagram", {
        viewId: fixture.viewId,
        source: changed,
        expectedRevision: before.structured.sourceRevision,
      });
      expect(written.structured.modelRevision).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(written.structured.modelRevision).not.toBe(before.structured.modelRevision);
      const presented = await app.call("present_diagram", {
        viewId: fixture.viewId,
        expectedRevision: written.structured.modelRevision,
      });
      expect((presented.structured.envelope as { revision: string }).revision).toBe(written.structured.modelRevision);
    } finally {
      app.close();
    }
  });
}
