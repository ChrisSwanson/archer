// The doc pack (docs/proposals/doc-pack.md, ADR 0033): the generated router, routing a question to
// at most three files, and pack health (caps, budgets, dead references, router freshness, required
// files), through the docs_index operation every adapter shares.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import {
  bodyRefs,
  buildPack,
  CAPS,
  keywords,
  linkTargets,
  packFields,
  packHealth,
  refProblem,
  route,
} from "../../src/docs/pack.ts";
import { findProject } from "../../src/project/index.ts";
import { removeTempDirs, tempDir } from "../project/support.ts";
import { front, packProject } from "./pack-support.ts";

afterEach(removeTempDirs);

const app = (cwd: string) => createApplication({ cwd });
async function docsIndex(cwd: string, args: Record<string, unknown> = {}) {
  const application = app(cwd);
  try {
    return await application.call("docs_index", args);
  } finally {
    application.close();
  }
}
const health = (result: { structured: Record<string, unknown> }) =>
  result.structured["health"] as ReturnType<typeof packHealth>;

test("a complete pack: write generates the router, check passes, and a second write changes nothing", async () => {
  const dir = packProject();
  const first = await docsIndex(dir, { write: true, check: true });
  expect(first.structured["written"]).toBe(true);
  expect(health(first).failures).toEqual([]);
  expect(health(first).status).toBe("pass");
  const router = readFileSync(join(dir, ".archer/index.md"), "utf8");
  expect(router).toContain("type: index");
  expect(router).toContain("| What are the parts? Where is the code? | [architecture.md](architecture.md) |");
  expect(router).toContain("[Checkout](notes/flows/checkout.md) ([picture](diagrams/flows/checkout.mmd))");
  expect(router).toContain("[returns](diagrams/flows/returns.mmd): A returned parcel is scanned and refunded.");
  expect(router).toContain("`notes/architecture/`: 1 note");
  expect(router).toMatch(/Pack \d+\.\dk\/80k characters\./);
  expect(router.length).toBeLessThanOrEqual(CAPS.index);
  const second = await docsIndex(dir, { write: true });
  expect(second.structured["written"]).toBe(false);
  expect(readFileSync(join(dir, ".archer/index.md"), "utf8")).toBe(router);
});

test("the router is deterministic and lists the core files in their fixed order", () => {
  const dir = packProject();
  const a = buildPack(findProject(dir)),
    b = buildPack(findProject(dir));
  expect(a.router).toBe(b.router);
  expect(a.core.map((entry) => entry.file.path)).toEqual(["intent.md", "use-cases.md", "architecture.md"]);
  expect(a.flows.map((entry) => entry.file.path)).toEqual(["diagrams/flows/returns.mmd", "notes/flows/checkout.md"]);
  expect(a.details.map((entry) => entry.file.path)).toEqual(["notes/architecture/payments.md"]);
  expect(a.pictures.map((entry) => entry.file.path)).toEqual(["diagrams/flows/checkout.mmd"]);
});

test("an empty docs-mode project gets an empty router, and check names what is required", async () => {
  const dir = tempDir({ "archer.toml": 'version = 1\nmode = "docs"\n' });
  const result = await docsIndex(dir, { check: true });
  expect(String((result.structured["router"] as { text: string }).text)).toContain(
    "No docs yet. Ask your agent to set up the architecture docs.",
  );
  expect(health(result).required).toEqual([
    "README.md",
    "intent.md",
    "use-cases.md",
    "architecture.md",
    "two to five flows (0 found)",
  ]);
  expect(health(result).failures).toContain(
    "index.md is missing: run `archer docs index --write` (docs_index with write).",
  );
  expect(health(result).status).toBe("fail");
});

test("outside docs mode nothing is required, and a missing router is no failure", async () => {
  const result = await docsIndex(tempDir({ "archer.toml": "version = 1\n" }), { check: true });
  expect(health(result)).toMatchObject({ status: "pass", required: [], router: { status: "missing" } });
});

