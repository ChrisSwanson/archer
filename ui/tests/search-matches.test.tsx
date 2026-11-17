// @vitest-environment jsdom
//
// Search match fields (phase3-front-door.md, "Match fields"): the page reads
// which field each result matched in -- and which element, note or thread --
// from `matches` (a result without them is not read), and
// shows each match as a labelled item the reader can jump to.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSearch, searchHits, MAX_PARSED_MATCHES } from "../src/app/search";
import { matchLabel, SearchMatches } from "../src/app/SearchMatches";

afterEach(cleanup);

describe("parseSearch", () => {
  it("reads each result's matches and how many more", () => {
    const answer = parseSearch({
      query: "lexer",
      results: [
        {
          target: "view:pipeline",
          title: "Compile pipeline",
          where: ["title", "diagram"],
          matches: [
            { field: "node", text: "Lexer", elementId: "lex" },
            { field: "path", text: "pipeline.mmd" },
            { field: "note", text: "The lexer…", notePath: "notes/lexer.md" },
            { field: "comment", text: "Split the lexer?", threadId: "t-1" },
          ],
          moreMatches: 2,
        },
      ],
    });
    expect(answer?.results[0]).toEqual({
      target: "view:pipeline",
      title: "Compile pipeline",
      where: ["title", "diagram"],
      matches: [
        { field: "node", text: "Lexer", elementId: "lex" },
        { field: "path", text: "pipeline.mmd" },
        { field: "note", text: "The lexer…", notePath: "notes/lexer.md" },
        { field: "comment", text: "Split the lexer?", threadId: "t-1" },
      ],
      moreMatches: 2,
    });
  });

  it("drops a match it cannot read, and keeps the result", () => {
    const answer = parseSearch({
      query: "x",
      results: [
        {
          target: "view:a",
          title: "A",
          where: ["diagram"],
          matches: [
            { field: "nonsense", text: "x" },
            { field: "node", text: 3 },
            { field: "node", text: "ok", elementId: 7 },
            { field: "note", text: "n", notePath: "../escape.md" },
            null,
            { field: "edge", text: "kept", elementId: "e1" },
          ],
          moreMatches: -1,
        },
      ],
    });
    expect(answer?.results[0]?.matches).toEqual([
      { field: "node", text: "ok" },
      { field: "note", text: "n" },
      { field: "edge", text: "kept", elementId: "e1" },
    ]);
    expect(answer?.results[0]).not.toHaveProperty("moreMatches");
  });

  it("reads at most a bounded number of matches, and drops a result whose matches are junk", () => {
    const many = Array.from({ length: MAX_PARSED_MATCHES + 10 }, (_, i) => ({
      field: "node",
      text: `n${i}`,
      elementId: `n${i}`,
    }));
    expect(
      parseSearch({ query: "n", results: [{ target: "view:a", title: "A", where: ["diagram"], matches: many }] })
        ?.results[0]?.matches,
    ).toHaveLength(MAX_PARSED_MATCHES);
    expect(
      parseSearch({ query: "n", results: [{ target: "view:a", title: "A", where: ["diagram"], matches: "junk" }] })
        ?.results,
    ).toEqual([]);
  });

  it("carries the matches into the hits, by target", () => {
    const answer = parseSearch({
      query: "x",
      results: [
        {
          target: "view:a",
          title: "A",
          where: ["diagram"],
          matches: [{ field: "node", text: "X", elementId: "x" }],
          moreMatches: 1,
        },
      ],
    })!;
    expect(searchHits(answer).matches.get("view:a")).toEqual({
      matches: [{ field: "node", text: "X", elementId: "x" }],
      more: 1,
    });
  });
});

describe("SearchMatches", () => {
  it("labels each field in plain words", () => {
    expect(matchLabel({ field: "node", text: "Lexer" })).toBe("Node · Lexer");
    expect(matchLabel({ field: "edge", text: "token stream" })).toBe("Edge · token stream");
    expect(matchLabel({ field: "path", text: ".archer/compile-pipeline.mmd" })).toBe(
      "Path · .archer/compile-pipeline.mmd",
    );
    expect(matchLabel({ field: "participant", text: "Alice" })).toBe("Participant · Alice");
    expect(matchLabel({ field: "message", text: "hi" })).toBe("Message · hi");
    expect(matchLabel({ field: "group", text: "Front end" })).toBe("Group · Front end");
    expect(matchLabel({ field: "source", text: "%% x" })).toBe("Source · %% x");
    expect(matchLabel({ field: "note", text: "…x…" })).toBe("Note · …x…");
    expect(matchLabel({ field: "comment", text: "c" })).toBe("Comment · c");
    expect(matchLabel({ field: "title", text: "T" })).toBe("Title · T");
  });

  it("makes what can be jumped to a button, the rest plain text, and says how many more", () => {
    const onOpen = vi.fn();
    render(
      <SearchMatches
        summary={{
          matches: [
            { field: "title", text: "Compile pipeline" },
            { field: "node", text: "Lexer", elementId: "lex" },
            { field: "note", text: "The lexer…", notePath: "notes/lexer.md" },
            { field: "comment", text: "Split?", threadId: "t-1" },
            { field: "source", text: "%% lexer" },
          ],
          more: 3,
        }}
        onOpen={onOpen}
      />,
    );
    const list = screen.getByRole("list", { name: "Matches" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "Title · Compile pipeline",
      "Node · Lexer",
      "Note · The lexer…",
      "Comment · Split?",
      "Source · %% lexer",
      "and 3 more",
    ]);
    expect(
      within(list)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Node · Lexer", "Note · The lexer…", "Comment · Split?"]);
    fireEvent.click(within(list).getByRole("button", { name: "Node · Lexer" }));
    expect(onOpen).toHaveBeenLastCalledWith({ field: "node", text: "Lexer", elementId: "lex" });
  });

  it("is nothing without matches", () => {
    const { container } = render(<SearchMatches summary={undefined} onOpen={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
