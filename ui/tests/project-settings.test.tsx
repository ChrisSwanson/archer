// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectSettingsDialog } from "../src/app/ProjectSettings";
import {
  forgetProjectCatalogs,
  loadProjectCatalog,
  markProjectCatalogStale,
  rememberedProjectCatalog,
} from "../src/app/project-directory";
import { announceProjectCatalogChanged, PROJECT_CATALOG_CHANGED } from "../src/app/project-lifecycle";

const BASE = "http://127.0.0.1:4000/p/demo/";
const SETTINGS_URL = "http://127.0.0.1:4000/p/demo/api/project-settings";
const LIFECYCLE_URL = "http://127.0.0.1:4000/api/project-lifecycle";
const REV1 = `sha256:${"1".repeat(64)}`;
const REV2 = `sha256:${"2".repeat(64)}`;
const MANIFEST = 'version = 1\nname = \'Demo\'\n\n[discovery]\nroots = [".archer", "docs"]\n';

const snapshot = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  slug: "demo",
  revision: REV1,
  loaded: true,
  general: {
    name: "Demo",
    nameSource: "archer.toml",
    description: "What it is.",
    descriptionSource: "archer.toml",
    location: "/home/alex/code/demo",
    folder: ".archer",
    editing: { enabled: true, source: "default" },
  },
  views: [{ id: "flow", kind: "freeform", title: "The flow", source: "flow.mmd", covers: ["src/**"] }],
  viewProblems: [],
  discovery: {
    roots: [".archer", "docs"],
    exclude: ["docs/private/**"],
    configured: { roots: [".archer", "docs"], exclude: ["docs/private/**"] },
  },
  feedback: {
    changes: "manual",
    delivery: "next_call",
    allowNotifications: false,
    notificationPolicy: "not_requested",
    sources: { changes: "project", delivery: "builtin", allowNotifications: "builtin" },
  },
  visibility: { state: "active", visibility: "auto" },
  manifest: { path: "archer.toml", text: MANIFEST },
  ...overrides,
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Call = { url: string; init?: RequestInit };
function fakeService(replies: ((call: Call) => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const call = { url, ...(init === undefined ? {} : { init }) };
    calls.push(call);
    const reply = replies.shift();
    if (reply === undefined) throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
    return reply(call);
  });
  return { calls, fetchImpl };
}

function Harness(props: {
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  diagramCount?: number;
  noteCount?: number;
  onSaved?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <main>
        <button type="button" onClick={() => setOpen(true)}>
          Project settings
        </button>
      </main>
      <ProjectSettingsDialog
        open={open}
        onClose={() => setOpen(false)}
        baseUrl={BASE}
        fetchImpl={props.fetchImpl}
        projectName="Demo"
        {...(props.onSaved === undefined ? {} : { onSaved: props.onSaved })}
        {...(props.diagramCount === undefined ? {} : { diagramCount: props.diagramCount })}
        {...(props.noteCount === undefined ? {} : { noteCount: props.noteCount })}
      />
    </>
  );
}

async function openDialog(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  extra: { diagramCount?: number; noteCount?: number; onSaved?: () => void } = {},
) {
  render(<Harness fetchImpl={fetchImpl} {...extra} />);
  const opener = screen.getByRole("button", { name: "Project settings" });
  opener.focus();
  fireEvent.click(opener);
  const dialog = await screen.findByRole("dialog", { name: "Project Settings" });
  await within(dialog).findByLabelText("Name");
  return dialog;
}

afterEach(() => {
  cleanup();
  document.body.removeAttribute("inert");
});