test("a change to what the router shows (a status, a description, a size) makes it stale", async () => {
  const dir = packProject();
  await docsIndex(dir, { write: true });
  // An edit that leaves the size, status and description alone: the router still says what it should.
  writeFileSync(
    join(dir, ".archer/intent.md"),
    readFileSync(join(dir, ".archer/intent.md"), "utf8").replace("Sell books.", "Sell books!"),
  );
  expect(health(await docsIndex(dir, { check: true })).router.status).toBe("fresh");
  writeFileSync(
    join(dir, ".archer/intent.md"),
    readFileSync(join(dir, ".archer/intent.md"), "utf8").replace("status: proposed", "status: confirmed"),
  );
  const result = await docsIndex(dir, { check: true });
  expect(health(result).router.status).toBe("stale");
  expect(health(result).failures[0]).toMatch(/index\.md is out of date/);
});

test("caps count characters, front matter and embedded diagram source included, and refuse nothing silently", async () => {
  const fence = "```mermaid\n%% archer-id: big\nflowchart LR\n  a[A] e@--> b[B]\n```\n";
  const padding = "é".repeat(CAPS.invariants);
  const dir = packProject({
    ".archer/invariants.md": `${front({ type: "invariants" })}# Invariants\n\n${fence}${padding}`,
  });
  await docsIndex(dir, { write: true });
  const text = readFileSync(join(dir, ".archer/invariants.md"), "utf8");
  const result = await docsIndex(dir, { check: true });
  const cap = health(result).caps.find((item) => item.path === "invariants.md");
  expect(cap).toEqual({ path: "invariants.md", chars: [...text].length, cap: CAPS.invariants, over: true, near: true });
  expect(health(result).failures).toContain(
    `invariants.md is ${[...text].length} characters, over its ${CAPS.invariants} cap by ${[...text].length - CAPS.invariants}: consolidate or split it.`,
  );
});

test("a file over 80% of its cap is a warning, not a failure", async () => {
  const dir = packProject({
    ".archer/invariants.md": `${front({ type: "invariants" })}# Invariants\n\n${"x".repeat(2600)}`,
  });
  await docsIndex(dir, { write: true });
  const result = await docsIndex(dir, { check: true });
  expect(health(result).status).toBe("pass");
  expect(health(result).warnings.some((w) => w.startsWith("invariants.md is over 80% of its cap"))).toBe(true);
});

test.each([
  ["refs: [src/gone.ts]", "src/gone.ts", "refs entry does not exist"],
  ["refs: [src/checkout.ts#refund]", "src/checkout.ts#refund", "refs entry has no refund"],
  ["refs: [src/checkout.ts/]", "src/checkout.ts/", "refs entry is not a directory"],
  ["refs: [../outside.ts]", "../outside.ts", "refs entry not a path inside the repository"],
])("a dead refs entry fails the check: %s", async (line, ref, reason) => {
  const dir = packProject({ ".archer/invariants.md": `---\ntype: invariants\n${line}\n---\n# Invariants\n` });
  await docsIndex(dir, { write: true });
  const result = await docsIndex(dir, { check: true });
  expect(health(result).deadRefs).toEqual([{ file: "invariants.md", ref, reason }]);
  expect(health(result).status).toBe("fail");
});

test("a dead code reference in the body fails; Archer-folder paths and prose are not code references", async () => {
  const dir = packProject({
    ".archer/invariants.md": `${front({ type: "invariants" })}# Invariants\n\n- Writes go through \`src/write.ts#confine\`, never \`notes/scratch/x.md\`; run \`archer docs index --check\`.\n\n\`\`\`text\nsrc/in-a-fence.ts\n\`\`\`\n`,
  });
  await docsIndex(dir, { write: true });
  const result = await docsIndex(dir, { check: true });
  expect(health(result).deadRefs).toEqual([
    { file: "invariants.md", ref: "src/write.ts#confine", reason: "does not exist" },
  ]);
});

