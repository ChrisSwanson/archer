// `archer walkthrough list|show|write|delete [--json] [--markdown]` (ADR 0034 §5): the shared
// operations through the CLI; none starts a service.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { main } from "../../src/bin/main.ts";
import { cleanup, repo, write } from "../accuracy/support.ts";
import { tempDir } from "../service/support.ts";

afterEach(cleanup);

const FLOW = "flowchart LR\n  a[Client]\n  b[API]\n  c[(Store)]\n  a e1@-->|Calls| b\n  b e2@-->|Writes| c\n";
const draft = {
  id: "ask",
  title: "Asking the API",
  description: "A request and its write.",
  steps: [
    {
      title: "Ask",
      kind: "sends",
      what: "A request.",
      why: "The client never touches the store.",
      code: ["src/api.ts"],
      edges: [{ id: "e1" }],
      messages: [{ from: "a", to: "b", label: "GET /x" }],
    },
    { title: "Store", kind: "does", what: "The API saves it.", nodes: [{ id: "c" }] },
  ],
};

function setup() {
  const root = repo({ ".archer/flow.mmd": FLOW, "src/api.ts": "export {};\n" });
  const state = tempDir();
  const env = { ARCHER_STATE_DIR: state, ARCHER_SOCKET: join(state, "none.sock") };
  const run = async (args: string[], stdin?: string) => {
    let out = "",
      err = "";
    const code = await main(["walkthrough", ...args], {
      cwd: root,
      env,
      stdout: (s) => (out += s),
      stderr: (s) => (err += s),
      isTTY: false,
      columns: undefined,
      ...(stdin === undefined ? {} : { stdin: async () => stdin }),
    });
    return { code, out, err };
  };
  write(root, "w.json", JSON.stringify(draft));
  return { root, state, run };
}

test("write from a file, list and show --json, and show --markdown; no service is started", async () => {
  const { root, state, run } = setup();
  const wrote = await run(["write", "flow", "--file", "w.json", "--json"]);
  expect(wrote.code, wrote.err).toBe(0);
  expect(JSON.parse(wrote.out)).toMatchObject({
    walkthrough: { id: "ask", revision: 1, author: "agent" },
    resolution: { status: "current" },
  });
  expect(existsSync(join(root, ".archer/flow.walkthroughs.json"))).toBe(true);

  const listed = await run(["list", "flow", "--json"]);
  expect(JSON.parse(listed.out)).toMatchObject({
    walkthroughs: [{ id: "ask", steps: 2, status: "current", revision: 1 }],
  });
  expect((await run(["list", "flow"])).out).toContain("ask");

  const shown = JSON.parse((await run(["show", "flow", "ask", "--json"])).out);
  expect(shown.walkthrough.steps[0].edges[0]).toMatchObject({ id: "e1", source: "a", target: "b", label: "Calls" });

  const md = await run(["show", "flow", "ask", "--markdown"]);
  expect(md.code, md.err).toBe(0);
  expect(md.out).toBe(
    [
      "### Asking the API",
      "A request and its write.",
      "",
      `revision: ${shown.walkthrough.modelRevision.slice(7, 14)}`,
      "",
      "1. **Ask** — `a -> b: Calls`, message `a -> b: GET /x`",
      "   Sends: A request. Why: The client never touches the store.",
      "   Code: `src/api.ts`",
      "2. **Store** — boxes `c`",
      "   Does: The API saves it.",
      "",
    ].join("\n"),
  );
  expect(existsSync(join(state, "archer.lock"))).toBe(false);
});

test("a shown walkthrough written back unchanged is a no-op, and replacing takes its revision", async () => {
  const { root, run } = setup();
  await run(["write", "flow", "--file", "w.json"]);
  const before = readFileSync(join(root, ".archer/flow.walkthroughs.json"), "utf8");
  // The echo of `show --json` carries Archer's fields; the revision it holds is the expectedRevision.
  const echo = await run(["show", "flow", "ask", "--json"]);
  const again = await run(["write", "flow", "--stdin", "--json"], JSON.stringify(JSON.parse(echo.out).walkthrough));
  expect(again.code, again.err).toBe(0);
  expect(JSON.parse(again.out).walkthrough.revision).toBe(1);
  expect(readFileSync(join(root, ".archer/flow.walkthroughs.json"), "utf8")).toBe(before);

  write(root, "w2.json", JSON.stringify({ ...draft, title: "Asking" }));
  const stale = await run(["write", "flow", "--file", "w2.json", "--expected", "7"]);
  expect(stale.code).toBe(1);
  expect(stale.err).toContain("revision 1");
  expect((await run(["write", "flow", "--file", "w2.json", "--expected", "1", "--json"])).out).toContain(
    '"revision":2',
  );
});

test("delete removes a walkthrough at its revision, and refuses an unknown one", async () => {
  const { root, run } = setup();
  await run(["write", "flow", "--file", "w.json"]);
  const missing = await run(["delete", "flow", "nope"]);
  expect(missing.code).toBe(1);
  expect(missing.err).toContain("nope");
  const gone = await run(["delete", "flow", "ask", "--json"]);
  expect(gone.code, gone.err).toBe(0);
  expect(JSON.parse(gone.out)).toMatchObject({ deleted: "ask" });
  expect(existsSync(join(root, ".archer/flow.walkthroughs.json"))).toBe(false);
});

test("a refusal prints the problems, and the file is untouched", async () => {
  const { root, run } = setup();
  write(root, "bad.json", JSON.stringify({ ...draft, steps: [{ ...draft.steps[0], edges: [{ id: "e11" }] }] }));
  const bad = await run(["write", "flow", "--file", "bad.json"]);
  expect(bad.code).toBe(1);
  expect(bad.err).toContain('Did you mean "e1"');
  expect(existsSync(join(root, ".archer/flow.walkthroughs.json"))).toBe(false);
});

test.each(
  [
    [],
    ["unknown"],
    ["show", "flow"],
    ["list"],
    ["write", "flow"],
    ["delete", "flow"],
    ["show", "flow", "ask", "--json", "--markdown"],
    ["list", "flow", "--markdown"],
  ].map((args) => ({ args })),
)("malformed command $args is a usage error", async ({ args }) => {
  expect((await setup().run(args)).code).toBe(2);
});
