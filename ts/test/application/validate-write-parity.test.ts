// validate_diagram reports, as errors at the same lines, whatever write_diagram would refuse
// (package review P6, server review S10): the reading rules (ADR 0030) and added nesting (ADR 0029).
import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { cleanUp, tempDir, write } from "../service/support.ts";

afterEach(cleanUp);

const BASE = "flowchart LR\n  a[Client] e1@--> b[API]\n";
const LONG =
  "flowchart LR\n  a[Client] e1@-->|sends the signed order request with every line item and the address| b[API]\n";
type Diag = { code: string; severity: string; span: { start: { line: number } } };

async function both(app: ReturnType<typeof createApplication>, viewId: string, source: string) {
  const validated = await app.call("validate_diagram", { viewId, source });
  const read = await app.call("read_diagram", { viewId });
  const refused = await app
    .call("write_diagram", { viewId, source, expectedRevision: read.structured.sourceRevision })
    .then(
      () => undefined,
      (error: { data?: Record<string, unknown> }) => error,
    );
  return { validated, refused };
}

test.each([
  ["a file", ".archer/flow.mmd", BASE, "flow", (s: string) => s],
  [
    "an embedded diagram",
    ".archer/notes/n.md",
    `---\nauthor: agent\n---\n# N\n\n\`\`\`mermaid\n%% archer-id: flow\n${BASE}\`\`\`\n`,
    "notes/n.md#flow",
    (s: string) => `%% archer-id: flow\n${s}`,
  ],
])("what write refuses, validate calls an error at the same line (%s)", async (_, path, content, viewId, shape) => {
  const cwd = tempDir();
  write(cwd, path, content);
  const app = createApplication({ cwd });
  try {
    const { validated, refused } = await both(app, viewId, shape(LONG));
    expect(refused?.data?.code).toBe("invalid_source");
    const writeLines = (refused!.data!.diagnostics as Diag[]).map((d) => [d.code, d.span.start.line]);
    expect(validated.structured.valid).toBe(false);
    const errors = (validated.structured.diagnostics as Diag[])
      .filter((d) => d.severity === "error")
      .map((d) => [d.code, d.span.start.line]);
    expect(errors).toEqual(writeLines);
    expect(String(validated.text)).toContain("write_diagram would refuse");
  } finally {
    app.close();
  }
});

test("a finding the file already has stays a warning, and validate still says valid", async () => {
  const cwd = tempDir();
  write(cwd, ".archer/flow.mmd", LONG);
  const app = createApplication({ cwd });
  try {
    const validated = await app.call("validate_diagram", { viewId: "flow", source: LONG.replace("API", "Service") });
    expect(validated.structured.valid).toBe(true);
    expect((validated.structured.diagnostics as Diag[]).map((d) => [d.code, d.severity])).toEqual([
      ["edge_label_too_long", "warning"],
    ]);
  } finally {
    app.close();
  }
});
