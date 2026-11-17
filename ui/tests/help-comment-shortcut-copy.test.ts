// @vitest-environment jsdom
import { expect, test } from "vitest";
import { commentingSection } from "../src/app/HelpOverlay";

const commentMeaning = (view: "graph" | "sequence" | "journey", walking = false) =>
  commentingSection(view, walking).keys.find(([key]) => key === "C")?.[1];

test.each(["graph", "journey"] as const)("%s comment shortcut avoids sequence-only targets", (view) => {
  expect(commentMeaning(view)).toBe("Comment on the selection; otherwise open diagram chat");
  expect(commentMeaning(view, true)).not.toMatch(/block|note/);
});

test("sequence comment shortcut includes focused blocks and notes", () => {
  expect(commentMeaning("sequence")).toBe(
    "Comment on the selection or focused block/note; otherwise open diagram chat",
  );
  expect(commentMeaning("sequence", true)).toMatch(/focused step/);
});
