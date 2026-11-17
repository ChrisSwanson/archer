import { expect, it } from "vitest";
import { browserRoutePath, projectResourceBase, readBrowserRoute, type BrowserRoute } from "../src/app/browser-routes";

/** Canonical addresses: each parses to its route and builds back to the same href. */
const canonical: readonly [string, BrowserRoute][] = [
  ["/projects/", { kind: "projects" }],
  ["/projects/archer/?follow", { kind: "follow", projectSlug: "archer" }],
  ["/projects/archer/", { kind: "browse", projectSlug: "archer", folder: "" }],
  [
    "/projects/archer/notes/%E6%9E%B6%E6%A7%8B%20docs/",
    { kind: "browse", projectSlug: "archer", folder: "notes/架構 docs" },
  ],
  ["/projects/archer/notes/setup.md", { kind: "file", projectSlug: "archer", path: "notes/setup.md" }],
  ["/projects/archer/diagrams/system.mmd", { kind: "file", projectSlug: "archer", path: "diagrams/system.mmd" }],
  [
    "/projects/archer/notes/setup.md#login",
    { kind: "file", projectSlug: "archer", path: "notes/setup.md", fragment: "login" },
  ],
  ["/projects/archer/README.md", { kind: "file", projectSlug: "archer", path: "README.md" }],
  ["/projects/archer/-/repo/README.md", { kind: "document", projectSlug: "archer", path: "README.md" }],
  ["/projects/archer/-/repo/-/odd.md", { kind: "document", projectSlug: "archer", path: "-/odd.md" }],
  ["/projects/archer-2/a.md", { kind: "file", projectSlug: "archer-2", path: "a.md" }],
];
it.each(canonical)("reads and writes the canonical address %s", (href, route) => {
  const url = new URL(href, "https://host");
  expect(readBrowserRoute(url.pathname, url.search, url.hash)).toEqual(route);
  expect(browserRoutePath(route)).toBe(href);
});

/** The retired `/p/<name>/…` page addresses (0.15.0) are no pages: `/p/<name>/` is the API base only. */
it.each([
  "/p/archer-12345678/",
  "/p/archer-12345678/browse/",
  "/p/archer/browse/notes/deep/",
  "/p/archer/notes/notes/setup.md",
  "/p/archer/documents/docs/a.md",
  "/p/archer/views/notes%2Fsetup.md%23login/",
  "/p/archer/views/system/",
  "/p/archer/edit/",
])("the retired address %s is no page", (path) => expect(readBrowserRoute(path)).toBeNull());

/** `note` and `view` are built, never read: each builds to its canonical address. */
it("writes a standalone diagram at its file, and without one on the follow page by its id", () => {
  expect(
    browserRoutePath({ kind: "view", projectSlug: "archer", viewId: "system", sourcePath: "diagrams/system.mmd" }),
  ).toBe("/projects/archer/diagrams/system.mmd");
  expect(browserRoutePath({ kind: "view", projectSlug: "archer", viewId: "system" })).toBe(
    "/projects/archer/?follow&view=system",
  );
  expect(browserRoutePath({ kind: "view", projectSlug: "archer", viewId: "a b/c" })).toBe(
    "/projects/archer/?follow&view=a%20b%2Fc",
  );
  expect(browserRoutePath({ kind: "view", projectSlug: "archer", viewId: "notes/setup.md#login" })).toBe(
    "/projects/archer/notes/setup.md#login",
  );
  expect(browserRoutePath({ kind: "note", projectSlug: "archer", path: "notes/setup.md" })).toBe(
    "/projects/archer/notes/setup.md",
  );
  expect(browserRoutePath({ kind: "note", projectSlug: "archer", path: "a.md" })).toBe("/projects/archer/a.md");
});

