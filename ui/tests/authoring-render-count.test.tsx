// @vitest-environment jsdom
// How often one structured edit re-renders the whole editor (Workspace). The budget is one render per thing the
// person can see change: busy, the edited diagram with its open label field, the redrawn layout. A setter that
// stores the value already held, or a busy flag kept as state when it can be derived, each cost one more.
// In the browser (smoke journey, add a part and name it = two edits): 8 Workspace renders and 8 canvas renders before,
// 7 and 4 after (the canvas element is kept while what it draws is unchanged).
import { Profiler } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AuthoringWorkspace } from "../src/authoring/AuthoringWorkspace";
import type { AuthoringClient, FlowchartEdit } from "../src/authoring/client";
import { loadModelEnvelope } from "./fixtures";

const renders = { workspace: 0 };
vi.mock("../src/source-editor/lazy", () => ({ useSourceEditor: () => null, preloadSourceEditor: async () => null }));
// `familyOf` runs once per Workspace render (the diagram's type): a render counter without touching the product.
vi.mock("../src/authoring/families", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/authoring/families")>();
  return {
    ...real,
    familyOf: (source: string) => {
      renders.workspace++;
      return real.familyOf(source);
    },
  };
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

const status = {
  authorized: true as const,
  edit: { enabled: true },
  storeId: "store_" + "a".repeat(32),
  generation: "gen_" + "b".repeat(32),
  drafts: [],
  operations: [],
  nextOffset: null,
};
const base = loadModelEnvelope("flowchart", "minimal");
const withNode = (id: string) => {
  const model = structuredClone(base.model) as unknown as { nodes: { id: string; label: string; shape: string }[] };
  model.nodes.push({ id, label: "Process", shape: "rectangle" });
  return { ...base, model };
};
function client(): AuthoringClient {
  return {
    presentation: vi.fn(async () => ({ presentation: null })),
    status: vi.fn(async () => status),
    preview: vi.fn(async () => ({ envelope: base, diagnostics: [] })),
    open: vi.fn(),
    snapshot: vi.fn(),
    mutate: vi.fn(),
    operation: vi.fn(),
    edit: vi.fn(async (source: string, edit: FlowchartEdit) =>
      edit.kind === "add-node"
        ? {
            ok: true as const,
            source: `${source}  ${edit.id}[${edit.label}]\n`,
            envelope: withNode(edit.id),
            diagnostics: [],
          }
        : { ok: false as const, source, code: "edit_source_mapping_ambiguous" },
    ),
  };
}

test("adding a part re-renders the editor three times: busy, the added part with its label field, the redrawn layout", async () => {
  window.history.replaceState(null, "", "/p/example/edit/");
  let commits = 0;
  render(
    <Profiler
      id="editor"
      onRender={() => {
        commits++;
      }}
    >
      <AuthoringWorkspace projectSlug="example" api={client()} />
    </Profiler>,
  );
  await screen.findByRole("button", { name: "Delete selected" }, { timeout: 5000 });
  await waitFor(() => expect(document.querySelectorAll(".react-flow__node").length).toBeGreaterThan(0), {
    timeout: 10000,
  });
  await waitFor(() => expect(screen.getByRole("button", { name: /^Process/ })).toBeEnabled(), { timeout: 5000 });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  renders.workspace = 0;
  commits = 0;
  fireEvent.click(screen.getByRole("button", { name: /^Process/ }));
  await screen.findByRole("textbox", { name: /^n1 label$/ }, { timeout: 5000 });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
  // Before: 4 Workspace renders (a derived busy flag kept as state, setters storing what was already held).
  expect(renders.workspace).toBeLessThanOrEqual(3);
  expect(commits).toBeLessThanOrEqual(12);
});
