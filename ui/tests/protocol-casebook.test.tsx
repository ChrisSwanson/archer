// @vitest-environment jsdom
// The shipped named fences through the real compiler, note painter and canvas.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { compileEmbedded, readEmbeddedIn } from "../../ts/src/notes/embedded";
import { noteContent } from "../../ts/src/comments/notes";
import { findProject } from "../../ts/src/project";
import { App } from "../src/app/App";
import { figureLoader, paintFigure } from "../src/comments/note-figures";
import { NoteReader } from "../src/comments/NoteReader";
import type { ReviewModel } from "../src/comments/useReview";
import { MockEventSource, mountAgentPresented, publishedNodeIds, restoreLocation, selectionPosts } from "./app-harness";

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class {
    addEventListener(): void {}
    callServerTool = vi.fn(() => Promise.resolve({ content: [] }));
    close = vi.fn(() => Promise.resolve());
    connect = vi.fn(() => Promise.resolve());
    updateModelContext = vi.fn(() => Promise.resolve({}));
  },
}));

const cases = [
  ["rfc-2324-htcpcp", "coffee-uri-slots", "coffee_pot"],
  ["rfc-1149-ipoac", "paper-datagram", "scroll"],
] as const;

beforeEach(() => {
  MockEventSource.instances.length = 0;
  vi.stubGlobal("EventSource", MockEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreLocation();
});

test.each(cases)("%s: clicking the named figure's node publishes its selection", async (name, figure, nodeId) => {
  const project = findProject(resolve(import.meta.dirname, "../../examples", name));
  const fence = readEmbeddedIn(project, "notes/reading-guide.md").find((entry) => entry.name === figure)!;
  const { envelope, diagnostics } = await compileEmbedded(fence);
  expect(diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
  expect(envelope?.view.id).toBe(`notes/reading-guide.md#${figure}`);
  const { container } = await mountAgentPresented(<App />, {
    envelope,
    ready: (root) => expect(root.querySelector(`[data-id="${nodeId}"]`)).not.toBeNull(),
  });
  expect(screen.getByRole("button", { name: "Hand mode" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(container.querySelector(`.react-flow__node[data-id="${nodeId}"]`)!);
  expect(publishedNodeIds(selectionPosts())).not.toContain(nodeId);
  fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
  fireEvent.click(container.querySelector(`.react-flow__node[data-id="${nodeId}"]`)!);
  await waitFor(() => expect(publishedNodeIds(selectionPosts())).toContain(nodeId));
  const last = selectionPosts().at(-1) as [string, { body: string }];
  expect(JSON.parse(last[1].body)).toMatchObject({ viewId: fence.address, nodes: [{ id: nodeId }] });
});

test.each(cases)("%s: the note reader paints, opens and restores every named casebook fence", async (name) => {
  const root = resolve(import.meta.dirname, "../../examples", name);
  const project = findProject(root);
  const before = readFileSync(resolve(root, ".archer/notes/reading-guide.md"), "utf8");
  const fences = readEmbeddedIn(project, "notes/reading-guide.md");
  const load = figureLoader(async (address) => {
    const fence = fences.find((entry) => entry.address === address);
    if (!fence) throw new Error(`Unexpected figure: ${address}`);
    return { ...fence, ...(await compileEmbedded(fence)), freshness: { status: "not-in-git" } };
  }, paintFigure);
  const content = noteContent(project, "notes/reading-guide.md");
  const model = {
    capabilities: { notes: true },
    threads: new Map(),
    noteContents: new Map([[content.path, { status: "ready", content }]]),
    actions: { openNote: vi.fn() },
  } as unknown as ReviewModel;
  const onOpen = vi.fn();
  const reader = (address?: string) => (
    <NoteReader
      model={model}
      path={content.path}
      note={{ path: content.path, title: name }}
      figures={{ load, now: Date.now }}
      onCompose={vi.fn()}
      onOpenDiagram={onOpen}
      {...(address === undefined ? {} : { returnTo: { address, scrollTop: 0 } })}
    />
  );
  let shown = render(reader());
  for (const fence of fences) {
    expect(fence.explicit).toBe(true);
    const figure = await load(fence.address, fence.sourceRevision);
    expect(figure.status).toBe("drawn");
    if (figure.status !== "drawn") throw new Error(JSON.stringify(figure));
    expect(figure.diagram.envelope).toMatchObject({ view: { id: fence.address } });
    expect(figure.drawing.content).toContain("data-element-id");
    expect(figure.drawing.viewBox.split(" ").map(Number).every(Number.isFinite)).toBe(true);
    const link = await screen.findByRole("link", { name: `Open ${fence.name}, Flowchart` });
    await waitFor(() => expect(link.querySelector("svg.archer-note-figure-drawing [data-element-id]")).not.toBeNull());
    fireEvent.click(link);
    expect(onOpen).toHaveBeenLastCalledWith(fence.address, 0);
    shown.unmount();
    shown = render(reader(fence.address));
    await waitFor(() => expect(screen.getByRole("link", { name: `Open ${fence.name}, Flowchart` })).toHaveFocus());
  }
  expect(readFileSync(resolve(root, ".archer/notes/reading-guide.md"), "utf8")).toBe(before);
});
