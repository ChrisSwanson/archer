// @vitest-environment jsdom
import { cleanup, render, screen, act } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
const pending = new Map<string, (body: unknown) => void>();
// The plain text stands in for the CodeMirror editor here: jsdom cannot measure it (tests/authoring-source-editor.test.tsx mounts the real one).
vi.mock("../src/source-editor/lazy", () => ({ useSourceEditor: () => null, preloadSourceEditor: async () => null }));
vi.mock("../src/app/browser-resource", () => ({
  browserFetch: (url: string) =>
    new Promise((resolve) => pending.set(url, (body) => resolve({ ok: true, json: async () => body }))),
}));
import { SourcePanel, forgetSourceReads, forgetDiagramAnswers } from "../src/app/SourcePanel";
afterEach(() => {
  cleanup();
  pending.clear();
  forgetSourceReads();
});
// The text, whether shown plainly or (once loaded) in the source editor, whose tokens split it into spans.
const shown = () => screen.getByRole("region", { name: "Mermaid Source" }).textContent ?? "";

test("switching diagrams never shows (or copies) the previous diagram’s source", async () => {
  const mounted = render(<SourcePanel target={{ kind: "view", viewId: "a" }} version={1} onClose={() => {}} />);
  await act(async () => {
    pending.get("api/diagram-source/a")!({ path: "a.mmd", source: "flowchart LR\n a" });
  });
  expect(shown()).toMatch(/flowchart LR/);
  mounted.rerender(<SourcePanel target={{ kind: "view", viewId: "b" }} version={1} onClose={() => {}} />);
  expect(shown()).not.toMatch(/flowchart LR/);
  expect(screen.getByRole("button", { name: "Copy" })).toHaveProperty("disabled", true);
  await act(async () => {
    pending.get("api/diagram-source/b")!({ path: "b.mmd", source: "sequenceDiagram\n" });
  });
  expect(shown()).toMatch(/sequenceDiagram/);
});

test("Escape closes the panel", () => {
  const onClose = vi.fn();
  render(<SourcePanel target={{ kind: "view", viewId: "a" }} version={1} onClose={onClose} />);
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  expect(onClose).toHaveBeenCalled();
});

test("a read that already answered at the revision the page learns of next is not repeated (perf #10)", async () => {
  const asked: string[] = [];
  const real = pending.set.bind(pending);
  pending.set = ((url: string, fn: (body: unknown) => void) => {
    asked.push(url);
    return real(url, fn);
  }) as typeof pending.set;
  // After a Save: the panel reads the saved file while the page still holds the old revision.
  const mounted = render(
    <SourcePanel target={{ kind: "view", viewId: "a" }} version="a@r1" revision="r1" onClose={() => {}} />,
  );
  await act(async () => {
    pending.get("api/diagram-source/a")!({ path: "a.mmd", source: "flowchart LR\n new", modelRevision: "r2" });
  });
  mounted.rerender(
    <SourcePanel target={{ kind: "view", viewId: "a" }} version="a@r2" revision="r2" onClose={() => {}} />,
  );
  await act(async () => {});
  expect(asked).toHaveLength(1);
  // A revision it has not read is read.
  mounted.rerender(
    <SourcePanel target={{ kind: "view", viewId: "a" }} version="a@r3" revision="r3" onClose={() => {}} />,
  );
  await act(async () => {});
  expect(asked).toHaveLength(2);
  pending.set = real;
});

test("the page learning the revision while that read is still in flight asks once, not twice (source-panel journey)", async () => {
  const asked: string[] = [];
  const real = pending.set.bind(pending);
  pending.set = ((url: string, fn: (body: unknown) => void) => {
    asked.push(url);
    return real(url, fn);
  }) as typeof pending.set;
  // Back on the reading page after Save: the panel reads the saved file, and the page hears of the new revision before the answer lands.
  const mounted = render(<SourcePanel target={{ kind: "view", viewId: "a" }} version="a@g4" onClose={() => {}} />);
  mounted.rerender(
    <SourcePanel target={{ kind: "view", viewId: "a" }} version="a@r2" revision="r2" onClose={() => {}} />,
  );
  await act(async () => {
    pending.get("api/diagram-source/a")!({ path: "a.mmd", source: "flowchart LR\n new", modelRevision: "r2" });
  });
  await act(async () => {});
  expect(asked).toHaveLength(1);
  expect(shown()).toMatch(/new/);
  // A version change during a read whose answer turns out older than what the page learnt meanwhile is read again, once.
  mounted.rerender(
    <SourcePanel target={{ kind: "view", viewId: "a" }} version="a@r3" revision="r3" onClose={() => {}} />,
  );
  mounted.rerender(
    <SourcePanel target={{ kind: "view", viewId: "a" }} version="a@r4" revision="r4" onClose={() => {}} />,
  );
  await act(async () => {
    pending.get("api/diagram-source/a")!({ path: "a.mmd", source: "flowchart LR\n newer", modelRevision: "r3" });
  });
  await act(async () => {});
  expect(asked).toHaveLength(3);
  await act(async () => {
    pending.get("api/diagram-source/a")!({ path: "a.mmd", source: "flowchart LR\n newest", modelRevision: "r4" });
  });
  await act(async () => {});
  expect(asked).toHaveLength(3);
  expect(shown()).toMatch(/newest/);
  pending.set = real;
});

