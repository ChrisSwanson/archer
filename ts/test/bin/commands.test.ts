// The project commands, run in-process against a fake terminal, in temporary
// projects.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { main, type Io } from "../../src/bin/main.ts";
import { BROKEN, FLOW, FLOW_OLD, removeTempDirs, SEQ, tempDir } from "../project/support.ts";

afterEach(removeTempDirs);

interface Run {
  code: number;
  out: string;
  err: string;
}

async function run(cwd: string, args: string[], io: Partial<Io> = {}): Promise<Run> {
  let out = "",
    err = "";
  const code = await main(args, {
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    isTTY: false,
    columns: undefined,
    env: {},
    cwd,
    ...io,
  });
  return { code, out, err };
}

const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

// ------------------------------------------------------------------ init

test("init makes the project, says what it did, and is quiet the second time", async () => {
  const dir = tempDir({ "CLAUDE.md": "# Claude\n" });
  const first = await run(dir, ["init"]);
  expect(first.err).toBe("");
  expect(first.code).toBe(0);
  for (const s of ["archer.toml", ".archer", "AGENTS.md", "CLAUDE.md"]) expect(first.out).toContain(s);
  expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toContain("`.archer/`");
  const second = await run(dir, ["init"]);
  expect(second.code).toBe(0);
  expect(second.out).toMatch(/nothing to do|already/i);
});

test("init takes a directory", async () => {
  const dir = tempDir({ "app/x": "" });
  expect((await run("/", ["init", join(dir, "app")])).code).toBe(0);
  expect(existsSync(join(dir, "app", ".archer"))).toBe(true);
});

// ------------------------------------------------------------------ list

test("list shows diagrams with their compile status and notes with what they are about", async () => {
  const dir = tempDir({
    "archer.toml":
      'version = 1\n[[views]]\nid = "login-view"\nkind = "freeform"\ntitle = "Login"\nsource = ".archer/auth/login.mmd"\n' +
      '[[views]]\nid = "gone"\nkind = "freeform"\ntitle = "Gone"\nsource = "docs/gone.mmd"\n',
    ".archer/auth/login.mmd": FLOW,
    ".archer/auth/seq.mmd": SEQ,
    ".archer/bad.mmd": BROKEN,
    ".archer/auth/story.md": "---\ntype: user story\nstatus: draft\n---\n",
    ".archer/odd.md": "---\ndiagrams: [nope.mmd]\n---\n",
  });
  const { code, out, err } = await run(dir, ["list"]);
  expect(err).toBe("");
  expect(code).toBe(0);
  expect(out).toMatch(/^\s*ok\s+auth\/login\.mmd\s+view login-view$/m);
  expect(out).toMatch(/^\s*ok\s+auth\/seq\.mmd$/m);
  expect(out).toMatch(/^\s*1 error\s+bad\.mmd$/m);
  expect(out).toMatch(/auth\/story\.md\s+user story, draft\s+-> auth\/login\.mmd, auth\/seq\.mmd/);
  expect(out).toMatch(/odd\.md.*\n\s+! diagram nope\.mmd does not exist/);
  expect(out).toMatch(/archer\.toml view 2 \(gone\): .*outside the Archer folder/);
});

test("list in a directory with no Archer folder says how to make one", async () => {
  const { code, out } = await run(tempDir(), ["list"]);
  expect(code).toBe(0);
  expect(out).toMatch(/archer init/);
});

// ------------------------------------------------------------------ validate

test("validate prints ok for a good diagram with optional non-blocking review progress", async () => {
  const dir = tempDir({ ".archer/good.mmd": FLOW });
  const { code, out } = await run(dir, ["validate", "good"]);
  expect(code).toBe(0);
  expect(out).toMatch(
    /^\.archer\/good\.mmd: ok\n(?:Layout review pending \(non-blocking\)\. Inspect with archer measure good --json\.\n)?$/,
  );
});

