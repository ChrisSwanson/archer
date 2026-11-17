// @vitest-environment jsdom
// O156: a banner that stays up while its words change is an alert only when it first appears. An alert is read out
// again each time its text changes, so the words that follow the person's own actions (Save refused, a proposal
// saved, which puts back the first words) are said politely.
import { expect, test } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAnnouncedOnce } from "../src/authoring/announced-once";

test("alert on first appearance, status once its words change, alert again for a new appearance", () => {
  const { result, rerender } = renderHook(({ text }: { text: string | null }) => useAnnouncedOnce(text), {
    initialProps: { text: "The original changed" as string | null },
  });
  expect(result.current).toBe("alert");
  rerender({ text: "The original changed" });
  expect(result.current).toBe("alert");
  rerender({ text: "Save is blocked" });
  expect(result.current).toBe("status");
  rerender({ text: "The original changed" });
  expect(result.current).toBe("status");
  rerender({ text: null });
  expect(result.current).toBe(null);
  rerender({ text: "Save is blocked" });
  expect(result.current).toBe("alert");
});
