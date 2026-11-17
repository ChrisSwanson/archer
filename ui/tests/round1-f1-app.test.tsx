// @vitest-environment jsdom
// Round 1 (UI/UX) batch F1, #18: the reading page's Edit sits in the diagram's header row, at its right end,
// never over the drawing or the off-screen cue (Cl-12). The real App over the real service, as contents-page.test.tsx.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

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
import { restoreLocation } from "./app-harness";
import { pageOnService, SERVICE_HOME, viewEntry, type PageOnService } from "./support/page-on-service";
import { startTsProject, type TsProject } from "./support/ts-service";
import { installReducedMotion } from "./match-media";

const FILES = {
  "archer.toml": `version = 1\n\n${viewEntry("pipeline", "Compile pipeline")}`,
  ".archer/pipeline.mmd": "flowchart LR\n lexer[Lexer] e1@--> parser[Parser]\n",
};

let service: TsProject;
let project: TsProject | undefined;
let page: PageOnService | undefined;

beforeAll(async () => {
  service = await startTsProject({ files: SERVICE_HOME });
}, 30_000);
afterAll(async () => {
  await service?.stop();
});

async function mount(present: boolean): Promise<void> {
  project = await service.attachProject(FILES);
  if (present) await project.present("pipeline", "The parser now owns lexing.");
  // The project's own follow page (`/projects/<name>/?follow`), so the page knows its project and offers Edit.
  page = await pageOnService(project);
  installReducedMotion(false);
  render(<App />);
}

afterEach(async () => {
  cleanup();
  await page?.close();
  restoreLocation();
  vi.unstubAllGlobals();
  await project?.stop();
  project = undefined;
  page = undefined;
});

const edit = async (): Promise<HTMLElement> => screen.findByRole("button", { name: "Edit" }, { timeout: 5000 });

it("#18 Edit is in the diagram's header row, at its end, and not on the drawing (agent caption)", async () => {
  await mount(true);

  const button = await edit();
  const header = button.closest(".archer-diagram-header");
  expect(header).not.toBeNull();
  expect(header!.lastElementChild!.contains(button)).toBe(true);
  expect(button.closest(".archer-diagram-content")).toBeNull();
});

it("#18 Edit has its header row even where there is no presence line to show", async () => {
  await mount(false);
  fireEvent.click(await screen.findByRole("button", { name: "Compile pipeline" }));
  await waitFor(() => expect(document.querySelectorAll(".react-flow__node.archer-node").length).toBeGreaterThan(0));
  const button = await edit();
  expect(button.closest(".archer-diagram-header")).not.toBeNull();
  expect(button.closest(".archer-diagram-content")).toBeNull();
});

// The cheat sheet lists only keys that work on the surface: Alt+arrow moves a flowchart shape, not a sequence's.
import { editingSection } from "../src/app/App";
const keysOf = (family: Parameters<typeof editingSection>[0]): string[] =>
  editingSection(family).keys.map(([key, meaning]) => `${key}: ${meaning}`);

it("#1 the Editing section lists shape moving for a flowchart, and only there", () => {
  expect(keysOf("flowchart")).toEqual(
    expect.arrayContaining([
      "Alt ← ↑ → ↓: Move the selected shape 10 px",
      "Shift Alt ← ↑ → ↓: Move the selected shape 50 px",
      "Move selected: Then click where the selected shape should go",
    ]),
  );
  expect(keysOf("flowchart").some((row) => row.includes("participant"))).toBe(false);
  for (const family of ["sequence", "other", null] as const)
    expect(keysOf(family).some((row) => row.includes("selected shape 10 px") || row.startsWith("Move selected"))).toBe(
      false,
    );
  expect(keysOf("sequence")).toEqual(
    expect.arrayContaining(["Alt ← / →: Move the selected participant", "Alt ↑ / ↓: Move the selected message"]),
  );
  expect(keysOf("other").some((row) => row.startsWith("Alt"))).toBe(false);
});