test("a body citation outside refs is a warning (upkeep matches on refs)", async () => {
  const dir = packProject({
    ".archer/invariants.md": `${front({ type: "invariants", refs: "[src/checkout.ts]" })}# Invariants\n\nReceipts: \`src/email/send.ts#sendReceipt\`.\n`,
  });
  await docsIndex(dir, { write: true });
  const result = await docsIndex(dir, { check: true });
  expect(health(result).status).toBe("pass");
  expect(health(result).uncoveredRefs).toEqual([
    {
      file: "invariants.md",
      ref: "src/email/send.ts#sendReceipt",
      reason: "cited in the body but not covered by refs",
    },
  ]);
});

test("a link to a missing note or diagram is a dead reference", async () => {
  const dir = packProject({
    ".archer/invariants.md": `${front({ type: "invariants" })}# Invariants\n\nSee [gone](notes/gone.md) and [old](diagrams/old.mmd).\n`,
  });
  await docsIndex(dir, { write: true });
  const result = await docsIndex(dir, { check: true });
  expect(
    health(result)
      .deadRefs.map((d) => d.ref)
      .sort(),
  ).toEqual(["diagram link", "diagrams/old.mmd", "notes/gone.md"]);
});

test("scratch, proposals and retired copies stay out of the route even when linked", () => {
  const dir = packProject({
    ".archer/notes/scratch/idea.md": `${front({ type: "user-flow" })}# Idea\n`,
    ".archer/notes/proposals/next.md": `${front({ type: "architecture", status: "proposed" })}# Next\n`,
    ".archer/notes/old.md": `${front({ type: "user-flow", status: "implemented" })}# Old\n`,
    ".archer/notes/long-history.md": `${front({ type: "reference" })}# History\n`,
  });
  const architecture = join(dir, ".archer/architecture.md");
  writeFileSync(
    architecture,
    `${readFileSync(architecture, "utf8")}\n[idea](notes/scratch/idea.md) [next](notes/proposals/next.md) [old](notes/old.md)\n`,
  );
  const pack = buildPack(findProject(dir));
  const routed = [...pack.listed, ...pack.details, ...pack.pictures].map((entry) => entry.file.path);
  for (const path of ["notes/scratch/idea.md", "notes/proposals/next.md", "notes/old.md", "notes/long-history.md"]) {
    expect(routed).not.toContain(path);
    expect(pack.unrouted).toContain(path);
  }
});

test("the router lists at most 12 core files and flows; the rest fail the check as missing from it", async () => {
  const flows = Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [
      `.archer/diagrams/flows/f${String(i).padStart(2, "0")}.mmd`,
      `flowchart LR\n  a[A] e${i}@--> b[B]\n`,
    ]),
  );
  const dir = packProject(flows);
  await docsIndex(dir, { write: true });
  const result = await docsIndex(dir, { check: true });
  const pack = buildPack(findProject(dir));
  expect(pack.listed).toHaveLength(12);
  expect(pack.overflow.map((e) => e.file.path)).toEqual(["diagrams/flows/returns.mmd", "notes/flows/checkout.md"]);
  expect(health(result).failures.some((f) => /lists at most 12 core files and flows; 2 more are missing/.test(f))).toBe(
    true,
  );
});

test("the routed pack over 80,000 characters fails and asks the person whether to split it", async () => {
  const notes = Object.fromEntries(
    Array.from({ length: 21 }, (_, i) => [
      `.archer/notes/architecture/part${i}.md`,
      `# Part ${i}\n${"x".repeat(3900)}`,
    ]),
  );
  const dir = packProject(notes);
  const architecture = join(dir, ".archer/architecture.md");
  writeFileSync(
    architecture,
    `${readFileSync(architecture, "utf8")}\n${Object.keys(notes)
      .map((path, i) => `[p${i}](${path.slice(".archer/".length)})`)
      .join(" ")}\n`,
  );
  await docsIndex(dir, { write: true });
  const result = await docsIndex(dir, { check: true });
  expect(health(result).budgets.pack.over).toBe(true);
  expect(
    health(result).failures.some((f) =>
      /routed pack is \d+ characters, over its 80000 budget\. Ask the person whether to split/.test(f),
    ),
  ).toBe(true);
});

