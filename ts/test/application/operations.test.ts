import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { FLOW, removeTempDirs, tempDir } from "../project/support.ts";

afterEach(removeTempDirs);

test("public application runs the production inventory without a transport", async () => {
  const entry = new URL("../../src/application/index.ts", import.meta.url);
  expect(existsSync(entry), "a shared application entry point exists").toBe(true);
  const { createApplication, OPERATIONS } = await import(entry.href);
  const app = createApplication({ cwd: tempDir({ ".archer/overview.mmd": FLOW }) });
  try {
    const answer = await app.call("list_diagrams", {});
    expect(answer.structured.views).toMatchObject([{ id: "overview" }]);
    expect(answer.text).toContain("1 diagrams");
    expect(OPERATIONS).toHaveLength(41);
    expect(OPERATIONS.map((operation: { readonly name: string }) => operation.name)).toEqual(
      expect.arrayContaining(["list_changes", "read_change", "resolve_change", "issue_authoring_access"]),
    );
    const root = fileURLToPath(new URL("../../src/application", import.meta.url));
    for (const path of readdirSync(root)) {
      expect(readFileSync(join(root, path), "utf8"), path).not.toMatch(/from ["'](?:@modelcontextprotocol|\.\.\/mcp)/);
    }
  } finally {
    app.close();
  }
});

test("public operation input refuses malformed values under a stable domain code", async () => {
  const { createApplication, OperationError, OPERATIONS } = await import("../../src/application/index.ts");
  const app = createApplication({ cwd: tempDir() });
  try {
    for (const operation of OPERATIONS) {
      for (const value of [null, false, 7, "source", []]) {
        let failure: unknown;
        try {
          await app.call(operation.name, value as never);
        } catch (error) {
          failure = error;
        }
        expect(failure, `${operation.name}: ${JSON.stringify(value)}`).toBeInstanceOf(OperationError);
        expect((failure as InstanceType<typeof OperationError>).data.code).toBe("invalid_arguments");
      }
    }
  } finally {
    app.close();
  }
});

test("the programmatic application's resolved dependency graph excludes MCP", async () => {
  const { build } = await import("esbuild");
  const built = await build({
    entryPoints: [fileURLToPath(new URL("../../src/api.ts", import.meta.url))],
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    alias: {
      "@archer/export-painter": fileURLToPath(new URL("../../../ui/src/export/painter.ts", import.meta.url)),
      "@archer/layout-analysis": fileURLToPath(new URL("../../../ui/src/layout/analysis.ts", import.meta.url)),
    },
    logLevel: "silent",
  });
  const inputs = Object.keys(built.metafile!.inputs);
  expect(inputs.length).toBeGreaterThan(10);
  for (const input of inputs) expect(input).not.toMatch(/(?:src\/mcp\/|@modelcontextprotocol\/)/);
}, 15_000); // bundles the API with esbuild: 1.2 s idle, 2.8 s under CPU load, 5.2 s (timed out) beside the UI and browser jobs

// flows-r1 (S4): list_diagrams listed a registered diagram whose file is gone with nothing to say so.
test("list_diagrams flags a registered view whose file is missing, in the structure and the text", async () => {
  const { createApplication } = await import("../../src/application/index.ts");
  const manifest =
    'version = 1\n\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "The flow"\nsource = ".archer/gone.mmd"\n\n[[views]]\nid = "here"\nkind = "freeform"\ntitle = "Here"\nsource = ".archer/here.mmd"\n';
  const app = createApplication({ cwd: tempDir({ "archer.toml": manifest, ".archer/here.mmd": FLOW }) });
  try {
    const answer = await app.call("list_diagrams", {});
    const views = answer.structured.views as { id: string; sourceStatus?: string }[];
    expect(views.find((v) => v.id === "flow")).toMatchObject({ sourceStatus: "missing" });
    expect(views.find((v) => v.id === "here")).not.toHaveProperty("sourceStatus");
    expect(answer.text).toMatch(/"flow": its source file is missing/);
  } finally {
    app.close();
  }
});
