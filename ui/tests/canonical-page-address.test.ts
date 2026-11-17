import { expect, it } from "vitest";
import { readPageAddress, searchPageHref, withPageAddress } from "../src/app/page-address";
import { EMPTY_SEARCH } from "../src/app/file-index";
it("reads canonical project and folder scope with the live query", () => {
  expect(readPageAddress("?q=recovery", "/projects/archer-12345678/notes/")).toEqual({
    kind: "search",
    state: { ...EMPTY_SEARCH, query: "recovery", projects: ["archer-12345678"], folder: "notes" },
  });
});
it("writes scope into canonical route and clearing Project leaves the folder", () => {
  expect(
    withPageAddress("https://host/projects/archer-12345678/notes/?q=before", {
      kind: "search",
      state: { ...EMPTY_SEARCH, query: "recover" },
    }),
  ).toBe("https://host/projects/archer-12345678/?follow&q=recover");
  expect(
    searchPageHref("https://host/projects/archer-12345678/notes/?q=before", { ...EMPTY_SEARCH, query: "recover" }),
  ).toBe("https://host/projects/?q=recover");
  expect(
    withPageAddress("https://host/projects/archer-12345678/", {
      kind: "search",
      state: { ...EMPTY_SEARCH, query: "recover", projects: ["archer-12345678"], folder: "notes" },
    }),
  ).toBe("https://host/projects/archer-12345678/notes/?q=recover");
});
it("reads query destinations on the follow page, and a bare follow address follows the agent", () => {
  expect(readPageAddress("?follow&note=notes/a.md", "/projects/archer-12345678/")).toEqual({
    kind: "note",
    path: "notes/a.md",
  });
  expect(readPageAddress("?follow", "/projects/archer-12345678/")).toBeNull();
  // The retired `/p/<name>/` and token-prefixed pages name nothing of their own.
  expect(readPageAddress("", "/p/archer-12345678/")).toBeNull();
});

// flows-r1 S4: one spelling for the search words, `q`, written and read everywhere (the older `search` is retired, 0.15.0).
import { readSearchState, writeSearchState } from "../src/app/file-index";
it("writes the search words as q, on every kind of page", () => {
  const url = new URL("https://host/projects/shop/?follow");
  writeSearchState(url, { ...EMPTY_SEARCH, query: "billing" });
  expect(url.searchParams.get("q")).toBe("billing");
  expect(url.searchParams.has("search")).toBe(false);
  expect(
    withPageAddress("https://host/projects/shop/?follow", {
      kind: "search",
      state: { ...EMPTY_SEARCH, query: "billing" },
    }),
  ).toBe("https://host/projects/shop/?follow&q=billing");
  expect(
    withPageAddress("https://host/projects/shop-12345678/?follow&view=a", {
      kind: "search",
      state: { ...EMPTY_SEARCH, query: "billing" },
    }),
  ).toBe("https://host/projects/shop-12345678/?follow&q=billing");
});
it("reads only q as the search words", () => {
  expect(readSearchState("?q=billing")?.query).toBe("billing");
  expect(readSearchState("?search=billing")).toBeNull();
  expect(readPageAddress("?follow&search=billing", "/projects/shop/")).toBeNull();
  expect(readPageAddress("?search=billing", "/projects/shop/")).toEqual(readPageAddress("", "/projects/shop/"));
});
