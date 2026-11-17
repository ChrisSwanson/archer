// @vitest-environment jsdom
//
// J3-F1: a note opened from a search match marks the passage the match quotes and brings it into view, once per
// opening: relaying the note (a re-read) keeps the mark and does not scroll the reader back to it.
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NoteItem, type SearchPassage } from "../src/comments/NoteItem";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const markdown =
  "# Scenario\n\nAmira checks out.\n\n1. Her bank **declines** the card. The provider sends `payment.failed`.\n";
const item = (searchMatch: SearchPassage | null, revision = "1") => (
  <NoteItem
    direct
    note={{ path: "notes/scenario.md", title: "Scenario" }}
    state={{ status: "ready", content: { path: "notes/scenario.md", frontMatter: {}, markdown, revision } }}
    threads={[]}
    commentsEnabled={false}
    onOpen={() => {}}
    onCompose={() => {}}
    onMissing={() => {}}
    searchMatch={searchMatch}
  />
);

it("marks the query's word in the quoted passage and scrolls it into view once per opening", async () => {
  const scroll = vi.fn();
  Element.prototype.scrollIntoView = scroll;
  const match = {
    key: 1,
    snippet: "…Her bank **declines** the card. The provider sends `payment.failed`.",
    words: ["declin"],
  };
  const view = render(item(match));
  await waitFor(() => expect(document.querySelectorAll("mark[data-search-match]")).toHaveLength(1));
  expect(document.querySelector("mark[data-search-match]")!.textContent).toBe("declin");
  expect(document.querySelector("mark[data-search-match]")!.closest("li")).not.toBeNull();
  expect(scroll).toHaveBeenCalledTimes(1);
  view.rerender(item(match, "2"));
  await waitFor(() => expect(document.querySelectorAll("mark[data-search-match]")).toHaveLength(1));
  expect(scroll).toHaveBeenCalledTimes(1);
  view.rerender(item({ ...match, key: 2 }, "2"));
  await waitFor(() => expect(scroll).toHaveBeenCalledTimes(2));
});

it("marks nothing without a match", async () => {
  render(item(null));
  await waitFor(() => expect(document.querySelector("li")).not.toBeNull());
  expect(document.querySelector("mark[data-search-match]")).toBeNull();
});
