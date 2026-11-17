// @vitest-environment jsdom
//
// The front door in the page: the project page as the first screen and the
// search page (projects-and-search.md; phase3-front-door.md before it), their
// keys, the way back, the presence line, and the change pulse with its
// reduced-motion form. The real `App` over the real service
// (`support/page-on-service.ts`), the agent presenting and writing through it.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
import { resetApplicationUpdate } from "../src/app/application-update";
import { MockEventSource, restoreLocation } from "./app-harness";
import { fileButton } from "./support/primary-navigation";
import { ownerComments, pageOnService, SERVICE_HOME, viewEntry, type PageOnService } from "./support/page-on-service";
import { startTsProject, type TsProject } from "./support/ts-service";
import { installReducedMotion } from "./match-media";

let service: TsProject;
let project: TsProject | undefined;
let page: PageOnService | undefined;
/** Every request the page made, as it named it. */
let requested: readonly string[];
/** The project's name, as the service gives it (its folder's). */
let projectName: string;

const PIPELINE = "flowchart LR\n lexer[Lexer] e1@--> parser[Parser]\n parser e2@--> checker[Checker]\n";
/** The agent's rewrite of the pipeline: Lexer merged into Parser, an Emitter added. */
const PIPELINE_AFTER =
  "flowchart LR\n  parser[Parser and lexer] e2@--> checker[Checker]\n  checker e3@--> emitter[Emitter]\n";

/** The pipeline, a diagram of each other family, a note on the pipeline and one on nothing. */
const FILES: Record<string, string> = {
  "archer.toml":
    "version = 1\n\n" +
    viewEntry("pipeline", "Compile pipeline") +
    viewEntry("login", "Sign in", "sequence") +
    viewEntry("model", "Data model", "entity-relationship") +
    viewEntry("checkout", "Checkout journey", "journey"),
  ".archer/pipeline.mmd": PIPELINE,
  ".archer/login.mmd":
    "sequenceDiagram\n participant browser as Browser\n participant server as Server\n browser->>server: Sign in\n",
  ".archer/model.mmd":
    'erDiagram\n user["User"] {\n string id PK\n }\n order["Order"] {\n string id PK\n }\n user ||--o{ order : places\n',
  ".archer/checkout.mmd": "journey\n title Checkout\n section Shopping\n Cart: 3: Reader\n Pay: 5: Reader\n",
  ".archer/notes/parsing.md": "---\ndiagrams: [../pipeline.mmd]\n---\n# Parsing\n\nThe tokenizer feeds the parser.\n",
  ".archer/notes/ideas.md": "# Ideas\n\nSomeday, incremental builds.\n",
};

beforeAll(async () => {
  service = await startTsProject({ files: SERVICE_HOME });
}, 30_000);
afterAll(async () => {
  await service?.stop();
});

async function mount(
  options: {
    files?: Record<string, string>;
    present?: string;
    reducedMotion?: boolean;
    /** What the project went through before the page opened. */
    before?: (project: TsProject) => Promise<void>;
    fault?: (path: string) => Response | undefined;
  } = {},
): Promise<void> {
  project = await service.attachProject(options.files ?? FILES);
  projectName = ((await (await project.fetch("api/bootstrap")).json()) as { project: { name: string } }).project.name;
  await options.before?.(project);
  if (options.present !== undefined) await project.present(options.present, "The parser now owns lexing.");
  page = await pageOnService(project, { path: "/", ...(options.fault === undefined ? {} : { fault: options.fault }) });
  installReducedMotion(options.reducedMotion ?? false);
  requested = page.requests;
  render(<App />);
}

beforeEach(() => {
  MockEventSource.instances = [];
});

afterEach(async () => {
  cleanup();
  await page?.close();
  page = undefined;
  restoreLocation();
  resetApplicationUpdate();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await project?.stop();
  project = undefined;
});

const table = (): HTMLElement => screen.getByRole("region", { name: "Project documents" });
const row = (title: string): HTMLElement =>
  within(table()).getByRole("button", { name: title }).closest<HTMLElement>("[data-browser-row]")!;
const rowTitles = (): string[] =>
  [...document.querySelectorAll(".archer-folder-tree-open")].map((b) => b.textContent ?? "");
const searchBox = (): HTMLInputElement => screen.getByRole("searchbox", { name: "Search projects and files" });
const searchRowTitles = (): string[] =>
  [...screen.getByRole("region", { name: "Project documents" }).querySelectorAll(".archer-folder-tree-open")].map(
    (b) => b.textContent ?? "",
  );

