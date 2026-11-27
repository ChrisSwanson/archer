// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ArcherSettings, { parseSettings } from "../src/app/ArcherSettings";
import { observeNetworkAccess } from "../src/app/network-access";

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  observeNetworkAccess(undefined);
  globalThis.fetch = originalFetch;
  document.body.removeAttribute("inert");
});

const SNAPSHOT = {
  serviceName: "Archer on studio",
  commentSubmission: "immediate",
  configRevision: "rev-7",
  configPath: "/Users/alex/.config/archer/archer.toml",
  writable: false,
  settings: [
    { key: "host", value: "0.0.0.0", default: "127.0.0.1", source: "user" },
    { key: "port", value: null, default: null, source: "builtin" },
    { key: "commentSubmission", value: "queued", default: "immediate", source: "user" },
    { key: "tlsKey", value: "set", default: null, source: "env" },
    { key: "autoStart", value: true, default: true, source: "builtin" },
  ],
};

describe("Archer settings", () => {
  it("shows every service setting read-only, with its value, default and where it is set, and never saves", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(SNAPSHOT), { status: 200, headers: { "content-type": "application/json" } }),
      );
    globalThis.fetch = fetch;

    render(
      <main>
        <ArcherSettings />
      </main>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Archer settings" }));

    expect(await screen.findByText("Archer on studio")).toBeInTheDocument();
    expect(screen.getByText("/Users/alex/.config/archer/archer.toml")).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Service settings" });
    const host = within(list).getByRole("listitem", { name: "Listen address" });
    expect(host).toHaveTextContent("0.0.0.0");
    expect(host).toHaveTextContent("Default: 127.0.0.1");
    expect(host).toHaveTextContent("Set in your archer.toml");
    expect(within(list).getByRole("listitem", { name: "Port" })).toHaveTextContent("Chosen when the service starts");
    expect(within(list).getByRole("listitem", { name: "Comment submission" })).toHaveTextContent("Send each comment");
    expect(within(list).getByRole("listitem", { name: "TLS key" })).toHaveTextContent("Set (hidden)");
    expect(within(list).getByRole("listitem", { name: "Start on demand" })).toHaveTextContent("Default");
    expect(list).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("button", { name: "Save settings" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByText(/read-only here/)).toBeInTheDocument();
    // One close control, in the header (the dialog convention); the footer's duplicate is gone (round 1, C-16).
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("api/settings", { cache: "no-store", signal: expect.any(AbortSignal) });
  });

  it("reads an older service's snapshot that lists no settings", () => {
    const { settings: _ignored, writable: _alsoIgnored, ...older } = SNAPSHOT;
    expect(parseSettings(older)).toMatchObject({ commentSubmission: "immediate", settings: [] });
  });

  it("drops unknown keys and malformed rows instead of showing them", () => {
    const parsed = parseSettings({
      ...SNAPSHOT,
      settings: [
        ...SNAPSHOT.settings,
        { key: "secretToken", value: "x", default: null, source: "user" },
        { key: "host" },
      ],
    });
    expect(parsed.settings.map((row) => row.key)).toEqual(["host", "port", "commentSubmission", "tlsKey", "autoStart"]);
  });

  it("says where Archer is open to the network, since when and how to turn it off; the page changes nothing", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(SNAPSHOT), { status: 200, headers: { "content-type": "application/json" } }),
      );
    globalThis.fetch = fetch;
    act(() => observeNetworkAccess({ address: "https://192.168.1.42:40399/", since: "2026-10-22T10:00:00Z" }));
    render(
      <main>
        <ArcherSettings />
      </main>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Archer settings" }));
    const network = await screen.findByRole("region", { name: "Network Access" });
    expect(network).toHaveTextContent("Open to your network at 192.168.1.42:40399");
    expect(network).toHaveTextContent(new Date("2026-10-22T10:00:00Z").toLocaleString());
    expect(network).toHaveTextContent("To turn it off, ask your agent, or run archer network-access off");
    expect(within(network).queryByRole("button")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("claims nothing about the network until the service has answered (finding 6)", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(SNAPSHOT), { status: 200, headers: { "content-type": "application/json" } }),
      );
    render(
      <main>
        <ArcherSettings />
      </main>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Archer settings" }));
    const network = await screen.findByRole("region", { name: "Network Access" });
    expect(network).not.toHaveTextContent("Not open to your network");
    expect(network).not.toHaveTextContent("Open to your network at");
    expect(network).toHaveTextContent("Not known yet");
  });

  it("says Archer is not open to the network when it is not, and follows a change while open", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(SNAPSHOT), { status: 200, headers: { "content-type": "application/json" } }),
      );
    act(() => observeNetworkAccess(null));
    render(
      <main>
        <ArcherSettings />
      </main>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Archer settings" }));
    const network = await screen.findByRole("region", { name: "Network Access" });
    expect(network).toHaveTextContent("Not open to your network");
    act(() => observeNetworkAccess({ address: "https://10.0.0.5:40399/", since: "2026-10-22T10:00:00Z" }));
    expect(network).toHaveTextContent("Open to your network at 10.0.0.5:40399");
  });

  it("keeps the live Network Access region mounted while retrying the settings request", async () => {
    let finishRetry!: (response: Response) => void;
    const retry = new Promise<Response>((resolve) => {
      finishRetry = resolve;
    });
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error("Settings unavailable")).mockReturnValueOnce(retry);
    act(() => observeNetworkAccess(null));
    render(<ArcherSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Archer settings" }));
    const tryAgain = await screen.findByRole("button", { name: "Try again" });
    const network = screen.getByRole("region", { name: "Network Access" });

    fireEvent.click(tryAgain);
    expect(screen.getByRole("status")).toHaveTextContent("Loading settings");
    expect(network).toBeInTheDocument();
    act(() => observeNetworkAccess({ address: "https://10.0.0.5:40399/", since: "2026-10-22T10:00:00Z" }));
    expect(network).toHaveTextContent("Open to your network at 10.0.0.5:40399");
    finishRetry(new Response(JSON.stringify(SNAPSHOT), { status: 200 }));
    expect(await screen.findByText("Archer on studio")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Network Access" })).toBe(network);
  });

  it("renders no launcher when the service does not support settings", () => {
    render(<ArcherSettings supported={false} />);
    expect(screen.queryByRole("button", { name: "Archer settings" })).not.toBeInTheDocument();
  });
});
