// The Archer folder as folders: which folder a diagram or note is in and the
// breadcrumb trail to it (`folders.ts`).
import { describe, expect, it } from "vitest";
import { folderOf, folderTrail } from "../src/app/folders";

describe("the folder an item is in", () => {
  it.each([
    ["architecture.mmd", ""],
    ["./architecture.mmd", ""],
    ["diagrams/checkout.mmd", "diagrams"],
    ["diagrams/payments/refunds.mmd", "diagrams/payments"],
    [undefined, ""],
  ])("%s is in %j", (path, folder) => {
    expect(folderOf(path)).toBe(folder);
  });
});

describe("the breadcrumb trail", () => {
  it("is empty at the root of the Archer folder: no invented 'Files' segment", () => {
    expect(folderTrail("")).toEqual([]);
  });
  it("walks every folder on the way, each with its own path", () => {
    expect(folderTrail("diagrams/payments")).toEqual([
      { name: "diagrams", path: "diagrams" },
      { name: "payments", path: "diagrams/payments" },
    ]);
  });
});
