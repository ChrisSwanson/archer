// J3-F1: a note opened from a search match opens at, and marks, the passage the match quotes.
import { describe, expect, it } from "vitest";
import { locateSearchMatch } from "../src/comments/search-passage";

const rendered =
  'Scenario: The Card Is Declined\nAmira has two books in her basket and checks out.\nHer bank declines the card. The payment provider sends payment.failed to the Shop API and returns Amira to the Storefront with "try another card" (checkout, the "card declined" branch).';
const slice = (ranges: { start: number; end: number }[] | null) => ranges?.map((r) => rendered.slice(r.start, r.end));

describe("locateSearchMatch", () => {
  it("finds the quoted passage, whitespace and case aside, and marks the query's words in it", () => {
    const at = locateSearchMatch(
      rendered,
      "…Her bank declines the card. The payment provider sends `payment.failed` to the Shop API…",
      ["declin"],
    );
    expect(slice(at)).toEqual(["declin"]);
    expect(at![0]!.start).toBe(rendered.indexOf("declines"));
  });
  it("a snippet quoting Markdown the page renders differently is found by its longest leading run of words", () => {
    const at = locateSearchMatch(
      rendered,
      'returns Amira to the Storefront with "try another card" ([checkout](../diagrams/checkout.mmd), the "card declined" branch).',
      ["declined"],
    );
    expect(slice(at)).toEqual(["declined"]);
    expect(at![0]!.start).toBe(rendered.lastIndexOf("declined"));
  });
  it("the heading match is the heading", () => {
    const at = locateSearchMatch(rendered, "# Scenario: The Card Is Declined Amira has two books in her basket", [
      "declined",
    ]);
    expect(at![0]!.start).toBe(rendered.indexOf("Declined"));
  });
  it("falls back to the first place a query word is, and to nothing when there is none", () => {
    expect(slice(locateSearchMatch(rendered, "nothing like this anywhere", ["basket"]))).toEqual(["basket"]);
    expect(locateSearchMatch(rendered, "nothing like this anywhere", ["zebra"])).toBeNull();
  });
  it("marks the passage itself when the query has no words to mark in it", () => {
    const at = locateSearchMatch(rendered, "Amira has two books", []);
    expect(slice(at)).toEqual(["Amira has two books"]);
  });
});
