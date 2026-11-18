// What `archer validate` prints and returns for problems: severity on every line, hints that stay
// readable over several lines, an honest count past the report's cap, the fixed source in --json.
import { afterEach, expect, test } from "vitest";
import { main } from "../../src/bin/main.ts";
import { removeTempDirs, tempDir } from "../project/support.ts";

afterEach(removeTempDirs);

async function run(cwd: string, args: string[]) {
  let out = "",
    err = "";
  const code = await main(args, {
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    isTTY: false,
    columns: undefined,
    env: {},
    cwd,
  });
  return { code, out, err };
}

const NO_IDS = "flowchart LR\n  a[A]\n  b[B]\n  a --> b\n";
const MANY = `flowchart LR\n${Array.from({ length: 30 }, (_, i) => `  n${i}[N${i}] --> m${i}[M${i}]\n`).join("")}`;

test("every plain line says whether it is an error or a warning", async () => {
  const dir = tempDir({ ".archer/x.mmd": "flowchart LR\n  a[A] e1@--> b[B]\n  c[C]\n  a e1@--> b\n" });
  const { out } = await run(dir, ["validate", ".archer/x.mmd"]);
  const lines = out.split("\n").filter((l) => /^\S+:\d+:\d+ /.test(l));
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) expect(line).toMatch(/^\S+:\d+:\d+ (error|warning) [a-z_]+ /);
  expect(lines.some((l) => /:\d+:\d+ warning /.test(l))).toBe(true);
});

test("a hint of several lines prints on several indented lines", async () => {
  const dir = tempDir({ ".archer/y.mmd": "flowchart LR\n  a[A] --> b[B] %% trailing comment\n" });
  const { out } = await run(dir, ["validate", ".archer/y.mmd"]);
  expect(out).toMatch(/\n {2}hint:\n {4}\s*%% trailing comment\n {4}\s*a\[A\] a_b@--> b\[B\]\n/);
});

test("past the cap, the count is honest and the marker is not counted as an error", async () => {
  const dir = tempDir({ ".archer/many.mmd": MANY });
  const text = await run(dir, ["validate", ".archer/many.mmd"]);
  expect(text.out).toMatch(/\.archer\/many\.mmd: 20 errors shown, more remain/);
  expect(text.out).not.toMatch(/21 errors/);
  const json = JSON.parse((await run(dir, ["validate", ".archer/many.mmd", "--json"])).out) as {
    errors: number;
    status: string;
    moreErrors?: boolean;
  };
  expect(json.errors).toBe(20);
  expect(json.moreErrors).toBe(true);
  const list = await run(dir, ["list"]);
  expect(list.out).toMatch(/20\+ errors/);
  expect(list.out).not.toMatch(/21 errors/);
});

test("validate --json carries the whole fixed source as fix.source", async () => {
  const dir = tempDir({ ".archer/x.mmd": NO_IDS });
  const json = JSON.parse((await run(dir, ["validate", ".archer/x.mmd", "--json"])).out) as {
    fix?: { source: string; added: { id: string }[]; operation: string };
  };
  expect(json.fix?.operation).toBe("add-edge-ids");
  expect(json.fix?.source).toContain("a a_b@--> b");
  const again = tempDir({ ".archer/fixed.mmd": json.fix!.source });
  expect((await run(again, ["validate", ".archer/fixed.mmd"])).code).toBe(0);
});

test("the edge-ID message names a route that can be run, not an edit", async () => {
  const dir = tempDir({ ".archer/x.mmd": NO_IDS });
  const { out } = await run(dir, ["validate", ".archer/x.mmd"]);
  expect(out).not.toContain("The edit `add-edge-ids`");
  expect(out).toMatch(/validate_diagram|--json/);
  expect(out).toContain("fix.source");
});

test("a diagram type Archer does not draw is named as unsupported", async () => {
  for (const header of ["classDiagram", "gantt", "C4Code", "pie"]) {
    const dir = tempDir({ ".archer/x.mmd": `${header}\n  x\n` });
    const { out } = await run(dir, ["validate", ".archer/x.mmd"]);
    expect(out, header).toMatch(/ unsupported_diagram_type /);
    expect(out, header).toContain(`\`${header}\``);
    expect(out, header).toMatch(/does not support|doesn't support/);
  }
  const none = tempDir({ ".archer/x.mmd": "hello\n" });
  expect((await run(none, ["validate", ".archer/x.mmd"])).out).toMatch(/ expected_flowchart /);
});

test("every diagram type the unsupported-type refusal offers is one Archer accepts", async () => {
  const dir = tempDir({ ".archer/x.mmd": "classDiagram\n  x\n" });
  const { out } = await run(dir, ["validate", ".archer/x.mmd"]);
  const offered = [...(out.split("Archer draws")[1] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
  expect(offered.length).toBeGreaterThan(5);
  for (const header of offered) {
    const each = tempDir({ ".archer/y.mmd": `${header}\n` });
    const result = (await run(each, ["validate", ".archer/y.mmd"])).out;
    expect(result, header).not.toMatch(
      /:1:\d+ error (unsupported_diagram_type|unsupported_construct|expected_flowchart) /,
    );
  }
});

test("an over-long edge label's message states the real rule", async () => {
  const dir = tempDir({
    ".archer/x.mmd":
      "flowchart LR\n  a[A] e1@-->|sends the signed order request with every line item and the address| b[B]\n",
  });
  const { out } = await run(dir, ["validate", ".archer/x.mmd"]);
  expect(out).toMatch(/edge_label_too_long/);
  expect(out).toMatch(/2 lines of 24 characters/);
  expect(out).not.toContain("4 words");
});
