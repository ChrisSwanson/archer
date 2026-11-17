// Hard rules 2 and 5 of the doc pack (docs/proposals/doc-pack.md): in a docs-mode project every
// write_diagram is checked against the cap of the file it lands in, and an add that would cross it
// is refused with how much to free, never truncated. Outside docs mode nothing changes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createApplication, type OperationError } from "../../src/application/index.ts";
import { CAPS } from "../../src/docs/pack.ts";
import { removeTempDirs, tempDir } from "../project/support.ts";

afterEach(removeTempDirs);

const FLOW = "flowchart LR\n  a[A] e@--> b[B]\n";
/** A flowchart of `n` nodes, about 40 characters a line. */
const long = (n: number) =>
  `flowchart LR\n  n0[Step 0]\n${Array.from({ length: n }, (_, i) => `  n${i} e${i}@--> n${i + 1}[Step number ${i + 1}]`).join("\n")}\n`;

function project(mode: string) {
  return tempDir({
    "archer.toml": `version = 1\n${mode}`,
    ".archer/diagrams/flows/pay.mmd": FLOW,
    ".archer/diagrams/other/big.mmd": FLOW,
    ".archer/notes/flows/pay.md": `---\nauthor: agent\ntype: user-flow\n---\n# Pay\n\n\`\`\`mermaid\n%% archer-id: pay\n${FLOW}\`\`\`\n`,
  });
}

async function write(dir: string, viewId: string, source: string) {
  const app = createApplication({ cwd: dir });
  try {
    const read = await app.call("read_diagram", { viewId });
    return await app.call("write_diagram", { viewId, source, expectedRevision: read.structured["sourceRevision"] });
  } finally {
    app.close();
  }
}

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as OperationError;
  }
  throw new Error("expected a refusal");
};

test("a flow diagram write past its cap is refused with the characters to free, and nothing is written", async () => {
  const dir = project('mode = "docs"\n');
  const source = long(120);
  const error = await refusal(write(dir, "pay", source));
  expect(error.data["code"]).toBe("doc_over_cap");
  expect(error.message).toContain(
    `diagrams/flows/pay.mmd would be ${[...source].length} characters, over its ${CAPS.flow} cap`,
  );
  expect(error.message).toContain(`Free ${[...source].length - CAPS.flow}`);
  expect(error.message).toMatch(/Nothing was written/);
  expect(readFileSync(join(dir, ".archer/diagrams/flows/pay.mmd"), "utf8")).toBe(FLOW);
});

test("a diagram write that grows its note past the note's cap is refused", async () => {
  const dir = project('mode = "docs"\n');
  const error = await refusal(write(dir, "notes/flows/pay.md#pay", long(120)));
  expect(error.data["code"]).toBe("doc_over_cap");
  expect(error.message).toContain("notes/flows/pay.md would be");
});

test("within the cap, and outside the pack, writes go through in docs mode", async () => {
  const dir = project('mode = "docs"\n');
  expect((await write(dir, "pay", long(20))).structured["status"]).toBe("compiled");
  expect((await write(dir, "big", long(120))).structured["status"]).toBe("compiled");
});

test("a write that shrinks a file already over its cap is allowed", async () => {
  const dir = project("");
  await write(dir, "pay", long(120));
  const toml = join(dir, "archer.toml");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(toml, 'version = 1\nmode = "docs"\n');
  expect((await write(dir, "pay", long(110))).structured["status"]).toBe("compiled");
});

test("without docs mode there is no cap", async () => {
  const dir = project("");
  expect((await write(dir, "pay", long(120))).structured["status"]).toBe("compiled");
});

test("a retired note is out of the pack and has no cap", async () => {
  const dir = project('mode = "docs"\n');
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    join(dir, ".archer/notes/flows/old.md"),
    `---\nauthor: agent\ntype: user-flow\nstatus: implemented\n---\n# Old\n\n\`\`\`mermaid\n%% archer-id: old\n${FLOW}\`\`\`\n`,
  );
  expect((await write(dir, "notes/flows/old.md#old", long(120))).structured["status"]).toBe("compiled");
});