it("reads ?follow only on the project root, and a fragment only as a diagram name", () => {
  expect(readBrowserRoute("/projects/archer/notes/", "?follow")).toEqual({
    kind: "browse",
    projectSlug: "archer",
    folder: "notes",
  });
  expect(readBrowserRoute("/projects/archer/", "?q=x&follow")).toEqual({ kind: "follow", projectSlug: "archer" });
  expect(readBrowserRoute("/projects/archer/", "?q=x")).toEqual({ kind: "browse", projectSlug: "archer", folder: "" });
  expect(readBrowserRoute("/projects/archer/a.md", "", "#not a name")).toEqual({
    kind: "file",
    projectSlug: "archer",
    path: "a.md",
  });
  expect(readBrowserRoute("/projects/archer/a.md", "", "#")).toEqual({
    kind: "file",
    projectSlug: "archer",
    path: "a.md",
  });
  expect(readBrowserRoute("/projects/archer/notes/", "", "#x")).toEqual({
    kind: "browse",
    projectSlug: "archer",
    folder: "notes",
  });
  expect(readBrowserRoute("/projects/archer", "")).toEqual({ kind: "browse", projectSlug: "archer", folder: "" });
});

it('reserves the first segment "-" for system routes', () => {
  for (const path of [
    "/projects/archer/-/",
    "/projects/archer/-",
    "/projects/archer/-/repo/",
    "/projects/archer/-/repo",
    "/projects/archer/-/other/a.md",
    "/projects/archer/-/a.md",
  ])
    expect(readBrowserRoute(path), path).toBeNull();
  expect(browserRoutePath({ kind: "file", projectSlug: "archer", path: "-/a.md" })).toBeNull();
  expect(browserRoutePath({ kind: "note", projectSlug: "archer", path: "-/a.md" })).toBeNull();
  expect(browserRoutePath({ kind: "browse", projectSlug: "archer", folder: "-" })).toBeNull();
  expect(browserRoutePath({ kind: "browse", projectSlug: "archer", folder: "x/-" })).toBe("/projects/archer/x/-/");
});

it.each([
  "/projects/a/notes/../secret/",
  "/projects/a/%2e%2e/",
  "/projects/a/%2Fetc/",
  "/projects/a/%5Cetc/",
  "/projects/a/notes/%ZZ",
  "/projects/a/-/unknown/",
  "//projects/a/notes/",
  "/projects/a/notes//deep/",
  "/projects/../a.md",
  "/projects/a/../b.md",
  "/projects/a/%2e%2e/b.md",
  "/projects/a/%2Fetc",
  "/projects/a/b%5Cc.md",
  "/projects/a/%00.md",
  "/projects/a/x//y.md",
  "/projects/Upper/",
  "/projects//a.md",
  "/projects/a/c:x.md",
  "/projects/a/-/repo/../x.md",
])("refuses invalid path %s", (path) => expect(readBrowserRoute(path)).toBeNull());

it("resolves project resources from nested pages independently of the document directory", () => {
  expect(projectResourceBase("https://host/projects/archer-12345678/notes/deep/?q=hi")).toBe(
    "https://host/p/archer-12345678/",
  );
  // The API base itself is no page.
  expect(projectResourceBase("https://host/p/archer-12345678/")).toBeNull();
  expect(projectResourceBase("https://host/projects/archer/notes/deep/a.md?thread=x#login")).toBe(
    "https://host/p/archer/",
  );
  expect(projectResourceBase("https://host/projects/archer/?follow")).toBe("https://host/p/archer/");
  expect(projectResourceBase("https://host/projects/archer/-/repo/README.md")).toBe("https://host/p/archer/");
  expect(projectResourceBase("https://host/projects/?q=hi", "archer-12345678")).toBe("https://host/p/archer-12345678/");
  // A token-prefixed address (retired in 0.15.0) is no page: it names no resource base.
  expect(projectResourceBase("http://host/token/p/archer-12345678/?note=notes/a.md", "other-12345678")).toBeNull();
  expect(projectResourceBase("https://host/projects/")).toBeNull();
  expect(projectResourceBase("https://host/projects/", "../escape")).toBeNull();
});