describe("Project settings dialog", () => {
  it("loads the snapshot and renders every section", async () => {
    const { calls, fetchImpl } = fakeService([() => json(snapshot())]);
    const dialog = await openDialog(fetchImpl, { diagramCount: 17, noteCount: 20 });

    expect(calls[0]!.url).toBe(SETTINGS_URL);
    expect(calls[0]!.init?.method ?? "GET").toBe("GET");
    const nav = within(dialog).getByRole("navigation", { name: "Settings sections" });
    expect(
      within(nav)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["General", "Diagrams17", "Notes20", "Discovery", "Feedback", "Visibility", "archer.toml"]);
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Demo");
    expect(within(dialog).getByLabelText("Description")).toHaveValue("What it is.");
    expect(within(dialog).getByText("/projects/demo/")).toBeInTheDocument();
    expect(within(dialog).getByText("~/code/demo")).toBeInTheDocument();
    expect(within(dialog).getByText("The flow")).toBeInTheDocument();
    expect(within(dialog).getByText("docs/private/**")).toBeInTheDocument();
    expect(within(dialog).getByText("Status:")).toHaveTextContent("Status: Active");
    expect(within(dialog).queryByRole("button", { name: /Why is this project inactive/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: "Automatic" })).toBeChecked();
    expect(dialog.querySelector("pre")).toHaveTextContent('roots = [".archer", "docs"]');
    expect(within(dialog).getByText("0 unsaved changes")).toBeInTheDocument();
  });

  it("keeps protected fields read-only with a lock and the archer.toml hint", async () => {
    const { fetchImpl } = fakeService([
      () =>
        json(
          snapshot({
            manifest: null,
            revision: null,
            general: {
              name: "demo",
              nameSource: "directory",
              description: null,
              descriptionSource: null,
              location: "/srv/demo",
              folder: ".archer",
              editing: { enabled: true, source: "default" },
            },
          }),
        ),
    ]);
    const dialog = await openDialog(fetchImpl);
    expect(within(dialog).getByLabelText("Name")).toHaveAttribute("readonly");
    expect(within(dialog).getByLabelText("Description")).toHaveAttribute("readonly");
    expect(within(dialog).getAllByRole("img", { name: "Protected" }).length).toBeGreaterThanOrEqual(4);
    expect(
      within(dialog).getByText("Protected fields are read-only here; change them in archer.toml."),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole("textbox", { name: "Archer folder" })).not.toBeInTheDocument();
  });

  it("keeps name and description read-only, to be changed in archer.toml", async () => {
    const { fetchImpl } = fakeService([() => json(snapshot())]);
    const dialog = await openDialog(fetchImpl);
    expect(within(dialog).getByLabelText("Name")).toHaveAttribute("readonly");
    expect(within(dialog).getByLabelText("Description")).toHaveAttribute("readonly");
    expect(within(dialog).getAllByText(/edit archer\.toml/).length).toBeGreaterThanOrEqual(1);
  });

  it("greys the visibility choice where editing is off, as Edit and New are (D1), and sends no lifecycle change", async () => {
    const off = snapshot({
      general: { ...(snapshot().general as object), editing: { enabled: false, source: "project" } },
    });
    const { calls, fetchImpl } = fakeService([() => json(off)]);
    const dialog = await openDialog(fetchImpl);
    for (const name of ["Automatic", "Always show", "Archive"])
      expect(within(dialog).getByRole("radio", { name })).toBeDisabled();
    expect(
      within(dialog).getByText(/Editing is off for this project, so its visibility can't be changed here/),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("radio", { name: "Archive" }));
    expect(within(dialog).getByRole("radio", { name: "Automatic" })).toBeChecked();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(calls.filter((call) => call.url === LIFECYCLE_URL)).toEqual([]);
  });

  it("keeps the visibility choice where editing is on", async () => {
    const on = snapshot({
      general: { ...(snapshot().general as object), editing: { enabled: true, source: "default" } },
    });
    const { fetchImpl } = fakeService([() => json(on)]);
    const dialog = await openDialog(fetchImpl);
    expect(within(dialog).getByRole("radio", { name: "Archive" })).toBeEnabled();
  });

  it("shows a change dot in the gutter whose tooltip gives old, new and destination", async () => {
    const { fetchImpl } = fakeService([() => json(snapshot())]);
    const dialog = await openDialog(fetchImpl);
    fireEvent.click(within(dialog).getByRole("radio", { name: "Always show" }));
    const dot = within(dialog).getByRole("button", {
      name: "Visibility changed from Automatic to Always show, saved to service setting",
    });
    expect(dot).toHaveClass("archer-project-settings-dot");
    fireEvent.focus(dot);
    expect(within(dialog).getByRole("tooltip")).toHaveTextContent("Automatic→Always showService setting");
    fireEvent.blur(dot);
    expect(within(dialog).getByText("1 unsaved change")).toBeInTheDocument();
  });

  it("saves visibility through the lifecycle action and never writes archer.toml", async () => {
    const { calls, fetchImpl } = fakeService([
      () => json(snapshot()),
      () => json({ slug: "demo", lifecycle: { state: "active", visibility: "hidden" } }),
      () => json(snapshot({ visibility: { state: "active", visibility: "hidden" } })),
    ]);
    const dialog = await openDialog(fetchImpl);
    fireEvent.click(within(dialog).getByRole("radio", { name: "Archive" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls.map((c) => `${c.init?.method ?? "GET"} ${c.url}`)).toEqual([
      `GET ${SETTINGS_URL}`,
      `POST ${LIFECYCLE_URL}`,
      `GET ${SETTINGS_URL}`,
    ]);
    expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({ slug: "demo", action: "archive" });
  });

  // Sweep after O207: a visibility picked while Save waited was dropped when the dialog closed on the answer.
  it("takes no other visibility while its Save waits", async () => {
    let answer!: () => void;
    const held = new Promise<void>((done) => {
      answer = done;
    });
    const { fetchImpl } = fakeService([
      () => json(snapshot()),
      async () => {
        await held;
        return json({ slug: "demo", lifecycle: { state: "active", visibility: "hidden" } });
      },
      () => json(snapshot({ visibility: { state: "active", visibility: "hidden" } })),
    ]);
    const dialog = await openDialog(fetchImpl);
    fireEvent.click(within(dialog).getByRole("radio", { name: "Archive" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(dialog).getByRole("radio", { name: "Always show" })).toBeDisabled());
    answer();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Project Settings" })).toBeNull());
  });

  describe("a lifecycle save and the page's catalog", () => {
    /** The service: settings, the lifecycle action and the catalog, whose lifecycle follows the action. */
    function lifecycleService() {
      let visibility = "auto";
      const held: ((response: Response) => void)[] = [];
      let holdNextCatalog = false;
      const catalog = (): Response =>
        json({
          schemaVersion: 1,
          projects: [{ slug: "demo", name: "Demo", views: [], notes: [], lifecycle: { state: "active", visibility } }],
        });
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        if (url === "api/browser-projects") {
          if (!holdNextCatalog) return catalog();
          holdNextCatalog = false;
          const answer = catalog(); // read before the save: it answers with the former lifecycle, late
          return new Promise((resolve) => held.push(() => resolve(answer)));
        }
        if (url === LIFECYCLE_URL) {
          visibility = "hidden";
          return json({ slug: "demo", lifecycle: { state: "active", visibility } });
        }
        if (url === SETTINGS_URL) return json(snapshot({ visibility: { state: "active", visibility } }));
        throw new Error(`unexpected request ${url}`);
      });
      return {
        fetchImpl,
        holdNextCatalog: () => {
          holdNextCatalog = true;
        },
        releaseHeld: () => held.splice(0).forEach((release) => release(new Response())),
      };
    }
    const visibilityOf = (fetchImpl: unknown): string | undefined => {
      const held = rememberedProjectCatalog(fetchImpl as Parameters<typeof rememberedProjectCatalog>[0]);
      return held?.status === "ready" ? held.projects[0]?.lifecycle.visibility : undefined;
    };
    /** What a listener adopts on each announcement (the sidebar and search read the held catalog). */
    function announcements(fetchImpl: unknown): string[] {
      const seen: string[] = [];
      const listener = (): void => {
        seen.push(visibilityOf(fetchImpl) ?? "none");
      };
      window.addEventListener(PROJECT_CATALOG_CHANGED, listener);
      cleanups.push(() => window.removeEventListener(PROJECT_CATALOG_CHANGED, listener));
      return seen;
    }
    const cleanups: (() => void)[] = [];
    afterEach(() => {
      cleanups.splice(0).forEach((cleanup) => cleanup());
      forgetProjectCatalogs();
    });

    async function save(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>): Promise<void> {
      // As App.tsx does after a save: a confirming catalog read, then the announcement.
      const dialog = await openDialog(fetchImpl, {
        onSaved: () => {
          void loadProjectCatalog(fetchImpl).then(() => announceProjectCatalogChanged());
        },
      });
      fireEvent.click(within(dialog).getByRole("radio", { name: "Archive" }));
      fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }

    it("a catalog read a moment ago (still fresh) shows the saved lifecycle at once", async () => {
      const service = lifecycleService();
      await loadProjectCatalog(service.fetchImpl);
      expect(visibilityOf(service.fetchImpl)).toBe("auto");
      const seen = announcements(service.fetchImpl);
      await save(service.fetchImpl);
      await waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(2));
      expect(seen.every((visibility) => visibility === "hidden")).toBe(true);
      expect(visibilityOf(service.fetchImpl)).toBe("hidden");
    });

    it("a catalog read already under way (with the former lifecycle) cannot bring it back", async () => {
      const service = lifecycleService();
      await loadProjectCatalog(service.fetchImpl);
      markProjectCatalogStale();
      service.holdNextCatalog();
      const racing = loadProjectCatalog(service.fetchImpl);
      const seen = announcements(service.fetchImpl);
      await save(service.fetchImpl);
      await waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(2));
      service.releaseHeld();
      await racing;
      expect(seen.every((visibility) => visibility === "hidden")).toBe(true);
      expect(visibilityOf(service.fetchImpl)).toBe("hidden");
    });
  });

  it("settings the service does not answer (a hidden 404) cannot be loaded, and can be tried again", async () => {
    const { fetchImpl } = fakeService([() => new Response("", { status: 404 })]);
    render(<Harness fetchImpl={fetchImpl} />);
    fireEvent.click(screen.getByRole("button", { name: "Project settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Project Settings" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Project settings could not be loaded. Try again.",
    );
    expect(await within(dialog).findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("explains an Inactive status through an info tooltip", async () => {
    const { fetchImpl } = fakeService([
      () =>
        json(
          snapshot({
            visibility: {
              state: "inactive",
              visibility: "auto",
              reason: "empty",
              emptySince: "2026-10-18T10:00:00.000Z",
            },
          }),
        ),
    ]);
    const dialog = await openDialog(fetchImpl);
    expect(within(dialog).getByText("Status:")).toHaveTextContent("Status: Inactive");
    const info = within(dialog).getByRole("button", { name: "Why is this project inactive?" });
    fireEvent.focus(info);
    expect(within(dialog).getByRole("tooltip")).toHaveTextContent(
      "No notes or diagrams yet. Add one and this project becomes Active again, or choose Always show to keep it listed.",
    );
  });

  it("traps focus, makes the background inert and returns focus to the opener", async () => {
    const { fetchImpl } = fakeService([() => json(snapshot())]);
    const dialog = await openDialog(fetchImpl);
    const opener = screen.getByRole("button", { name: "Project settings", hidden: true });
    expect(opener.closest("[inert]")).not.toBeNull();
    expect(dialog.closest("[inert]")).toBeNull();
    expect(dialog.contains(document.activeElement)).toBe(true);

    const close = within(dialog).getByRole("button", { name: "Close settings" });
    const save = within(dialog).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    cancel.focus();
    fireEvent.keyDown(cancel, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(cancel);

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(opener.closest("[inert]")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("returns focus to a given opener even when the click did not focus it", async () => {
    const { fetchImpl } = fakeService([() => json(snapshot())]);
    function WithOpener() {
      const [open, setOpen] = useState(false);
      const gear = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={gear} type="button" onClick={() => setOpen(true)}>
            Gear
          </button>
          <ProjectSettingsDialog
            open={open}
            onClose={() => setOpen(false)}
            baseUrl={BASE}
            fetchImpl={fetchImpl}
            projectName="Demo"
            opener={gear}
          />
        </>
      );
    }
    render(<WithOpener />);
    fireEvent.click(screen.getByRole("button", { name: "Gear" }));
    const dialog = await screen.findByRole("dialog", { name: "Project Settings" });
    await within(dialog).findByLabelText("Name");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Close settings" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Gear" }));
  });

  it("asks before discarding unsaved changes on Escape, and Cancel discards", async () => {
    const { fetchImpl } = fakeService([() => json(snapshot())]);
    const dialog = await openDialog(fetchImpl);
    fireEvent.click(within(dialog).getByRole("radio", { name: "Always show" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(within(dialog).getByText("Discard 1 unsaved change?")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(within(dialog).getByRole("radio", { name: "Always show" })).toBeChecked();
    act(() => {
      within(dialog).getByRole("button", { name: "Close settings" }).click();
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Cancel discards pending edits without asking and sends nothing", async () => {
    const { calls, fetchImpl } = fakeService([() => json(snapshot()), () => json(snapshot())]);
    const dialog = await openDialog(fetchImpl);
    fireEvent.click(within(dialog).getByRole("radio", { name: "Always show" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Project settings" }));
    const reopened = await screen.findByRole("dialog", { name: "Project Settings" });
    expect(await within(reopened).findByRole("radio", { name: "Automatic" })).toBeChecked();
  });
});
