// @vitest-environment jsdom
//
// Emphasis reaches a sequence diagram through the page, by the route it
// reaches a graph: the `emphasis` event, the chip row, and Esc.
//
// `sequence-emphasis.test.tsx` holds what the canvas draws when handed an
// emphasis. This holds that the page hands it one -- that nothing between the
// wire and the canvas still assumes emphasis is a graph's alone.
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class MockApp {
    addEventListener(): void {}
    callServerTool = vi.fn(() => Promise.resolve({ content: [] }));
    close = vi.fn(() => Promise.resolve());
    connect = vi.fn(() => Promise.resolve());
    updateModelContext = vi.fn(() => Promise.resolve({}));
  },
}));

import { App } from "../src/app/App";
import { MockEventSource, mountAgentPresented, restoreLocation, type Mounted } from "./app-harness";
import { loadValidFixture } from "./fixtures";
import { installReducedMotion } from "./match-media";

const SEQUENCE_ENVELOPE = loadValidFixture("minimal-sequence.json") as { view: { id: string } };
const VIEW = SEQUENCE_ENVELOPE.view.id;

beforeEach(() => {
  MockEventSource.instances.length = 0;
  installReducedMotion(false);
  vi.stubGlobal("EventSource", MockEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreLocation();
});

/** A sequence diagram on screen, then one emphasis published for it. */
async function mountEmphasised(): Promise<Mounted> {
  const mounted = await mountAgentPresented(<App />, {
    envelope: SEQUENCE_ENVELOPE,
    ready: (container) => {
      expect(container.querySelector("[aria-label='Sequence diagram canvas']")).not.toBeNull();
    },
  });
  act(() => {
    mounted.source.emit("emphasis", {
      schemaVersion: 1,
      viewId: VIEW,
      emphases: [
        {
          id: "login",
          viewId: VIEW,
          title: "The login path",
          groups: [
            { id: "path", style: "flow", palette: "teal", label: "Login", nodes: [], edges: ["msg-0", "msg-1"] },
            { id: "store", style: "highlight", palette: "coral", label: "The store", nodes: ["db"], edges: [] },
          ],
        },
      ],
    });
  });
  await waitFor(() => expect(mounted.container.querySelector(".archer-emph")).not.toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
  return mounted;
}

const emphasised = (container: HTMLElement): string[] =>
  [...container.querySelectorAll("g.archer-emph[data-seq-id]")]
    .map((element) => element.getAttribute("data-seq-id")!)
    .sort();

describe("an emphasis published for a sequence view", () => {
  it("is drawn on the sequence canvas, with the legend and a chip", async () => {
    const { container } = await mountEmphasised();

    expect(emphasised(container)).toEqual(["db", "msg-0", "msg-1"]);
    expect(container.querySelectorAll(".archer-emph-chevrons")).toHaveLength(2);
    expect(screen.getByRole("region", { name: "Highlights" }).textContent).toContain("The login path");
    const chips = screen.getByRole("group", { name: "Highlights" });
    expect(chips.textContent).toContain("The login path");
  });

  it("is dismissed by Esc and brought back by its chip", async () => {
    const { container } = await mountEmphasised();

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(container.querySelector(".archer-emph")).toBeNull());
    expect(screen.queryByRole("region", { name: "Highlights" })).toBeNull();
    // Dismissed is not deleted: the agent's list is untouched, so the chip
    // stays and puts it back.
    const chip = screen.getByRole("button", { name: /The login path/ });
    fireEvent.click(chip);
    await waitFor(() => expect(emphasised(container)).toEqual(["db", "msg-0", "msg-1"]));
  });

  it("keeps the reader's selection through an emphasis, and drops only the emphasis on the first Esc that finds both", async () => {
    const { container } = await mountEmphasised();
    fireEvent.click(screen.getByText("POST /login"));
    await waitFor(() => {
      expect(container.querySelector("g.archer-seq-selected.archer-emph[data-seq-id='msg-0']")).not.toBeNull();
    });

    // One press does both jobs, as the cheat sheet says under two headings.
    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(container.querySelector(".archer-emph")).toBeNull());
    expect(container.querySelector(".archer-seq-selected")).toBeNull();
  });
});
