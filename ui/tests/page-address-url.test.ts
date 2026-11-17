import { describe, expect, it } from "vitest";
import { readPageAddress, withPageAddress, type PageAddress } from "../src/app/page-address";

const base = "http://127.0.0.1:4000/t0k3n/p/courierdesk-1a2b/";

describe("the page's address", () => {
  it.each<[PageAddress, string]>([
    [{ kind: "view", viewId: "delivery-handoff" }, "?view=delivery-handoff"],
    [{ kind: "view", viewId: "notes/auth.md#login-flow" }, "?view=notes%2Fauth.md%23login-flow"],
    [{ kind: "note", path: "notes/auth.md" }, "?note=notes%2Fauth.md"],
    [{ kind: "folder", path: "diagrams/payments" }, "?folder=diagrams%2Fpayments"],
    [{ kind: "overview" }, "?overview=1"],
  ])("writes %o as the one destination, and reads it back", (address, search) => {
    const href = withPageAddress(`${base}?view=old&note=a.md&folder=x&overview=1`, address);
    expect(new URL(href).search).toBe(search);
    expect(readPageAddress(search)).toEqual(address);
  });

  it("keeps what else the address holds", () => {
    const href = withPageAddress(`${base}?keep=pay&view=old#top`, { kind: "note", path: "a.md" });
    expect(href).toBe(`${base}?keep=pay&note=a.md#top`);
  });

  it("reads back every folder it writes", () => {
    for (const path of ["", "diagrams", "diagrams/payments", "a b/ç"]) {
      expect(readPageAddress(new URL(withPageAddress(base, { kind: "folder", path })).search)).toEqual({
        kind: "folder",
        path,
      });
    }
  });

  it("reads a bare address as no destination, and a folder outside the Archer folder as no folder", () => {
    expect(readPageAddress("")).toBeNull();
    expect(readPageAddress("?keep=pay")).toBeNull();
    // `q` is the search page's words (flows-r1 S4), so it names a search here too.
    expect(readPageAddress("?q=pay")?.kind).toBe("search");
    expect(readPageAddress("?folder=..%2Fetc")).toEqual({ kind: "folder", path: null });
  });
});
