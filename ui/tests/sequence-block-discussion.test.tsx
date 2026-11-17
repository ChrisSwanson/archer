// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { FloatingDiscussion, FloatingReview } from "../src/comments/FloatingDiscussion";
import { parseThread } from "../src/comments/parse";
import { ThreadCard } from "../src/comments/ThreadCard";
import { commentPins } from "../src/comments/state";
import { NO_CAPABILITIES, type Thread } from "../src/comments/contract";
import type { ReviewModel } from "../src/comments/useReview";
import { SvgPinRow } from "../src/diagrams/CommentPins";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const wire = {
  id: "t-block",
  target: "view:sequence",
  revision: 1,
  anchor: { kind: "group", id: "frag-0", label: "ready" },
  status: "sent",
  modelRevision: `sha256:${"b".repeat(64)}`,
  identity: { version: 1, fingerprint: `sha256:${"a".repeat(64)}`, unique: false },
  orphaned: true,
  comments: [{ id: "c-block", author: "person", body: "Review alternative", createdAt: "2026-11-12T12:00:00Z" }],
};

test("the page preserves server-owned block identity metadata and model revision", () => {
  expect(parseThread(wire)).toEqual(wire);
  expect(parseThread({ ...wire, identity: { ...wire.identity, fingerprint: "frag-0" } })).toBeUndefined();
  expect(parseThread({ ...wire, identity: { ...wire.identity, unique: "yes" } })).toBeUndefined();
});

test("a group discussion attaches to the sequence header, rather than the full container or an unrelated id", () => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return this.matches(".archer-seq-block-header") ? new DOMRect(100, 100, 240, 30) : new DOMRect(0, 0, 0, 0);
  });
  render(
    <>
      <svg>
        <title>Sequence block test drawing</title>
        <g className="archer-seq-block-header" data-seq-channel="fragments" data-seq-id="frag-0" />
      </svg>
      <FloatingDiscussion
        anchor={{ kind: "group", id: "frag-0", label: "ready" }}
        title="Group: ready"
        onClose={() => {}}
      >
        Discussion text
      </FloatingDiscussion>
    </>,
  );
  expect(screen.queryByText("Original location is unavailable. The conversation remains available.")).toBeNull();
  expect(screen.getByRole("region", { name: "Contextual discussion" })).toHaveStyle({ left: "356px", top: "100px" });
});

test("an ambiguous block retains the discussion with recovery guidance and no positional pin", () => {
  const thread = wire as unknown as Thread;
  render(
    <ThreadCard
      thread={thread}
      scope="view"
      onReply={async () => true}
      onEdit={async () => true}
      onDelete={async () => true}
      onResolve={async () => true}
      onDismiss={async () => true}
    />,
  );
  expect(screen.getByText(/This block cannot be identified safely/)).toHaveTextContent(
    "Start a new comment on the intended block",
  );
  expect(commentPins([thread]).groupPins.size).toBe(0);
});

test("placement includes a block's SVG pins above its header at a zoomed size", () => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.matches(".archer-seq-block-header")) return new DOMRect(100, 500, 824, 30);
    if (this.matches(".archer-pins-svg")) return new DOMRect(880, 470, 44, 60);
    return new DOMRect(0, 0, 0, 0);
  });
  render(
    <>
      <svg>
        <title>Sequence block test drawing</title>
        <g className="archer-seq-block-header" data-seq-channel="fragments" data-seq-id="frag-0" />
        <SvgPinRow
          {...{ owner: "group:frag-0" }}
          pins={[{ threadId: "t-block", number: 1, state: "sent" }]}
          x={924}
          y={500}
        />
      </svg>
      <FloatingDiscussion
        anchor={{ kind: "group", id: "frag-0", label: "ready" }}
        title="Group: ready"
        onClose={() => {}}
      >
        Discussion text
      </FloatingDiscussion>
    </>,
  );
  expect(screen.getByRole("region", { name: "Contextual discussion" })).toHaveStyle({ top: "194px" });
});

function reviewModel(thread: Thread): ReviewModel {
  return {
    capabilities: { ...NO_CAPABILITIES, comments: true },
    viewId: "sequence",
    viewTarget: "view:sequence",
    threads: new Map([["view:sequence", [thread]]]),
    notes: { status: "ready", notes: [] },
    noteContents: new Map(),
    pending: 0,
    pendingTargets: [],
    announcement: null,
    error: null,
    submitting: false,
    actions: {
      create: async () => null,
      reply: async () => false,
      edit: async () => false,
      remove: async () => false,
      resolve: async () => false,
      dismiss: async () => false,
      submitAll: async () => {},
      openNote: () => {},
      dismissError: () => {},
    },
  };
}

