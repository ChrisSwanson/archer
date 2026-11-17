// @vitest-environment jsdom
// Real service menu answers + compiler/layout, through the production expansion controller.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { useState } from "react";
import { App } from "../src/app/App";
import { useExpand, type ExpandInputs } from "../src/expand/use-expand";
import { projectEnvelope, type ProjectedView } from "../src/diagrams/projection";
import { computeLayout, type LayoutResult } from "../src/layout/elk-adapter";
import { parseInventory } from "../src/app/inventory";
import { sourceMetadata } from "../src/expand/source-metadata";
import { pageOnService, viewEntry, type PageOnService } from "./support/page-on-service";
import { startTsProject, type TsProject } from "./support/ts-service";

let service: TsProject;
let page: PageOnService;
let base: ProjectedView;
let layout: LayoutResult;
let metadata: ExpandInputs["metadataOf"];
const openView = vi.fn();
beforeAll(async () => {
  service = await startTsProject({
    files: {
      "archer.toml": `version = 1\n${viewEntry("context", "Context", "c4")}${viewEntry("containers", "Containers", "c4")}`,
      ".archer/context.mmd": 'C4Context\nSystem(shop, "Shop")\n',
      ".archer/containers.mmd": 'C4Container\nSystem_Boundary(shop, "Shop") {\nContainer(api, "API", "Node")\n}\n',
    },
  });
  const projection = projectEnvelope(await (await service.fetch("api/diagrams/context")).json());
  if (!projection.ok || projection.type !== "graph") throw new Error("context did not compile");
  base = projection.view;
  layout = await computeLayout(base);
  const inventory = parseInventory(await (await service.fetch("api/diagrams")).json())!;
  metadata = (source, piece) => sourceMetadata(source, inventory, piece);
});
afterAll(async () => {
  await service?.stop();
});
afterEach(async () => {
  cleanup();
  await page?.close();
  vi.unstubAllGlobals();
  openView.mockClear();
});

function Harness() {
  const [mode, setMode] = useState<ExpandInputs["mode"]>("explore");
  const host = useExpand({
    viewId: "context",
    base,
    baseLayout: layout,
    typeface: "fira",
    mode,
    toExplore: () => setMode("explore"),
    comments: true,
    commentOnBase: () => undefined,
    commentOnSource: () => undefined,
    insideOf: () => ({ count: 1, open: () => undefined }),
    openView,
    titleOf: (id) => id,
    metadataOf: metadata,
    inventoryKey: "initial",
  });
  return (
    <>
      <button
        type="button"
        onClick={(event) =>
          host.open({ canvasId: "shop", kind: "node", label: "Shop", x: 0, y: 0 }, event.currentTarget)
        }
      >
        Shop context
      </button>
      <button type="button" onClick={() => setMode("highlights")}>
        Highlights mode
      </button>
      <button type="button" onClick={() => setMode("edit")}>
        Edit mode
      </button>
      <output data-testid="frames">{host.frames.length}</output>
      <output data-testid="preview">
        {host.layout?.groups.some((group) => group.id === "xf~containers") ? "frame" : "base"}
      </output>
      {host.menu}
      {host.details?.content}
      {host.panel}
    </>
  );
}
async function details() {
  page = await pageOnService(service);
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Shop context" }));
  await screen.findByRole("menuitem", { name: "Containers" });
  fireEvent.click(screen.getByRole("menuitem", { name: "Details and additions…" }));
}
test("real C4 metadata, preview survives focus on Add; Add clears preview and restores context", async () => {
  await details();
  expect(screen.getByText("Containers", { selector: "p" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Preview: Containers" }));
  await waitFor(() => expect(screen.getByTestId("preview")).toHaveTextContent("frame"));
  expect(screen.getByTestId("frames")).toHaveTextContent("0");
  const add = screen.getByRole("button", { name: "Add to view: Containers" });
  act(() => add.focus());
  expect(screen.getByRole("button", { name: "Preview: Containers" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(add);
  await waitFor(() => expect(screen.getByTestId("frames")).toHaveTextContent("1"));
  expect(screen.queryByRole("region", { name: "Details and Additions" })).toBeNull();
  expect(screen.getByRole("button", { name: "Shop context" })).toHaveFocus();
  expect(page.requests.filter((url) => url.includes("api/expand-menu"))).toHaveLength(1);
});
test.each(["Edit", "Highlights"])("entering %s dismisses details and clears its preview", async (mode) => {
  await details();
  fireEvent.click(screen.getByRole("button", { name: "Preview: Containers" }));
  await waitFor(() => expect(screen.getByTestId("preview")).toHaveTextContent("frame"));
  fireEvent.click(screen.getByRole("button", { name: `${mode} mode` }));
  expect(screen.queryByRole("region", { name: "Details and Additions" })).toBeNull();
  expect(screen.getByTestId("preview")).toHaveTextContent("base");
});

test("Project Review and element details give the panel to each other, clearing a displaced preview", async () => {
  await service.present("context");
  page = await pageOnService(service);
  const mounted = render(<App />);
  await waitFor(() => expect(mounted.container.querySelector('.react-flow__node[data-id="shop"]')).not.toBeNull());
  const notifications = screen.getByRole("button", { name: /^Notifications/ });
  fireEvent.click(notifications);
  expect(screen.getByRole("region", { name: "Project Review" })).toBeVisible();
  fireEvent.contextMenu(mounted.container.querySelector('.react-flow__node[data-id="shop"]')!, { button: 2 });
  await screen.findByRole("menuitem", { name: "Containers" });
  fireEvent.click(screen.getByRole("menuitem", { name: "Details and additions…" }));
  expect(screen.queryByRole("region", { name: "Project Review" })).toBeNull();
  expect(screen.getByRole("region", { name: "Details and Additions" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Preview: Containers" }));
  await waitFor(() => expect(mounted.container.querySelector('[data-id="group:xf~containers"]')).not.toBeNull());
  fireEvent.click(notifications);
  expect(screen.getByRole("region", { name: "Project Review" })).toBeVisible();
  expect(screen.queryByRole("region", { name: "Details and Additions" })).toBeNull();
  await waitFor(() => expect(mounted.container.querySelector('[data-id="group:xf~containers"]')).toBeNull());
});

test("browser extremes compile through the service with 12+12 cuts, duplicate titles and visible description metadata", async () => {
  const { extremeMenuProject } = await import("./support/element-menu-fixtures");
  const { readExpandMenu } = await import("../src/expand/pieces");
  const fixture = extremeMenuProject();
  const extreme = await service.attachProject(fixture.files);
  try {
    const response = await extreme.fetch("api/expand-menu?viewId=context&element=shop");
    expect(response.status).toBe(200);
    const menu = readExpandMenu(await response.json())!;
    expect(menu.diagrams.items).toHaveLength(12);
    expect(menu.neighbours.items).toHaveLength(12);
    expect(menu.neighbours.total).toBe(14);
    expect(menu.diagrams.items.some((entry) => entry.source === "neighbours")).toBe(false);
    const inventory = parseInventory(await (await extreme.fetch("api/diagrams")).json())!;
    expect(inventory.find((view) => view.id === "part1")).toMatchObject({
      title: fixture.longTitle,
      description: expect.stringContaining("A detailed description"),
    });
    expect(inventory.filter((view) => view.title === "Shared Title")).toHaveLength(2);
  } finally {
    await extreme.stop();
  }
});
