// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { WorkspaceNavigation } from "../src/app/WorkspaceNavigation";
import { forgetProjectCatalogs } from "../src/app/project-directory";

const active = {
  slug: "active-12345678",
  name: "Active",
  views: [],
  notes: [],
  lifecycle: { state: "active", visibility: "auto" },
};
const inactive = {
  slug: "inactive-12345678",
  name: "Inactive",
  views: [],
  notes: [],
  lifecycle: { state: "inactive", visibility: "hidden", reason: "manual" },
};
const grace = {
  slug: "grace-12345678",
  name: "Grace",
  views: [],
  notes: [],
  lifecycle: { state: "grace", visibility: "auto", reason: "empty", emptySince: "2026-10-15T12:00:00.000Z" },
};
const response = (projects: unknown[]): Response =>
  new Response(JSON.stringify({ schemaVersion: 1, projects }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

afterEach(() => {
  cleanup();
  forgetProjectCatalogs();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function navigation(
  activeProjectSlug: string | null = active.slug,
  currentSlug: string | null = active.slug,
  overviewOpen = false,
  recents: Parameters<typeof WorkspaceNavigation>[0]["recents"] = [],
  globalOverview = false,
) {
  return render(
    <WorkspaceNavigation
      workspace="Active"
      currentSlug={currentSlug}
      globalOverview={globalOverview}
      place={null}
      activeProjectSlug={activeProjectSlug}
      overviewOpen={overviewOpen}
      searchOpen={false}
      recents={recents}
      onContents={vi.fn()}
      onSearch={vi.fn()}
      onOpenProject={vi.fn()}
      onOpenRecent={vi.fn()}
      onHelp={vi.fn()}
      drawer
      onDrawer={vi.fn()}
    />,
  );
}

test("the sidebar partitions inactive projects into one counted collapsed group", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response([active, inactive])),
  );
  navigation();
  const group = await screen.findByRole("group", { name: "Inactive projects (1)" });
  expect(group).not.toHaveAttribute("open");
  expect(await within(group).findByRole("button", { name: "Inactive" })).not.toBeVisible();
  fireEvent.click(within(group).getByText("Inactive projects"));
  expect(group).toHaveAttribute("open");
  expect(within(group).getByRole("button", { name: "Inactive" })).toBeVisible();
  expect(screen.getByRole("button", { name: /^Active/ })).toBeVisible();
});

test("the current inactive project stays visible in its automatically opened sidebar group", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response([active, inactive])),
  );
  navigation(inactive.slug);
  const group = await screen.findByRole("group", { name: "Inactive projects (1)" });
  expect(group).toHaveAttribute("open");
  expect(
    within(screen.getByRole("button", { name: /^Inactive/ })).getByRole("img", { name: "Active project" }),
  ).toBeVisible();
});

test("a scoped inactive project overview opens its group despite an unrelated recent file", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response([active, inactive])),
  );
  navigation(active.slug, inactive.slug, true, [
    { slug: active.slug, projectName: active.name, kind: "note", id: "notes/old.md", title: "Old note", at: 1 },
  ]);
  const group = await screen.findByRole("group", { name: "Inactive projects (1)" });
  expect(group).toHaveAttribute("open");
  expect(await within(group).findByRole("button", { name: "Inactive" })).toBeVisible();
});

test("the global overview keeps its inactive group collapsed despite an inactive recent file", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response([active, inactive])),
  );
  navigation(
    inactive.slug,
    null,
    true,
    [{ slug: inactive.slug, projectName: inactive.name, kind: "note", id: "notes/old.md", title: "Old note", at: 1 }],
    true,
  );
  const group = await screen.findByRole("group", { name: "Inactive projects (1)" });
  expect(group).not.toHaveAttribute("open");
});

test("a sidebar left open refreshes grace state on its bounded poll", async () => {
  vi.useFakeTimers();
  let expired = false;
  const fetcher = vi.fn(async () =>
    response([active, expired ? { ...grace, lifecycle: { ...grace.lifecycle, state: "inactive" } } : grace]),
  );
  vi.stubGlobal("fetch", fetcher);
  navigation();
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByRole("button", { name: "Grace" })).toBeVisible();
  expect(screen.queryByRole("group", { name: "Inactive projects (1)" })).toBeNull();
  expired = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.getByRole("group", { name: "Inactive projects (1)" })).toBeInTheDocument();
});