test("closing an orphan returns to the review launcher instead of a reused positional block", async () => {
  render(
    <>
      <button type="button" aria-controls="archer-review">
        Review launcher
      </button>
      <svg>
        <title>Sequence block test drawing</title>
        <g className="archer-seq-block-header" data-seq-channel="fragments" data-seq-id="frag-0" tabIndex={0} />
      </svg>
      <FloatingReview
        model={reviewModel(wire as unknown as Thread)}
        open
        onClose={() => {}}
        compose={null}
        onCompose={() => {}}
        onComposeEnd={() => {}}
        diagramChoices={[]}
        threadRequest={{ key: 1, threadId: "t-block" }}
      />
    </>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Close discussion" }));
  expect(screen.getByRole("button", { name: "Review launcher" })).toHaveFocus();
});

test("Project Review never asks to show a reused positional block for an orphan", async () => {
  const onShowAnchor = vi.fn();
  render(
    <FloatingReview
      model={reviewModel(wire as unknown as Thread)}
      open
      onClose={() => {}}
      compose={null}
      onCompose={() => {}}
      onComposeEnd={() => {}}
      diagramChoices={[]}
      onShowAnchor={onShowAnchor}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Group: ready/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Show on diagram" }));
  expect(onShowAnchor).not.toHaveBeenCalled();
  expect(screen.getByText(/Original location is unavailable/)).toBeInTheDocument();
  expect(screen.queryByText(/Open the discussion’s document/)).not.toBeInTheDocument();
});

test("ambiguous identity cannot be read as an attached positional block", () => {
  expect(parseThread({ ...wire, orphaned: undefined })).toBeUndefined();
});

test("tracks intrinsic composer size even when the discussion body is constrained", async () => {
  const { Composer } = await import("../src/comments/Composer");
  const observed = new Set<Element>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(element: Element) {
        observed.add(element);
      }
      unobserve() {}
      disconnect() {}
    },
  );
  try {
    render(
      <FloatingDiscussion
        anchor={{ kind: "group", id: "frag-0", label: "ready" }}
        title="alt block: ready"
        onClose={() => {}}
      >
        <Composer
          requestKey={1}
          choices={[]}
          anchor={{ kind: "group", id: "frag-0", label: "ready" }}
          anchorLabel="alt block: ready"
          onSave={async () => true}
          onCancel={() => {}}
        />
      </FloatingDiscussion>,
    );
    // An autosized textarea can grow this form while its capped scrolling parent stays the same size.
    expect(observed.has(screen.getByRole("form", { name: "New comment" }))).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("a sequence note discussion attaches to its note and uses the picker name", async () => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return this.matches('[data-seq-channel="notes"]') ? new DOMRect(100, 100, 240, 40) : new DOMRect(0, 0, 0, 0);
  });
  const thread = {
    ...wire,
    anchor: { kind: "node", id: "note-0", label: "Body may be short" },
    orphaned: false,
    identity: undefined,
  } as unknown as Thread;
  render(
    <>
      <svg>
        <title>Sequence notes</title>
        <g data-seq-channel="notes" data-seq-id="note-0" tabIndex={0} />
      </svg>
      <FloatingReview
        model={reviewModel(thread)}
        open
        onClose={() => {}}
        compose={null}
        onCompose={() => {}}
        onComposeEnd={() => {}}
        threadRequest={{ key: 1, threadId: thread.id }}
        diagramChoices={[{ anchor: thread.anchor, label: "Note over Client, Server: Body may be short" }]}
      />
    </>,
  );
  const discussion = await screen.findByRole("region", { name: "Contextual discussion" });
  expect(discussion.querySelector(".primary-floating-context")).toHaveTextContent(
    "Note over Client, Server: Body may be short",
  );
  expect(discussion).toHaveStyle({ left: "356px", top: "100px" });
  expect(screen.queryByText("Original location is unavailable. The conversation remains available.")).toBeNull();
});

test("a block discussion stands clear of the whole block, not just its header strip", () => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.matches(".archer-seq-block-header")) return new DOMRect(100, 100, 800, 30);
    if (this.matches(".archer-seq-fragment-border-hit")) return new DOMRect(100, 100, 800, 200);
    return new DOMRect(0, 0, 0, 0);
  });
  render(
    <>
      <svg>
        <title>Sequence block test drawing</title>
        <rect className="archer-seq-fragment-border-hit" data-seq-channel="fragments" data-seq-id="frag-0" />
        <g className="archer-seq-block-header" data-seq-channel="fragments" data-seq-id="frag-0" />
      </svg>
      <FloatingDiscussion
        anchor={{ kind: "group", id: "frag-0", label: "ready" }}
        title="Group: ready"
        onClose={() => {}}
      >
        Discussion text
      </FloatingDiscussion>
    </>,
  );
  // Below the block's bottom edge (300) plus the gap, not below the 30px header.
  expect(screen.getByRole("region", { name: "Contextual discussion" })).toHaveStyle({ top: "316px" });
});

test("a note discussion takes the side beside the note before covering the steps after it", () => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return this.matches('[data-seq-channel="notes"]') ? new DOMRect(300, 300, 400, 34) : new DOMRect(0, 0, 0, 0);
  });
  render(
    <>
      <svg>
        <title>Sequence note test drawing</title>
        <g className="archer-seq-note-comment-target" data-seq-channel="notes" data-seq-id="note-0" />
      </svg>
      <FloatingDiscussion anchor={{ kind: "node", id: "note-0", label: "Note" }} title="Note" onClose={() => {}}>
        Discussion text
      </FloatingDiscussion>
    </>,
  );
  expect(screen.getByRole("region", { name: "Contextual discussion" })).toHaveStyle({ left: "716px", top: "300px" });
});

test("a discussion keeps clear of the canvas's off-screen cue", () => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.matches(".archer-seq-block-header")) return new DOMRect(100, 400, 800, 30);
    if (this.matches(".archer-offscreen-cue")) return new DOMRect(150, 440, 600, 40);
    return new DOMRect(0, 0, 0, 0);
  });
  render(
    <>
      <button type="button" className="archer-offscreen-cue">
        1 more to the right · Show all
      </button>
      <svg>
        <title>Sequence block test drawing</title>
        <g className="archer-seq-block-header" data-seq-channel="fragments" data-seq-id="frag-0" />
      </svg>
      <FloatingDiscussion
        anchor={{ kind: "group", id: "frag-0", label: "ready" }}
        title="Group: ready"
        onClose={() => {}}
      >
        Discussion text
      </FloatingDiscussion>
    </>,
  );
  const top = Number.parseFloat(screen.getByRole("region", { name: "Contextual discussion" }).style.top);
  // Below the cue (bottom 480) plus its margin, or wholly above it.
  expect(top >= 492 || top + 260 <= 428).toBe(true);
});