test("a question routes to at most three files, best first, each with why", async () => {
  const dir = packProject();
  const result = await docsIndex(dir, { question: "How does a customer pay at checkout and get the receipt?" });
  const matches = result.structured["matches"] as { path: string; why: string; diagrams?: string[] }[];
  expect(matches.length).toBeGreaterThan(0);
  expect(matches.length).toBeLessThanOrEqual(3);
  expect(matches[0]).toMatchObject({ path: "notes/flows/checkout.md", diagrams: ["diagrams/flows/checkout.mmd"] });
  expect(matches[0]!.why).toMatch(/checkout/);
  expect(result.text).toContain("notes/flows/checkout.md (picture: diagrams/flows/checkout.mmd)");
});

test("routing finds a detail note and a use case by its name", () => {
  const pack = buildPack(findProject(packProject()));
  expect(route(pack, "card payments")[0]?.path).toBe("notes/architecture/payments.md");
  expect(route(pack, "buy a book")[0]?.path).toBe("use-cases.md");
  expect(route(pack, "how does it work?")).toEqual([]);
});

test("without a question or check, docs_index returns the router", async () => {
  const dir = packProject();
  const result = await docsIndex(dir);
  expect(result.text).toBe(buildPack(findProject(dir)).router.trimEnd());
});

test("covered .mmd staleness is reported, never a failure, and note staleness is unavailable", async () => {
  const dir = packProject();
  const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  writeFileSync(
    join(dir, "archer.toml"),
    `version = 1\nname = "Shop"\nmode = "docs"\n[[views]]\nid = "checkout"\nkind = "freeform"\ntitle = "Checkout"\nsource = ".archer/diagrams/flows/checkout.mmd"\ncovers = ["src/checkout.ts"]\n`,
  );
  git("init", "-q");
  git("-c", "user.name=t", "-c", "user.email=t@t", "add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  writeFileSync(
    join(dir, "src/checkout.ts"),
    "export function placeOrder() { return 2; }\nexport const charge = () => 1;\n",
  );
  await docsIndex(dir, { write: true });
  const result = await docsIndex(dir, { check: true });
  const h = result.structured["health"] as {
    status: string;
    staleness: { views: { viewId: string; status: string }[] };
    noteStaleness: { status: string };
  };
  expect(h.staleness.views).toEqual([
    { viewId: "checkout", source: "diagrams/flows/checkout.mmd", status: "stale", changed: 1 },
  ]);
  expect(h.noteStaleness.status).toBe("unavailable");
  expect(h.status).toBe("pass");
  expect(result.text).toContain("stale: diagrams/flows/checkout.mmd");
});

test("refProblem keeps to the repository and reads symbols as words", () => {
  const dir = packProject();
  expect(refProblem(dir, "src/checkout.ts#placeOrder")).toBeNull();
  expect(refProblem(dir, "src/checkout.ts#place")).toBe("has no place");
  expect(refProblem(dir, "src/")).toBeNull();
  expect(refProblem(dir, "/etc/passwd")).toBe("not a path inside the repository");
  expect(refProblem(dir, "src/checkout.ts:3@abcdef1")).toBeNull();
});

test("the readers take what notes hold literally", () => {
  expect(packFields("---\nrefs: [a/b.ts, 'c/']\nuse-cases:\n  - how-x\nchecked: abc1234 2026-10-22\n---\n")).toEqual({
    checked: "abc1234 2026-10-22",
    refs: ["a/b.ts", "c/"],
    useCases: ["how-x"],
  });
  expect(linkTargets("notes/a.md", "[x](../b.md#h) [y](https://e.x) [z](<c d.md>)\n```\n[no](n.md)\n```")).toEqual([
    "b.md",
    "notes/c d.md",
  ]);
  expect(bodyRefs("`ts/src/a.ts#f` `a b/c` `x.md` `ts/`")).toEqual(["ts/src/a.ts#f", "ts/"]);
  expect(keywords("How do the comments reach the agents?")).toEqual(["comment", "reach", "agent"]);
});

