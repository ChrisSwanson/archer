// @vitest-environment jsdom
// The project page's title section: name, description, a facts line whose
// parts appear only when known, and the Project settings gear; and the README
// card, only when the project has a root README the service can read.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectReadme, ProjectTitle } from "../src/app/ProjectTitle";
import { fileRows } from "../src/app/file-index";
import { parseProjectCatalog, parseProjectFacts } from "../src/app/project-directory";

afterEach(cleanup);

const NOW = Date.parse("2026-10-11T12:00:00Z");
const rows = fileRows({
  slug: "demo",
  name: "Demo",
  current: true,
  views: [
    {
      id: "a",
      title: "A",
      kind: "flowchart",
      registration: "durable",
      sourcePath: "a.mmd",
      modifiedAt: "2026-10-10T10:00:00Z",
      threads: { draft: 0, sent: 1, read: 0, answered: 1, resolved: 0 },
    } as never,
  ],
  notes: [{ path: "n.md", title: "N", viewIds: [], modifiedAt: "2026-10-01T10:00:00Z" }],
});
const facts = (): HTMLElement => screen.getByLabelText("Project facts");
const fact = (name: string): Element | null => facts().querySelector(`[data-fact="${name}"]`);

describe("the title section", () => {
  it("shows every fact the catalog gives, with the gear and no Archive button", () => {
    const onOpenSettings = vi.fn();
    render(
      <ProjectTitle
        name="Archer"
        description="Diagrams for agents."
        now={NOW}
        rows={rows}
        onOpenSettings={onOpenSettings}
        facts={{
          diagrams: 15,
          notes: 11,
          openThreads: 1,
          projectFolder: "~/code/archer",
          git: { branch: "main", commit: "a35b01bcafe" },
          lastEditedAt: "2026-10-11T09:00:00Z",
        }}
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Archer" })).toBeInTheDocument();
    expect(screen.getByText("Diagrams for agents.")).toBeInTheDocument();
    expect(fact("diagrams")).toHaveTextContent("15 diagrams");
    expect(fact("notes")).toHaveTextContent("11 notes");
    expect(fact("threads")).toHaveTextContent("1 open thread");
    expect(fact("folder")).toHaveTextContent("~/code/archer");
    expect(fact("git")).toHaveTextContent("maina35b01b");
    expect(fact("edited")).toHaveTextContent(/^edited /);
    fireEvent.click(screen.getByRole("button", { name: "Project settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: /Archive project/ })).toBeNull();
  });

  it("without catalog facts counts the page's own files and leaves out what it cannot know", () => {
    render(<ProjectTitle name="Demo" now={NOW} rows={rows} />);
    expect(screen.queryByText("Diagrams for agents.")).toBeNull();
    expect(fact("diagrams")).toHaveTextContent("1 diagram");
    expect(fact("notes")).toHaveTextContent("1 note");
    expect(fact("threads")).toHaveTextContent("2 open threads");
    expect(fact("folder")).toBeNull();
    expect(fact("git")).toBeNull();
    expect(fact("edited")?.querySelector("time")).toHaveAttribute("datetime", "2026-10-10T10:00:00Z");
    // Where settings cannot open (an embedded page), there is no gear that does nothing.
    expect(screen.queryByRole("button", { name: "Project settings" })).toBeNull();
  });

  it("shows a commit without a branch, and no thread count for a project with no files", () => {
    render(<ProjectTitle name="Empty" now={NOW} rows={[]} facts={{ git: { commit: "0123456789" } }} />);
    expect(fact("git")).toHaveTextContent("0123456");
    expect(fact("threads")).toBeNull();
    expect(fact("edited")).toBeNull();
  });
});

describe("the catalog's optional page facts", () => {
  const entry = (extra: Record<string, unknown>) => ({
    schemaVersion: 1,
    projects: [{ slug: "demo", name: "Demo", views: [], notes: [], ...extra }],
  });
  it("keeps valid facts and the README, drops malformed parts without refusing the catalog", () => {
    const [project] = parseProjectCatalog(
      entry({
        readme: { path: "README.md" },
        facts: {
          diagrams: 2,
          notes: -1,
          openThreads: 0,
          projectFolder: "~/x",
          lastEditedAt: "nope",
          git: { branch: "main", commit: "abc" },
        },
      }),
    )!;
    expect(project!.readme).toEqual({ path: "README.md" });
    expect(project!.facts).toEqual({
      diagrams: 2,
      openThreads: 0,
      projectFolder: "~/x",
      git: { branch: "main", commit: "abc" },
    });
    const [plain] = parseProjectCatalog(entry({ readme: { path: "../etc" }, facts: "x" }))!;
    expect(plain!.readme).toBeUndefined();
    expect(plain!.facts).toBeUndefined();
    expect(parseProjectFacts({ git: { branch: "main" } })).toBeUndefined();
  });
});

describe("the README card", () => {
  const json = (value: unknown, status = 200): Response =>
    ({ ok: status === 200, status, json: async () => value }) as Response;
  it("shows a collapsed preview that opens in full", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ source: { path: "README.md" }, markdown: "# Archer\n\nArcher shows diagrams." }),
    );
    render(<ProjectReadme path="README.md" resourceBase="http://h/p/demo/" fetchImpl={fetchImpl} />);
    const card = await screen.findByRole("region", { name: /README/ });
    expect(fetchImpl).toHaveBeenCalledWith("http://h/p/demo/api/documents/content?path=README.md", expect.anything());
    // The card can appear before its Markdown has rendered; wait for the text itself.
    expect(await within(card).findByText("Archer shows diagrams.")).toBeInTheDocument();
    const toggle = within(card).getByRole("button", { name: "Show full README" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(card.querySelector(".archer-project-readme-body")).toHaveAttribute("data-collapsed", "true");
    fireEvent.click(toggle);
    expect(within(card).getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
    expect(within(card).queryByRole("link", { name: "Open note" })).toBeNull();
  });

  it("is left out when the README cannot be read", async () => {
    const fetchImpl = vi.fn(async () => json({}, 404));
    render(<ProjectReadme path="README.md" resourceBase="http://h/p/demo/" fetchImpl={fetchImpl} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: /README/ })).toBeNull();
  });
});