// A C4 view that compiles, with one reading-rule warning (an arrow label that needs a third line at the 24-character wrap) and one
// advice finding (a file path as technology): what validate_diagram reports, and `archer validate` printed as "ok".
const LINTED = [
  "C4Container",
  "    title Shop",
  '    System_Boundary(shop, "Shop") {',
  '        Container(api, "Shop API", "services/api/server.js", "Orders and stock")',
  '        ContainerDb(db, "Shop Database", "PostgreSQL", "Orders")',
  "    }",
  '    Rel(api, db, "Reports every payment outcome and refund back to the shop")',
  "",
].join("\n");

test("validate prints validate_diagram's reading-rule warnings and advice, not a bare ok, and exits 0", async () => {
  const dir = tempDir({ "archer.toml": "version = 1\n", ".archer/diagrams/shop.mmd": LINTED });
  const { code, out, err } = await run(dir, ["validate", "shop"]);
  expect(err).toBe("");
  expect(code).toBe(0);
  expect(out).toMatch(/^\.archer\/diagrams\/shop\.mmd:7:\d+ warning edge_label_too_long /m);
  expect(out).toMatch(/^\.archer\/diagrams\/shop\.mmd: ok, 1 warning$/m);
  expect(out).toMatch(/^Advice \(fix each, or say in one line why not\):\n- .*\[technology_is_path\]$/m);
  expect(out).not.toMatch(UNSAFE);
});

