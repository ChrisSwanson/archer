// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ArcherSettings from "../src/app/ArcherSettings";
import { useShellHelp, useShellShortcuts } from "../src/app/shell-help";
import { useCanvasShortcuts } from "../src/diagrams/canvas-shortcuts";
import { HelpOverlay, HelpProvider } from "../src/app/HelpOverlay";
import { useState } from "react";
import { App } from "../src/app/App";
import { GlobalProjectsPage } from "../src/app/GlobalProjectsPage";
import { SourceDocumentPage } from "../src/app/SourceDocumentPage";
import {
  KEYMAP,
  matchesShortcut,
  readerShortcutCapabilities,
  setCharacterShortcutsEnabled,
  shortcutRow,
} from "../src/app/shortcuts";
import { MockEventSource, mountAgentPresented, restoreLocation, stubRoutes } from "./app-harness";

function Keys({ fit, search }: { fit: () => void; search: () => void }) {
  const help = useShellHelp();
  useShellShortcuts(help, search);
  useCanvasShortcuts({ onFitView: fit, enabled: !help.open });
  return (
    <>
      <button type="button">Theme stand-in</button>
      <button type="button" onClick={help.toggle}>
        Help
      </button>
      <input aria-label="Typing" />
      <ArcherSettings />
      <HelpOverlay open={help.open} onClose={help.hide} view="graph" />
    </>
  );
}

beforeEach(() => {
  localStorage.clear();
  MockEventSource.instances.length = 0;
  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          serviceName: "Test",
          commentSubmission: "immediate",
          configRevision: "1",
          configPath: "archer.toml",
          settings: [],
        }),
      ),
    ),
  );
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  restoreLocation();
  window.history.replaceState(null, "", "/");
});

it("#9 persists one off switch for Help, search and both canvas Fit bindings, while Escape still closes Help", async () => {
  const fit = vi.fn(),
    search = vi.fn();
  const first = render(<Keys fit={fit} search={search} />);
  fireEvent.keyDown(screen.getByText("Theme stand-in"), { key: "1" });
  expect(fit).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Archer settings" }));
  const toggle = await screen.findByRole("checkbox", { name: "Single-character shortcuts" });
  expect(toggle).toBeChecked();
  fireEvent.click(toggle);
  fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
  first.unmount();
  render(<Keys fit={fit} search={search} />);
  for (const key of ["?", "1", "/", "g", "G"]) fireEvent.keyDown(screen.getByText("Theme stand-in"), { key });
  expect(screen.queryByRole("dialog", { name: "Keyboard & Pointer" })).toBeNull();
  expect(fit).toHaveBeenCalledTimes(1);
  expect(search).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Help" }));
  const help = screen.getByRole("dialog", { name: "Keyboard & Pointer" });
  expect(help).toHaveTextContent("Single-character shortcuts are off");
  expect(within(help).queryByText("1")).toBeNull();
  fireEvent.keyDown(help, { key: "?" });
  expect(help).toBeInTheDocument();
  fireEvent.keyDown(help, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Archer settings" }));
  expect(screen.getByRole("checkbox", { name: "Single-character shortcuts" })).not.toBeChecked();
  fireEvent.click(screen.getByRole("checkbox", { name: "Single-character shortcuts" }));
  fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
  fireEvent.keyDown(screen.getByText("Theme stand-in"), { key: "1" });
  expect(fit).toHaveBeenCalledTimes(2);
});

it("#9 blocks document-level step shortcuts when off without swallowing typing, Escape or modified keys", () => {
  render(<Keys fit={vi.fn()} search={vi.fn()} />);
  setCharacterShortcutsEnabled(false);
  const local = vi.fn();
  document.addEventListener("keydown", local);
  try {
    fireEvent.keyDown(screen.getByText("Theme stand-in"), { key: "c" });
    fireEvent.keyDown(screen.getByText("Theme stand-in"), { key: "c", isComposing: true });
    expect(local).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText("Typing"), { key: "c" });
    fireEvent.keyDown(screen.getByText("Theme stand-in"), { key: "c", ctrlKey: true });
    fireEvent.keyDown(screen.getByText("Theme stand-in"), { key: "Escape" });
    expect(local).toHaveBeenCalledTimes(3);
  } finally {
    document.removeEventListener("keydown", local);
  }
});

