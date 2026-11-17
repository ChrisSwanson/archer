// A diagram embedded in a note is searched by its own block, never by the whole note around it
// (the note-diagrams inventory's defects 1 to 3 and 6).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { MAX_SEARCH_RESULTS } from "../../src/service/front-door.ts";
import { ProjectState } from "../../src/service/project-state.ts";
import { cleanUp, project, write } from "./support.ts";

const states: ProjectState[] = [];
afterEach(async () => {
  states.splice(0).forEach((state) => state.close());
  await cleanUp();
});

const LOGIN = "%% archer-id: login\nflowchart LR\n  a[Alpha] e1@--> b[Beta]\n";
const NOTE = [
  "# Auth",
  "",
  "Prose about zeppelin only.",
  "",
  "## Login",
  "",
  "```mermaid",
  LOGIN.trimEnd(),
  "```",
  "",
  "Middle words between the blocks.",
  "",
  "## Logout",
  "",
  "```mermaid",
  "%% archer-id: logout",
  "flowchart LR",
  "  g[Gamma] e1@--> d[Delta]",
  "```",
  "",
].join("\n");

async function open(files: Readonly<Record<string, string>>) {
  const root = project();
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  const state = await ProjectState.open(
    root,
    (slug) => `http://127.0.0.1/projects/${slug}/`,
    () => {},
    { restoreState: false },
  );
  states.push(state);
  await state.reload();
  return { root, state };
}

const targets = (results: readonly { target: string }[]): string[] =>
  results
    .map((r) => r.target)
    .filter((t) => t.includes("auth.md"))
    .sort();
const LOGIN_VIEW = "view:notes/auth.md#login";
const LOGOUT_VIEW = "view:notes/auth.md#logout";
const AUTH_NOTE = "note:notes/auth.md";

test("a word in one block matches that block and the note, not the sibling block", async () => {
  const { state } = await open({ ".archer/notes/auth.md": NOTE });
  expect(targets(state.search("alpha").results)).toEqual([AUTH_NOTE, LOGIN_VIEW].sort());
  expect(targets(state.search("gamma").results)).toEqual([AUTH_NOTE, LOGOUT_VIEW].sort());
  expect(targets(state.browserSearch("alpha").results)).toEqual([AUTH_NOTE, LOGIN_VIEW].sort());
  expect(targets(state.browserSearch("gamma").results)).toEqual([AUTH_NOTE, LOGOUT_VIEW].sort());
});

test("a word only in the prose, or in prose between blocks, matches the note and no block", async () => {
  const { state } = await open({ ".archer/notes/auth.md": NOTE });
  for (const word of ["zeppelin", "middle"]) {
    expect(targets(state.search(word).results), word).toEqual([AUTH_NOTE]);
    expect(targets(state.browserSearch(word).results), word).toEqual([AUTH_NOTE]);
  }
});

test("every word of a query must be in the same block: words split across two blocks match neither", async () => {
  const { state } = await open({ ".archer/notes/auth.md": NOTE });
  expect(targets(state.search("alpha gamma").results)).toEqual([AUTH_NOTE]);
  expect(targets(state.search("alpha beta").results)).toEqual([AUTH_NOTE, LOGIN_VIEW].sort());
});

test("a block matches by its name and its nearest heading, and the match shown is the block's own line", async () => {
  const { state } = await open({ ".archer/notes/auth.md": NOTE });
  const byHeading = state.search("logout").results.filter((r) => r.target.startsWith("view:"));
  expect(byHeading.map((r) => r.target)).toEqual([LOGOUT_VIEW]);
  const found = state.search("alpha").results.find((r) => r.target === LOGIN_VIEW)!;
  expect(found.matches.map((m) => m.text).join("\n")).toContain("Alpha");
  expect(found.matches.map((m) => m.text).join("\n")).not.toContain("zeppelin");
});

test("diagramSource of an embedded address is the block, with its model revision", async () => {
  const { state } = await open({ ".archer/notes/auth.md": NOTE });
  const source = (await state.diagramSource("notes/auth.md#login"))!;
  expect(source.source).toBe(LOGIN);
  expect(source.path).toBe("notes/auth.md");
  expect(source.modelRevision).toBe(state.envelope("notes/auth.md#login")!.revision);
  expect((await state.diagramSource("notes/auth.md#logout"))!.source).toContain("Gamma");
});

