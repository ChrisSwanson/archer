// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HelpOverlay, type HelpView } from "../src/app/HelpOverlay";
afterEach(cleanup);
it.each(["graph", "sequence", "journey", "none"] satisfies HelpView[])(
  "describes pointer modes only where controls exist: %s",
  (view) => {
    render(<HelpOverlay open view={view} onClose={vi.fn()} />);
    const instructions = screen.queryByText(/In Hand mode, drag with the left button to pan/);
    if (view === "graph" || view === "sequence") {
      expect(instructions).toBeVisible();
      expect(instructions).toHaveTextContent("Select mode");
      expect(instructions).toHaveTextContent("Keyboard selection works in both modes");
      if (view === "sequence") expect(instructions).not.toHaveTextContent(/marquee/i);
    } else expect(instructions).toBeNull();
  },
);
