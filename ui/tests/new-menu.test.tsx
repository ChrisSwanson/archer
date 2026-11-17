// @vitest-environment jsdom
// New (D6): the menu for a browser authorized to author; otherwise a visible control that explains why not.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const status = vi.fn();
vi.mock("../src/authoring/client", () => ({ authoringClient: () => ({ status }) }));
import { NewMenu } from "../src/app/NewMenu";
import { forgetAuthoringStatus } from "../src/authoring/status-cache";
import { editorHref } from "../src/authoring/address";

beforeEach(() => {
  status.mockReset();
  forgetAuthoringStatus();
});
afterEach(cleanup);

const authorized = () =>
  status.mockResolvedValue({
    authorized: true,
    edit: { enabled: true },
    storeId: "s",
    generation: "g",
    drafts: [],
    operations: [],
  });
async function opened() {
  authorized();
  render(<NewMenu projectSlug="pageturner-a1234567" projectName="Pageturner" />);
  const button = await screen.findByRole("button", { name: "New" });
  fireEvent.click(button);
  return { button, menu: screen.getByRole("menu") };
}

it("renders nothing while the first status answer is on its way", async () => {
  status.mockReturnValue(new Promise(() => undefined));
  const { container } = render(<NewMenu projectSlug="pageturner-a1234567" projectName="Pageturner" />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(status).toHaveBeenCalled();
  expect(container).toBeEmptyDOMElement();
});

it("when the status cannot be read, New stays, says so and tries again; never the menu until a grant answers (D6)", async () => {
  status.mockRejectedValue(new Error("offline"));
  render(<NewMenu projectSlug="pageturner-a1234567" projectName="Pageturner" />);
  const button = await screen.findByRole("button", { name: "New" });
  expect(button).toHaveAttribute("aria-haspopup", "dialog");
  fireEvent.click(button);
  const dialog = screen.getByRole("dialog", { name: "Editing is unavailable right now" });
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Still unavailable"));
  expect(dialog).toBeInTheDocument();
  authorized();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  const menuButton = await screen.findByRole("button", { name: "New", expanded: false });
  await waitFor(() => expect(menuButton).toHaveAttribute("aria-haspopup", "menu"));
  expect(menuButton).toHaveFocus();
});

it("opened without a sign-in link, New stays visible and opens how to get a sign-in link, not the menu (D6)", async () => {
  status.mockResolvedValue({ authorized: false });
  render(<NewMenu projectSlug="pageturner-a1234567" projectName="Pageturner" />);
  const button = await screen.findByRole("button", { name: "New" });
  expect(button).toHaveAttribute("aria-haspopup", "dialog");
  fireEvent.click(button);
  const dialog = screen.getByRole("dialog", { name: "Editing needs a sign-in link" });
  expect(dialog).toHaveTextContent("can read and comment but not edit");
  expect(dialog).toHaveTextContent("Please give me a new Archer link for Pageturner.");
  expect(screen.queryByRole("menu")).toBeNull();
  await waitFor(() => expect(screen.getByRole("button", { name: "Copy request" })).toHaveFocus());
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(button).toHaveFocus();
});

it("without the Clipboard API (plain HTTP), Copy request selects the sentence and copies the selection", async () => {
  status.mockResolvedValue({ authorized: false });
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  const exec = vi.fn(() => true);
  (document as { execCommand?: unknown }).execCommand = exec;
  try {
    render(<NewMenu projectSlug="pageturner-a1234567" projectName="Pageturner" />);
    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy request" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Copied"));
    expect(exec).toHaveBeenCalledWith("copy");
    expect(window.getSelection()?.toString()).toBe("Please give me a new Archer link for Pageturner.");
  } finally {
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else delete (navigator as { clipboard?: unknown }).clipboard;
    delete (document as { execCommand?: unknown }).execCommand;
  }
});

