// @vitest-environment jsdom
// React's error handlers with telemetry on keep React's default propagation: an uncaught render error
// still reaches the window `error` event (what test runners report as a page error) and the console,
// and is recorded once, as `ui.react-error`.
import { createRoot } from "react-dom/client";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startTelemetry } from "../src/telemetry/runtime";

const consoleErrors: unknown[][] = [];
const windowErrors: unknown[] = [];
const original = console.error;
const onError = (event: ErrorEvent) => {
  windowErrors.push(event.error);
  event.preventDefault();
};

beforeAll(() => {
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args);
  };
  window.addEventListener("error", onError);
});
afterAll(() => {
  console.error = original;
  window.removeEventListener("error", onError);
});

function Broken(): never {
  throw new Error("render failed");
}

it("an uncaught render error still reaches window error; telemetry records it once", async () => {
  const { rootOptions } = startTelemetry();
  window.__archerTelemetry!.clear();
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container, rootOptions);
  root.render(<Broken />);
  // Outside act(), as in the page: React hands the error to the root's handler.
  for (let i = 0; i < 50 && windowErrors.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(windowErrors.map((error) => (error as Error).message)).toEqual(["render failed"]);
  const codes = window.__archerTelemetry!.events().map((event) => event.code);
  expect(codes.filter((code) => code === "ui.react-error")).toHaveLength(1);
  expect(codes).not.toContain("ui.page-error");
  root.unmount();
});

it("uses reportError when the browser has it, and the console for caught errors", () => {
  const { rootOptions } = startTelemetry();
  const reported: unknown[] = [];
  (window as { reportError?: (error: unknown) => void }).reportError = (error) => reported.push(error);
  try {
    const uncaught = new Error("uncaught"),
      recoverable = new Error("recoverable"),
      caught = new Error("caught");
    rootOptions.onUncaughtError!(uncaught, { componentStack: "" });
    rootOptions.onRecoverableError!(recoverable, { componentStack: "" });
    consoleErrors.length = 0;
    rootOptions.onCaughtError!(caught, { componentStack: "", errorBoundary: undefined } as never);
    expect(reported).toEqual([uncaught, recoverable]);
    expect(consoleErrors).toEqual([[caught]]);
  } finally {
    delete (window as { reportError?: unknown }).reportError;
  }
});