test("a read made for another diagram or revision never lands over the one already held for the current one (codex review)", async () => {
  const asked: string[] = [];
  const real = pending.set.bind(pending);
  pending.set = ((url: string, fn: (body: unknown) => void) => {
    asked.push(url);
    return real(url, fn);
  }) as typeof pending.set;
  const mounted = render(
    <SourcePanel target={{ kind: "view", viewId: "a" }} version="a@r1" revision="r1" onClose={() => {}} />,
  );
  await act(async () => {
    pending.get("api/diagram-source/a")!({ path: "a.mmd", source: "flowchart LR\n one", modelRevision: "r1" });
  });
  // To B and back to A before B answers: A is shown from what it holds, and B's late answer is dropped.
  mounted.rerender(
    <SourcePanel target={{ kind: "view", viewId: "b" }} version="b@r1" revision="r1" onClose={() => {}} />,
  );
  mounted.rerender(
    <SourcePanel target={{ kind: "view", viewId: "a" }} version="a@r1" revision="r1" onClose={() => {}} />,
  );
  await act(async () => {
    pending.get("api/diagram-source/b")!({ path: "b.mmd", source: "sequenceDiagram\n", modelRevision: "r1" });
  });
  expect(shown()).toMatch(/one/);
  // r1 → r2 (pending) → back to r1: the r2 answer does not replace what r1 shows.
  mounted.rerender(
    <SourcePanel target={{ kind: "view", viewId: "a" }} version="a@r2" revision="r2" onClose={() => {}} />,
  );
  mounted.rerender(
    <SourcePanel target={{ kind: "view", viewId: "a" }} version="a@r1b" revision="r1" onClose={() => {}} />,
  );
  await act(async () => {
    pending.get("api/diagram-source/a")!({ path: "a.mmd", source: "flowchart LR\n two", modelRevision: "r2" });
  });
  expect(shown()).toMatch(/one/);
  pending.set = real;
});

test("a panel put back while the last one’s read is still in flight joins that read (source-panel journey: the page remounts the panel after Save)", async () => {
  const asked: string[] = [];
  const real = pending.set.bind(pending);
  pending.set = ((url: string, fn: (body: unknown) => void) => {
    asked.push(url);
    return real(url, fn);
  }) as typeof pending.set;
  const first = render(<SourcePanel target={{ kind: "view", viewId: "a" }} version="a@g4" onClose={() => {}} />);
  first.unmount();
  render(<SourcePanel target={{ kind: "view", viewId: "a" }} version="a@r2" revision="r2" onClose={() => {}} />);
  await act(async () => {
    pending.get("api/diagram-source/a")!({ path: "a.mmd", source: "flowchart LR\n saved", modelRevision: "r2" });
  });
  await act(async () => {});
  expect(asked).toHaveLength(1);
  expect(shown()).toMatch(/saved/);
  pending.set = real;
});

test("a panel put back just after the last one’s read answered takes that answer at the same revision, and reads a newer one", async () => {
  const asked: string[] = [];
  const real = pending.set.bind(pending);
  pending.set = ((url: string, fn: (body: unknown) => void) => {
    asked.push(url);
    return real(url, fn);
  }) as typeof pending.set;
  const first = render(<SourcePanel target={{ kind: "view", viewId: "a" }} version="a@g4" onClose={() => {}} />);
  await act(async () => {
    pending.get("api/diagram-source/a")!({ path: "a.mmd", source: "flowchart LR\n saved", modelRevision: "r2" });
  });
  first.unmount();
  const second = render(
    <SourcePanel target={{ kind: "view", viewId: "a" }} version="a@r2" revision="r2" onClose={() => {}} />,
  );
  await act(async () => {});
  expect(asked).toHaveLength(1);
  expect(shown()).toMatch(/saved/);
  second.unmount();
  render(<SourcePanel target={{ kind: "view", viewId: "a" }} version="a@r3" revision="r3" onClose={() => {}} />);
  await act(async () => {});
  expect(asked).toHaveLength(2);
  pending.set = real;
});

