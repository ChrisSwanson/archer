// The project browser's tab (Folders, Diagrams, Notes) is part of its address:
// `?tab=`, the default left out, so a reload, a shared link and Back keep it.
import { describe, expect, it } from "vitest";
import {
  EMPTY_SEARCH,
  PROJECT_TABS,
  readSearchState,
  SEARCH_PARAMS,
  searchKey,
  writeSearchState,
} from "../src/app/file-index";
import { readPageAddress, withPageAddress } from "../src/app/page-address";

describe("the project browser tab in the address", () => {
  it("defaults to Folders and leaves the default out of the address", () => {
    expect(EMPTY_SEARCH.tab).toBe("folders");
    const url = new URL("https://a.invalid/projects/demo/");
    writeSearchState(url, EMPTY_SEARCH);
    expect(url.searchParams.has("tab")).toBe(false);
  });

  it.each(PROJECT_TABS)("round-trips %s", (tab) => {
    const url = new URL("https://a.invalid/projects/demo/");
    writeSearchState(url, { ...EMPTY_SEARCH, tab });
    expect(readSearchState(url.search)?.tab).toBe(tab);
  });

  it("reads an unknown tab as the default, never a guess", () => {
    expect(readSearchState("?q=&tab=cards")?.tab).toBe("folders");
  });

  it("is a search parameter, so another place clears it and the tab names a different address", () => {
    expect(SEARCH_PARAMS).toContain("tab");
    expect(searchKey({ ...EMPTY_SEARCH, tab: "notes" })).not.toBe(searchKey(EMPTY_SEARCH));
  });

  it("a clean project address carries the tab, with the query and filters", () => {
    const href = withPageAddress("https://a.invalid/projects/demo/", {
      kind: "search",
      state: { ...EMPTY_SEARCH, projects: ["demo"], tab: "diagrams", query: "flow" },
    });
    const url = new URL(href);
    expect(url.pathname).toBe("/projects/demo/");
    expect(url.searchParams.get("tab")).toBe("diagrams");
    const back = readPageAddress(url.search, url.pathname);
    expect(back).toEqual({
      kind: "search",
      state: { ...EMPTY_SEARCH, projects: ["demo"], tab: "diagrams", query: "flow" },
    });
  });
});
