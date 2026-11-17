import { expect, it } from "vitest";
import { parseSearch, parseBrowserSearch } from "../src/app/search";
it("keeps configured source hits separate from legacy annotation targets", () => {
  const answer = {
    query: "needle",
    results: [
      {
        target: "source:docs/guide.md",
        title: "Guide",
        where: ["note"],
        matches: [{ field: "note", text: "Hidden needle" }],
      },
    ],
  };
  expect(parseSearch(answer)?.results).toEqual([]);
  expect(parseBrowserSearch(answer)?.results).toEqual(answer.results);
  expect(
    parseBrowserSearch({ ...answer, results: [{ ...answer.results[0], target: "source:../secret.md" }] })?.results,
  ).toEqual([]);
});
