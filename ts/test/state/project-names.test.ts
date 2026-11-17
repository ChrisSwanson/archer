import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { MAX_PROJECT_NAMES, ProjectNameStore, parseProjectNames, readableName } from "../../src/state/project-names.ts";
import { cleanUp, tempDir } from "../service/support.ts";

afterEach(cleanUp);

test.each([
  ["/home/me/code/My Project", "my-project"],
  ["/x/.archer-ü", "archer"],
  ["/x/日本", "project"],
  ["/", "project"],
  ["/x/web--shop__2", "web-shop-2"],
  [`/x/${"a".repeat(100)}`, "a".repeat(40)],
  [`/x/${"a".repeat(39)}-b`, "a".repeat(39)],
])("a readable name is the folder name, lower-cased and URL-safe: %s", (root, name) => {
  expect(readableName(root)).toBe(name);
});

test("names are allocated once per root, suffixed on collision, persisted, and never reassigned", () => {
  const state = tempDir("archer-names-");
  const store = new ProjectNameStore(state);
  expect(store.nameFor("/a/archer")).toBe("archer");
  expect(store.nameFor("/b/archer")).toBe("archer-2");
  expect(store.nameFor("/a/archer")).toBe("archer");
  // A root named like an allocated suffix takes the next free name rather than sharing one.
  expect(store.nameFor("/c/archer-2")).toBe("archer-2-2");
  expect(store.nameFor("/d/archer")).toBe("archer-3");
  const reopened = new ProjectNameStore(state);
  expect(reopened.nameFor("/b/archer")).toBe("archer-2");
  expect(reopened.nameFor("/d/archer")).toBe("archer-3");
  expect(reopened.nameFor("/e/archer")).toBe("archer-4");
  expect(statSync(join(state, "project-names.json")).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(join(state, "project-names.json"), "utf8"))).toEqual({
    version: 1,
    names: [
      { root: "/a/archer", name: "archer" },
      { root: "/b/archer", name: "archer-2" },
      { root: "/c/archer-2", name: "archer-2-2" },
      { root: "/d/archer", name: "archer-3" },
      { root: "/e/archer", name: "archer-4" },
    ],
  });
});

test("looking a name up never allocates one", () => {
  const state = tempDir("archer-names-");
  const store = new ProjectNameStore(state);
  expect(store.recorded("/a/archer")).toBeUndefined();
  store.nameFor("/a/archer");
  expect(store.recorded("/a/archer")).toBe("archer");
});

test.each([
  ["not JSON", "{"],
  ["unknown version", JSON.stringify({ version: 2, names: [] })],
  ["extra field", JSON.stringify({ version: 1, names: [], more: 1 })],
  ["relative root", JSON.stringify({ version: 1, names: [{ root: "a", name: "a" }] })],
  ["unsafe name", JSON.stringify({ version: 1, names: [{ root: "/a", name: "../a" }] })],
  [
    "duplicate name",
    JSON.stringify({
      version: 1,
      names: [
        { root: "/a/x", name: "x" },
        { root: "/b/x", name: "x" },
      ],
    }),
  ],
  [
    "duplicate root",
    JSON.stringify({
      version: 1,
      names: [
        { root: "/a/x", name: "x" },
        { root: "/a/x", name: "x-2" },
      ],
    }),
  ],
  ["extra record field", JSON.stringify({ version: 1, names: [{ root: "/a/x", name: "x", slug: "y" }] })],
])("a corrupt names file fails closed: %s", (_case, text) => {
  expect(() => parseProjectNames(text)).toThrow(expect.objectContaining({ code: "invalid_saved_state" }));
  const state = tempDir("archer-names-");
  writeFileSync(join(state, "project-names.json"), text, { mode: 0o600 });
  expect(() => new ProjectNameStore(state)).toThrow(expect.objectContaining({ code: "invalid_saved_state" }));
});

test("a shared names file is refused rather than trusted", () => {
  const state = tempDir("archer-names-");
  writeFileSync(join(state, "project-names.json"), JSON.stringify({ version: 1, names: [] }), { mode: 0o600 });
  chmodSync(join(state, "project-names.json"), 0o644);
  expect(() => new ProjectNameStore(state)).toThrow(expect.objectContaining({ code: "saved_state_io" }));
});

test("capacity is bounded and refusing a new root changes nothing", () => {
  const state = tempDir("archer-names-");
  const names = Array.from({ length: MAX_PROJECT_NAMES }, (_, index) => ({ root: `/r/${index}`, name: `p${index}` }));
  writeFileSync(join(state, "project-names.json"), JSON.stringify({ version: 1, names }), { mode: 0o600 });
  const store = new ProjectNameStore(state);
  expect(store.nameFor("/r/7")).toBe("p7");
  expect(() => store.nameFor("/r/new")).toThrow(expect.objectContaining({ code: "saved_state_capacity" }));
  expect(JSON.parse(readFileSync(join(state, "project-names.json"), "utf8")).names).toHaveLength(MAX_PROJECT_NAMES);
});

test("a new root takes the base it is given (a worktree's <repository>-<folder>); a recorded root keeps its name", () => {
  const state = tempDir("archer-names-");
  const store = new ProjectNameStore(state);
  // Recorded before worktrees were named after their repository: the address stays.
  expect(store.nameFor("/tmp/scratch/order-notes")).toBe("order-notes");
  expect(store.nameFor("/tmp/scratch/order-notes", "pageturner-order-notes")).toBe("order-notes");
  expect(store.nameFor("/tmp/other/order-notes", "pageturner-order-notes")).toBe("pageturner-order-notes");
  expect(store.nameFor("/tmp/third/order-notes", "pageturner-order-notes")).toBe("pageturner-order-notes-2");
  expect(() => store.nameFor("/tmp/bad", "Not A Slug")).toThrow();
});
