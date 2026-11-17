// The folder page's address: `?folder=<path in the Archer folder>`
// (`folder-link.ts`). Read from a page address, written onto one; a path that
// would leave the Archer folder is never taken for a folder.
import { describe, expect, it } from "vitest";
import { readFolderLink } from "../src/app/folder-link";

describe("reading ?folder=", () => {
  it.each([
    ["", null],
    ["?view=checkout", null],
    ["?folder=diagrams", { path: "diagrams" }],
    ["?folder=diagrams%2Fpayments", { path: "diagrams/payments" }],
    ["?folder=diagrams/payments/", { path: "diagrams/payments" }],
    ["?folder=./diagrams//payments", { path: "diagrams/payments" }],
    ["?folder=", { path: "" }],
  ])("%s is %j", (search, link) => {
    expect(readFolderLink(search)).toEqual(link);
  });

  it.each([
    "?folder=..",
    "?folder=../secrets",
    "?folder=diagrams/../../etc",
    "?folder=%2Fetc",
    "?folder=/etc/passwd",
    "?folder=%5Cserver%5Cshare",
    "?folder=C:%5Cwindows",
    "?folder=c:/windows",
    "?folder=diagrams%00x",
  ])("%s leaves the Archer folder, so it names no folder", (search) => {
    expect(readFolderLink(search)).toEqual({ path: null });
  });
});