test("the readers and the router never throw on arbitrary note text", () => {
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
  const alphabet = [
    "---\n",
    "refs: [",
    "]",
    "`",
    "](",
    ")",
    "#",
    "\n",
    "```",
    "|",
    "a/",
    "../",
    "%% description: ",
    "type: user-flow\n",
    "é",
    "\u0000",
    " ",
  ];
  const started = Date.now();
  for (let i = 0; i < 300; i++) {
    const text = Array.from({ length: next() % 80 }, () => alphabet[next() % alphabet.length]).join("");
    expect(() => {
      packFields(text);
      linkTargets("notes/x.md", text);
      bodyRefs(text);
      keywords(text);
    }).not.toThrow();
  }
  const dir = packProject({
    ".archer/notes/flows/odd.md": "---\ntype: user-flow\ndescription: a | b\n\nrefs: [\n---\n# `x`](y\n",
  });
  expect(() => packHealth(buildPack(findProject(dir)))).not.toThrow();
  expect(Date.now() - started).toBeLessThan(10_000);
});

// Security review (2026-10-22): a refs symbol is untrusted text and never becomes a pattern; a
// symbol lookup reads only a bounded file inside the repository, whatever a link says.
test.each([
  "src/checkout.ts#(a+)+$",
  "src/checkout.ts#[",
  "src/checkout.ts#a|placeOrder",
  "src/checkout.ts#.*",
  "src/checkout.ts#place\\w+",
])("a refs symbol outside the [\\w$.-] grammar is an invalid reference, not a pattern: %s", (ref) => {
  expect(refProblem(packProject(), ref)).toBe(
    "is not a valid code reference (a symbol is letters, digits, _, $, . and -)",
  );
});

test("a symbol lookup on a catastrophic-backtracking shape stays linear", () => {
  const dir = packProject({ "src/aaa.ts": `${"a".repeat(200_000)}!` });
  const started = Date.now();
  expect(refProblem(dir, `src/aaa.ts#${"a".repeat(200)}b`)).toBe(`has no ${"a".repeat(200)}b`);
  expect(refProblem(dir, "src/checkout.ts#$charge")).toBe("has no $charge");
  expect(Date.now() - started).toBeLessThan(2000);
});

test("a symbol lookup checks the linked file's size, and never reads outside the repository", async () => {
  const { symlinkSync } = await import("node:fs");
  const dir = packProject({ "big/huge.ts": `export const x = 1;\n${"/".repeat(3 * 1024 * 1024)}\n` });
  symlinkSync(join(dir, "big/huge.ts"), join(dir, "src/link.ts"));
  expect(refProblem(dir, "src/link.ts#x")).toBe("is too large to look for the symbol in");
  const outside = tempDir({ "secret.ts": "export const token = 1;\n" });
  symlinkSync(join(outside, "secret.ts"), join(dir, "src/out.ts"));
  expect(refProblem(dir, "src/out.ts#token")).toBe("leads outside the repository");
});

test("a symbol lookup in one long run of identifier characters is linear", () => {
  const dir = packProject({ "src/run.ts": "a".repeat(1024 * 1024) });
  const started = performance.now();
  expect(refProblem(dir, "src/run.ts#aaaa")).toBe("has no aaaa");
  expect(performance.now() - started).toBeLessThan(100);
});

test("a symbol or symbol part over 256 characters is an invalid reference", () => {
  const dir = packProject();
  expect(refProblem(dir, `src/checkout.ts#${"a".repeat(257)}`)).toBe(
    "is not a valid code reference (a symbol is letters, digits, _, $, . and -)",
  );
  expect(refProblem(dir, `src/checkout.ts#placeOrder.${"b".repeat(300)}`)).toBe(
    "is not a valid code reference (a symbol is letters, digits, _, $, . and -)",
  );
});

