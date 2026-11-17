import { authoringStatus } from "../src/authoring/status-cache";
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { PageRuntime } from "../src/app/runtime";
vi.hoisted(() => vi.resetModules());
const holder = vi.hoisted(() => ({ current: null as PageRuntime | null }));
vi.mock("../src/app/runtime", () => ({
  get runtime() {
    return holder.current;
  },
}));
vi.mock("../src/runtime/address.ts", async () => await import("../src/playground/address"));
import { PlaygroundShell } from "../src/playground/shell";
import { configureStaticAddress, decodeAddress, encodeAddress } from "../src/playground/address";
import { createStaticRuntime } from "../src/playground/runtime";
import { exampleSnapshot } from "./support/playground-snapshot";
import type { PlaygroundSnapshot } from "../../shared/playground-snapshot.mts";
import { parseWalkthroughs } from "../src/walkthroughs/parse";
import { installMatchMedia } from "./match-media";
import type { StaticControls } from "../src/playground/webmcp-controls";
import type { BrowserTool } from "../src/playground/webmcp";
let snapshot: PlaygroundSnapshot;
beforeAll(() => {
  snapshot = exampleSnapshot();
}, 30000);
beforeEach(() => {
  installMatchMedia(false);
  window.history.replaceState(
    null,
    "",
    "/archer/playground/app/index.html?route=%2Fprojects%2Farcher-tour%2Fdiagrams%2Fsystem-context.mmd",
  );
  configureStaticAddress({ documentUrl: window.location.href, digest: snapshot.manifest.digest });
  holder.current = createStaticRuntime({
    snapshot,
    href: () => decodeAddress(window.location.href),
    storage: null,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("API network forbidden"))),
  );
  vi.stubGlobal(
    "EventSource",
    vi.fn(() => {
      throw new Error("EventSource forbidden");
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("mounts the real App on a generated project with working local comment controls and no connection claims", async () => {
  render(<PlaygroundShell snapshot={snapshot} runtime={holder.current as ReturnType<typeof createStaticRuntime>} />);
  expect(screen.getByText("Example · Changes stay in this browser · No agent connected.")).toBeInTheDocument();
  await waitFor(() => expect(document.querySelectorAll(".react-flow__node").length).toBeGreaterThan(0), {
    timeout: 10000,
  });
  expect(screen.queryByText(/not connected|reconnecting|connection dropped/i)).toBeNull();
  await act(async () => {
    fireEvent.keyDown(document, { key: "c" });
  });
  const save = await screen.findByRole("button", { name: "Save comment" });
  const text = screen.getByRole("textbox", { name: "Comment" });
  fireEvent.change(text, { target: { value: "A local review of the real diagram" } });
  fireEvent.click(save);
  // Waits for the saved thread, not the comment's text: React writes a controlled textarea's value into its text too,
  // so a text query found the composer's draft at once and went on before the local save had committed the thread.
  const thread = (await screen.findByText("Saved locally")).closest("article")!;
  expect(within(thread).getByText("A local review of the real diagram")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /send.*agent|send queued/i })).toBeNull();
  expect(await screen.findByText("Kept until this tab closes.")).toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
  expect(EventSource).not.toHaveBeenCalled();
}, 15000);

function openLogical(path: string): void {
  window.history.replaceState(null, "", encodeAddress(path));
}
function mountPlayground() {
  return render(
    <PlaygroundShell snapshot={snapshot} runtime={holder.current as ReturnType<typeof createStaticRuntime>} />,
  );
}
for (const slug of ["archer-tour", "rfc-2324-htcpcp", "rfc-1149-ipoac"]) {
  it(`reads a generated note in the real App for ${slug} without API or EventSource traffic`, async () => {
    const project = snapshot.projects.find((project) => project.slug === slug)!;
    const note = (project.responses["api/notes/all"] as { notes: { path: string; title: string }[] }).notes[0]!;
    expect(note).toBeDefined();
    openLogical(`/projects/${slug}/${note.path.split("/").map(encodeURIComponent).join("/")}`);
    mountPlayground();
    expect(await screen.findByRole("article", { name: `Reading ${note.title}` })).toBeInTheDocument();
    expect(screen.queryByText(/not connected|reconnecting|connection dropped/i)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(EventSource).not.toHaveBeenCalled();
  }, 15000);
}

it("steps and plays the saved Tour Containers walkthrough with the real player and no network", async () => {
  const tour = snapshot.projects.find((project) => project.slug === "archer-tour")!;
  const payload = Object.values(tour.responses).find(
    (value) =>
      value &&
      typeof value === "object" &&
      "walkthroughs" in value &&
      "viewId" in value &&
      value.viewId === "containers",
  );
  const walk = parseWalkthroughs(payload)!.walks.find((walk) => walk.steps.length > 2)!;
  expect(walk).toBeDefined();
  openLogical("/projects/archer-tour/diagrams/containers.mmd");
  const { container } = mountPlayground();
  const list = await screen.findByRole("group", { name: "Walkthroughs on this diagram" });
  fireEvent.click(await within(list).findByRole("button", { name: (name) => name.includes(walk.title) }));
  const slider = await screen.findByRole("slider", { name: "Step" });
  expect(slider).toHaveValue("1");
  fireEvent.click(screen.getByRole("button", { name: "Next step" }));
  await waitFor(() => expect(slider).toHaveValue("2"));
  expect(container.querySelectorAll(".archer-emph").length).toBeGreaterThan(0);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  fireEvent.click(screen.getByRole("button", { name: "Play" }));
  expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(slider).toHaveValue("3");
  expect(fetch).not.toHaveBeenCalled();
  expect(EventSource).not.toHaveBeenCalled();
}, 15000);

it("adds a selected-node comment through the real App and updates its pin and activity count", async () => {
  const { container } = mountPlayground();
  await waitFor(() => expect(container.querySelectorAll(".react-flow__node").length).toBeGreaterThan(0));
  const node = container.querySelector<HTMLElement>(".react-flow__node[data-id]")!;
  const id = node.dataset.id!;
  fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
  fireEvent.click(node);
  fireEvent.keyDown(window, { key: "c" });
  const textbox = await screen.findByRole("textbox", { name: "Comment" });
  fireEvent.change(textbox, { target: { value: "Pinned local question" } });
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  // The saved thread, not the composer's draft (which a text query also finds).
  const thread = (await screen.findByText("Saved locally")).closest("article")!;
  expect(within(thread).getByText("Pinned local question")).toBeInTheDocument();
  await waitFor(() =>
    expect(container.querySelector(`.react-flow__node[data-id="${id}"] .archer-pin`)?.textContent).toBe("1"),
  );
  expect(container.querySelector(`.react-flow__node[data-id="${id}"]`)).toHaveAttribute(
    "aria-label",
    expect.stringContaining("has comments"),
  );
  const activity = await holder.current!.request("api/comment-activity");
  const body = (await activity.json()) as { targets: Record<string, { totalThreads: number }> };
  expect(Object.values(body.targets).reduce((sum, target) => sum + target.totalThreads, 0)).toBe(1);
  expect(fetch).not.toHaveBeenCalled();
  expect(EventSource).not.toHaveBeenCalled();
}, 15000);

it("omits authoring and project-settings controls on the example project browser", async () => {
  openLogical("/projects/archer-tour/");
  mountPlayground();
  await screen.findByRole("heading", { name: "Archer Tour" });
  await act(async () => {
    await authoringStatus();
  });
  expect(screen.queryByRole("button", { name: "New" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Project settings/i })).toBeNull();
});

it("omits disk-change claims and New on an example diagram", async () => {
  mountPlayground();
  await waitFor(() => expect(document.querySelectorAll(".react-flow__node").length).toBeGreaterThan(0));
  await act(async () => {
    await authoringStatus();
  });
  expect(screen.queryByText(/Changed on disk/)).toBeNull();
  expect(screen.queryByRole("button", { name: "New" })).toBeNull();
});

// The chat bubble is offered with an example conversation and no composer (owner, 2026-11-15; playground-examples).
it("omits compare, export, Edit, a live chat and draft publishing on an example diagram", async () => {
  const { container } = mountPlayground();
  await waitFor(() => expect(container.querySelectorAll(".react-flow__node").length).toBeGreaterThan(0));
  await act(async () => {
    await authoringStatus();
  });
  expect(screen.queryByRole("button", { name: "Compare revisions" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Export diagram" })).toBeNull();
  expect(container.querySelector(".archer-diagram-edit")).toBeNull();
  expect(screen.queryByRole("button", { name: /^Chat with the agent/u })).toBeNull();
  expect(container.querySelector(".archer-chat-form, .archer-chat textarea")).toBeNull();
  expect(container.querySelector(".archer-review-submit, .primary-comment-publishing")).toBeNull();
});

it("does not promise desktop editing on a phone in the demo", async () => {
  const desktop = window.matchMedia;
  window.matchMedia = ((query: string) => {
    const result = desktop(query);
    return query.includes("max-width") ? { ...result, matches: true } : result;
  }) as typeof window.matchMedia;
  mountPlayground();
  await waitFor(() => expect(document.querySelectorAll(".react-flow__node").length).toBeGreaterThan(0));
  await act(async () => {
    await authoringStatus();
  });
  expect(screen.queryByText("Editing is on desktop")).toBeNull();
});

it("binds browser tools to the real navigation and player, then releases them on unmount", async () => {
  const local = holder.current as ReturnType<typeof createStaticRuntime> & { controls?: StaticControls };
  const { unmount } = mountPlayground();
  await waitFor(() => expect(local.controls).toBeDefined());
  const controls = local.controls!;
  expect(controls.context().projectSlug).toBe("archer-tour");
  let presenting: Promise<unknown>;
  act(() => {
    presenting = controls.present({ viewId: "containers" }, new AbortController().signal);
  });
  await waitFor(() => expect(controls.context().viewId).toBe("containers"));
  await presenting!;
  const tour = snapshot.projects[0]!;
  const walk = parseWalkthroughs(tour.responses["api/walkthroughs?viewId=containers"])!.walks[0]!;
  act(() => {
    presenting = controls.present(
      { viewId: "containers", walkthrough: { id: walk.id, step: 2 } },
      new AbortController().signal,
    );
  });
  await waitFor(() => expect(screen.getByRole("slider", { name: "Step" })).toHaveValue("2"));
  await presenting!;
  act(() => {
    presenting = controls.controlWalk({ action: "play" }, new AbortController().signal);
  });
  await waitFor(() => expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument());
  await presenting!;
  act(() => {
    presenting = controls.controlWalk({ action: "pause" }, new AbortController().signal);
  });
  await waitFor(() => expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument());
  await presenting!;
  unmount();
  expect(local.controls).toBeUndefined();
  await expect(controls.present({ viewId: "containers" }, new AbortController().signal)).rejects.toThrow();
}, 15000);

it("shows browser-agent availability only after the entire registration batch succeeds", async () => {
  let finish: () => void = () => {};
  const pending = new Promise<undefined>((resolve) => {
    finish = () => resolve(undefined);
  });
  const registerTool = vi.fn(() => pending);
  Object.defineProperty(document, "modelContext", { configurable: true, value: { registerTool } });
  try {
    mountPlayground();
    await waitFor(() => expect(registerTool).toHaveBeenCalled());
    expect(screen.queryByText("Agent tools available (WebMCP)")).toBeNull();
    await act(async () => {
      finish();
    });
    expect(await screen.findByText("Agent tools available (WebMCP)")).toBeInTheDocument();
  } finally {
    Reflect.deleteProperty(document, "modelContext");
  }
}, 15000);

it("executes registered browser tools against the visible App with no network", async () => {
  const tools = new Map<string, BrowserTool>();
  Object.defineProperty(document, "modelContext", {
    configurable: true,
    value: {
      registerTool: async (tool: BrowserTool, options: { signal: AbortSignal }) => {
        tools.set(tool.name, tool);
        options.signal.addEventListener("abort", () => tools.delete(tool.name), { once: true });
      },
    },
  });
  try {
    const { container, unmount } = mountPlayground();
    await screen.findByText("Agent tools available (WebMCP)");
    const execute = (name: string, args: object) =>
      tools.get(name)!.execute(args, { signal: new AbortController().signal });
    let result: unknown;
    let done = false;
    void execute("present_diagram", { viewId: "containers" }).then((value) => {
      result = value;
      done = true;
    });
    await waitFor(() => expect(done).toBe(true));
    expect(result).toMatchObject({ context: { viewId: "containers" }, provenance: "static-playground" });
    await act(async () => {
      await execute("set_emphasis", {
        id: "browser-tools",
        viewId: "containers",
        title: "Browser tools",
        groups: [
          {
            id: "browser",
            style: "highlight",
            label: "Browser",
            description: "The person’s page",
            nodes: ["web_page"],
          },
        ],
      });
    });
    await waitFor(() => expect(container.querySelectorAll(".archer-emph").length).toBeGreaterThan(0));
    const tour = snapshot.projects[0]!;
    const walk = parseWalkthroughs(tour.responses["api/walkthroughs?viewId=containers"])!.walks[0]!;
    done = false;
    void execute("present_diagram", { viewId: "containers", walkthrough: { id: walk.id, step: 2 } }).then(() => {
      done = true;
    });
    await waitFor(() => expect(screen.getByRole("slider", { name: "Step" })).toHaveValue("2"));
    await waitFor(() => expect(done).toBe(true));
    expect(fetch).not.toHaveBeenCalled();
    expect(EventSource).not.toHaveBeenCalled();
    unmount();
    expect(tools.size).toBe(0);
  } finally {
    Reflect.deleteProperty(document, "modelContext");
  }
}, 15000);

it("present_diagram with emphasis on the walkthrough's own diagram closes the walkthrough, so the emphasis shows", async () => {
  const tools = new Map<string, BrowserTool>();
  Object.defineProperty(document, "modelContext", {
    configurable: true,
    value: {
      registerTool: async (tool: BrowserTool, options: { signal: AbortSignal }) => {
        tools.set(tool.name, tool);
        options.signal.addEventListener("abort", () => tools.delete(tool.name), { once: true });
      },
    },
  });
  try {
    const { container } = mountPlayground();
    await screen.findByText("Agent tools available (WebMCP)");
    const execute = (name: string, args: object) =>
      tools.get(name)!.execute(args, { signal: new AbortController().signal });
    const tour = snapshot.projects[0]!;
    const walk = parseWalkthroughs(tour.responses["api/walkthroughs?viewId=containers"])!.walks[0]!;
    let done = false;
    void execute("present_diagram", { viewId: "containers", walkthrough: { id: walk.id, step: 2 } }).then(() => {
      done = true;
    });
    await waitFor(() => expect(done).toBe(true));
    await waitFor(() => expect(screen.getByRole("slider", { name: "Step" })).toHaveValue("2"));
    done = false;
    void execute("present_diagram", {
      viewId: "containers",
      emphasis: {
        id: "browser-tools",
        title: "Browser tools",
        groups: [{ id: "browser", style: "highlight", label: "Browser", nodes: ["web_page"] }],
      },
    }).then(() => {
      done = true;
    });
    await waitFor(() => expect(done).toBe(true));
    // As a live presentation that names no walkthrough does: the walkthrough leaves and the requested emphasis shows.
    await waitFor(() => expect(screen.queryByRole("slider", { name: "Step" })).toBeNull());
    await waitFor(() =>
      expect(
        [...container.querySelectorAll(".react-flow__node.archer-emph")].map((node) => node.getAttribute("data-id")),
      ).toEqual(["web_page"]),
    );
  } finally {
    Reflect.deleteProperty(document, "modelContext");
  }
}, 15000);

it.each([
  ["graph", "containers", ".react-flow__node"],
  ["sequence", "answer-by-showing", '[aria-label="Sequence diagram canvas"]'],
  ["journey", "working-session", ".archer-journey"],
])(
  "acknowledges a visible %s canvas through the real App tool binding",
  async (_family, viewId, selector) => {
    const local = holder.current as ReturnType<typeof createStaticRuntime>;
    const { container } = mountPlayground();
    await waitFor(() => expect(local.controls).toBeDefined());
    const controls = local.controls!;
    let completed = false;
    let result: unknown;
    act(() => {
      void controls.present({ viewId }, new AbortController().signal).then(
        (value) => {
          result = value;
          completed = true;
        },
        () => {
          /* A failed assertion unmounts and aborts the still-pending action. */
        },
      );
    });
    await waitFor(() => expect(controls.context().viewId).toBe(viewId));
    await waitFor(() => expect(completed).toBe(true));
    await waitFor(() => expect(container.querySelector(selector)).not.toBeNull());
    expect(result).toMatchObject({ projectSlug: "archer-tour", viewId });
    expect(fetch).not.toHaveBeenCalled();
    expect(EventSource).not.toHaveBeenCalled();
  },
  15000,
);

it("rejects an overtaken App presentation while the newer request reaches its visible canvas", async () => {
  const local = holder.current as ReturnType<typeof createStaticRuntime>;
  const { container } = mountPlayground();
  await waitFor(() => expect(local.controls).toBeDefined());
  await waitFor(() => expect(container.querySelector(".react-flow__node")).not.toBeNull());
  const controls = local.controls!;
  let firstOutcome: unknown;
  let secondDone = false;
  act(() => {
    void controls.present({ viewId: "containers" }, new AbortController().signal).then(
      () => {
        firstOutcome = "resolved";
      },
      (failure: unknown) => {
        firstOutcome = failure;
      },
    );
    void controls.present({ viewId: "heartbeat" }, new AbortController().signal).then(() => {
      secondDone = true;
    });
  });
  await waitFor(() => expect(secondDone).toBe(true));
  expect(controls.context().viewId).toBe("heartbeat");
  await waitFor(() => expect(firstOutcome).toMatchObject({ name: "AbortError" }));
  expect(fetch).not.toHaveBeenCalled();
}, 15000);