test("a note over 256 KiB with a small block: the block is found by its word and its source is the block alone", async () => {
  const filler = "Plain words that make the note long enough to pass the diagram size limit.\n\n".repeat(4500);
  const big = `# Big\n\n${filler}\n## Part\n\n\`\`\`mermaid\n%% archer-id: part\nflowchart LR\n  o[Omega] e1@--> p[Pi]\n\`\`\`\n`;
  expect(Buffer.byteLength(big)).toBeGreaterThan(300 * 1024);
  const { state } = await open({ ".archer/notes/big.md": big });
  expect(
    state
      .search("omega")
      .results.map((r) => r.target)
      .sort(),
  ).toEqual(["note:notes/big.md", "view:notes/big.md#part"]);
  const source = (await state.diagramSource("notes/big.md#part"))!;
  expect(source.source).toBe("%% archer-id: part\nflowchart LR\n  o[Omega] e1@--> p[Pi]\n");
  expect(source.modelRevision).toBeDefined();
});

test("an edit of the block shows in the source at once, not an old copy", async () => {
  const { root, state } = await open({ ".archer/notes/auth.md": NOTE });
  writeFileSync(join(root, ".archer/notes/auth.md"), NOTE.replace("Alpha", "Aardvark"));
  const source = (await state.diagramSource("notes/auth.md#login"))!;
  expect(source.source).toContain("Aardvark");
  expect(source.modelRevision).toBe(state.envelope("notes/auth.md#login")!.revision);
});

test("many matching blocks do not push the note out of the results", async () => {
  const blocks = Array.from(
    { length: MAX_SEARCH_RESULTS + 5 },
    (_, i) =>
      `## Part ${i}\n\n\`\`\`mermaid\n%% archer-id: part-${i}\nflowchart LR\n  a[Quokka ${i}] e1@--> b[B]\n\`\`\`\n`,
  );
  const { state } = await open({ ".archer/notes/many.md": `# Many\n\nQuokka prose.\n\n${blocks.join("\n")}` });
  const results = state.search("quokka").results;
  expect(results.length).toBeLessThanOrEqual(MAX_SEARCH_RESULTS);
  expect(results.map((r) => r.target)).toContain("note:notes/many.md");
}, 60_000);

test("many matching notes do not push a diagram out of the results (the mirror image)", async () => {
  const files: Record<string, string> = { ".archer/zz-quokka.mmd": "flowchart LR\n  a[Quokka] e1@--> b[B]\n" };
  for (let i = 0; i < MAX_SEARCH_RESULTS + 5; i++) files[`.archer/notes/n${i}.md`] = `# Note ${i}\n\nquokka\n`;
  const { state } = await open(files);
  const results = state.search("quokka").results;
  expect(results).toHaveLength(MAX_SEARCH_RESULTS);
  expect(results.map((r) => r.target)).toContain("view:zz-quokka");
  // Each kind keeps a bounded share; what one kind leaves is the other's.
  expect(results.filter((r) => r.target.startsWith("note:")).length).toBe(MAX_SEARCH_RESULTS - 1);
}, 60_000);

test("the page's search keeps a diagram that matches on its own past diagrams found only through a note", async () => {
  const files: Record<string, string> = { ".archer/zz-own.mmd": "flowchart LR\n  a[Quokka] e1@--> b[B]\n" };
  const about: string[] = [];
  for (let i = 0; i < MAX_SEARCH_RESULTS + 5; i++) {
    files[`.archer/d${String(i).padStart(3, "0")}.mmd`] = `flowchart LR\n  a[A${i}] e1@--> b[B]\n`;
    about.push(`d${String(i).padStart(3, "0")}.mmd`);
  }
  files[".archer/notes/about.md"] = `---\ndiagrams: [${about.join(", ")}]\n---\n# About\n\nquokka\n`;
  const { state } = await open(files);
  const targets = state.browserSearch("quokka").results.map((r) => r.target);
  expect(targets).toContain("view:zz-own");
  expect(targets).toContain("note:notes/about.md");
  // A diagram found only through the note is the note's hit, not its own.
  expect(targets).not.toContain("view:d000");
}, 60_000);
