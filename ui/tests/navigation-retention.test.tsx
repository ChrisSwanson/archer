// @vitest-environment jsdom
//
// G6, PF-3 (review evidence performance-2026-11-02-draft, private, not published): navigation must not keep the page it left. The leak
// journey found every loop's project page held through a detached control kept in App's state (`headingWanted.from`):
// each kept page held the closures of an older render, so the chain grew by one page per loop. Here: after opening a
// diagram from the project page, no hook of any mounted component holds a node that is no longer in the document.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { MockEventSource } from "./app-harness";
import { installViewport, type Viewport } from "./match-media";

const view = (id: string, title: string, kind: string) => ({ id, kind, title, registration: "durable" as const });

const VIEWS = [
  view("compile", "Compile pipeline", "data-flow"),
  view("orders", "Order lifecycle", "state"),
  view("shop", "Web shop containers", "c4-container"),
  view("checkout", "Checkout journey", "journey"),
];

const envelope = (viewId: string) => ({
  schemaVersion: 2,
  view: { id: viewId, kind: "data-flow", title: viewId },
  revision: `sha256:${"0".repeat(63)}${VIEWS.findIndex((v) => v.id === viewId) + 1}`,
  model: { type: "data-flow-graph", nodes: [{ id: "web", label: "Web" }], edges: [], groups: [] },
});

const REAL_LOCATION = Object.getOwnPropertyDescriptor(window, "location")!;

/** Served over HTTP at `pathname`, as the TypeScript service serves a project's page. */
function serveAt(pathname: string): void {
  const real = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new Proxy(real, {
      get: (target, key) => (key === "protocol" ? "http:" : key === "pathname" ? pathname : Reflect.get(target, key)),
    }),
  });
}

let fetched: string[];

function stubRoutes(): void {
  fetched = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      fetched.push(url);
      // This fixture models the original single-project service, with no catalog API.
      if (url === "api/browser-projects" || url === "api/projects")
        return Promise.resolve({ ok: false, status: 404, json: async () => null });
      const viewId = url.startsWith("api/diagrams/") ? url.slice("api/diagrams/".length) : null;
      const body =
        url === "api/diagrams"
          ? { schemaVersion: 1, views: VIEWS }
          : url === "api/compile"
            ? { schemaVersion: 1, failures: [] }
            : viewId !== null
              ? envelope(viewId)
              : null;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    }),
  );
}

let moveWindow: (next: Viewport) => void;
let root: HTMLElement;

async function mount(
  viewport: Viewport = { width: 1440, coarse: false },
  pathname = "/projects/web-shop/",
): Promise<void> {
  moveWindow = installViewport(viewport);
  serveAt(pathname);
  stubRoutes();
  await act(async () => {
    root = render(<App />).container;
  });
  // Await the complete rendered inventory, then flush the passive shortcut
  // handler effect before a test sends its first window-level keystroke.
  await waitFor(() => {
    const shown = [...document.querySelectorAll("[data-browser-row][data-target]")]
      .map((row) => row.getAttribute("data-target")?.slice("view:".length))
      .sort();
    expect(shown).toEqual(VIEWS.map((entry) => entry.id).sort());
    expect(screen.getByRole("heading", { name: "Projects" })).toBeInTheDocument();
  });
  await act(async () => {});
}

const selectedDocument = (): string | null =>
  document.querySelector(".primary-document-identity h1")?.textContent ?? null;

/** Waits for `viewId`'s envelope to be asked for: the click reached the page. */
async function loaded(viewId: string): Promise<void> {
  await waitFor(() => expect(fetched).toContain(`api/diagrams/${viewId}`));
}

/** Every DOM node within two steps of a hook's state (a value, an object's fields, an array's items). */
function nodesIn(value: unknown, depth = 0, seen = new Set<unknown>()): Node[] {
  if (value === null || typeof value !== "object" || seen.has(value) || depth > 2) return [];
  seen.add(value);
  if (value instanceof Node) return [value];
  const items = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return items.flatMap((item) => nodesIn(item, depth + 1, seen));
}

type Fiber = { child: Fiber | null; sibling: Fiber | null; memoizedState: unknown; tag: number; type: unknown };
type Hook = { memoizedState: unknown; next: Hook | null };

/**
 * Nodes of the page that was left (`left`) held by hooks (state, refs, memos) of any function component under
 * `container`. A component's own never-attached node (a portal host made with createElement) is not the page left.
 */
function leftPageInHooks(container: Element, left: ReadonlySet<Node>): string[] {
  const key = Object.keys(container).find((name) => name.startsWith("__reactContainer$"))!;
  const found: string[] = [];
  const walk = (fiber: Fiber | null): void => {
    for (let at = fiber; at !== null; at = at.sibling) {
      // Function components (0) and forwardRef/memo wrappers (11, 15) keep hooks in memoizedState.
      if (
        (at.tag === 0 || at.tag === 11 || at.tag === 15) &&
        at.memoizedState !== null &&
        typeof at.memoizedState === "object"
      ) {
        let index = 0;
        for (
          let hook = at.memoizedState as Hook | null;
          hook !== null && hook !== undefined && "next" in hook;
          hook = hook.next, index += 1
        ) {
          for (const node of nodesIn(hook.memoizedState)) {
            if (!node.isConnected && left.has(node)) {
              const name = typeof at.type === "function" ? at.type.name : String(at.type);
              found.push(
                `${name} hook ${index}: <${node.nodeName.toLowerCase()} class="${(node as Element).className ?? ""}">`,
              );
            }
          }
        }
      }
      walk(at.child);
    }
  };
  walk((container as unknown as Record<string, Fiber>)[key]!);
  return found;
}

beforeEach(() => {
  MockEventSource.instances.length = 0;
  vi.stubGlobal("EventSource", MockEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(window, "location", REAL_LOCATION);
});

describe("navigation keeps no page it left (G6, PF-3)", () => {
  it("opening a diagram from the project page leaves no detached control in any component's hooks", async () => {
    await mount();
    const files = screen.getByRole("region", { name: "Project documents" });
    const opener = within(files).getByRole("button", { name: "Web shop containers" });
    opener.focus();
    const before = new Set<Node>(document.querySelectorAll("*"));
    await act(async () => {
      fireEvent.click(opener);
    });
    await loaded("shop");
    await waitFor(() => expect(selectedDocument()).toContain("Web shop containers"));
    expect(opener.isConnected).toBe(false);
    expect(leftPageInHooks(root, before)).toEqual([]);
  });
});
