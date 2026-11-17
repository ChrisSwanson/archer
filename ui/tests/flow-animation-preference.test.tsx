// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  prefersReducedMotion,
  useBrowserReducedMotion,
  useFlowAnimationPreference,
  useReducedMotion,
} from "../src/emphasis/reduced-motion";

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute("data-flow-animation");
  document.documentElement.removeAttribute("data-flow-animation-volatile");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function motionQuery(initial: boolean) {
  let matches = initial;
  const events = new EventTarget();
  const query = {
    get matches() {
      return matches;
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  };
  vi.stubGlobal("matchMedia", () => query);
  return (next: boolean) =>
    act(() => {
      matches = next;
      events.dispatchEvent(new Event("change"));
    });
}

function Consumer({ name = "consumer" }: { name?: string }) {
  const { preference, setPreference } = useFlowAnimationPreference();
  const reduced = useReducedMotion();
  return (
    <div>
      <output aria-label={name}>
        {preference}:{reduced ? "static" : "moving"}
      </output>
      <button type="button" onClick={() => setPreference("on")}>
        {name} On
      </button>
      <button type="button" onClick={() => setPreference("off")}>
        {name} Off
      </button>
      <button type="button" onClick={() => setPreference("auto")}>
        {name} Auto
      </button>
    </div>
  );
}

it.each([
  ["auto", true, "static"],
  ["auto", false, "moving"],
  ["on", true, "moving"],
  ["on", false, "moving"],
  ["off", true, "static"],
  ["off", false, "static"],
  ["invalid", true, "moving"],
] as const)("resolves persisted %s with browser reduced=%s to %s", (stored, browser, result) => {
  localStorage.setItem("archer.flow-animation", stored);
  motionQuery(browser);
  render(<Consumer />);
  expect(screen.getByRole("status")).toHaveTextContent(`${stored === "invalid" ? "on" : stored}:${result}`);
  expect(prefersReducedMotion()).toBe(browser);
});

it("defaults to On with nothing stored, so the flow moves even when the browser asks for less motion", () => {
  motionQuery(true);
  render(<Consumer />);
  expect(screen.getByRole("status")).toHaveTextContent("on:moving");
});

it.each(["on", "off", "auto", null] as const)(
  "motion that is not emphasis follows the browser alone, whatever Flow animation says (%s)",
  (stored) => {
    if (stored !== null) localStorage.setItem("archer.flow-animation", stored);
    const change = motionQuery(true);
    function Camera() {
      return <output aria-label="camera">{useBrowserReducedMotion() ? "jumps" : "glides"}</output>;
    }
    render(<Camera />);
    expect(screen.getByRole("status")).toHaveTextContent("jumps");
    change(false);
    expect(screen.getByRole("status")).toHaveTextContent("glides");
  },
);

it("shares a choice across mounted consumers, persists it and restores it on a new document", async () => {
  motionQuery(true);
  render(
    <>
      <Consumer name="graph" />
      <Consumer name="sequence" />
      <Consumer name="legend" />
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: "legend On" }));
  await waitFor(() => {
    for (const output of screen.getAllByRole("status")) expect(output).toHaveTextContent("on:moving");
  });
  expect(localStorage.getItem("archer.flow-animation")).toBe("on");
  cleanup();
  document.documentElement.removeAttribute("data-flow-animation");
  render(<Consumer />);
  expect(screen.getByRole("status")).toHaveTextContent("on:moving");
});

it.each(["off", null] as const)(
  "reconciles a cross-tab %s change made while every consumer is unmounted",
  async (next) => {
    motionQuery(true);
    render(<Consumer />);
    fireEvent.click(screen.getByRole("button", { name: "consumer On" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("on:moving"));
    cleanup();
    if (next === null) localStorage.removeItem("archer.flow-animation");
    else localStorage.setItem("archer.flow-animation", next);
    window.dispatchEvent(
      new StorageEvent("storage", { key: "archer.flow-animation", newValue: next, storageArea: localStorage }),
    );
    render(<Consumer />);
    expect(screen.getByRole("status")).toHaveTextContent(next === null ? "on:moving" : "off:static");
  },
);

it("honors dynamic OS changes in Auto and current OS state when returning to Auto", async () => {
  localStorage.setItem("archer.flow-animation", "auto");
  const change = motionQuery(false);
  render(<Consumer />);
  change(true);
  expect(screen.getByRole("status")).toHaveTextContent("auto:static");
  fireEvent.click(screen.getByRole("button", { name: "consumer On" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("on:moving"));
  change(false);
  change(true);
  expect(screen.getByRole("status")).toHaveTextContent("on:moving");
  fireEvent.click(screen.getByRole("button", { name: "consumer Auto" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("auto:static"));
});

it("applies choices to every consumer even when storage reads and writes throw", async () => {
  motionQuery(true);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  render(
    <>
      <Consumer name="graph" />
      <Consumer name="legend" />
    </>,
  );
  expect(screen.getByRole("status", { name: "graph" })).toHaveTextContent("on:moving");
  fireEvent.click(screen.getByRole("button", { name: "legend Off" }));
  await waitFor(() => {
    for (const output of screen.getAllByRole("status")) expect(output).toHaveTextContent("off:static");
  });
  fireEvent.click(screen.getByRole("button", { name: "legend On" }));
  await waitFor(() => {
    for (const output of screen.getAllByRole("status")) expect(output).toHaveTextContent("on:moving");
  });
  cleanup();
  render(<Consumer />);
  expect(screen.getByRole("status")).toHaveTextContent("on:moving");
});

it("preserves an unpersisted choice across unmounts when writes are blocked but reads still work", async () => {
  motionQuery(true);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  render(<Consumer />);
  fireEvent.click(screen.getByRole("button", { name: "consumer On" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("on:moving"));
  cleanup();
  render(<Consumer />);
  expect(screen.getByRole("status")).toHaveTextContent("on:moving");
  expect(localStorage.getItem("archer.flow-animation")).toBeNull();
});

it("synchronizes cross-tab storage changes and clear while ignoring other keys and session storage", async () => {
  motionQuery(false);
  render(
    <>
      <Consumer name="graph" />
      <Consumer name="legend" />
    </>,
  );
  const stored = (key: string | null, newValue: string | null, storageArea: Storage | null = null) =>
    act(() => {
      // A real receiving tab's store already reflects the change when its event arrives.
      if (storageArea !== sessionStorage) {
        if (key === null) localStorage.clear();
        else if (newValue === null) localStorage.removeItem(key);
        else localStorage.setItem(key, newValue);
      }
      window.dispatchEvent(new StorageEvent("storage", { key, newValue, storageArea }));
    });
  stored("archer.flow-animation", "off");
  for (const output of screen.getAllByRole("status")) expect(output).toHaveTextContent("off:static");
  stored("other", "on");
  stored("archer.flow-animation", "on", sessionStorage);
  expect(screen.getByRole("status", { name: "graph" })).toHaveTextContent("off:static");
  stored("archer.flow-animation", "bad");
  for (const output of screen.getAllByRole("status")) expect(output).toHaveTextContent("on:moving");
  stored("archer.flow-animation", "off", localStorage);
  stored(null, null, localStorage);
  for (const output of screen.getAllByRole("status")) expect(output).toHaveTextContent("on:moving");
});

it("persisted On animates emphasis even when the browser requests reduced motion", () => {
  localStorage.setItem("archer.flow-animation", "on");
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  function Consumer() {
    return <output>{useReducedMotion() ? "static" : "moving"}</output>;
  }
  render(<Consumer />);
  expect(screen.getByRole("status")).toHaveTextContent("moving");
});
