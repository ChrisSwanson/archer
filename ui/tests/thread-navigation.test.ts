import { expect, it } from "vitest";
import { withPageAddress } from "../src/app/page-address";
it("clears a notification's thread when ordinary legacy navigation changes document", () => {
  const href = withPageAddress("https://host/token/p/demo/?view=first&thread=answer&theme=dark", {
    kind: "note",
    path: "notes/next.md",
  });
  expect(new URL(href).searchParams.has("thread")).toBe(false);
  expect(new URL(href).searchParams.get("theme")).toBe("dark");
});
