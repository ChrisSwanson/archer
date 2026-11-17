// @vitest-environment jsdom
import { resolve } from "node:path";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "../src/app/App";
import {
  MockEventSource,
  mountAgentPresented,
  publishedEdgeIds,
  publishedNodeIds,
  restoreLocation,
  selectionPosts,
  settleSelection,
} from "./app-harness";

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class MockApp {
    addEventListener(): void {}
    callServerTool = vi.fn(() => Promise.resolve({ content: [] }));
    close = vi.fn(() => Promise.resolve());
    connect = vi.fn(() => Promise.resolve());
    updateModelContext = vi.fn(() => Promise.resolve({}));
  },
}));
beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreLocation();
  localStorage.clear();
});
async function mount() {
  const { compile } = await import(resolve(__dirname, "../../ts/src/mermaid/index.ts"));
  const compiled = await compile(
    "sequenceDiagram\nparticipant A as Client\nparticipant B as Server\nA->>B: Send\nopt ready\nNote over A,B: Body MAY be short and stout\nend\n",
  );
  expect(compiled.diagnostics).toEqual([]);
  const mounted = await mountAgentPresented(<App />, {
    envelope: {
      schemaVersion: 2,
      view: { id: "alpha", kind: "sequence", title: "Sequence" },
      revision: `sha256:${"a".repeat(64)}`,
      model: compiled.model,
    },
    views: [{ id: "alpha", kind: "sequence", title: "Sequence", registration: "durable" }],
    bootstrap: { capabilities: { comments: true } },
    ready: (container) => expect(container.querySelector('[data-seq-channel="notes"]')).not.toBeNull(),
  });
  fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
  fireEvent.click(mounted.container.querySelector('[data-seq-channel="messages"][data-seq-id="msg-0"]')!);
  await settleSelection();
  expect(publishedEdgeIds(selectionPosts())).toContain("msg-0");
  return mounted;
}
for (const gesture of ["click", "right-click", "c", "Enter", " "]) {
  test(`${gesture} opens the note comment without changing the selected message or publishing note ids`, async () => {
    const { container } = await mount();
    const note = screen.getByRole("button", { name: "Note over Client and Server: Body MAY be short and stout" });
    act(() => note.focus());
    if (gesture === "click") fireEvent.click(note);
    else if (gesture === "right-click") fireEvent.contextMenu(note, { clientX: 200, clientY: 200 });
    else fireEvent.keyDown(note, { key: gesture });
    await screen.findByRole("textbox", { name: "Comment" });
    expect(
      screen.getByRole("region", { name: "Contextual discussion" }).querySelector(".primary-floating-context"),
    ).toHaveTextContent("Note over Client and Server: Body MAY be short and stout");
    expect(container.querySelector('[data-seq-channel="messages"]')).toHaveClass("archer-seq-selected");
    await settleSelection();
    expect(publishedNodeIds(selectionPosts())).not.toContain("note-0");
    expect(publishedEdgeIds(selectionPosts())).not.toContain("note-0");
  });
}
