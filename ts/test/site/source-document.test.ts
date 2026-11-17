import { expect, it } from "vitest";
import { sourceDocument } from "../../../site/scripts/prepare.ts";

it("keeps published source links inside the site and sends maintainer links to GitHub", () => {
  const markdown =
    "[TLS](tls.md#trust-the-certificate) [Usage](../site/usage.md) [Schema](../schema/diagram-envelope.schema.json)";
  const result = sourceDocument(markdown, "docs/install.md");
  expect(result).toContain("[TLS](/security/network-access#trust-the-certificate)");
  expect(result).toContain("[Usage](/usage)");
  expect(result).toContain("https://github.com/chrisswanson/archer/blob/main/schema/diagram-envelope.schema.json");
});
