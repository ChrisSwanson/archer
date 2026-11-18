import { afterEach, expect, test } from "vitest";
import { main, type Io } from "../../src/bin/main.ts";
import { cleanUp, project, tempDir } from "../service/support.ts";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

afterEach(cleanUp);
function runner(root = project(), input = "{}") {
  const state = tempDir();
  return async (args: string[]) => {
    let out = "",
      err = "";
    const io: Io & { stdin: () => Promise<string> } = {
      cwd: root,
      env: { ARCHER_STATE_DIR: state, ARCHER_SOCKET: join(state, "absent.sock") },
      stdout: (s) => (out += s),
      stderr: (s) => (err += s),
      isTTY: false,
      columns: undefined,
      stdin: async () => input,
    };
    const code = await main(args, io);
    return { code, out, err };
  };
}
test("tools progressively discovers every operation and a selected input schema", async () => {
  const run = runner();
  const inventory = await run(["tools", "--json"]);
  expect(inventory.code, inventory.err).toBe(0);
  const tools = JSON.parse(inventory.out);
  expect(tools).toHaveLength(41);
  expect(tools.map((tool: { readonly name: string }) => tool.name)).toEqual(
    expect.arrayContaining(["list_changes", "read_change", "resolve_change", "issue_authoring_access"]),
  );
  expect(tools.map((tool: { name: string }) => tool.name)).toContain("list_note_emphases");
  expect(tools.map((tool: { name: string }) => tool.name)).toContain("set_note_emphasis");
  expect(tools.map((tool: { name: string }) => tool.name)).toContain("create_comment");
  expect(tools.map((tool: { name: string }) => tool.name)).toContain("resolve_comment");
  expect(tools.every((tool: object) => !Object.hasOwn(tool, "inputSchema"))).toBe(true);
  const detail = await run(["tools", "set_emphasis", "--json"]);
  expect(detail.code, detail.err).toBe(0);
  expect(JSON.parse(detail.out)).toMatchObject({ name: "set_emphasis", inputSchema: { type: "object" } });
});

test("generic calls read real diagrams from stdin and file arguments", async () => {
  const root = project();
  const fromStdin = await runner(root, '{"viewId":"flow"}')(["call", "read_diagram", "--stdin", "--json"]);
  expect(fromStdin.code, fromStdin.err).toBe(0);
  expect(JSON.parse(fromStdin.out)).toMatchObject({
    envelope: { view: { id: "flow" } },
    compile: { status: "compiled" },
  });
  const { write } = await import("../service/support.ts");
  write(root, "args.json", '{"viewId":"flow"}');
  const fromFile = await runner(root)(["call", "read_diagram", "--file", "args.json", "--json"]);
  expect(fromFile.code, fromFile.err).toBe(0);
  expect(JSON.parse(fromFile.out)).toEqual(JSON.parse(fromStdin.out));
});

test("generic calls preserve shared validation codes and omit stdout on failure", async () => {
  const run = runner();
  const bad = await run(["call", "read_diagram", "--json"]);
  expect(bad.code).toBe(1);
  expect(bad.out).toBe("");
  expect(JSON.parse(bad.err)).toMatchObject({ code: "invalid_arguments", details: { tool: "read_diagram" } });
  const unknown = await run(["call", "unrecognized", "--json"]);
  expect(unknown.code).toBe(1);
  expect(JSON.parse(unknown.err)).toMatchObject({ code: "unknown_tool" });
});

test("human output uses operation text while machine output stays structured", async () => {
  const run = runner();
  const human = await run(["call", "list_diagrams"]);
  expect(human.code, human.err).toBe(0);
  expect(human.out).toContain("diagrams in the Archer folder");
  expect(() => JSON.parse(human.out)).toThrow();
  const machine = await run(["call", "list_diagrams", "--json"]);
  expect(machine.code, machine.err).toBe(0);
  expect(JSON.parse(machine.out)).toMatchObject({ schemaVersion: 1 });
});

test("piped note text preserves exact source through EOF; terminal text labels its sanitization", async () => {
  const root = project();
  const source = "\uFEFF# Policy\r\nKeep 43 days.\r\nLiteral \u001b[31m and \u202e markers; final Unicode Ω";
  writeFileSync(join(root, ".archer/policy.md"), source);
  const input = '{"notePath":"policy.md"}';
  const piped = await runner(root, input)(["call", "read_note", "--stdin", "--format", "text"]);
  expect(piped.code, piped.err).toBe(0);
  expect(piped.out.split("--- BEGIN EXACT NOTE SOURCE ---\n")[1]).toBe(source);
  let terminal = "";
  const code = await main(["call", "read_note", "--stdin", "--format", "text"], {
    cwd: root,
    env: { ARCHER_STATE_DIR: tempDir() },
    stdout: (s) => (terminal += s),
    stderr: () => {},
    isTTY: true,
    columns: 80,
    stdin: async () => input,
  } as Io & { stdin: () => Promise<string> });
  expect(code).toBe(0);
  expect(terminal).not.toContain("BEGIN EXACT NOTE SOURCE");
  expect(terminal).toContain("BEGIN TERMINAL-SAFE NOTE SOURCE");
  expect(terminal).not.toMatch(/[\r\u001b\u202e]/);
  const json = await runner(root, input)(["call", "read_note", "--stdin", "--json"]);
  expect(JSON.parse(json.out).source.text).toBe(source);
});

