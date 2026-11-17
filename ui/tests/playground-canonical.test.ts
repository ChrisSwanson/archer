import { expect, it, vi } from "vitest";
vi.hoisted(() => vi.resetModules());
vi.mock("../src/runtime/address.ts", async () => await import("../src/playground/address"));
import { configureStaticAddress, encodeAddress, decodeAddress } from "../src/playground/address";
import { canonicalFileHref } from "../src/app/page-address";
it("takes the canonical route while retaining caller query and fragments", () => {
  configureStaticAddress({ documentUrl: "https://demo.test/archer/playground/app/index.html", digest: "sha256:test" });
  const here = encodeAddress(
    "https://demo.test/projects/archer-tour/.archer/notes/what-is-archer.md?thread=abc#purpose",
  );
  const there = encodeAddress("https://demo.test/projects/archer-tour/notes/what-is-archer.md");
  expect(decodeAddress(new URL(canonicalFileHref(here, there), here).href)).toBe(
    "https://demo.test/projects/archer-tour/notes/what-is-archer.md?thread=abc#purpose",
  );
});