test("validate reads an embedded diagram's warnings at its lines in the note", async () => {
  const note = `---\nauthor: agent\ndescription: The shop.\n---\n\n# Shop\n\n\`\`\`mermaid\n%% archer-id: shop\n${LINTED}\`\`\`\n`;
  const dir = tempDir({ "archer.toml": "version = 1\n", ".archer/notes/shop.md": note });
  const { code, out } = await run(dir, ["validate", "notes/shop.md#shop"]);
  expect(code).toBe(0);
  // Line 7 of the source is line 16 of the note (the fence opens on 8, the pin is 9).
  expect(out).toMatch(/^\.archer\/notes\/shop\.md:16:\d+ warning edge_label_too_long /m);
  expect(out).toMatch(/notes\/shop\.md#shop: ok, 1 warning$/m);
  expect(out).toMatch(/\[technology_is_path\]/);
});

test("validate prints file:line:col severity code message, then the hint, and exits 1", async () => {
  const dir = tempDir({ ".archer/old.mmd": FLOW_OLD });
  const { code, out } = await run(join(dir, ".archer"), ["validate", "old.mmd"]);
  expect(code).toBe(1);
  expect(out.split("\n")).toEqual([
    "old.mmd:2:5 error legacy_syntax Mermaid needs this label quoted: it holds parentheses, brackets, braces or quotes",
    '  hint:   a["A (x)"]',
    "old.mmd:4:11 error legacy_syntax Mermaid needs this label quoted: it holds parentheses, brackets, braces or quotes",
    '  hint:   a e@-->|"reads (c)"| b',
    "old.mmd: 2 errors",
    "",
  ]);
});

// `archer validate <name> --json`: one JSON value on stdout, the text form's exit code, `lint` as `archer present --json` has it.
const oneJson = (out: string): Record<string, unknown> => {
  expect(out.endsWith("\n")).toBe(true);
  expect(out.trimEnd().split("\n")).toHaveLength(1);
  return JSON.parse(out) as Record<string, unknown>;
};

test("validate --json on a clean diagram: ok, no diagnostics, no lint, exit 0", async () => {
  const dir = tempDir({ ".archer/good.mmd": FLOW });
  const { code, out, err } = await run(dir, ["validate", "good", "--json"]);
  expect(err).toBe("");
  expect(code).toBe(0);
  const { layoutReview, ...priorFields } = oneJson(out);
  expect(layoutReview).toMatchObject({ version: 1, profile: "desktop-1025x896-gutter24" });
  expect(priorFields).toEqual({
    diagram: ".archer/good.mmd",
    viewId: "good",
    status: "ok",
    errors: 0,
    warnings: 0,
    diagnostics: [],
  });
});

test("validate --json on a diagram with warnings and advice only: its diagnostics and lint, exit 0", async () => {
  const dir = tempDir({ "archer.toml": "version = 1\n", ".archer/diagrams/shop.mmd": LINTED });
  const { code, out, err } = await run(dir, ["validate", "--json", "shop"]);
  expect(err).toBe("");
  expect(code).toBe(0);
  const result = oneJson(out);
  expect(result).toMatchObject({
    diagram: ".archer/diagrams/shop.mmd",
    viewId: "shop",
    status: "ok, 1 warning",
    errors: 0,
    warnings: 1,
  });
  expect(result["diagnostics"]).toEqual([
    expect.objectContaining({
      code: "edge_label_too_long",
      severity: "warning",
      span: expect.objectContaining({ start: expect.objectContaining({ line: 7 }) }),
    }),
  ]);
  const lint = result["lint"] as { diagnostics: { code: string }[]; advice: { code: string; fix: string }[] };
  expect(Object.keys(lint).sort()).toEqual(["advice", "diagnostics"]);
  expect(lint.diagnostics.map((d) => d.code)).toEqual(["edge_label_too_long"]);
  expect(lint.advice).toEqual([
    expect.objectContaining({ code: "technology_is_path", element: "api", fix: expect.any(String) }),
  ]);
  expect(out).not.toMatch(UNSAFE);
});

test("validate --json on a diagram that does not compile: its errors, no lint, exit 1", async () => {
  const dir = tempDir({ ".archer/old.mmd": FLOW_OLD });
  const { code, out, err } = await run(join(dir, ".archer"), ["validate", "old.mmd", "--json"]);
  expect(err).toBe("");
  expect(code).toBe(1);
  const result = oneJson(out);
  expect(result).toMatchObject({ diagram: "old.mmd", status: "2 errors", errors: 2, warnings: 0 });
  expect(result).not.toHaveProperty("lint");
  expect((result["diagnostics"] as { code: string; hint?: string }[]).map((d) => [d.code, d.hint])).toEqual([
    ["legacy_syntax", '  a["A (x)"]'],
    ["legacy_syntax", '  a e@-->|"reads (c)"| b'],
  ]);
});

test("validate --json on an embedded diagram names its address", async () => {
  const note = `---\nauthor: agent\ndescription: The shop.\n---\n\n# Shop\n\n\`\`\`mermaid\n%% archer-id: shop\n${LINTED}\`\`\`\n`;
  const dir = tempDir({ "archer.toml": "version = 1\n", ".archer/notes/shop.md": note });
  const result = oneJson((await run(dir, ["validate", "notes/shop.md#shop", "--json"])).out);
  expect(result).toMatchObject({
    diagram: ".archer/notes/shop.md#shop",
    viewId: "notes/shop.md#shop",
    status: "ok, 1 warning",
  });
  expect(result["diagnostics"]).toEqual([
    expect.objectContaining({
      code: "edge_label_too_long",
      span: expect.objectContaining({ start: expect.objectContaining({ line: 16 }) }),
    }),
  ]);
});

test("validate refuses a file outside the Archer folder", async () => {
  const dir = tempDir({ "loose.mmd": FLOW, ".archer/x.mmd": FLOW });
  const { code, err } = await run(dir, ["validate", "loose.mmd"]);
  expect(code).toBe(1);
  expect(err).toMatch(/outside the Archer folder/);
});

test("validate with an ambiguous name lists the choices, each line printable", async () => {
  const dir = tempDir({ ".archer/a/flow.mmd": FLOW, ".archer/b/flow.mmd": FLOW });
  const { code, err } = await run(dir, ["validate", "flow"]);
  expect(code).toBe(1);
  expect(err).toContain("  a/flow.mmd\n");
  expect(err).toContain("  b/flow.mmd");
});

// ------------------------------------------------------------------ compile

test("compile prints the envelope as JSON", async () => {
  const dir = tempDir({ ".archer/sys.mmd": FLOW });
  const { code, out } = await run(dir, ["compile", "sys"]);
  expect(code).toBe(0);
  const envelope = JSON.parse(out) as {
    schemaVersion: number;
    view: unknown;
    revision: string;
    model: { type: string };
  };
  expect(envelope.schemaVersion).toBe(2);
  expect(envelope.view).toEqual({ id: "sys", kind: "freeform", title: "sys" });
  expect(envelope.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(envelope.model.type).toBe("freeform-graph");
});

test("compile of a broken diagram prints its diagnostics and exits 1", async () => {
  const dir = tempDir({ ".archer/bad.mmd": BROKEN });
  const { code, out, err } = await run(dir, ["compile", "bad"]);
  expect(code).toBe(1);
  expect(out).toBe("");
  expect(err).toMatch(/^\.archer\/bad\.mmd:2:8 error unsupported_construct /m);
});

// ------------------------------------------------------------------ draw

test("draw compiles and draws a graph by name", async () => {
  const dir = tempDir({ ".archer/sys.mmd": FLOW });
  const { code, out, err } = await run(dir, ["draw", "sys", "--width", "60"]);
  expect(err).toBe("");
  expect(code).toBe(0);
  expect(out.split("\n")[0]).toBe("sys.mmd");
  expect(out).toContain("Client");
  expect(out).toContain("API");
});

test("draw of a sequence diagram points elsewhere in one line", async () => {
  const dir = tempDir({ ".archer/seq.mmd": SEQ });
  const { code, out } = await run(dir, ["draw", "seq"]);
  expect(code).toBe(0);
  expect(out.trimEnd().split("\n")).toHaveLength(1);
  expect(out).toMatch(/graphs only/);
});

test("draw draws a state diagram and an ER diagram", async () => {
  const dir = tempDir({
    ".archer/life.mmd": "stateDiagram-v2\n  state Idle\n  state Busy\n  Idle --> Busy : go\n",
    ".archer/data.mmd": "erDiagram\n  CUSTOMER\n  ORDER\n  CUSTOMER ||--o{ ORDER : places\n",
  });
  const life = await run(dir, ["draw", "life", "--width", "60"]);
  expect(life.code).toBe(0);
  for (const word of ["Idle", "Busy", "go"]) expect(life.out).toContain(word);
  const data = await run(dir, ["draw", "data", "--width", "80"]);
  expect(data.code).toBe(0);
  for (const word of ["CUSTOMER", "ORDER", "places", "0..*"]) expect(data.out).toContain(word);
});

test.each([
  ["c4", 'C4Context\n  Person(user, "User")\n', "a C4 diagram"],
  ["arch", "architecture-beta\n  service api(server)[API]\n", "an architecture diagram"],
  ["trip", "journey\n  section Go\n    Leave home: 3: Me\n", "a user journey"],
])("draw of %s points to the browser page in one line", async (name, source, what) => {
  const dir = tempDir({ [`.archer/${name}.mmd`]: source });
  const { code, out } = await run(dir, ["draw", name]);
  expect(code).toBe(0);
  expect(out.trimEnd().split("\n")).toHaveLength(1);
  expect(out).toContain(what);
  expect(out).toMatch(/archer serve/);
});

test("draw of a broken diagram prints the diagnostics, exit 1", async () => {
  const dir = tempDir({ ".archer/bad.mmd": BROKEN });
  const { code, err } = await run(dir, ["draw", "bad"]);
  expect(code).toBe(1);
  expect(err).toMatch(/unsupported_construct/);
});

test("draw takes a name or --model, not both", async () => {
  const dir = tempDir({ ".archer/sys.mmd": FLOW, "m.json": "{}" });
  const { code, err } = await run(dir, ["draw", "sys", "--model", join(dir, "m.json")]);
  expect(code).toBe(2);
  expect(err).toMatch(/not both/);
});

test("a manifest error is a sentence and exit 1", async () => {
  const dir = tempDir({ "archer.toml": 'version = 1\nfolder = "../up"\n' });
  for (const command of [["list"], ["validate", "x"], ["init"]]) {
    const { code, err } = await run(dir, command);
    expect(code, command.join(" ")).toBe(1);
    expect(err).toMatch(/archer\.toml cannot be used/);
  }
});

test("labels, names and file names reach the terminal without control characters", async () => {
  const dir = tempDir({
    ".archer/a\u001b[31m.mmd": BROKEN,
    ".archer/n‮.md": "---\ndiagrams: [\u001b]0;x\u0007.mmd]\n---\n",
  });
  writeFileSync(join(dir, ".archer", "label.mmd"), "flowchart LR\n  a[\u001b[2J] e1@--> b[B]\n");
  for (const command of [
    ["list"],
    ["validate", "label"],
    ["validate", "\u001b]0;pwn\u0007"],
    ["compile", "label"],
    ["draw", "label"],
  ]) {
    const { out, err } = await run(dir, command);
    expect(out, command.join(" ")).not.toMatch(UNSAFE);
    expect(err, command.join(" ")).not.toMatch(UNSAFE);
  }
});

// ------------------------------------------------------------------ embedded diagrams (ADR 0012)

const NOTE = `---\nauthor: agent\n---\n# Overview\n\n## Containers\n\n\`\`\`mermaid\n%% archer-id: containers\n${FLOW}\`\`\`\n\n\`\`\`mermaid\n%% archer-id: broken\n${BROKEN}\`\`\`\n`;

test("list shows the diagrams embedded in notes under their addresses", async () => {
  const dir = tempDir({ "archer.toml": "version = 1\n", ".archer/notes/overview.md": NOTE });
  const { code, out } = await run(dir, ["list"]);
  expect(code).toBe(0);
  expect(out).toMatch(/^\s*ok\s+notes\/overview\.md#containers$/m);
  expect(out).toMatch(/^\s*1 error\s+notes\/overview\.md#broken$/m);
  expect(out).not.toContain("(none)");
});

test("list shows each note's own diagrams under the note, by name, and none under a note without any", async () => {
  const dir = tempDir({
    "archer.toml": "version = 1\n",
    ".archer/notes/overview.md": NOTE,
    ".archer/notes/plain.md": "# Plain\n\nNo diagrams.\n",
  });
  const { out } = await run(dir, ["list"]);
  const lines = out.split("\n");
  const note = lines.findIndex((line) => /^\s+notes\/overview\.md\b/.test(line));
  expect(note).toBeGreaterThan(-1);
  expect(lines[note + 1]).toMatch(/^\s+blocks: containers, broken$/);
  const plain = lines.findIndex((line) => /^\s+notes\/plain\.md\b/.test(line));
  expect(lines[plain + 1] ?? "").not.toMatch(/blocks:/);
});

test("draw, validate and compile take an embedded address, from the folder or from where you stand, or its bare name", async () => {
  const dir = tempDir({ "archer.toml": "version = 1\n", ".archer/notes/overview.md": NOTE });
  for (const name of ["notes/overview.md#containers", ".archer/notes/overview.md#containers", "containers"]) {
    const drawn = await run(dir, ["draw", name, "--no-color"]);
    expect(drawn.err, name).toBe("");
    expect(drawn.code, name).toBe(0);
    expect(drawn.out).toContain("Client");
    const valid = await run(dir, ["validate", name]);
    expect(valid.out).toMatch(/notes\/overview\.md#containers: ok/);
    const compiled = await run(dir, ["compile", name]);
    expect(compiled.code).toBe(0);
    expect(JSON.parse(compiled.out).view.id).toBe("notes/overview.md#containers");
  }
  const broken = await run(dir, ["validate", "broken"]);
  expect(broken.code).toBe(1);
  // A position is a line of the note file, so an editor goes straight to it.
  expect(broken.out).toMatch(/^\.archer\/notes\/overview\.md:17:8 /m);
});

test("a bare name shared by a file and an embedded diagram asks for the address", async () => {
  const dir = tempDir({
    "archer.toml": "version = 1\n",
    ".archer/notes/overview.md": NOTE,
    ".archer/containers.mmd": FLOW,
  });
  const { code, err } = await run(dir, ["draw", "containers"]);
  expect(code).toBe(1);
  expect(err).toMatch(/containers\.mmd/);
  expect(err).toMatch(/notes\/overview\.md#containers/);
});

test("an unknown name lists the embedded diagrams too", async () => {
  const dir = tempDir({ "archer.toml": "version = 1\n", ".archer/notes/overview.md": NOTE });
  const { code, err } = await run(dir, ["draw", "nope"]);
  expect(code).toBe(1);
  expect(err).toMatch(/notes\/overview\.md#containers/);
  expect(err).not.toMatch(/none yet/);
});
