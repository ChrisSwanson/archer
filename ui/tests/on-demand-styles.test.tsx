// @vitest-environment jsdom
// A dialog's stylesheet joins the document when the dialog first opens, once, and stays (performance rubric S2).
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { resetOnDemandStylesForTests, useOnDemandStyles } from "../src/theme/on-demand-styles";

afterEach(() => {
  cleanup();
  resetOnDemandStylesForTests();
  document.head.innerHTML = "";
});
const sheets = (): HTMLStyleElement[] => [
  ...document.head.querySelectorAll<HTMLStyleElement>("style[data-archer-styles='dialog']"),
];
function Dialog(props: { open: boolean }): null {
  useOnDemandStyles("dialog", ".d{color:red}", props.open);
  return null;
}

test("nothing is added while the dialog is closed; it is added once when it opens, and kept after it closes", () => {
  const view = render(<Dialog open={false} />);
  expect(sheets()).toHaveLength(0);
  view.rerender(<Dialog open />);
  expect(sheets().map((s) => s.textContent)).toEqual([".d{color:red}"]);
  view.rerender(<Dialog open={false} />);
  view.rerender(<Dialog open />);
  render(<Dialog open />);
  expect(sheets()).toHaveLength(1);
});
