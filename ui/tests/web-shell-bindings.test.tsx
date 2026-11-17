// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRef } from "react";
import { act } from "@testing-library/react";
import { WebShell, WORKSPACE_ACTIONS, type WebShellContext } from "../src/app/WebShell";
import { observeNetworkAccess } from "../src/app/network-access";

const navigation = {
  workspace: "Archer",
  currentSlug: null,
  place: null,
  searchOpen: false,
  recents: [],
  onContents: vi.fn(),
  onSearch: vi.fn(),
  onOpenProject: vi.fn(),
  onOpenRecent: vi.fn(),
};
const help = { controller: { open: false, hide: vi.fn(), toggle: vi.fn() }, view: "none" as const };
afterEach(() => {
  cleanup();
  observeNetworkAccess(undefined);
});
it("replaces transitional omissions with required workspace actions", () => {
  expect(WORKSPACE_ACTIONS).toEqual({ notifications: { kind: "workspace" }, settings: { kind: "discover" } });
});
for (const context of [
  { kind: "service", actions: WORKSPACE_ACTIONS },
  { kind: "source", slug: "demo", path: "docs/ref.md", annotation: "read-only", actions: WORKSPACE_ACTIONS },
  {
    kind: "project",
    slug: "demo",
    actions: {
      notifications: { kind: "unsupported", reason: "comments-capability-absent" },
      settings: { kind: "instance", supported: false },
    },
  },
] satisfies WebShellContext[]) {
  it(`renders one frame and shared Help/theme actions for ${context.kind}`, () => {
    const { container } = render(
      <WebShell context={context} navigation={navigation} identity={{ title: "Page" }} help={help}>
        Content
      </WebShell>,
    );
    expect(container.querySelectorAll(".primary-document-bar")).toHaveLength(1);
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Keyboard shortcuts" })).toBeVisible();
    expect(container.querySelector(".primary-document-actions button")).not.toBeNull();
    expect(container.querySelector("[data-notifications-binding]")).toHaveAttribute(
      "data-notifications-binding",
      context.actions.notifications.kind,
    );
    if (context.kind === "source") expect(screen.getByText("Read-only")).toBeVisible();
    else expect(screen.queryByText("Read-only")).toBeNull();
    if (context.kind === "project") expect(screen.queryByRole("button", { name: /^Notifications/ })).toBeNull();
    else expect(screen.getByRole("button", { name: "Notifications" })).toBeVisible();
  });
}
it("keeps the network-access status out of the header: it lives in Archer's settings (ticket 11)", () => {
  render(
    <WebShell
      context={{ kind: "service", actions: WORKSPACE_ACTIONS }}
      navigation={navigation}
      identity={{ title: "Page" }}
      help={help}
    >
      Content
    </WebShell>,
  );
  act(() => observeNetworkAccess({ address: "https://192.168.1.42:40399/", since: "2026-10-22T10:00:00Z" }));
  expect(screen.queryByText(/Open to your network/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Turn off" })).toBeNull();
  expect(screen.queryByText("On network")).toBeNull();
});

it("shows a badge beside the title, outside the h1's name", () => {
  render(
    <WebShell
      context={{ kind: "service", actions: WORKSPACE_ACTIONS }}
      navigation={navigation}
      identity={{ title: "Checkout", badge: <span>Editing</span> }}
      help={help}
    >
      Content
    </WebShell>,
  );
  const title = screen.getByRole("heading", { level: 1, name: "Checkout" });
  expect(title.nextElementSibling).toHaveTextContent("Editing");
  expect(title.parentElement).toHaveClass("primary-document-heading");
});

it("keeps the page's one h1: the shell shows only its trail where the content holds the heading", () => {
  const context: WebShellContext = { kind: "service", actions: WORKSPACE_ACTIONS };
  const { rerender, container } = render(
    <WebShell context={context} navigation={navigation} identity={{ title: "Shop" }} help={help}>
      Content
    </WebShell>,
  );
  expect(screen.getByRole("heading", { level: 1, name: "Shop" })).toBeVisible();
  rerender(
    <WebShell context={context} navigation={navigation} identity={{ title: "Shop", heading: "content" }} help={help}>
      <h1>Shop</h1>
    </WebShell>,
  );
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(screen.getByRole("main")).toContainElement(screen.getByRole("heading", { level: 1 }));
  expect(container.querySelector(".primary-document-identity .primary-document-title")).toBeNull();
});

it("forwards measured header and notification-launcher refs through the shared frame", () => {
  const header = createRef<HTMLElement>(),
    launcher = createRef<HTMLButtonElement>();
  const toggle = vi.fn();
  const context: WebShellContext = {
    kind: "project",
    slug: "demo",
    actions: {
      settings: { kind: "instance", supported: false },
      notifications: {
        kind: "project-review",
        toggle: {
          label: "Notifications",
          unreadAnswers: 1,
          pending: 0,
          open: false,
          controls: "review",
          onToggle: toggle,
          ref: launcher,
        },
      },
    },
  };
  render(
    <WebShell
      context={context}
      navigation={navigation}
      identity={{ title: "Page" }}
      help={help}
      documentBarRef={header}
    >
      Content
    </WebShell>,
  );
  expect(header.current).toHaveClass("primary-document-bar");
  expect(launcher.current).toBe(screen.getByRole("button", { name: "Notifications, 1 unread agent answer" }));
  launcher.current!.click();
  expect(toggle).toHaveBeenCalledOnce();
});

// Compile-time contract tripwires: a missing action cannot silently become optional.
function actionTypeContract(): void {
  // @ts-expect-error source actions are required
  const missing: WebShellContext = { kind: "source", slug: "demo", path: "ref.md", annotation: "read-only" };
  // @ts-expect-error project bindings cannot use service workspace scope
  const project: WebShellContext = { kind: "project", slug: "demo", actions: WORKSPACE_ACTIONS };
  void missing;
  void project;
}
void actionTypeContract;

it("installs common keyboard behavior through the shell without page-owned wiring", () => {
  const toggle = vi.fn(),
    search = vi.fn();
  render(
    <WebShell
      context={{ kind: "service", actions: WORKSPACE_ACTIONS }}
      navigation={{ ...navigation, onSearch: search }}
      identity={{ title: "Page" }}
      help={{ controller: { open: false, toggle, hide: vi.fn() }, view: "none" }}
    >
      Content
    </WebShell>,
  );
  fireEvent.keyDown(window, { key: "?" });
  expect(toggle).toHaveBeenCalledOnce();
  fireEvent.keyDown(window, { key: "/" });
  expect(search).toHaveBeenCalledOnce();
});

it("returns focus to the phone Menu button when Escape closes its drawer", () => {
  const { container } = render(
    <WebShell
      context={{ kind: "service", actions: WORKSPACE_ACTIONS }}
      navigation={navigation}
      identity={{ title: "Page" }}
      help={help}
    >
      Content
    </WebShell>,
  );
  const menu = screen.getByRole("button", { name: "Menu" });
  fireEvent.click(menu);
  const contents = screen.getByRole("button", { name: "Archer contents" });
  contents.focus();
  expect(contents).toHaveFocus();
  fireEvent.keyDown(contents, { key: "Escape" });
  expect(menu).toHaveFocus();

  fireEvent.click(menu);
  const outside = screen.getByRole("button", { name: "Notifications" });
  outside.focus();
  fireEvent.click(container.querySelector(".primary-scrim")!);
  expect(outside).toHaveFocus();
});

it("restores Notifications on the service and source shell", () => {
  const { rerender } = render(
    <WebShell
      context={{ kind: "service", actions: WORKSPACE_ACTIONS }}
      navigation={navigation}
      identity={{ title: "Projects" }}
      help={help}
    >
      Content
    </WebShell>,
  );
  expect(screen.getByRole("button", { name: "Notifications" })).toBeVisible();
  rerender(
    <WebShell
      context={{
        kind: "source",
        slug: "demo",
        path: "docs/ref.md",
        annotation: "read-only",
        actions: WORKSPACE_ACTIONS,
      }}
      navigation={navigation}
      identity={{ title: "Reference" }}
      help={help}
    >
      Content
    </WebShell>,
  );
  expect(screen.getByRole("button", { name: "Notifications" })).toBeVisible();
  expect(screen.getByText("Read-only")).toBeVisible();
});
