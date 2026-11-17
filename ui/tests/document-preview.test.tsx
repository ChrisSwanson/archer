// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentPreview } from "../src/app/DocumentPreview";
import type { FileRow } from "../src/app/file-index";
import { parseInventory } from "../src/app/inventory";
import { forgetThumbnailVersion } from "../src/app/thumbnail-version";

const baseUrl = "http://127.0.0.1:4400/p/alpha-12345678/";
const diagram = (id = "overview", title = "System overview"): FileRow => ({
  key: `alpha-12345678\0view:${id}`,
  slug: "alpha-12345678",
  projectName: "Alpha",
  current: true,
  kind: "diagram",
  target: `view:${id}`,
  id,
  title,
  type: "flowchart",
  path: `${id}.mmd`,
  folder: "",
  failing: false,
  openThreads: 0,
  presented: false,
});

const artifact = (revisionDigit: string) => ({
  encoding: "base64",
  mimeType: "image/svg+xml",
  width: 120,
  height: 80,
  revision: `sha256:${revisionDigit.repeat(64)}`,
  lastGood: false,
  data: btoa('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><path d="M0 0h120"/></svg>'),
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DocumentPreview", () => {
  it("loads when IntersectionObserver is unavailable and renders the export as an image", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(artifact("2")), { status: 200 }));

    render(<DocumentPreview row={diagram()} baseUrl={baseUrl} theme="dark" fetchImpl={fetchImpl} />);

    const image = await screen.findByRole("img", { name: "Diagram thumbnail: System overview" });
    expect(image.getAttribute("src")).toBe(`data:image/svg+xml;base64,${artifact("2").data}`);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("shows an indexed note description without fetching the note body", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const note: FileRow = {
      ...diagram("notes/design.md", "Design note"),
      key: "alpha-12345678\0note:notes/design.md",
      kind: "note",
      target: "note:notes/design.md",
      id: "notes/design.md",
      type: null,
      path: "notes/design.md",
      description: "A concise description already in the project catalog.",
      descriptionFrom: "frontmatter",
    };
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));

    render(<DocumentPreview row={note} baseUrl={baseUrl} theme="light" fetchImpl={fetchImpl} />);

    expect(screen.getByText("A concise description already in the project catalog.")).toBeInTheDocument();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("renders fetched Markdown as React text, never as note-supplied HTML", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const note: FileRow = {
      ...diagram("notes/safety.md", "Safety note"),
      key: "alpha-12345678\0note:notes/safety.md",
      kind: "note",
      target: "note:notes/safety.md",
      id: "notes/safety.md",
      type: null,
      path: "notes/safety.md",
      failing: false,
    };
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            path: note.id,
            markdown: "# **Plain words**\n\n<script>window.compromised = true</script>",
            revision: `sha256:${"a".repeat(64)}`,
          }),
          { status: 200 },
        ),
    );
    const { container } = render(<DocumentPreview row={note} baseUrl={baseUrl} theme="light" fetchImpl={fetchImpl} />);

    expect(await screen.findByText(/Plain words/)).toBeInTheDocument();
    expect(container.querySelector("script, img")).toBeNull();
    expect(container.textContent).toContain("<script>");
  });

  it("waits until its element nears the viewport when IntersectionObserver is available", async () => {
    let intersect!: IntersectionObserverCallback;
    class ObserverStub {
      constructor(callback: IntersectionObserverCallback) {
        intersect = callback;
      }
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
      readonly root = null;
      readonly rootMargin = "160px";
      readonly thresholds = [0];
    }
    vi.stubGlobal("IntersectionObserver", ObserverStub);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(artifact("7")), { status: 200 }));

    render(<DocumentPreview row={diagram()} baseUrl={baseUrl} theme="dark" fetchImpl={fetchImpl} />);
    expect(screen.getByText("Preview loads when it is near the screen.")).toBeInTheDocument();
    expect(fetchImpl).not.toHaveBeenCalled();

    intersect!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(await screen.findByRole("img", { name: "Diagram thumbnail: System overview" })).toBeInTheDocument();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("keeps delayed responses from a previous row from replacing the latest preview", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const responses: ((response: Response) => void)[] = [];
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => responses.push(resolve)));
    const { rerender } = render(
      <DocumentPreview row={diagram("first", "First diagram")} baseUrl={baseUrl} theme="light" fetchImpl={fetchImpl} />,
    );
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

    rerender(
      <DocumentPreview
        row={diagram("second", "Second diagram")}
        baseUrl={baseUrl}
        theme="light"
        fetchImpl={fetchImpl}
      />,
    );
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    responses[1]!(new Response(JSON.stringify(artifact("4")), { status: 200 }));
    expect(await screen.findByRole("img", { name: "Diagram thumbnail: Second diagram" })).toBeInTheDocument();
    responses[0]!(new Response(JSON.stringify(artifact("3")), { status: 200 }));

    await waitFor(() =>
      expect(screen.getByRole("img", { name: "Diagram thumbnail: Second diagram" }).getAttribute("src")).toBe(
        `data:image/svg+xml;base64,${artifact("4").data}`,
      ),
    );
    expect(screen.queryByRole("img", { name: "Diagram thumbnail: First diagram" })).not.toBeInTheDocument();
  });
});