test.each([
  ["call"],
  ["call", "list_diagrams", "extra"],
  ["call", "list_diagrams", "--stdin", "--file", "args.json"],
  ["tools", "unknown"],
  ["tools", "read_diagram", "extra"],
])("malformed command is a usage error: %j", async (...args) => {
  expect((await runner()(args)).code).toBe(2);
});

test.each([
  ["call", "find_elements", "--file", '{"query":"orders"}'],
  ["call", "find_elements", '{"query":"orders"}'],
  ["call", "find_elements", "--json", '{"query":"orders"}'],
])("inline JSON in a command is refused with the way to send it: %j", async (...args) => {
  const result = await runner()(args);
  expect(result.code).toBe(2);
  expect(result.err).toMatch(/inline JSON is not accepted[^\n]*--stdin/);
  expect(result.err).not.toMatch(/ENOENT/);
});

test.each(["null", "[]", "true", "{broken", '"a"'])("stdin refuses non-object or malformed JSON %j", async (input) => {
  expect((await runner(project(), input)(["call", "list_diagrams", "--stdin"])).code).toBe(2);
});

test("JSON input boundary is refused or a valid object for arbitrary, vocabulary and edited input", async () => {
  const { parsePayload } = await import("../../src/bin/operations.ts");
  const { UsageError } = await import("../../src/bin/main.ts");
  let seed = 20261005;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return seed >>> 0;
  };
  const vocabulary = [
    "viewId",
    "flow",
    "groups",
    "nodes",
    "edges",
    "__proto__",
    "constructor",
    "style",
    "highlight",
    "palette",
    "amber",
    "source",
    "flowchart LR",
    "expectedRevision",
  ];
  const valid = JSON.stringify({
    viewId: "flow",
    id: "demo",
    groups: [{ id: "g", label: "g", style: "highlight", nodes: ["a"] }],
  });
  const samples = [valid, '{"__proto__":{"polluted":true}}'];
  for (let round = 0; round < 500; round++) {
    samples.push(Array.from({ length: next() % 100 }, () => String.fromCharCode(next() % 65536)).join(""));
    samples.push(
      JSON.stringify(
        Object.fromEntries(
          Array.from({ length: next() % 8 }, () => [
            vocabulary[next() % vocabulary.length]!,
            vocabulary[next() % vocabulary.length]!,
          ]),
        ),
      ),
    );
    const index = next() % valid.length;
    samples.push(valid.slice(0, index) + String.fromCharCode(next() % 128) + valid.slice(index + 1));
  }
  for (const input of samples) {
    try {
      const result = parsePayload(input);
      expect(result).toEqual(JSON.parse(input));
      expect(result).not.toBeNull();
      expect(Array.isArray(result)).toBe(false);
      expect(typeof result).toBe("object");
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
    }
  }
  expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
}, 10_000);

test("JSON size limit counts UTF-8 bytes and refuses instead of truncating", async () => {
  const { MAX_ARGUMENT_BYTES, parsePayload } = await import("../../src/bin/operations.ts");
  const input = JSON.stringify({ source: "😀".repeat(MAX_ARGUMENT_BYTES / 4) });
  expect(input.length).toBeLessThan(MAX_ARGUMENT_BYTES);
  expect(Buffer.byteLength(input)).toBeGreaterThan(MAX_ARGUMENT_BYTES);
  expect(() => parsePayload(input)).toThrow(/exceed/);
});

