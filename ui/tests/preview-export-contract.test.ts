// The gallery's HTTP export seam, on the production service: it renders the
// production-compiled model, and changes no reader state.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { startTsProject } from "./support/ts-service";

const SOURCE =
  "flowchart LR\n web[Web app] e1@-->|HTTPS| api[API]\n subgraph backend[Backend]\n api\n db[(Database)]\n end\n api e2@--> db\n";
const TS_SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "../../ts/src");
const load = async <T>(path: string): Promise<T> =>
  import(/* @vite-ignore */ pathToFileURL(join(TS_SOURCE, path)).href) as Promise<T>;

test("gallery SVG export preserves the compiled model, source and reader state", async () => {
  const { compile } = await load<{ compile(source: string): Promise<{ model: unknown; diagnostics: unknown[] }> }>(
    "mermaid/index.ts",
  );
  const compiled = await compile(SOURCE);
  expect(compiled.model, JSON.stringify(compiled.diagnostics)).not.toBeNull();
  const project = await startTsProject({
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "system"\nkind = "freeform"\ntitle = "The system"\nsource = ".archer/system.mmd"\n',
      ".archer/system.mmd": SOURCE,
    },
  });
  // The signed-in browser's requests: its cookie, and its Origin on a write.
  const server = project;
  const get = async (path: string) => (await server.fetch(path)).json();
  const post = async (path: string, body: unknown) =>
    server.fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    await project.present("system", "Keep this presentation");
    const envelope = await get("api/diagrams/system");
    const bootstrap = await get("api/bootstrap");
    const selected = await post("api/selection", {
      schemaVersion: 1,
      viewId: "system",
      revision: envelope.revision,
      presentationId: bootstrap.presentation.presentationId,
      nodes: [{ id: "web" }],
      edges: [],
    });
    expect(selected.status).toBe(204);
    const bootstrapBefore = await get("api/bootstrap");
    const selection = await project.selection();
    const sourceBefore = readFileSync(join(project.root, ".archer/system.mmd"), "utf8");
    const response = await post("api/operations", {
      name: "export_diagram",
      arguments: {
        viewId: "system",
        format: "svg",
        mode: "diagram",
        theme: "light",
        scale: 1,
        allowLastGood: false,
      },
    });
    expect(response.status).toBe(200);
    const artifact = await response.json();
    expect(artifact).toMatchObject({
      mimeType: "image/svg+xml",
      encoding: "base64",
      revision: envelope.revision,
      lastGood: false,
    });
    expect(artifact.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
    const svg = Buffer.from(artifact.data, "base64").toString("utf8");
    expect(Buffer.from(svg).toString("base64")).toBe(artifact.data);
    expect(svg).toMatch(/^<svg\b/);
    for (const id of ["web", "api", "db", "backend"]) expect(svg).toContain(`data-element-id="${id}"`);
    expect(svg).not.toMatch(/<script|foreignObject/);
    expect(await get("api/diagrams/system")).toEqual(envelope);
    expect(await get("api/bootstrap")).toEqual(bootstrapBefore);
    expect(await project.selection()).toEqual(selection);
    expect(readFileSync(join(project.root, ".archer/system.mmd"), "utf8")).toBe(sourceBefore);
  } finally {
    await project.stop();
  }
}, 60_000); // The cold real-service export measured 30.4 s in the aggregate gate.

const FAMILIES = [
  ["flowchart", "freeform"],
  ["state", "state"],
  ["er", "entity-relationship"],
  ["c4", "c4"],
  ["architecture", "architecture"],
  ["sequence", "sequence"],
  ["journey", "journey"],
] as const;

/** A project with one view of each family, from the compiler's own widened fixtures. */
const familyProject = () =>
  startTsProject({
    files: Object.fromEntries([
      [
        "archer.toml",
        `version = 1\n${FAMILIES.map(
          ([family, kind]) =>
            `[[views]]\nid = "${family}"\nkind = "${kind}"\ntitle = "${family}"\nsource = ".archer/${family}.mmd"\n`,
        ).join("")}`,
      ],
      ...FAMILIES.map(([family]) => [
        `.archer/${family}.mmd`,
        readFileSync(join(TS_SOURCE, "../test/fixtures", family, "widened.mmd"), "utf8"),
      ]),
    ]),
  });

const exportBody = (viewId: string, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: "export_diagram",
    arguments: { viewId, format: "svg", mode: "diagram", theme: "light", scale: 1, allowLastGood: false, ...overrides },
  });

test("SVG export preserves every production diagram family and its element IDs", async () => {
  const { addressable } = await load<{ addressable(model: unknown): { nodes: ReadonlySet<string> } }>(
    "service/emphasis.ts",
  );
  const project = await familyProject();
  try {
    for (const [family, kind] of FAMILIES) {
      const envelope = await (await project.fetch(`api/diagrams/${family}`)).json();
      expect(envelope.view.kind).toBe(kind);
      const response = await project.fetch("api/operations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: exportBody(family),
      });
      expect(response.status, kind).toBe(200);
      const artifact = await response.json();
      expect(artifact.revision).toBe(envelope.revision);
      expect(artifact.lastGood).toBe(false);
      const svg = Buffer.from(artifact.data, "base64").toString("utf8");
      const ids = [...addressable(envelope.model).nodes];
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) expect(svg, kind).toContain(`data-element-id="${id}"`);
    }
  } finally {
    await project.stop();
  }
}, 60_000);

test("the export route refuses unsupported operations and arguments without changing state", async () => {
  const project = await startTsProject({
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "system"\nkind = "freeform"\ntitle = "The system"\nsource = ".archer/system.mmd"\n',
      ".archer/system.mmd": SOURCE,
    },
  });
  try {
    const before = await (await project.fetch("api/bootstrap")).json();
    const selection = await project.selection();
    const source = readFileSync(join(project.root, ".archer/system.mmd"), "utf8");
    // PNG, presentation mode and the last good drawing are the service's to export (the fake refused them).
    for (const body of [
      JSON.stringify({ name: "write_diagram", arguments: { viewId: "system" } }),
      JSON.stringify({ name: "export_diagram", arguments: { viewId: "system", invented: true } }),
    ]) {
      const response = await project.fetch("api/operations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(response.status, body).toBe(422);
      expect((await response.json()).error.code).toMatch(/^invalid_(request|arguments)$/);
    }
    expect(await (await project.fetch("api/bootstrap")).json()).toEqual(before);
    expect(await project.selection()).toEqual(selection);
    expect(readFileSync(join(project.root, ".archer/system.mmd"), "utf8")).toBe(source);
  } finally {
    await project.stop();
  }
});