/** Every folder of the tree starts open: the files are all in sight. */
async function expandAllFiles(): Promise<void> {
  await screen.findByRole("treegrid", { name: "Project files" });
}

describe("the project page", () => {
  it("is the first screen when nothing is presented: every file with its full path, and search and filters ready", async () => {
    await mount();
    await screen.findByRole("region", { name: "Project documents" });
    await expandAllFiles();
    // The notes arrive from api/notes/all a moment after the inventory.
    await waitFor(() =>
      expect(rowTitles().sort()).toEqual([
        "Checkout journey",
        "Compile pipeline",
        "Data model",
        "Ideas",
        "Parsing",
        "Sign in",
      ]),
    );
    expect(searchBox()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();
    expect(row("Sign in")).toHaveTextContent("Sequence");
    expect(within(row("Ideas")).getByText("ideas.md").closest("[title]")).toHaveAttribute("title", "notes/ideas.md");
    // Nothing was opened on the reader's behalf.
    expect(requested.some((url) => url.startsWith("api/diagrams/"))).toBe(false);
  }, 60_000); // The cold initial fixture/test measured 47.1 s under the aggregate gate's recorded I/O pressure.

  it("names the project in the breadcrumb as a name, since the service gave one", async () => {
    await mount();
    await screen.findByRole("region", { name: "Project documents" });
    const name = within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("button", {
      name: projectName,
    });
    expect(name).toHaveTextContent(projectName);
  });

  it("says on each row what is being discussed and what the agent presented", async () => {
    await mount({ present: "pipeline" });
    await waitFor(() => expect(document.querySelectorAll(".react-flow__node.archer-node")).toHaveLength(3));
    await act(async () => {
      await ownerComments(project!).draft("view:pipeline", "Why two passes?");
    });
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("button", { name: projectName }),
    );
    await waitFor(() => expect(within(row("Compile pipeline")).getByText(/1 open$/)).toBeInTheDocument());
    // The comment publishes a replacement inventory. Let that refresh settle,
    // then make expansion the final state transition before checking all rows.
    await expandAllFiles();
    expect(within(row("Compile pipeline")).getByText("Presented by the agent")).toHaveAttribute("data-voice", "agent");
    expect(within(row("Sign in")).queryByRole("list", { name: "Status" })).toBeNull();
  });

  it("shows a designed empty state, with what to ask for, when there are no diagrams", async () => {
    await mount({ files: { "archer.toml": "version = 1\n" } });
    expect(await screen.findByRole("heading", { name: "No diagrams or notes yet." })).toBeInTheDocument();
    expect(screen.getByText(/Ask your agent to draw a diagram or write a note/)).toBeInTheDocument();
    expect(screen.getByText(/sequence diagram/)).toBeInTheDocument();
  });

  it("opens a note in the reader, a diagram on the canvas, and a folder in the shared browser", async () => {
    await mount();
    await screen.findByRole("region", { name: "Project documents" });
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.change(await screen.findByRole("combobox", { name: "Folder" }), { target: { value: "notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Close filters" }));
    expect(rowTitles()).toEqual(["Ideas", "Parsing"]);
    fireEvent.click(screen.getByRole("button", { name: "Parsing" }));
    const reader = await screen.findByRole("article", { name: "Reading Parsing" });
    expect(await within(reader).findByText("The tokenizer feeds the parser.")).toBeInTheDocument();
    // One h1, the note's own title (G6): the shell shows only the trail.
    expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual(["Parsing"]);
    expect(document.querySelector(".archer-stage")).toBeNull();
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("button", { name: "notes" }),
    );
    const folder = await screen.findByRole("region", { name: "notes" });
    expect(await within(folder).findByRole("searchbox", { name: "Search projects and files" })).toHaveValue("");
    expect(await within(folder).findByRole("button", { name: "Clear folder filter" })).toHaveTextContent("notes");
    expect(within(folder).getByRole("button", { name: "Ideas" })).toBeInTheDocument();
    expect(within(folder).getByRole("button", { name: "Parsing" })).toBeInTheDocument();
    expect(within(folder).queryByRole("button", { name: "Data model" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Archer contents" }));
    await expandAllFiles();
    // Anywhere on the row, not only its title.
    fireEvent.click(row("Data model").querySelector(".archer-folder-tree-kind")!);
    await waitFor(() => expect(document.querySelectorAll(".react-flow__node.archer-figure-entity")).toHaveLength(2));
  });
});

describe("the search page", () => {
  it("is opened by / from anywhere, focused, and filters names and kinds while typing", async () => {
    await mount({ present: "pipeline" });
    await waitFor(() => expect(document.querySelectorAll(".react-flow__node.archer-node")).toHaveLength(3));
    fireEvent.keyDown(document.body, { key: "/" });
    expect(searchBox()).toHaveFocus();
    expect(new URLSearchParams(window.location.search).get("q")).toBe("");
    fireEvent.change(searchBox(), { target: { value: "seq" } });
    expect(new URLSearchParams(window.location.search).get("q")).toBe("seq");
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    expect(searchRowTitles()).toEqual(["Sign in"]);
    expect(new URLSearchParams(window.location.search).get("q")).toBe("seq");
  });

  it("is already on the project page, with no duplicate sidebar Search entry", async () => {
    await mount();
    await screen.findByRole("region", { name: "Project documents" });
    const input = searchBox();
    expect(
      within(screen.getByRole("navigation", { name: "Workspace" })).queryByRole("button", { name: "Search" }),
    ).toBeNull();
    fireEvent.keyDown(document.body, { key: "/" });
    expect(searchBox()).toBe(input);
    expect(searchBox()).toHaveFocus();
  });

  it("finds a note by a word in its text, not every diagram the note is about, and opens it", async () => {
    await mount();
    await screen.findByRole("region", { name: "Project documents" });
    fireEvent.keyDown(document.body, { key: "/" });
    fireEvent.change(searchBox(), { target: { value: "tokenizer" } });
    expect(requested).not.toContain("api/browser-search?q=tokenizer");
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    await waitFor(() => expect(requested).toContain("api/browser-search?q=tokenizer"));
    // The service also names the pipeline, because the note is about it; that hit is the note's.
    await waitFor(() => expect(searchRowTitles()).toEqual(["Parsing"]));
    fireEvent.click(screen.getByRole("button", { name: "Parsing" }));
    expect(await screen.findByRole("article", { name: "Reading Parsing" })).toBeInTheDocument();
  });

  it("names the element a word matched in, and opening it selects that element", async () => {
    await mount();
    await screen.findByRole("region", { name: "Project documents" });
    fireEvent.change(searchBox(), { target: { value: "parser" } });
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    const pipeline = await waitFor(() => row("Compile pipeline"));
    fireEvent.click(await within(pipeline).findByRole("button", { name: "Node · Parser" }));
    await waitFor(() => expect(document.querySelector('.react-flow__node[data-id="parser"]')).toHaveClass("selected"));
    expect(document.querySelector('.react-flow__node[data-id="checker"]')).not.toHaveClass("selected");
  });

  it("opens the comment thread a word matched in, focused", async () => {
    await mount();
    await screen.findByRole("region", { name: "Project documents" });
    const thread = await ownerComments(project!).draft("view:pipeline", "Should this be idempotent?", {
      kind: "node",
      id: "parser",
      label: "Parser",
    });
    fireEvent.change(searchBox(), { target: { value: "idempotent" } });
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    await waitFor(() => expect(searchRowTitles()).toEqual(["Compile pipeline"]));
    fireEvent.click(await screen.findByRole("button", { name: "Comment · Should this be idempotent?" }));
    await waitFor(() => expect(document.getElementById(`archer-thread-${thread.id}`)).toHaveFocus());
  });

  it("Enter submits without opening a result, says when nothing matches, and a file title opens the result", async () => {
    await mount();
    await screen.findByRole("region", { name: "Project documents" });
    fireEvent.keyDown(document.body, { key: "/" });
    fireEvent.change(searchBox(), { target: { value: "zebra" } });
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    expect(await screen.findByText("Nothing matches “zebra”.")).toBeInTheDocument();
    const input = searchBox();
    fireEvent.change(searchBox(), { target: { value: "data" } });
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    const title = await screen.findByRole("button", { name: "Data model" });
    expect(searchBox()).toBe(input);
    expect(new URLSearchParams(window.location.search).get("q")).toBe("data");
    expect(document.querySelectorAll(".archer-stage .react-flow__node.archer-figure-entity")).toHaveLength(0);
    fireEvent.click(title);
    await waitFor(() => expect(document.querySelectorAll(".react-flow__node.archer-figure-entity")).toHaveLength(2));
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("falls back to metadata when body search is unavailable", async () => {
    // The service answers 500 when it cannot complete a content search; nothing in a project makes it fail on cue.
    await mount({
      fault: (path) =>
        path.includes("/api/browser-search")
          ? Response.json(
              { schemaVersion: 1, error: { code: "internal", message: "document search could not be completed" } },
              { status: 500 },
            )
          : undefined,
    });
    await screen.findByRole("region", { name: "Project documents" });
    fireEvent.keyDown(document.body, { key: "/" });
    expect(searchBox()).toHaveAttribute("placeholder", "Names, descriptions, diagrams, notes and comments");
    // A word in no name, description, title or comment: only the failed body search could have found it.
    fireEvent.change(searchBox(), { target: { value: "zyzzyva" } });
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    expect(await screen.findByText("Nothing matches “zyzzyva”.")).toBeInTheDocument();
    expect(requested.some((url) => url.startsWith("api/browser-search"))).toBe(true);
    expect(document.querySelector(".archer-search-summary")).toHaveTextContent("content search unavailable");
  });
});

describe("the way back", () => {
  it("is the project's name and the sidebar's Archer, and the agent presenting leaves it", async () => {
    await mount({ present: "pipeline" });
    await waitFor(() => expect(document.querySelectorAll(".react-flow__node.archer-node")).toHaveLength(3));
    fireEvent.click(screen.getByRole("button", { name: "Archer contents" }));
    expect(table()).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).not.toHaveTextContent("Overview");
    // The agent presenting takes the page.
    await act(() => project!.present("login"));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Project documents" })).toBeNull());
  });
});

describe("presence", () => {
  it("says the agent presented the diagram on screen, how long ago, with its caption", async () => {
    await mount({ present: "pipeline" });
    await waitFor(() => expect(document.querySelector(".archer-presence")).not.toBeNull());
    expect(document.querySelector(".archer-presence")!.textContent).toBe(
      "Presented by the agent · just now — The parser now owns lexing.",
    );
  });

  it("shows a short caption once, in the presence line, and keeps it for a screen reader", async () => {
    await mount({ present: "pipeline" });
    await waitFor(() => expect(document.querySelector(".archer-presence")).not.toBeNull());
    const line = document.querySelector<HTMLElement>(".archer-presence")!;
    expect(line).toHaveAttribute("data-caption", "true");
    // The bar under the drawing is not drawn a second time...
    const box = document.querySelector(".archer-caption-box")!;
    expect(box).toHaveClass("archer-visually-hidden");
    // ...but it is still what the stage is described by and what is announced,
    // so the line's copy is not read twice.
    expect(document.querySelector(".archer-stage, .archer-mcp-stage")).toHaveAccessibleDescription(
      "The parser now owns lexing.",
    );
    expect(line.querySelector(".archer-presence-detail")).toHaveAttribute("aria-hidden", "true");
  });

  it("leaves a long caption to the bar under the drawing, and the presence line says only who and when", async () => {
    await mount({ present: "pipeline" });
    const long =
      `The parser now owns lexing. ${"It reads tokens as it goes, so the lexer stage is gone. ".repeat(3)}`.trim();
    await act(() => project!.present("pipeline", long));
    await waitFor(() => expect(document.querySelector(".archer-caption")?.textContent).toBe(long));
    expect(document.querySelector(".archer-caption-box")).not.toHaveClass("archer-visually-hidden");
    await waitFor(() =>
      expect(document.querySelector(".archer-presence")?.textContent).toBe("Presented by the agent · just now"),
    );
  });

  it("says who last changed a diagram the reader opened", async () => {
    await mount({
      files: {
        "archer.toml": `version = 1\n\n${viewEntry("pipeline", "Compile pipeline")}`,
        ".archer/pipeline.mmd": PIPELINE,
      },
      before: async (project) => {
        await project.agentWrite(
          "pipeline",
          ".archer/pipeline.mmd",
          `${PIPELINE} checker e3@--> types[Type checker]\n`,
          "split the checker",
        );
        // The service has taken the write as the agent's before the page opens.
        await vi.waitFor(
          async () => {
            const { views } = (await (await project.fetch("api/diagrams")).json()) as {
              views: { lastChange?: { by: string; summary?: string } }[];
            };
            expect(views[0]?.lastChange).toMatchObject({ by: "agent", summary: "split the checker" });
          },
          { timeout: 10_000 },
        );
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Compile pipeline" }));
    await waitFor(() => expect(document.querySelector(".archer-presence")).not.toBeNull());
    expect(document.querySelector(".archer-presence")!.textContent).toMatch(
      /^Changed by the agent · \d\d:\d\d — split the checker$/,
    );
  });
});

describe("the change pulse", () => {
  /** The agent writing the pipeline, and its `change` reaching the page, as the service publishes it. */
  const agentWrites = async (text: string, summary?: string): Promise<void> => {
    const heard = (): number =>
      page!.streams[0]!.received.filter(
        (event) => event.type === "change" && (event.data as { viewId?: string }).viewId === "pipeline",
      ).length;
    const before = heard();
    await project!.agentWrite("pipeline", ".archer/pipeline.mmd", text, summary);
    await waitFor(() => expect(heard()).toBe(before + 1));
  };
  const rewrite = () => agentWrites(PIPELINE_AFTER, "merged Lexer into Parser");

  it("marks what the agent added and changed, once, names what it removed, and shows it again", async () => {
    await mount({ present: "pipeline" });
    await waitFor(() => expect(document.querySelectorAll(".react-flow__node.archer-node")).toHaveLength(3));
    await rewrite();
    await waitFor(() =>
      expect(document.querySelector(".archer-change-headline")?.textContent).toBe("The agent changed 3 elements"),
    );
    expect(document.querySelector(".archer-change")!.textContent).toContain("merged Lexer into Parser");
    // The removed edge is named too: the service's change lists every element that went.
    expect(document.querySelector(".archer-change")!.textContent).toContain("Removed: Lexer, lexer → parser.");

    await waitFor(() => expect(document.querySelector("style[data-archer-change-pulse]")).not.toBeNull());
    const style = (): string => document.querySelector("style[data-archer-change-pulse]")!.textContent ?? "";
    expect(document.querySelector("style[data-archer-change-pulse]")).toHaveAttribute(
      "data-archer-change-pulse",
      "once",
    );
    // What the rewrite added (the Emitter and the edge to it, e3) and changed (the Parser, relabelled).
    for (const id of ["emitter", "e3", "parser"]) expect(style()).toContain(`[data-id="${id}"]`);
    expect(style()).not.toContain('"lexer"');
    const first = /archer-change-pulse-(\d)/.exec(style())![1];
    // Every drawn element the rule names is on the canvas.
    await waitFor(() =>
      expect(document.querySelector('.archer-stage .react-flow__node[data-id="emitter"]')).not.toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Show changes" }));
    expect(/archer-change-pulse-(\d)/.exec(style())![1]).not.toBe(first);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss the change notice" }));
    expect(document.querySelector(".archer-change")).toBeNull();
    expect(document.querySelector("style[data-archer-change-pulse]")).toBeNull();
  });

  it("holds a still outline instead, for a reader who asked for less motion", async () => {
    await mount({ present: "pipeline", reducedMotion: true });
    await waitFor(() => expect(document.querySelectorAll(".react-flow__node.archer-node")).toHaveLength(3));
    await rewrite();
    await waitFor(() => expect(document.querySelector("style[data-archer-change-pulse]")).not.toBeNull());
    const style = document.querySelector("style[data-archer-change-pulse]")!;
    expect(style).toHaveAttribute("data-archer-change-pulse", "static");
    expect(style.textContent).not.toContain("animation");
    expect(style.textContent).toContain("drop-shadow");
  });

  it("says the agent changed the diagram when nothing it can name moved", async () => {
    await mount({ present: "pipeline" });
    await waitFor(() => expect(document.querySelectorAll(".react-flow__node.archer-node")).toHaveLength(3));
    // The same drawing in other words: the agent wrote it, and nothing it can name moved.
    await agentWrites(`${PIPELINE}%% tidied\n`);
    await waitFor(() =>
      expect(document.querySelector(".archer-change-headline")?.textContent).toBe("The agent changed this diagram"),
    );
    expect(screen.queryByRole("button", { name: "Show changes" })).toBeNull();
  });

  it("waits for a diagram with comments the reader is not looking at, and pulses when they open it", async () => {
    await mount({ present: "login" });
    await waitFor(() => expect(document.querySelectorAll(".archer-seq-participant")).toHaveLength(2));
    await act(async () => {
      await ownerComments(project!).draft("view:pipeline", "Keep the lexer?");
    });
    await rewrite();
    expect(document.querySelector(".archer-change")).toBeNull();
    fireEvent.click(fileButton(/Compile pipeline/));
    await waitFor(() =>
      expect(document.querySelector(".archer-change-headline")?.textContent).toBe("The agent changed 3 elements"),
    );
    await waitFor(() => expect(document.querySelector("style[data-archer-change-pulse]")).not.toBeNull());
  });

  it("ignores a change to a diagram the reader is neither looking at nor discussing", async () => {
    await mount({ present: "login" });
    await waitFor(() => expect(document.querySelectorAll(".archer-seq-participant")).toHaveLength(2));
    await rewrite();
    fireEvent.click(fileButton(/Compile pipeline/));
    await waitFor(() => expect(document.querySelectorAll(".react-flow__node.archer-node")).toHaveLength(3));
    expect(document.querySelector(".archer-change")).toBeNull();
  });
});
