// @vitest-environment jsdom
// Round 1 (UI/UX) pass 4, batch F14: shell, settings and comments. Each test names its row in the round's fourth
// fixes list and the finding it answers.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PANEL_WIDTH, PanelDivider } from "../src/app/PanelDivider";
import { FolderTree } from "../src/app/FolderTree";
import { fileRows, type FileRow } from "../src/app/file-index";
import { TREE_COLUMNS, type TreeColumn } from "../src/app/project-tree";
import { ProjectSettingsDialog } from "../src/app/ProjectSettings";
import { ThreadCard } from "../src/comments/ThreadCard";
import type { Thread } from "../src/comments/contract";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.body.removeAttribute("inert");
});

describe("row 1 (R3-14, D9): the panel divider without a drag, and Escape during one", () => {
  function Divider(props: { readonly initial: number; readonly seen: number[] }) {
    const [width, setWidth] = useState(props.initial);
    return (
      <div>
        <PanelDivider
          width={width}
          onChange={(next) => {
            props.seen.push(next);
            setWidth(next);
          }}
        />
      </div>
    );
  }

  it("a click with a single pointer steps the width, wider each time, then back to the narrowest", () => {
    const seen: number[] = [];
    render(<Divider initial={PANEL_WIDTH.initial} seen={seen} />);
    const bar = screen.getByRole("separator", { name: "Resize diagram panel" });
    const click = (): void => {
      fireEvent.pointerDown(bar, { clientX: 500, clientY: 300, pointerId: 1, button: 0 });
      fireEvent.pointerUp(bar, { clientX: 501, clientY: 300, pointerId: 1, button: 0 });
    };
    click();
    expect(bar).toHaveAttribute("aria-valuenow", "480");
    click();
    expect(bar).toHaveAttribute("aria-valuenow", String(PANEL_WIDTH.max));
    click();
    expect(bar).toHaveAttribute("aria-valuenow", String(PANEL_WIDTH.min));
    expect(window.localStorage.getItem("archer.diagram-panel.width")).toBe(String(PANEL_WIDTH.min));
    // The way to do it is said where a pointer finds it, and to assistive technology.
    expect(bar).toHaveAttribute("title", "Drag or click to resize");
    expect(bar.getAttribute("aria-description")).toMatch(/click/);
  });

  it("Escape during a drag puts the width back where the drag began, and the release then changes nothing", () => {
    const seen: number[] = [];
    render(<Divider initial={340} seen={seen} />);
    const bar = screen.getByRole("separator", { name: "Resize diagram panel" });
    fireEvent.pointerDown(bar, { clientX: 600, clientY: 300, pointerId: 1, button: 0 });
    fireEvent.pointerMove(bar, { clientX: 508, clientY: 300, pointerId: 1 });
    expect(bar).toHaveAttribute("aria-valuenow", "432");
    const escapeKey = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => {
      document.body.dispatchEvent(escapeKey);
    });
    expect(bar).toHaveAttribute("aria-valuenow", "340");
    // The page's own Escape (clear the selection, close a panel) does not also run.
    expect(escapeKey.defaultPrevented).toBe(true);
    fireEvent.pointerMove(bar, { clientX: 400, clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(bar, { clientX: 400, clientY: 300, pointerId: 1 });
    expect(bar).toHaveAttribute("aria-valuenow", "340");
    expect(window.localStorage.getItem("archer.diagram-panel.width")).toBe("340");
  });

  it("a real drag is still a drag, not a click", () => {
    const seen: number[] = [];
    render(<Divider initial={340} seen={seen} />);
    const bar = screen.getByRole("separator", { name: "Resize diagram panel" });
    fireEvent.pointerDown(bar, { clientX: 600, clientY: 300, pointerId: 1, button: 0 });
    fireEvent.pointerMove(bar, { clientX: 560, clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(bar, { clientX: 560, clientY: 300, pointerId: 1 });
    expect(bar).toHaveAttribute("aria-valuenow", "380");
  });
});

describe("row 2 (D8): a column moves by click, without a drag", () => {
  const NOW = Date.parse("2026-10-11T12:00:00Z");
  const rows: FileRow[] = fileRows({
    slug: "demo",
    name: "Demo",
    current: true,
    views: [
      {
        id: "ctx",
        title: "System context",
        kind: "c4",
        registration: "durable" as const,
        sourcePath: "diagrams/context.mmd",
        modifiedAt: "2026-10-10T10:00:00Z",
      },
    ],
    notes: [],
  });
  function Tree(props: { readonly onReorder: (columns: readonly TreeColumn[]) => void }) {
    const [columns, setColumns] = useState<readonly TreeColumn[]>(TREE_COLUMNS);
    const tree: ComponentProps<typeof FolderTree> = {
      rows,
      sort: { key: "folder", dir: "asc" },
      onSort: () => {},
      columns,
      filtering: false,
      now: NOW,
      onOpen: () => {},
      onColumnsReorder: (next) => {
        props.onReorder(next);
        setColumns(next);
      },
    };
    return <FolderTree {...tree} />;
  }

  it("the Move handle opens Move left and Move right; a choice moves the column and keeps focus on it", () => {
    const onReorder = vi.fn();
    render(<Tree onReorder={onReorder} />);
    const handle = screen.getByRole("button", { name: "Move Kind column" });
    expect(handle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(handle);
    expect(handle).toHaveAttribute("aria-expanded", "true");
    const choice = screen.getByRole("group", { name: "Move Kind" });
    fireEvent.click(within(choice).getByRole("button", { name: "Move left" }));
    expect(onReorder).toHaveBeenLastCalledWith(["kind", "title", "threads", "edited", "created"]);
    // Still open on the moved column, focus on the choice just made; the name never gives up first place.
    const moved = screen.getByRole("group", { name: "Move Kind" });
    const left = within(moved).getByRole("button", { name: "Move left" });
    expect(left).toHaveFocus();
    expect(left).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(left);
    expect(onReorder).toHaveBeenCalledTimes(1);
    fireEvent.click(within(moved).getByRole("button", { name: "Move right" }));
    expect(onReorder).toHaveBeenLastCalledWith(TREE_COLUMNS);
    // Escape puts it away and returns to the handle.
    fireEvent.keyDown(
      within(screen.getByRole("group", { name: "Move Kind" })).getByRole("button", { name: "Move right" }),
      { key: "Escape" },
    );
    expect(screen.queryByRole("group", { name: "Move Kind" })).toBeNull();
    expect(screen.getByRole("button", { name: "Move Kind column" })).toHaveFocus();
  });
});

describe("rows 3 and 4 (R3-03, R3-11, D3, F83–F90): Project settings", () => {
  const BASE = "http://127.0.0.1:4000/p/demo/";
  const snapshot = {
    schemaVersion: 1,
    slug: "demo",
    revision: `sha256:${"1".repeat(64)}`,
    loaded: true,
    general: {
      name: "Demo",
      nameSource: "archer.toml",
      description: "What it is.",
      location: "/home/alex/code/demo",
      folder: ".archer",
      editing: { enabled: true, source: "default" },
    },
    views: [],
    viewProblems: [],
    discovery: { roots: [".archer"], exclude: [], configured: {} },
    feedback: null,
    visibility: { state: "active", visibility: "auto" },
    manifest: { path: "archer.toml", text: "version = 1\n" },
  };
  function Harness() {
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
          projectName="Demo"
          fetchImpl={async () =>
            new Response(JSON.stringify(snapshot), { status: 200, headers: { "content-type": "application/json" } })
          }
        />
      </>
    );
  }
  async function openDialog(): Promise<HTMLElement> {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Project settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Project Settings" });
    await within(dialog).findByLabelText("Name");
    return dialog;
  }

  it("row 3: a section in the nav takes focus to its heading, and that section keeps the marker", async () => {
    const dialog = await openDialog();
    const nav = within(dialog).getByRole("navigation", { name: "Settings sections" });
    for (const name of ["Discovery", "Visibility", "archer.toml", "General"]) {
      fireEvent.click(within(nav).getByRole("button", { name }));
      const heading = within(dialog).getByRole("heading", {
        level: 3,
        name: new RegExp(`^${name.replace(".", "\\.")}`),
      });
      expect(heading, name).toHaveFocus();
      // The smooth scroll passes other sections on the way: the marker stays on the one asked for.
      fireEvent.scroll(dialog.querySelector(".archer-project-settings-content")!);
      expect(within(nav).getByRole("button", { name })).toHaveAttribute("aria-current", "true");
      expect(nav.querySelectorAll("[aria-current]")).toHaveLength(1);
    }
  });

  it("row 4: Escape with a changed field asks first, from wherever focus is, and Keep editing returns to Close settings", async () => {
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole("radio", { name: "Always show" }));
    expect(within(dialog).getByText("1 unsaved change")).toBeInTheDocument();
    const places = [
      within(dialog).getByRole("radio", { name: "Always show" }),
      within(dialog).getByRole("button", { name: /^Visibility changed/ }),
      within(dialog).getByRole("button", { name: "Discovery" }),
      within(dialog).getByLabelText("Name"),
      within(dialog).getByLabelText("archer.toml contents"),
      dialog,
    ];
    for (const place of places) {
      place.focus();
      fireEvent.keyDown(place, { key: "Escape" });
      // A tooltip on the change dot takes the first Escape; the next one is the dialog's.
      if (within(dialog).queryByText("Discard 1 unsaved change?") === null) fireEvent.keyDown(place, { key: "Escape" });
      expect(
        within(dialog).getByText("Discard 1 unsaved change?"),
        place.textContent ?? place.tagName,
      ).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
      await waitFor(() => expect(within(dialog).getByRole("button", { name: "Close settings" })).toHaveFocus());
      expect(screen.getByRole("dialog", { name: "Project Settings" })).toBeInTheDocument();
    }
    // Escape at the question is Keep editing too.
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.keyDown(within(dialog).getByRole("button", { name: "Keep editing" }), { key: "Escape" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Close settings" })).toHaveFocus());
    expect(within(dialog).getByText("1 unsaved change")).toBeInTheDocument();
  });

  it("row 4: Close settings with a changed field asks too", async () => {
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole("radio", { name: "Archive" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Close settings" }));
    expect(within(dialog).getByText("Discard 1 unsaved change?")).toBeInTheDocument();
  });
});

describe("row 6 (F74, R3-10): Delete then Keep returns to Delete", () => {
  const thread: Thread = {
    id: "t1",
    revision: 1,
    target: "view:system",
    anchor: { kind: "node", id: "web", label: "Web" },
    status: "sent",
    comments: [{ id: "c1", author: "person", body: "Mine to delete", createdAt: "2026-10-05T12:00:00Z" }],
  };
  const card = (onDelete: () => Promise<boolean>) =>
    render(
      <ThreadCard
        thread={thread}
        scope="view"
        onReply={async () => true}
        onEdit={async () => true}
        onDelete={onDelete}
        onResolve={async () => true}
        onDismiss={async () => true}
      />,
    );

  it("Keep puts focus back on Delete, not Edit", () => {
    card(async () => true);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("button", { name: "Keep" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus();
  });

  it("a delete the service refuses also returns to Delete", async () => {
    card(async () => false);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const group = screen.getByRole("group", { name: "Delete this comment?" });
    fireEvent.click(within(group).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus());
  });

  it("Cancel in the editor still returns to Edit", () => {
    card(async () => true);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Edit" })).toHaveFocus();
  });
});
