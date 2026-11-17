// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SourceDocumentPage } from "../src/app/SourceDocumentPage";
import { forgetProjectCatalogs } from "../src/app/project-directory";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  forgetProjectCatalogs();
});
test("source pages use the shared keyboard Help toggle without changing document permissions", async () => {
  window.history.replaceState(null, "", "/projects/example-12345678/-/repo/docs/guide.md");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        source: { path: "docs/guide.md" },
        kind: "markdown",
        revision: "sha256:" + "a".repeat(64),
        text: "# Guide",
        markdown: "# Guide",
        embedded: [],
      }),
    })),
  );
  render(<SourceDocumentPage projectSlug="example-12345678" path="docs/guide.md" />);
  await screen.findByRole("heading", { name: "Guide" });
  fireEvent.keyDown(window, { key: "?" });
  expect(screen.getByRole("dialog", { name: "Keyboard & Pointer" })).toBeVisible();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Keyboard & Pointer" })).toBeNull();
  expect(screen.getByText("Read-only")).toBeVisible();
});
test("external Markdown is readable and explicitly read-only", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        source: { path: "docs/guide.md" },
        kind: "markdown",
        revision: "sha256:" + "a".repeat(64),
        text: "# External guide",
        markdown: "# External guide",
        embedded: [],
      }),
    })),
  );
  window.history.replaceState(null, "", "/projects/example-12345678/-/repo/docs/guide.md");
  render(<SourceDocumentPage projectSlug="example-12345678" path="docs/guide.md" />);
  expect(await screen.findByRole("heading", { name: "External guide" })).toBeInTheDocument();
  expect(screen.getByText("Read-only")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /comment|highlight/i })).toBeNull();
});

test("unavailable documents offer a retry without exposing write actions", async () => {
  window.history.replaceState(null, "", "/projects/example-12345678/-/repo/docs/guide.md");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
  );
  render(<SourceDocumentPage projectSlug="example-12345678" path="docs/guide.md" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("outside the configured scope");
  expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
});

test("Markdown remains sanitized and headings provide an outline", async () => {
  window.history.replaceState(null, "", "/projects/example-12345678/-/repo/docs/guide.md");
  const markdown = '# External guide\n\n<script>alert("no")</script>\n\n## Details\n\n[unsafe](javascript:alert(1))';
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        source: { path: "docs/guide.md" },
        kind: "markdown",
        revision: "sha256:" + "a".repeat(64),
        text: markdown,
        markdown,
        embedded: [],
      }),
    })),
  );
  const { container } = render(<SourceDocumentPage projectSlug="example-12345678" path="docs/guide.md" />);
  expect(await screen.findByRole("heading", { name: "Details" })).toBeInTheDocument();
  expect(await screen.findByRole("navigation", { name: "Table of contents" })).toBeInTheDocument();
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
});

class Source {
  static instances: Source[] = [];
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  listeners = new Map<string, ((event: Event) => void)[]>();
  close = vi.fn();
  constructor(readonly url: string) {
    Source.instances.push(this);
  }
  addEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener(new MessageEvent(type, { data: "{}" }));
  }
}
const info = {
  browserProtocolMajor: 1,
  supportedBrowserProtocolMajors: [1],
  serverEpoch: "12345678-1234-1234-1234-123456789abc",
  capabilities: ["heartbeat"],
  applicationVersion: "0.2.0",
  semanticSchemaVersion: 2,
  heartbeatIntervalMs: 15000,
};
test("managed document events and reconnection refresh the reader and clean up the stream", async () => {
  window.history.replaceState(null, "", "/projects/example-12345678/-/repo/docs/guide.md");
  Source.instances = [];
  vi.stubGlobal("EventSource", Source);
  let markdown = "# First version";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.includes("api/connection")
          ? info
          : {
              source: { path: "docs/guide.md" },
              kind: "markdown",
              revision: "sha256:" + "a".repeat(64),
              text: markdown,
              markdown,
              embedded: [],
            },
    })),
  );
  const mounted = render(<SourceDocumentPage projectSlug="example-12345678" path="docs/guide.md" />);
  expect(await screen.findByRole("heading", { name: "First version" })).toBeInTheDocument();
  expect(Source.instances).toHaveLength(1);
  Source.instances[0]!.onopen?.(new Event("open"));
  await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
  markdown = "# Second version";
  Source.instances[0]!.emit("documents");
  expect(await screen.findByRole("heading", { name: "Second version" })).toBeInTheDocument();
  markdown = "# After reconnect";
  Source.instances[0]!.onopen?.(new Event("open"));
  expect(await screen.findByRole("heading", { name: "After reconnect" })).toBeInTheDocument();
  mounted.unmount();
  expect(Source.instances[0]!.close).toHaveBeenCalled();
});
test("the stream's first open does not read the document a second time (perf #10)", async () => {
  window.history.replaceState(null, "", "/projects/example-12345678/-/repo/docs/guide.md");
  Source.instances = [];
  vi.stubGlobal("EventSource", Source);
  const seen: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      seen.push(url);
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () =>
          url.includes("api/connection")
            ? info
            : {
                source: { path: "docs/guide.md" },
                kind: "markdown",
                revision: "sha256:" + "a".repeat(64),
                text: "# One",
                markdown: "# One",
                embedded: [],
              },
      };
    }),
  );
  const mounted = render(<SourceDocumentPage projectSlug="example-12345678" path="docs/guide.md" />);
  expect(await screen.findByRole("heading", { name: "One" })).toBeInTheDocument();
  Source.instances[0]!.onopen?.(new Event("open"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(seen.filter((url) => url.includes("api/documents/content"))).toHaveLength(1);
  mounted.unmount();
});

test("the source page's location is the shell's shared breadcrumb, not one of its own (G16)", async () => {
  window.history.replaceState(null, "", "/projects/example-12345678/docs/guide.md");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        source: { path: "docs/guide.md" },
        kind: "markdown",
        revision: "sha256:" + "a".repeat(64),
        text: "# Guide",
        markdown: "# Guide",
        embedded: [],
      }),
    })),
  );
  const { container } = render(<SourceDocumentPage projectSlug="example-12345678" path="docs/guide.md" />);
  await screen.findByRole("heading", { name: "Guide" });
  const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
  expect(container.querySelector(".primary-document-trail")?.contains(trail)).toBe(true);
  expect(trail.textContent).toContain("example-12345678");
  expect(trail.textContent).toContain("docs/guide.md");
  expect(screen.queryByRole("navigation", { name: "Document location" })).toBeNull();
});