test("the router and an unset pack point an agent at the docs-mode rules", async () => {
  const dir = tempDir({ "archer.toml": 'version = 1\nmode = "docs"\n' });
  const result = await docsIndex(dir, { check: true });
  expect(String((result.structured["router"] as { text: string }).text)).toContain("`archer docs docs-mode`");
  expect(result.text).toContain("archer://docs/docs-mode");
  expect(result.text).toMatch(/draft .*from the code.*one question at a time/i);
  expect((await docsIndex(packProject(), { check: true })).text).not.toContain("archer://docs/docs-mode");
});

// Codex review (2026-10-22): untrusted note text stays linear and never throws; oversized files are
// reported, not dropped; reference links count; empty symbol parts are invalid.
test("link scanning stays linear on a hostile line", () => {
  const started = performance.now();
  linkTargets("notes/x.md", "](< ".repeat(40_000));
  expect(performance.now() - started).toBeLessThan(200);
});

test("front-matter keys that name Object properties, and huge lists, neither throw nor leak", () => {
  for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty"])
    expect(packFields(`---\n${key}: anything\nrefs: [a/b.ts]\n---\n`)).toEqual({ refs: ["a/b.ts"], useCases: [] });
  const huge = packFields(`---\nrefs: [${Array.from({ length: 200_000 }, (_, i) => `a${i}/`).join(",")}]\n---\n`);
  expect(huge.refs).toHaveLength(200_000);
});

test("reference-style links are followed; a missing target is a dead reference", async () => {
  expect(linkTargets("notes/a.md", "See [the flow][f].\n\n[f]: flows/x.md\n")).toEqual(["notes/flows/x.md"]);
  const dir = packProject({
    ".archer/invariants.md": `${front({ type: "invariants" })}# Invariants\n\n[gone][g]\n\n[g]: notes/missing.md\n`,
  });
  await docsIndex(dir, { write: true });
  expect(health(await docsIndex(dir, { check: true })).deadRefs.map((d) => d.ref)).toEqual(["notes/missing.md"]);
});

test("a pack file too large to read is a failure, not a file the check forgets", async () => {
  const dir = packProject({ ".archer/notes/architecture/huge.md": `# Huge\n${"x".repeat(1024 * 1024 + 10)}` });
  const architecture = join(dir, ".archer/architecture.md");
  writeFileSync(architecture, `${readFileSync(architecture, "utf8")}\n[huge](notes/architecture/huge.md)\n`);
  await docsIndex(dir, { write: true });
  const h = health(await docsIndex(dir, { check: true }));
  expect(h.status).toBe("fail");
  expect(h.failures.some((f) => f.startsWith("notes/architecture/huge.md is over 1048576 bytes"))).toBe(true);
});

test.each(["src/checkout.ts#...", "src/checkout.ts#placeOrder.", "src/checkout.ts#.placeOrder"])(
  "a symbol with an empty part is invalid: %s",
  (ref) => {
    expect(refProblem(packProject(), ref)).toBe(
      "is not a valid code reference (a symbol is letters, digits, _, $, . and -)",
    );
  },
);

test("more than five flows is a warning: the router's limit of 12 is the failure", async () => {
  const flows = Object.fromEntries(
    Array.from({ length: 4 }, (_, i) => [`.archer/diagrams/flows/x${i}.mmd`, `flowchart LR\n  a[A] e${i}@--> b[B]\n`]),
  );
  const dir = packProject(flows);
  await docsIndex(dir, { write: true });
  const h = health(await docsIndex(dir, { check: true }));
  expect(h.status).toBe("pass");
  expect(h.warnings.some((w) => /6 flows; docs mode asks for two to five/.test(w))).toBe(true);
});

test("list_diagrams in a docs-mode project points at the pack first; elsewhere it says nothing new", async () => {
  const application = app(packProject());
  try {
    expect((await application.call("list_diagrams")).text).toContain(
      "Docs mode: look in the doc pack first (docs_index with the question, or index.md); rules: archer://docs/docs-mode.",
    );
  } finally {
    application.close();
  }
  const plain = app(packProject({}, ""));
  try {
    expect((await plain.call("list_diagrams")).text).not.toContain("Docs mode");
  } finally {
    plain.close();
  }
});