describe("DocumentPreview with service thumbnails", () => {
  const revision = `sha256:${"e".repeat(64)}`;
  const revisioned = (id = "overview", title = "System overview"): FileRow => ({
    ...diagram(id, title),
    modelRevision: revision,
  });
  const neverNear = (): void => {
    class ObserverStub {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
      readonly root = null;
      readonly rootMargin = "";
      readonly thresholds = [0];
    }
    vi.stubGlobal("IntersectionObserver", ObserverStub);
  };

  it("points a lazy image at the revisioned thumbnail address and paints nothing itself", () => {
    neverNear();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    render(<DocumentPreview row={revisioned()} baseUrl={baseUrl} theme="dark" fetchImpl={fetchImpl} />);
    const image = screen.getByRole("img", { name: "Diagram thumbnail: System overview" });
    expect(image.getAttribute("src")).toBe(
      `http://127.0.0.1:4400/p/alpha-12345678/api/thumbnails/overview?rev=${revision}&theme=dark`,
    );
    expect(image.getAttribute("loading")).toBe("lazy");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("asks for a first-screen card's thumbnail at once and at high priority; the rest wait for the screen", () => {
    neverNear();
    render(
      <>
        <DocumentPreview row={revisioned("a", "First")} baseUrl={baseUrl} theme="dark" firstScreen />
        <DocumentPreview row={revisioned("b", "Later")} baseUrl={baseUrl} theme="dark" />
      </>,
    );
    const first = screen.getByRole("img", { name: "Diagram thumbnail: First" }),
      later = screen.getByRole("img", { name: "Diagram thumbnail: Later" });
    expect([first.getAttribute("loading"), first.getAttribute("fetchpriority")]).toEqual(["eager", "high"]);
    expect([later.getAttribute("loading"), later.getAttribute("fetchpriority")]).toEqual(["lazy", null]);
  });

  it("names the painter's version from the inventory, so an upgrade's previews are fetched afresh", () => {
    neverNear();
    parseInventory({ schemaVersion: 1, views: [], thumbnailVersion: "0123456789ab" });
    try {
      render(<DocumentPreview row={revisioned()} baseUrl={baseUrl} theme="dark" />);
      expect(screen.getByRole("img", { name: "Diagram thumbnail: System overview" }).getAttribute("src")).toBe(
        `http://127.0.0.1:4400/p/alpha-12345678/api/thumbnails/overview?rev=${revision}&theme=dark&v=0123456789ab`,
      );
      // A live inventory update carries no version; the one already read stays.
      parseInventory({ schemaVersion: 1, views: [] });
      cleanup();
      render(<DocumentPreview row={revisioned()} baseUrl={baseUrl} theme="light" />);
      expect(screen.getByRole("img", { name: "Diagram thumbnail: System overview" }).getAttribute("src")).toMatch(
        /&v=0123456789ab$/,
      );
    } finally {
      forgetThumbnailVersion();
    }
  });

  it("encodes an embedded diagram's address as one path segment and follows the theme", () => {
    neverNear();
    render(<DocumentPreview row={revisioned("notes/auth.md#login", "Login")} baseUrl={baseUrl} theme="light" />);
    expect(screen.getByRole("img", { name: "Diagram thumbnail: Login" }).getAttribute("src")).toBe(
      `http://127.0.0.1:4400/p/alpha-12345678/api/thumbnails/notes%2Fauth.md%23login?rev=${revision}&theme=light`,
    );
  });

  it("falls back to painting in the page when the service has no thumbnail for it", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(artifact("5")), { status: 200 }));
    render(
      <DocumentPreview row={revisioned("fallback", "Fallback")} baseUrl={baseUrl} theme="dark" fetchImpl={fetchImpl} />,
    );
    const served = screen.getByRole("img", { name: "Diagram thumbnail: Fallback" });
    expect(served.getAttribute("src")).toContain("api/thumbnails/fallback");
    fireEvent.error(served);
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "Diagram thumbnail: Fallback" }).getAttribute("src")).toBe(
        `data:image/svg+xml;base64,${artifact("5").data}`,
      ),
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("asks for nothing for a diagram that does not compile", () => {
    neverNear();
    render(<DocumentPreview row={{ ...revisioned(), failing: true }} baseUrl={baseUrl} theme="dark" />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("This diagram does not compile; no thumbnail was requested.")).toBeInTheDocument();
  });
});
