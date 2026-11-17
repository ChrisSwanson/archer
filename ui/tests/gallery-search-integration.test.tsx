// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class {
    addEventListener() {}
    close = async () => {};
    connect = async () => {};
    updateModelContext = async () => ({});
  },
}));
import { SearchPage } from "../src/app/SearchPage";
import { EMPTY_SEARCH } from "../src/app/file-index";
import { restoreLocation } from "./app-harness";
import { forgetProjectCatalogs } from "../src/app/project-directory";

const view = (title: string) => ({
  id: "checkout",
  title,
  kind: "freeform",
  registration: "durable" as const,
  sourcePath: "checkout.mmd",
});
const json = (value: unknown): Response => ({ ok: true, status: 200, json: async () => value }) as Response;
const catalog = (empty: boolean) => ({
  schemaVersion: 1,
  projects: [
    { slug: "local-a1234567", name: "Local", views: empty ? [] : [view("Local flow")], notes: [] },
    { slug: "remote-b1234567", name: "Remote", views: [view("Remote flow")], notes: [] },
  ],
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  restoreLocation();
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
  vi.unstubAllGlobals();
  forgetProjectCatalogs();
});

it("typing applies a content query and retains the gallery while its service answers", async () => {
  const pending = new Map<string, (response: Response) => void>();
  const fetchImpl = vi.fn((url: string) => {
    if (url === "api/browser-projects") return Promise.resolve(json(catalog(false)));
    if (url.endsWith("api/compile")) return Promise.resolve(json({ schemaVersion: 1, failures: [] }));
    return new Promise<Response>((resolve) => pending.set(url, resolve));
  });
  const props = {
    state: EMPTY_SEARCH,
    onChange: vi.fn(),
    currentSlug: "local-a1234567",
    currentName: "Local",
    views: [view("Local flow")],
    notes: [],
    serverSearch: true,
    baseUrl: "http://localhost/projects/local-a1234567/?follow&overview=1",
    now: Date.now(),
    onOpen: vi.fn(),
    onOpenMatch: vi.fn(),
    fetchImpl,
  };
  function ControlledBrowser() {
    const [state, setState] = useState(EMPTY_SEARCH);
    return (
      <SearchPage
        {...props}
        state={state}
        onChange={(next) => {
          props.onChange(next);
          setState(next);
        }}
      />
    );
  }
  render(<ControlledBrowser />);
  const gallery = screen.getByRole("region", { name: "Project documents" });
  await screen.findByRole("button", { name: "Remote flow" });
  const input = screen.getByRole("searchbox", { name: "Search projects and files" });
  vi.useFakeTimers();
  fireEvent.change(input, { target: { value: "needle" } });
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(props.onChange).toHaveBeenCalledWith({ ...EMPTY_SEARCH, query: "needle" });
  expect([...pending.keys()].filter((url) => url.includes("api/browser-search"))).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "Remote flow" })).toBeNull();
  expect(document.querySelector(".archer-search-summary")).toHaveTextContent("searching diagrams, notes and comments");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(props.onChange).toHaveBeenCalledWith({ ...EMPTY_SEARCH, query: "needle" });
  expect(props.onOpen).not.toHaveBeenCalled();
  expect(screen.getByRole("region", { name: "Project documents" })).toBe(gallery);
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect([...pending.keys()].filter((url) => url.includes("api/browser-search"))).toHaveLength(2);
  expect(screen.getByRole("region", { name: "Project documents" })).toBe(gallery);
  await act(async () => {
    for (const [url, resolve] of pending)
      if (url.includes("api/browser-search"))
        resolve(
          json({
            query: "needle",
            results: [
              {
                target: "view:checkout",
                title: "Flow",
                where: ["diagram"],
                matches: [{ field: "node", text: "needle", elementId: "n" }],
              },
            ],
          }),
        );
  });
  vi.useRealTimers();
  await screen.findByRole("button", { name: "Remote flow" });
  expect(screen.getByRole("region", { name: "Project documents" })).toBe(gallery);
});
