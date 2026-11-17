// @vitest-environment jsdom
import { expect, test } from "vitest";
import { placeNoteHtml, renderNoteMarkdown } from "../src/comments/markdown";
import { passageAnchor, locatePassage } from "../src/comments/state";

test.each([
  ["Fish &amp; chips.", "Fish & chips"],
  ["The [API][api] accepts tokens.\n\n[api]: https://example.com", "API"],
  ["The \\*token\\* is literal.", "*token*"],
])("the shared renderer and production DOM anchor agree on %s", (markdown, quote) => {
  const root = document.createElement("div");
  placeNoteHtml(root, renderNoteMarkdown(markdown));
  const text = root.textContent!;
  const at = text.indexOf(quote);
  expect(at).toBeGreaterThanOrEqual(0);
  const anchor = passageAnchor(text, at, at + quote.length);
  expect(locatePassage(text, anchor)).toEqual({ start: at, end: at + quote.length });
});

test("the page renders isolated surrogates as replacements and preserves valid emoji", () => {
  const root = document.createElement("div");
  placeNoteHtml(root, renderNoteMarkdown("\udd7e\udd7e 📘"));
  expect(root.textContent).toBe("\ufffd\ufffd 📘\n");
});