test("JSON parser boundary stays refused or valid on a small stack within a clock", async () => {
  const { spawnSync } = await import("node:child_process");
  const parser = new URL("../../src/bin/operations.ts", import.meta.url).href;
  const mainModule = new URL("../../src/bin/main.ts", import.meta.url).href;
  const inputs: string[] = [];
  const valid = '{"viewId":"flow","groups":[{"id":"g", "label": "g","nodes":["a"] }]}';
  for (let i = 0; i < 300; i++) {
    inputs.push(String.fromCharCode(i, (i * 23) % 65536, 0, 34, 92));
    inputs.push(
      JSON.stringify({ viewId: "flow", source: "flowchart LR", nodes: ["a"], [String.fromCharCode(i)]: "highlight" }),
    );
    const index = i % valid.length;
    inputs.push(valid.slice(0, index) + String.fromCharCode(i % 128) + valid.slice(index + 1));
  }
  // JSON.parse uses the runtime parser rather than JavaScript recursion.
  inputs.push('{"nested":' + "[".repeat(5000) + "0" + "]".repeat(5000) + "}");
  const script = `
    import { readFileSync } from "node:fs";
    import { parsePayload } from ${JSON.stringify(parser)};
    import { UsageError } from ${JSON.stringify(mainModule)};
    for (const input of JSON.parse(readFileSync(0, "utf8"))) {
      try {
        const value = parsePayload(input);
        if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid outcome");
      } catch (error) { if (!(error instanceof UsageError)) throw error; }
    }
    console.log("refused or valid");
  `;
  const child = spawnSync(
    process.execPath,
    ["--stack_size=256", "--import", "tsx", "--input-type=module", "-e", script],
    {
      input: JSON.stringify(inputs),
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout.trim()).toBe("refused or valid");
});

// ------------------------------------------------------------------ --source <file.mmd>
// Multi-line Mermaid without wrapping it in JSON: the file is the source, the rest of the arguments one line.

test("--source reads the Mermaid from a file for validate_diagram and write_diagram", async () => {
  const root = project();
  const { readFileSync } = await import("node:fs");
  const scratch = tempDir();
  const next = "flowchart LR\n  a[Client] e1@--> b[API]\n  b e2@--> c[Queue]\n";
  writeFileSync(join(scratch, "next.mmd"), next);
  const checked = await runner(
    root,
    '{"viewId":"flow"}',
  )(["call", "validate_diagram", "--source", join(scratch, "next.mmd"), "--stdin", "--json"]);
  expect(checked.code, checked.err).toBe(0);
  expect(JSON.parse(checked.out)).toMatchObject({ valid: true });
  const read = JSON.parse((await runner(root, '{"viewId":"flow"}')(["call", "read_diagram", "--stdin", "--json"])).out);
  const written = await runner(
    root,
    JSON.stringify({ viewId: "flow", expectedRevision: read.sourceRevision }),
  )(["call", "write_diagram", "--source", join(scratch, "next.mmd"), "--stdin"]);
  expect(written.code, written.err).toBe(0);
  expect(readFileSync(join(root, ".archer/flow.mmd"), "utf8")).toBe(next);
  // A relative path is from where the command runs; --source alone, with no viewId, is refused by the operation.
  writeFileSync(join(root, "draft.mmd"), next);
  const relative = await runner(
    root,
    '{"viewId":"chat"}',
  )(["call", "validate_diagram", "--source", "draft.mmd", "--stdin", "--json"]);
  expect(relative.code, relative.err).toBe(0);
  const alone = await runner(root)(["call", "validate_diagram", "--source", "draft.mmd", "--json"]);
  expect(alone.code).toBe(1);
  expect(JSON.parse(alone.err)).toMatchObject({ code: "invalid_arguments" });
});

test("--source refuses a file it cannot use, with what to do, and never reads past the source limit", async () => {
  const root = project();
  const { MAX_SOURCE_BYTES } = await import("../../src/mermaid/limits.ts");
  const scratch = tempDir();
  writeFileSync(join(scratch, "big.mmd"), "flowchart LR\n" + "%%".padEnd(MAX_SOURCE_BYTES, "x") + "\n");
  writeFileSync(join(scratch, "latin1.mmd"), Buffer.from([0x66, 0x6c, 0xe9, 0x0a]));
  const cases: [string[], string, RegExp][] = [
    [
      ["call", "validate_diagram", "--source", join(scratch, "missing.mmd"), "--stdin"],
      '{"viewId":"flow"}',
      /--source \S*missing\.mmd: no such file/,
    ],
    [["call", "validate_diagram", "--source", scratch, "--stdin"], '{"viewId":"flow"}', /--source \S*: not a file/],
    [
      ["call", "validate_diagram", "--source", join(scratch, "big.mmd"), "--stdin"],
      '{"viewId":"flow"}',
      new RegExp(`--source \\S*big\\.mmd: .*at most ${MAX_SOURCE_BYTES}`),
    ],
    [
      ["call", "validate_diagram", "--source", join(scratch, "latin1.mmd"), "--stdin"],
      '{"viewId":"flow"}',
      /--source \S*latin1\.mmd: not UTF-8/,
    ],
    [
      ["call", "validate_diagram", "--source", join(scratch, "next.mmd"), "--stdin"],
      '{"viewId":"flow","source":"flowchart LR"}',
      /--source and a "source" argument/,
    ],
    [
      ["call", "read_diagram", "--source", join(scratch, "latin1.mmd"), "--stdin"],
      '{"viewId":"flow"}',
      /read_diagram takes no source/,
    ],
  ];
  for (const [args, input, message] of cases) {
    const text = await runner(root, input)(args);
    expect(text.code, args.join(" ")).toBe(1);
    expect(text.out).toBe("");
    expect(text.err, args.join(" ")).toMatch(new RegExp(`^archer: ${message.source}`));
    const json = await runner(root, input)([...args, "--json"]);
    expect(json.code).toBe(1);
    const refusal = JSON.parse(json.err);
    expect(refusal).toMatchObject({ code: "invalid_arguments", details: { argument: "--source" } });
    expect(refusal.message).toMatch(message);
  }
});