function EditorFitHelp() {
  const help = useShellHelp();
  const [canvas, setCanvas] = useState(true);
  return (
    <HelpProvider value={help}>
      <button type="button" onClick={() => setCanvas((value) => !value)}>
        Toggle canvas
      </button>
      <button type="button" onClick={help.toggle}>
        Help
      </button>
      {canvas ? <FitOwner /> : null}
      <HelpOverlay
        open={help.open}
        onClose={help.hide}
        view="none"
        extra={[{ section: "Editing", keys: [["Ctrl/⌘ Z", "Undo"]] }]}
      />
    </HelpProvider>
  );
}
function FitOwner() {
  useCanvasShortcuts({ onFitView: vi.fn(), enabled: true });
  return null;
}
it("#10 advertises editor Fit only while a canvas registers that binding", () => {
  render(<EditorFitHelp />);
  fireEvent.click(screen.getByRole("button", { name: "Help" }));
  expect(within(screen.getByRole("dialog")).getByText("1")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getByRole("button", { name: "Toggle canvas" }));
  fireEvent.click(screen.getByRole("button", { name: "Help" }));
  expect(within(screen.getByRole("dialog")).queryByText("1")).toBeNull();
});

it("#24 has one Settings close control, in the header", () => {
  render(<ArcherSettings />);
  fireEvent.click(screen.getByRole("button", { name: "Archer settings" }));
  const close = within(screen.getByRole("dialog")).getAllByRole("button", { name: /close/i });
  expect(close).toHaveLength(1);
  expect(close[0]!.closest("header")).not.toBeNull();
});

it("#10 lists shared search on the global overview", () => {
  stubRoutes();
  render(<GlobalProjectsPage />);
  fireEvent.keyDown(window, { key: "?" });
  const help = screen.getByRole("dialog", { name: "Keyboard & Pointer" });
  expect(within(help).getByText("/")).toBeVisible();
  expect(within(help).getByText("G")).toBeVisible();
});

it("#10 lists shared search on the read-only source page", () => {
  stubRoutes();
  render(<SourceDocumentPage projectSlug="test" path="README.md" />);
  fireEvent.keyDown(window, { key: "?" });
  const help = screen.getByRole("dialog", { name: "Keyboard & Pointer" });
  expect(within(help).getByText("/")).toBeVisible();
  expect(within(help).getByText("G")).toBeVisible();
});

it("#10 uses the keymap's spelling and metadata for dispatch and Help, including capability refusals", () => {
  for (const [id, binding] of Object.entries(KEYMAP)) {
    const shortcut = id as keyof typeof KEYMAP;
    expect(shortcutRow(shortcut)).toEqual([binding.label, binding.meaning]);
    for (const key of binding.keys) {
      expect(matchesShortcut(new KeyboardEvent("keydown", { key }), shortcut)).toBe(true);
      expect(matchesShortcut(new KeyboardEvent("keydown", { key }), shortcut, false)).toBe(false);
      expect(matchesShortcut(new KeyboardEvent("keydown", { key, isComposing: true }), shortcut)).toBe(false);
    }
  }
  const reading = {
    editing: false,
    views: 2,
    comments: true,
    note: false,
    contents: false,
    reviewView: true,
    projectChat: false,
    chat: true,
    walk: true,
    camera: true,
  };
  expect(readerShortcutCapabilities(reading)).toEqual({ previous: true, next: true, comment: true, follow: true });
  expect(readerShortcutCapabilities({ ...reading, editing: true })).toEqual({
    previous: false,
    next: false,
    comment: false,
    follow: false,
  });
  expect(readerShortcutCapabilities({ ...reading, camera: false }).follow).toBe(false);
});

it("#10 lists Editing Help on the new-editor route without reading selection or commenting", async () => {
  window.history.replaceState(null, "", "/projects/test/-/edit/");
  await mountAgentPresented(<App />, { ready: () => {} });
  fireEvent.keyDown(window, { key: "?" });
  const help = screen.getByRole("dialog", { name: "Keyboard & Pointer" });
  expect(within(help).getByRole("heading", { name: "Editing" })).toBeVisible();
  expect(within(help).queryByRole("heading", { name: "Select" })).toBeNull();
  expect(within(help).queryByRole("heading", { name: "Commenting" })).toBeNull();
});
