// @vitest-environment jsdom
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ReviewPanel } from "../src/comments/ReviewPanel";
import { diagramChoices } from "../src/comments/canvas-anchors";
import type { Anchor, Thread } from "../src/comments/contract";
import type { ReviewModel } from "../src/comments/useReview";
import { projectEnvelope } from "../src/diagrams/projection";
import { installMatchMedia } from "./match-media";

afterEach(cleanup);

async function choices() {
  const { compile } = await import(resolve(__dirname, "../../ts/src/mermaid/index.ts"));
  const compiled = await compile(`sequenceDiagram
participant Pot as Coffee Pot
participant Client
opt additions unavailable
Note over Pot,Client: Available additions SHOULD accompany 406
Pot-->>Client: 406 Not Acceptable
end
`);
  expect(compiled.diagnostics).toEqual([]);
  const projected = projectEnvelope({
    schemaVersion: 2,
    view: { id: "coffee", kind: "sequence", title: "Coffee" },
    revision: `sha256:${"a".repeat(64)}`,
    model: compiled.model,
  });
  if (!projected.ok || projected.type !== "sequence") throw new Error("sequence projection failed");
  return diagramChoices(projected, [], []);
}

function thread(id: string, anchor: Anchor, orphaned = false): Thread {
  return {
    id,
    revision: 1,
    target: "view:coffee",
    anchor,
    status: "sent",
    ...(orphaned ? { orphaned: true } : {}),
    comments: [{ id: `comment-${id}`, author: "person", body: `Question ${id}`, createdAt: "2026-11-13T12:00:00Z" }],
  };
}

function model(threads: readonly Thread[]): ReviewModel {
  return {
    capabilities: { comments: true, notes: false },
    viewId: "coffee",
    viewTarget: "view:coffee",
    threads: new Map([["view:coffee", threads]]),
    notes: { status: "ready", notes: [] },
    noteContents: new Map(),
    pending: 0,
    pendingTargets: [],
    announcement: null,
    error: null,
    submitting: false,
    isUnread: () => false,
    actions: {
      create: vi.fn(),
      reply: vi.fn(),
      edit: vi.fn(),
      remove: vi.fn(),
      resolve: vi.fn(),
      dismiss: vi.fn(),
      submitAll: vi.fn(),
      openNote: vi.fn(),
      dismissError: vi.fn(),
      markSeen: vi.fn(),
      markAllSeen: vi.fn(),
      resolveAll: vi.fn(),
      dismissAll: vi.fn(),
      publishAll: vi.fn(),
    },
  } as unknown as ReviewModel;
}

const base = {
  open: true,
  compose: null,
  onClose: () => {},
  onCompose: () => {},
  onComposeEnd: () => {},
};

test.each(["sidebar", "floating"] as const)(
  "%s threads use the picker's sequence block and note labels",
  async (mode) => {
    installMatchMedia(false);
    const diagram = await choices();
    const scoped = diagram.filter((choice) => choice.anchor.kind !== "view");
    expect(scoped.map((choice) => choice.label)).toEqual([
      "opt block: additions unavailable",
      "Note over Coffee Pot and Client: Available additions SHOULD accompany 406",
    ]);
    render(
      <ReviewPanel
        {...base}
        mode={mode}
        model={model(scoped.map((choice, i) => thread(String(i), choice.anchor)))}
        diagramChoices={diagram}
      />,
    );
    for (const choice of scoped) expect(screen.getByText(choice.label)).toBeInTheDocument();
    expect(screen.queryByText("Group: additions unavailable")).toBeNull();
    expect(screen.queryByText("Node: Available additions SHOULD accompany 406")).toBeNull();
  },
);

test("orphaned sequence scopes keep their recorded anchor label", async () => {
  installMatchMedia(false);
  const diagram = await choices();
  const anchor = diagram.find((choice) => choice.anchor.kind === "group")!.anchor;
  render(<ReviewPanel {...base} model={model([thread("orphan", anchor, true)])} diagramChoices={diagram} />);
  expect(screen.getByText("Group: additions unavailable")).toBeInTheDocument();
});
