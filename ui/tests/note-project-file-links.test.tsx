// @vitest-environment jsdom
//
// A note's link to another file of its project (the casebook's `../../NOTICE.md`), in the real App over the real
// service: a file the project's document catalog lists opens at its own page; one it does not list keeps the note's
// inline "Unavailable" message rather than leaving for a page that can only say it is out of scope.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

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
import { browserRoutePath } from "../src/app/browser-routes";
import { projectSlugFromPath } from "../src/app/project-directory";
import { resetApplicationUpdate } from "../src/app/application-update";
import { MockEventSource, restoreLocation } from "./app-harness";
import { installMatchMedia } from "./match-media";
import { pageOnService, SERVICE_HOME, SYSTEM_MMD, viewEntry, type PageOnService } from "./support/page-on-service";
import { startTsProject, type TsProject } from "./support/ts-service";

const GUIDE = [
  "# Guide",
  "",
  "Read [the README](../../README.md), [the private plan](../../private-plan.md) or [the gone file](../../gone.md).",
  "",
  "Or open [the system](../system.mmd), or read [the standard](https://example.com/standard).",
  "",
].join("\n");

let service: TsProject;
let project: TsProject;
let page: PageOnService | undefined;
let assigned: string[];

beforeAll(async () => {
  service = await startTsProject({ files: SERVICE_HOME });
}, 30_000);
afterAll(async () => {
  await service?.stop();
});
beforeEach(() => {
  MockEventSource.instances = [];
  localStorage.clear();
});
afterEach(async () => {
  cleanup();
  await page?.close();
  page = undefined;
  restoreLocation();
  resetApplicationUpdate();
  vi.unstubAllGlobals();
  await project?.stop();
});

/** Holds the page's document catalog requests until released, as a slow service would. */
let held: (() => void)[] = [];
/** The held requests' answers, once released. */
let answered: Promise<unknown>[] = [];
function holdCatalog(): void {
  const answer = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!/\/api\/documents(?:\?|$)/u.test(new URL(href, window.location.href).pathname + "?"))
      return answer(input, init);
    const reply = new Promise<void>((release) => held.push(release)).then(() => answer(input, init));
    answered.push(reply);
    return reply;
  });
}

async function readGuide(): Promise<HTMLElement> {
  project = await service.attachProject({
    "archer.toml": `version = 1\n\n${viewEntry("system", "The system")}`,
    ".archer/system.mmd": SYSTEM_MMD,
    ".archer/notes/guide.md": GUIDE,
    "README.md": "# The project\n",
    "private-plan.md": "# Not for the page\n",
  });
  await project.present("system");
  page = await pageOnService(project);
  // The note's own address, in the project the service mounted.
  const slug = projectSlugFromPath(window.location.pathname)!;
  window.history.replaceState(null, "", browserRoutePath({ kind: "note", projectSlug: slug, path: "notes/guide.md" }));
  // Navigation leaves the page; record where it would go instead.
  assigned = [];
  const location = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new Proxy({} as Location, {
      get: (_, key) => {
        if (key === "assign") return (href: string | URL) => void assigned.push(String(href));
        const value = Reflect.get(location, key);
        return typeof value === "function" ? value.bind(location) : value;
      },
    }),
  });
  installMatchMedia(false);
  render(<App />);
  return await screen.findByRole("article", { name: "Reading Guide" });
}

it("opens a project file the document catalog lists at its own page", async () => {
  const reader = await readGuide();
  fireEvent.click(await within(reader).findByRole("link", { name: "the README" }));
  await waitFor(() => expect(assigned).toHaveLength(1));
  expect(assigned[0]).toMatch(/\/README\.md$/u);
  expect(within(reader).queryByText(/^Unavailable:/u)).toBeNull();
});

it.each([
  ["the private plan", "../../private-plan.md"],
  ["the gone file", "../../gone.md"],
])("keeps the inline message for %s, which the catalog does not list", async (name, href) => {
  const reader = await readGuide();
  fireEvent.click(await within(reader).findByRole("link", { name }));
  expect(
    await within(reader).findByText(`Unavailable: ${href} is not a registered diagram or note in this project.`),
  ).toBeInTheDocument();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(assigned).toEqual([]);
});

/** Clicks the README, holds its catalog answer, does `meanwhile`, then lets the answer arrive. */
async function readmeAnswersAfter(reader: HTMLElement, meanwhile: () => Promise<void> | void): Promise<void> {
  held = [];
  answered = [];
  holdCatalog();
  fireEvent.click(await within(reader).findByRole("link", { name: "the README" }));
  await waitFor(() => expect(held.length).toBeGreaterThan(0));
  await meanwhile();
  for (const release of held) release();
  await Promise.allSettled(answered);
  // The answer's body is read, then the link decides: a few turns of the event loop.
  await new Promise((resolve) => setTimeout(resolve, 50));
}

it("does not leave for a file whose catalog answer arrives after the person went to its folder", async () => {
  const reader = await readGuide();
  await readmeAnswersAfter(reader, async () => {
    // A navigation outside the note's own link handling: the breadcrumb's folder.
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("button", { name: "notes" }),
    );
    await waitFor(() => expect(screen.queryByRole("article", { name: "Reading Guide" })).toBeNull());
  });
  expect(assigned).toEqual([]);
});

it("still opens the file when the person meanwhile follows an external link, which opens in a new tab", async () => {
  const reader = await readGuide();
  await readmeAnswersAfter(reader, () => {
    fireEvent.click(within(reader).getByRole("link", { name: "the standard" }));
  });
  expect(assigned).toHaveLength(1);
  expect(assigned[0]).toMatch(/\/README\.md$/u);
});
