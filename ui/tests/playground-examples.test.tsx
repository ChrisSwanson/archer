// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { PageRuntime } from "../src/app/runtime";
vi.hoisted(() => vi.resetModules());
const holder = vi.hoisted(() => ({ current: null as PageRuntime | null }));
vi.mock("../src/app/runtime", () => ({
  get runtime() {
    return holder.current;
  },
}));
vi.mock("../src/runtime/address.ts", async () => await import("../src/playground/address"));
import { PlaygroundShell } from "../src/playground/shell";
import { configureStaticAddress, decodeAddress, encodeAddress } from "../src/playground/address";
import { createStaticRuntime } from "../src/playground/runtime";
import { parseSettings } from "../src/app/ArcherSettings";
import { exampleSnapshot } from "./support/playground-snapshot";
import type { PlaygroundSnapshot } from "../../shared/playground-snapshot.mts";
import { installMatchMedia } from "./match-media";

// The Playground has no Archer service, yet it shows the settings gear and the chat bubble (owner, 2026-11-15):
// the real surfaces, filled with example data its static runtime supplies, labelled as examples and inert.
let snapshot: PlaygroundSnapshot;
beforeAll(() => {
  snapshot = exampleSnapshot();
}, 30000);
const runtime = () => holder.current as ReturnType<typeof createStaticRuntime>;
function openLogical(path: string): void {
  window.history.replaceState(null, "", encodeAddress(path));
  configureStaticAddress({ documentUrl: window.location.href, digest: snapshot.manifest.digest });
}
beforeEach(() => {
  installMatchMedia(false);
  window.history.replaceState(
    null,
    "",
    "/archer/playground/app/index.html?route=%2Fprojects%2Farcher-tour%2Fdiagrams%2Fheartbeat.mmd",
  );
  configureStaticAddress({ documentUrl: window.location.href, digest: snapshot.manifest.digest });
  holder.current = createStaticRuntime({ snapshot, href: () => decodeAddress(window.location.href), storage: null });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("API network forbidden"))),
  );
  vi.stubGlobal(
    "EventSource",
    vi.fn(() => {
      throw new Error("EventSource forbidden");
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("answers Archer Settings with example values the real dialog reads, and says they are examples", async () => {
  const response = await runtime().request("api/settings");
  expect(response.ok).toBe(true);
  const settings = parseSettings(await response.json());
  expect(settings.configPath).toBe("~/.config/archer/archer.toml");
  expect(settings.settings.map((row) => row.key)).toEqual(
    expect.arrayContaining(["host", "port", "commentSubmission", "admission"]),
  );
  expect(runtime().examples?.settingsNote).toMatch(/^Example settings/u);
  expect(runtime().examples?.settingsNote).toContain("archer.toml");
  // Writes stay refused: the example changes nothing.
  expect((await runtime().request("api/settings", { method: "PUT", body: "{}" })).ok).toBe(false);
});

it("offers the settings it can answer", async () => {
  const onCapabilities = vi.fn();
  runtime().connect!({ onPresent: vi.fn(), onClear: vi.fn(), onCapabilities });
  await waitFor(() => expect(onCapabilities).toHaveBeenCalled());
  expect(onCapabilities).toHaveBeenCalledWith(expect.objectContaining({ instanceSettings: true, listeners: false }));
});

it("scripts a short conversation for every example document and each project, the person asking first", () => {
  for (const project of snapshot.projects) {
    const views = (project.responses["api/diagrams"] as { views: { id: string }[] }).views;
    const notes = (project.responses["api/notes/all"] as { notes: { path: string }[] }).notes;
    const targets = [
      "project:",
      ...views.map((view) => `view:${view.id}`),
      ...notes.map((note) => `note:${note.path}`),
    ];
    for (const target of targets) {
      const thread = runtime().examples!.chat(project.slug, target as `view:${string}`);
      expect(thread, `${project.slug} ${target}`).not.toBeNull();
      expect(thread!.length, `${project.slug} ${target}`).toBeGreaterThanOrEqual(2);
      expect(thread![0]!.author).toBe("person");
      expect(thread!.some((message) => message.author === "agent")).toBe(true);
      for (const message of thread!) expect(message.body.trim().length).toBeGreaterThan(0);
    }
  }
  expect(runtime().examples!.chat("no-such-project", "project:")).toBeNull();
});

it("serves the project notice its README and casebook link to", async () => {
  const response = await runtime().request("/p/rfc-1149-ipoac/api/documents/content?path=NOTICE.md");
  expect(response.ok).toBe(true);
  const body = (await response.json()) as { kind: string; markdown: string; source: { path: string } };
  expect(body.source.path).toBe("NOTICE.md");
  expect(body.kind).toBe("markdown");
  expect(body.markdown).toBe(snapshot.projects.find((project) => project.slug === "rfc-1149-ipoac")?.notice);
});

it("opens the real Archer Settings dialog filled with the example, read-only", async () => {
  openLogical("/projects/archer-tour/");
  render(<PlaygroundShell snapshot={snapshot} runtime={runtime()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Archer settings" }));
  const dialog = await screen.findByRole("dialog", { name: "Archer Settings" });
  expect(await within(dialog).findByText(/^Example settings/u)).toBeInTheDocument();
  expect(await within(dialog).findByRole("listitem", { name: "Listen address" })).toHaveTextContent("127.0.0.1");
  expect(within(dialog).getByRole("list", { name: "Service settings" })).toHaveAttribute("aria-disabled", "true");
  expect(within(dialog).queryByRole("alert")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it("opens the settings from the Projects overview too, with nothing to retry", async () => {
  openLogical("/projects/");
  render(<PlaygroundShell snapshot={snapshot} runtime={runtime()} />);
  expect(screen.queryByRole("button", { name: "Retry settings discovery" })).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Archer settings" }));
  const dialog = await screen.findByRole("dialog", { name: "Archer Settings" });
  expect(await within(dialog).findByRole("listitem", { name: "Listen address" })).toBeInTheDocument();
});

it("opens the real chat on a diagram with a labelled example thread and no way to send", async () => {
  const { container } = render(<PlaygroundShell snapshot={snapshot} runtime={runtime()} />);
  await waitFor(() => expect(container.querySelectorAll(".react-flow__node").length).toBeGreaterThan(0), {
    timeout: 10000,
  });
  const launcher = await screen.findByRole("button", { name: /^Example chat about The Heartbeat Loop/u });
  await act(async () => {
    fireEvent.click(launcher);
  });
  const chat = await screen.findByRole("dialog", { name: /Example chat/u });
  const log = await within(chat).findByRole("log", { name: "Conversation" });
  const thread = runtime().examples!.chat("archer-tour", "view:heartbeat")!;
  for (const message of thread) expect(log).toHaveTextContent(message.body);
  expect(within(chat).queryByRole("textbox")).toBeNull();
  expect(within(chat).queryByRole("button", { name: "Send" })).toBeNull();
  expect(within(chat).queryByRole("button", { name: "Resolve" })).toBeNull();
  expect(chat).toHaveTextContent(
    "In your own project, what you write here waits for your coding agent's next turn in your terminal.",
  );
  // Whole project: the project's own example.
  fireEvent.click(within(chat).getByRole("button", { name: "Whole project" }));
  const project = runtime().examples!.chat("archer-tour", "project:")!;
  await waitFor(() => expect(log).toHaveTextContent(project[0]!.body));
  expect(fetch).not.toHaveBeenCalled();
}, 20000);

it("says in the example settings that Archer is open only to this computer, as a fresh install is", async () => {
  openLogical("/projects/archer-tour/");
  render(<PlaygroundShell snapshot={snapshot} runtime={runtime()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Archer settings" }));
  const dialog = await screen.findByRole("dialog", { name: "Archer Settings" });
  const network = await within(dialog).findByRole("region", { name: "Network Access" });
  expect(network).toHaveTextContent("Not open to your network: only this computer can open Archer.");
  expect(network).not.toHaveTextContent("Not known yet");
  expect(fetch).not.toHaveBeenCalled();
});

/** The `?` dialog's section, by its heading: the rows' text. */
async function helpSection(name: string): Promise<string | null> {
  fireEvent.click(await screen.findByRole("button", { name: "Keyboard shortcuts" }));
  const help = await screen.findByRole("dialog");
  const heading = within(help).queryByRole("heading", { name });
  return heading?.parentElement?.textContent ?? null;
}

it("lists the example chat's own keys in Help, without the sending ones, where C opens it", async () => {
  openLogical("/projects/archer-tour/");
  render(<PlaygroundShell snapshot={snapshot} runtime={runtime()} />);
  await screen.findByRole("button", { name: /^Example chat about/u });
  const chat = await helpSection("Chat with the Agent");
  expect(chat).not.toBeNull();
  expect(chat).toContain("Open the chat about the whole document");
  expect(chat).toContain("Arrow keys");
  expect(chat).toContain("Home");
  expect(chat).toContain("Collapse the open chat");
  expect(chat).not.toContain("send the message");
});

it("says in Help what C does on a note in the example: comments on the passage or the note", async () => {
  openLogical("/projects/archer-tour/notes/what-is-archer.md");
  render(<PlaygroundShell snapshot={snapshot} runtime={runtime()} />);
  await screen.findByRole("article", { name: /^Reading /u }, { timeout: 10000 });
  const chat = await helpSection("Chat with the Agent");
  expect(chat).not.toBeNull();
  expect(chat).not.toContain("Open the chat about the whole document");
  expect(chat).toContain("Comment on the selected passage, or on the whole note");
  expect(chat).not.toContain("send the message");
}, 20000);
