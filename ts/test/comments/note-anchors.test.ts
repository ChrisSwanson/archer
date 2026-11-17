import { afterEach, expect, test } from "vitest";
import { passageAnchor, locatePassage } from "../../../shared/note-markdown.mts";
import { renderedNoteText } from "../../src/comments/note-text.ts";
import { CommentsStore, type Place } from "../../src/comments/store.ts";
import { findProject } from "../../src/project/index.ts";
import { removeTempDirs, tempDir } from "../project/support.ts";

afterEach(removeTempDirs);
const cases = [
  ["HTML entity", "Fish &amp; chips.", "Fish & chips"],
  ["reference link", "The [API][api] accepts tokens.\n\n[api]: https://example.com", "API"],
  ["escaped punctuation", "The \\*token\\* is literal.", "*token*"],
  ["table", "| Name | Value |\n| --- | --- |\n| Alice | 42 |", "Alice"],
] as const;
test.each(cases)("a real rendered %s passage can be saved", (_name, markdown, quote) => {
  const root = tempDir({ ".archer/note.md": markdown });
  const text = renderedNoteText(markdown);
  const at = text.indexOf(quote);
  expect(at).toBeGreaterThanOrEqual(0);
  const anchor = passageAnchor(text, at, at + quote.length);
  const place: Place = {
    target: "note:note.md",
    path: "note.comments.json",
    subject: { kind: "note", text: markdown },
  };
  const store = new CommentsStore(findProject(root));
  expect(store.create(place, { anchor, body: "Question" }).value).toMatchObject({ status: "draft", anchor });
});

test("changing surrounding prose keeps the unchanged passage live, as the UI finds it", () => {
  const markdown = "The client sends a token to the API.";
  const root = tempDir({ ".archer/note.md": markdown });
  const place: Place = {
    target: "note:note.md",
    path: "note.comments.json",
    subject: { kind: "note", text: markdown },
  };
  const store = new CommentsStore(findProject(root));
  const quote = "sends a token";
  const at = markdown.indexOf(quote);
  const anchor = passageAnchor(markdown, at, at + quote.length);
  store.create(place, { anchor, body: "Question" });
  const changed = "The new client sends a token to the API.";
  expect(locatePassage(changed, anchor)).not.toBeNull();
  store.reconcile({ ...place, subject: { kind: "note", text: changed } });
  expect(store.list(place).threads[0]?.orphaned).toBeUndefined();
  store.reconcile({ ...place, subject: { kind: "note", text: "The passage was removed." } });
  expect(store.list(place).threads[0]?.orphaned).toBe(true);
});

test("isolated UTF-16 surrogates become replacement characters without confusing valid pairs", () => {
  expect(renderedNoteText("\udd7e".repeat(18))).toBe("\ufffd".repeat(18) + "\n");
  expect(renderedNoteText("Book 📘 and token 🔑")).toBe("Book 📘 and token 🔑\n");
});
