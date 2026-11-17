import { expect, it } from "vitest";
import {
  readPageAddress,
  searchPageHref,
  withPageAddress,
  type PageAddress,
  type ProjectFiles,
} from "../src/app/page-address";
import { withThreadAddress } from "../src/app/thread-address";
import { directoryProjectUrl } from "../src/app/project-directory";
import { projectNameFromPath } from "../src/app/project-name";
import { EMPTY_SEARCH } from "../src/app/file-index";

const files: ProjectFiles = {
  views: [
    { id: "flow", sourcePath: "diagrams/flow.mmd", registration: "durable" },
    { id: "notes/a.md#login", sourcePath: "notes/a.md", registration: "embedded" },
  ],
  notes: [{ path: "notes/a.md" }, { path: "README.md" }],
};

/** Each address reads as the page place it names, and the place writes back as that address. */
const places: readonly [string, PageAddress][] = [
  ["https://host/projects/shop/notes/a.md", { kind: "note", path: "notes/a.md" }],
  ["https://host/projects/shop/README.md", { kind: "note", path: "README.md" }],
  ["https://host/projects/shop/diagrams/flow.mmd", { kind: "view", viewId: "flow" }],
  ["https://host/projects/shop/notes/a.md#login", { kind: "view", viewId: "notes/a.md#login" }],
  [
    "https://host/projects/shop/notes/",
    { kind: "search", state: { ...EMPTY_SEARCH, projects: ["shop"], folder: "notes" } },
  ],
];
it.each(places)("reads %s and writes it back", (href, address) => {
  const url = new URL(href);
  expect(readPageAddress(url.search, url.pathname, { hash: url.hash, files })).toEqual(address);
  expect(withPageAddress("https://host/projects/shop/?follow", address, files)).toBe(href);
});

it("resolves a file to a note before a diagram, and leaves an unknown non-note file unresolved", () => {
  expect(readPageAddress("", "/projects/shop/notes/a.md")).toEqual({ kind: "note", path: "notes/a.md" });
  expect(readPageAddress("", "/projects/shop/diagrams/flow.mmd")).toEqual({ kind: "file", path: "diagrams/flow.mmd" });
  expect(readPageAddress("", "/projects/shop/diagrams/flow.mmd", { files })).toEqual({ kind: "view", viewId: "flow" });
  expect(readPageAddress("", "/projects/shop/notes/a.md", { hash: "#not a name", files })).toEqual({
    kind: "note",
    path: "notes/a.md",
  });
});

it("the follow address follows the agent; its legacy query destinations still name places", () => {
  expect(readPageAddress("?follow", "/projects/shop/")).toBeNull();
  expect(readPageAddress("?follow&view=flow", "/projects/shop/")).toEqual({ kind: "view", viewId: "flow" });
  expect(readPageAddress("?follow&note=notes%2Fa.md", "/projects/shop/")).toEqual({ kind: "note", path: "notes/a.md" });
  expect(readPageAddress("?follow&overview=1", "/projects/shop/")).toEqual({ kind: "overview" });
  // Canonical replacement drops ?follow: the reader is somewhere now.
  expect(withPageAddress("https://host/projects/shop/?follow&view=flow", { kind: "view", viewId: "flow" }, files)).toBe(
    "https://host/projects/shop/diagrams/flow.mmd",
  );
  expect(withPageAddress("https://host/projects/shop/?follow", { kind: "overview" })).toBe(
    "https://host/projects/shop/",
  );
});

it("a search across projects typed on the follow page stays on it, in the query, so the page keeps its project", () => {
  const state = { ...EMPTY_SEARCH, query: "billing" };
  expect(withPageAddress("https://host/projects/shop/?follow", { kind: "search", state })).toBe(
    "https://host/projects/shop/?follow&q=billing",
  );
  expect(readPageAddress("?follow&q=billing", "/projects/shop/")).toEqual({ kind: "search", state });
  // Scoped to this project, it is the project browser's address.
  expect(
    withPageAddress("https://host/projects/shop/?follow", { kind: "search", state: { ...state, projects: ["shop"] } }),
  ).toBe("https://host/projects/shop/?q=billing");
  // Scoped to another project, it is still this page's search: the cross-project filter stays in the query.
  expect(
    withPageAddress("https://host/projects/shop/?follow", { kind: "search", state: { ...state, projects: ["blog"] } }),
  ).toBe("https://host/projects/shop/?follow&q=billing&project=blog");
  expect(readPageAddress("?follow&q=billing&project=blog", "/projects/shop/")).toEqual({
    kind: "search",
    state: { ...state, projects: ["blog"] },
  });
  // Shown in place on any of the project's pages, it stays on the project; going to all projects is a navigation.
  expect(withPageAddress("https://host/projects/shop/diagrams/a.mmd", { kind: "search", state })).toBe(
    "https://host/projects/shop/?follow&q=billing",
  );
  expect(searchPageHref("https://host/projects/shop/diagrams/a.mmd", state)).toBe("https://host/projects/?q=billing");
  expect(searchPageHref("https://host/projects/shop/", { ...state, projects: ["blog"], folder: "notes" })).toBe(
    "https://host/projects/blog/notes/?q=billing",
  );
});

it("writes a diagram whose file is unknown on the follow page, by its id", () => {
  expect(withPageAddress("https://host/projects/shop/", { kind: "view", viewId: "flow" })).toBe(
    "https://host/projects/shop/?follow&view=flow",
  );
  expect(withPageAddress("https://host/projects/shop/", { kind: "view", viewId: "notes/a.md#login" })).toBe(
    "https://host/projects/shop/notes/a.md#login",
  );
});

it("a thread rides the query in front of the diagram fragment", () => {
  expect(withThreadAddress("https://host/projects/shop/notes/a.md#login", "t1")).toBe(
    "https://host/projects/shop/notes/a.md?thread=t1#login",
  );
  expect(withThreadAddress("https://host/projects/shop/notes/a.md", "t1")).toBe(
    "https://host/projects/shop/notes/a.md?thread=t1",
  );
  expect(withThreadAddress("https://host/projects/shop/notes/", "t1")).toBeNull();
});

it("another project's places are clean addresses too", () => {
  expect(directoryProjectUrl("https://host/projects/shop/?follow", "blog", { overview: true })).toBe(
    "https://host/projects/blog/",
  );
  expect(directoryProjectUrl("https://host/projects/shop/notes/a.md", "blog", { note: "x.md" })).toBe(
    "https://host/projects/blog/x.md",
  );
  expect(directoryProjectUrl("https://host/projects/", "blog", { view: "flow", sourcePath: "flow.mmd" })).toBe(
    "https://host/projects/blog/flow.mmd",
  );
  expect(directoryProjectUrl("https://host/projects/", "blog", { view: "flow" })).toBe(
    "https://host/projects/blog/?follow&view=flow",
  );
  expect(directoryProjectUrl("https://host/projects/", "blog", { view: "n.md#x" })).toBe(
    "https://host/projects/blog/n.md#x",
  );
});

it("the project name is the readable name in the address", () => {
  expect(projectNameFromPath("/projects/web-shop-2/notes/a.md")).toBe("web-shop-2");
  expect(projectNameFromPath("/projects/web-shop/")).toBe("web-shop");
  // A real name that ends like a hash is the name, whole (no former hash slug is stripped any more).
  expect(projectNameFromPath("/projects/build-cafebabe/")).toBe("build-cafebabe");
  // A retired `/p/<name>/` page names no project.
  expect(projectNameFromPath("/p/web-shop-1a2b3c4d/")).toBeUndefined();
  expect(projectNameFromPath("/projects/")).toBeUndefined();
});