test("the header and the Source panel share one read of a note’s diagram at the revision the page knows, and a new revision reads again (smoke-c-embedded-note)", async () => {
  const { httpCommentsTransport } = await import("../src/comments/transport");
  const asked: string[] = [];
  const real = pending.set.bind(pending);
  pending.set = ((url: string, fn: (body: unknown) => void) => {
    asked.push(url);
    return real(url, fn);
  }) as typeof pending.set;
  const address = "notes/n.md#flow",
    url = "api/notes/diagram?address=notes%2Fn.md%23flow";
  const body = (revision: string) => ({
    name: "flow",
    address,
    explicit: true,
    ordinal: 1,
    heading: null,
    kind: "flowchart",
    line: 3,
    bodyLine: 4,
    writable: true,
    sourceRevision: `s-${revision}`,
    notePath: "notes/n.md",
    source: `flowchart LR\n ${revision}`,
    diagnostics: [],
    envelope: { schemaVersion: 1, view: {}, revision, model: {} },
    freshness: { status: "not-in-git" },
  });
  // The panel's fetch stands in for the transport's too: one service, one queue of answers.
  const transport = httpCommentsTransport(
    (u) => new Promise((resolve) => pending.set(u, (b) => resolve({ ok: true, json: async () => b } as Response))),
  );
  // Opening the page: the header reads the diagram's freshness, then the reader opens Source.
  const header = transport.embeddedDiagram!(address, "r1");
  await act(async () => {
    pending.get(url)!(body("r1"));
  });
  await header;
  const first = render(
    <SourcePanel target={{ kind: "embedded", address }} version="v@r1" revision="r1" onClose={() => {}} />,
  );
  await act(async () => {});
  expect(asked).toHaveLength(1);
  expect(shown()).toMatch(/r1/);
  first.unmount();
  // After Save (a moment later): the panel comes back while the page still knows r1 and reads the saved block; the page then hears of r2.
  forgetDiagramAnswers();
  const panel = render(
    <SourcePanel target={{ kind: "embedded", address }} version="v@r1" revision="r1" onClose={() => {}} />,
  );
  await act(async () => {
    pending.get(url)!(body("r2"));
  });
  panel.rerender(
    <SourcePanel target={{ kind: "embedded", address }} version="v@r2" revision="r2" onClose={() => {}} />,
  );
  await expect(transport.embeddedDiagram!(address, "r2")).resolves.toMatchObject({ source: "flowchart LR\n r2" });
  await act(async () => {});
  expect(asked).toHaveLength(2);
  expect(shown()).toMatch(/r2/);
  // A change the page hears of next is read, not answered from what was held.
  const changed = transport.embeddedDiagram!(address, "r3");
  await act(async () => {});
  expect(asked).toHaveLength(3);
  await act(async () => {
    pending.get(url)!(body("r3"));
  });
  await expect(changed).resolves.toMatchObject({ source: "flowchart LR\n r3" });
  pending.set = real;
});

test("the page showing a generation rather than a revision just after Save does not read the answer again (source-panel journey)", async () => {
  const asked: string[] = [];
  const real = pending.set.bind(pending);
  pending.set = ((url: string, fn: (body: unknown) => void) => {
    asked.push(url);
    return real(url, fn);
  }) as typeof pending.set;
  const mounted = render(
    <SourcePanel target={{ kind: "view", viewId: "a" }} version="a@r1" revision="r1" onClose={() => {}} />,
  );
  await act(async () => {
    pending.get("api/diagram-source/a")!({ path: "a.mmd", source: "flowchart LR\n saved", modelRevision: "r2" });
  });
  mounted.rerender(<SourcePanel target={{ kind: "view", viewId: "a" }} version="a@g5" onClose={() => {}} />);
  await act(async () => {});
  expect(asked).toHaveLength(1);
  expect(shown()).toMatch(/saved/);
  pending.set = real;
});

test("a note’s figures, which know no model revision, always ask the service (they check the fence revision themselves)", async () => {
  const { httpCommentsTransport } = await import("../src/comments/transport");
  let calls = 0;
  const body = {
    name: "flow",
    address: "notes/n.md#flow",
    explicit: true,
    ordinal: 1,
    heading: null,
    kind: "flowchart",
    line: 3,
    bodyLine: 4,
    writable: true,
    sourceRevision: "s1",
    notePath: "notes/n.md",
    source: "flowchart LR",
    diagnostics: [],
    envelope: { schemaVersion: 1, view: {}, revision: "r1", model: {} },
    freshness: { status: "not-in-git" },
  };
  const transport = httpCommentsTransport(async () => {
    calls++;
    return { ok: true, json: async () => body } as Response;
  });
  await transport.embeddedDiagram!("notes/n.md#flow", "r1");
  await transport.embeddedDiagram!("notes/n.md#flow");
  expect(calls).toBe(2);
});
