// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SearchPage } from "../src/app/SearchPage";
import { EMPTY_SEARCH } from "../src/app/file-index";
import { forgetProjectCatalogs } from "../src/app/project-directory";

const diagram = {
  id: "system",
  title: "System",
  kind: "freeform",
  registration: "durable" as const,
  sourcePath: "system.mmd",
};
const note = { path: "notes/operations.md", title: "Operations", viewIds: [] };
const active = {
  slug: "active-12345678",
  name: "Active",
  views: [diagram],
  notes: [],
  lifecycle: { state: "active", visibility: "auto" },
};
const inactive = {
  slug: "inactive-12345678",
  name: "Inactive",
  views: [],
  notes: [note],
  lifecycle: { state: "inactive", visibility: "hidden", reason: "manual" },
};
const response = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

afterEach(() => {
  cleanup();
  forgetProjectCatalogs();
  localStorage.clear();
});

function overview(query = "", filters: Partial<typeof EMPTY_SEARCH> = {}) {
  const fetchImpl = vi.fn(async (url: string) =>
    response(
      url.endsWith("api/browser-projects")
        ? { schemaVersion: 1, projects: [active, inactive] }
        : url.endsWith("api/compile")
          ? { schemaVersion: 1, failures: [] }
          : { schemaVersion: 1, targets: {} },
    ),
  );
  render(
    <SearchPage
      state={{ ...EMPTY_SEARCH, ...filters, query }}
      onChange={vi.fn()}
      globalOverview
      currentSlug={null}
      currentName=""
      views={[]}
      notes={[]}
      serverSearch={false}
      baseUrl="https://archer.test/projects/"
      now={Date.parse("2026-10-15T12:00:00Z")}
      onOpen={vi.fn()}
      onOpenMatch={vi.fn()}
      fetchImpl={fetchImpl}
    />,
  );
  return fetchImpl;
}

test("plain global browsing keeps inactive projects in a counted collapsed disclosure", async () => {
  overview();
  await screen.findByRole("button", { name: "System" });
  const group = screen.getByRole("group", { name: "Inactive projects (1)" });
  expect(group).not.toHaveAttribute("open");
  expect(within(group).getByRole("button", { name: "Operations" })).not.toBeVisible();
  fireEvent.click(within(group).getByText("Inactive projects"));
  expect(group).toHaveAttribute("open");
  expect(within(group).getByRole("button", { name: "Operations" })).toBeVisible();
  expect(within(group).getByText(/ask your agent or use the Archer CLI/i)).toBeVisible();
});

test.each([
  ["a matching query", "operations", {}],
  ["a matching project-name query", "inactive", {}],
  ["a matching filter", "", { kinds: ["note" as const] }],
  ["an explicit project filter", "", { projects: [inactive.slug] }],
])("%s expands matching inactive content without changing result counts", async (_label, query, filters) => {
  overview(query, filters);
  const group = await screen.findByRole("group", { name: "Inactive projects (1)" });
  await waitFor(() => expect(group).toHaveAttribute("open"));
  expect(await within(group).findByRole("button", { name: "Operations" })).toBeVisible();
  expect(document.querySelector(".archer-search-summary")).toHaveTextContent("1 file");
  expect(within(group).getByText("1 matching file")).toBeVisible();
});
