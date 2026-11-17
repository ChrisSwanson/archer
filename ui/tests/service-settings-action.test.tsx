// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ServiceSettingsAction } from "../src/app/ServiceSettingsAction";
import { discoverServiceSettings } from "../src/app/service-settings";
vi.mock("../src/app/service-settings", () => ({ discoverServiceSettings: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it("exposes Settings after service discovery without project bootstrap", async () => {
  vi.mocked(discoverServiceSettings).mockResolvedValue({ kind: "supported" });
  render(<ServiceSettingsAction />);
  expect(await screen.findByRole("button", { name: "Archer settings" })).toBeVisible();
});
it("shows a retry after transient discovery failure and recovers", async () => {
  vi.mocked(discoverServiceSettings)
    .mockResolvedValueOnce({ kind: "unavailable" })
    .mockResolvedValueOnce({ kind: "supported" });
  render(<ServiceSettingsAction />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry settings discovery" }));
  expect(await screen.findByRole("button", { name: "Archer settings" })).toBeVisible();
});
it("cancels retired discovery and never revives an unmounted action", async () => {
  let finish!: (value: { kind: "supported" }) => void;
  vi.mocked(discoverServiceSettings).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { unmount } = render(<ServiceSettingsAction />);
  const signal = vi.mocked(discoverServiceSettings).mock.calls[0]![1]!;
  expect(screen.getByRole("button", { name: "Checking settings" })).toBeDisabled();
  unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => finish({ kind: "supported" }));
  expect(screen.queryByRole("button")).toBeNull();
});
it("keeps incompatible settings retryable without exposing the editing dialog", async () => {
  vi.mocked(discoverServiceSettings).mockResolvedValue({ kind: "incompatible" });
  render(<ServiceSettingsAction />);
  expect(await screen.findByRole("button", { name: "Retry settings discovery" })).toHaveAttribute(
    "title",
    expect.stringContaining("compatible server"),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});