it("opens a menu with a Diagram link and the save footnote; nothing that doesn't exist yet (ux:F17)", async () => {
  const { button, menu } = await opened();
  expect(button).toHaveAttribute("aria-haspopup", "menu");
  expect(button).toHaveAttribute("aria-expanded", "true");
  const items = screen.getAllByRole("menuitem");
  expect(items).toHaveLength(1);
  const diagram = screen.getByRole("menuitem", { name: "Diagram" });
  expect(diagram.tagName).toBe("A");
  expect(diagram).toHaveAttribute("href", editorHref("pageturner-a1234567", null)!);
  expect(diagram).toHaveAccessibleDescription("A new .mmd file in diagrams/. Pick flowchart, sequence, C4 and more.");
  expect(screen.queryByRole("menuitem", { name: "Note" })).toBeNull();
  expect(menu).toHaveAccessibleDescription("Nothing is written to the repository until you Save.");
  await waitFor(() => expect(diagram).toHaveFocus());
});

it("the arrow keys, Home and End keep focus on the menu's items", async () => {
  await opened();
  const diagram = screen.getByRole("menuitem", { name: "Diagram" });
  await waitFor(() => expect(diagram).toHaveFocus());
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) {
    fireEvent.keyDown(diagram, { key });
    expect(diagram).toHaveFocus();
  }
});

it("closes on Escape and returns focus to the button", async () => {
  const { button } = await opened();
  const diagram = screen.getByRole("menuitem", { name: "Diagram" });
  await waitFor(() => expect(diagram).toHaveFocus());
  fireEvent.keyDown(diagram, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(button).toHaveAttribute("aria-expanded", "false");
  expect(button).toHaveFocus();
});

it("closes on a click outside", async () => {
  const { button } = await opened();
  expect(screen.getByRole("menu")).toBeInTheDocument();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("menu")).toBeNull();
  expect(button).toHaveAttribute("aria-expanded", "false");
});

it("opens from the keyboard on ArrowDown", async () => {
  authorized();
  render(<NewMenu projectSlug="pageturner-a1234567" projectName="Pageturner" />);
  const button = await screen.findByRole("button", { name: "New" });
  fireEvent.keyDown(button, { key: "ArrowDown" });
  await waitFor(() => expect(screen.getByRole("menuitem", { name: "Diagram" })).toHaveFocus());
});

it.each([
  ["project", "edit = false in this project's archer.toml", "This project's archer.toml sets edit = false"],
  ["global", "edit = false in your account's archer.toml", "Your account's archer.toml sets edit = false"],
  ["account", "a [[projects]] rule in your Archer configuration", "turns off diagram and note writes for this project"],
] as const)(
  "with editing off (%s), New is greyed out with a tooltip naming the setting, and says where",
  async (reason, tip, where) => {
    status.mockResolvedValue({
      authorized: true,
      storeId: "s",
      generation: "g",
      drafts: [],
      operations: [],
      edit: { enabled: false, reason },
    });
    render(<NewMenu projectSlug="pageturner-a1234567" projectName="Pageturner" />);
    const button = await screen.findByRole("button", { name: "New" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAttribute("title", `Editing is off: ${tip}`);
    fireEvent.click(button);
    expect(screen.getByRole("dialog", { name: "Editing is turned off" })).toHaveTextContent(where);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  },
);

it.each([
  ["authorized", () => authorized()],
  ["unauthorized", () => status.mockResolvedValue({ authorized: false })],
])(
  "on a phone (%s), where the editor is read-only, says editing is on desktop instead of New (G5, D6)",
  async (_name, arrange) => {
    const { installViewport } = await import("./match-media");
    installViewport({ width: 390, coarse: true });
    try {
      arrange();
      render(<NewMenu projectSlug="pageturner-a1234567" projectName="Pageturner" />);
      expect(await screen.findByText("Editing is on desktop")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "New" })).toBeNull();
    } finally {
      delete (window as { matchMedia?: unknown }).matchMedia;
    }
  },
);