test("a view reached through a directory link is capped as the file it lands in", async () => {
  const dir = project('mode = "docs"\n');
  const { symlinkSync, writeFileSync } = await import("node:fs");
  symlinkSync(join(dir, ".archer/diagrams/flows"), join(dir, ".archer/diagrams/alias"));
  writeFileSync(
    join(dir, "archer.toml"),
    'version = 1\nmode = "docs"\n[[views]]\nid = "alias-pay"\nkind = "freeform"\ntitle = "Pay"\nsource = ".archer/diagrams/alias/pay.mmd"\n',
  );
  const error = await refusal(write(dir, "alias-pay", long(120)));
  expect(error.data["code"]).toBe("doc_over_cap");
  expect(readFileSync(join(dir, ".archer/diagrams/flows/pay.mmd"), "utf8")).toBe(FLOW);
});

// The cap is checked again inside the writer lock: a change that lands while the write is being
// announced (here docs mode switched on, as a concurrent writer or the person might) cannot slip a
// write past it.
test.each([
  ["a .mmd view", "pay", ".archer/diagrams/flows/pay.mmd", FLOW],
  ["a diagram in a note", "notes/flows/pay.md#pay", ".archer/notes/flows/pay.md", undefined],
])("the cap is checked again inside the writer lock (%s)", async (_kind, viewId, file, original) => {
  const dir = project("");
  const before = readFileSync(join(dir, file), "utf8");
  const app = createApplication({ cwd: dir });
  try {
    const read = await app.call("read_diagram", { viewId });
    const { writeFileSync } = await import("node:fs");
    (app as unknown as { announceWrite: () => Promise<void> }).announceWrite = async () => {
      writeFileSync(join(dir, "archer.toml"), 'version = 1\nmode = "docs"\n');
    };
    const error = await refusal(
      app.call("write_diagram", { viewId, source: long(120), expectedRevision: read.structured["sourceRevision"] }),
    );
    expect(error.data["code"]).toBe("doc_over_cap");
    expect(readFileSync(join(dir, file), "utf8")).toBe(original ?? before);
  } finally {
    app.close();
  }
});

// validate_diagram and write_diagram agree: in docs mode validate reports the cap a write would
// break, as a warning in write_diagram's terms; within the cap, or outside docs mode, it says nothing.
test.each([
  ["a .mmd view", "pay", "diagrams/flows/pay.mmd"],
  ["a diagram in a note", "notes/flows/pay.md#pay", "notes/flows/pay.md"],
])("validate_diagram warns of the cap write_diagram would refuse (%s)", async (_kind, viewId, landing) => {
  const validate = async (dir: string, source: string) => {
    const app = createApplication({ cwd: dir });
    try {
      return await app.call("validate_diagram", { viewId, source });
    } finally {
      app.close();
    }
  };
  const dir = project('mode = "docs"\n');
  const source = long(120);
  const refused = await refusal(write(dir, viewId, source));
  const checked = await validate(dir, source);
  const cap = (checked.structured["diagnostics"] as { code: string; severity: string; message: string }[]).filter(
    (d) => d.code === "doc_over_cap",
  );
  expect(cap).toHaveLength(1);
  expect(cap[0]!.severity).toBe("warning");
  expect(cap[0]!.message).toContain(
    `${landing} would be ${refused.data["chars"]} characters, over its ${refused.data["cap"]} cap (docs mode)`,
  );
  expect(cap[0]!.message).toContain(`Free ${refused.data["free"]} characters`);
  expect(checked.text).toContain("[doc_over_cap]");
  for (const quiet of [await validate(dir, long(5)), await validate(project(""), source)])
    expect(JSON.stringify(quiet.structured["diagnostics"])).not.toContain("doc_over_cap");
});
