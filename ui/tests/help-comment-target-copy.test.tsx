// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { HelpOverlay, commentingSection } from "../src/app/HelpOverlay";

afterEach(cleanup);

test.each(["graph", "sequence"] as const)("%s comment help names the composer's Comment on control", (view) => {
  render(<HelpOverlay open view={view} extra={[commentingSection(view, false)]} onClose={vi.fn()} />);
  const label = screen.getByText("New comment", { selector: "dt span" });
  expect(label.closest("dt")?.nextElementSibling).toHaveTextContent("Choose a target in “Comment on”");
  expect(label.closest("dt")?.nextElementSibling).not.toHaveTextContent("About");
});
