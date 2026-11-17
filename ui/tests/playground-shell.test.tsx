// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
vi.hoisted(() => vi.resetModules());
// Only the provenance shell is under test here; playground-app mounts the real App.
vi.mock("../src/app/App", () => ({ App: () => null }));
import { PlaygroundShell } from "../src/playground/shell";
import { configureStaticAddress, encodeAddress, decodeAddress } from "../src/playground/address";
import { createStaticRuntime } from "../src/playground/runtime";
import { IN_APP_NAVIGATION } from "../src/app/in-app-navigation";
import { exampleSnapshot } from "./support/playground-snapshot";
let snapshot: ReturnType<typeof exampleSnapshot>;
beforeAll(() => {
  snapshot = exampleSnapshot();
}, 30000);
beforeEach(() => {
  configureStaticAddress({
    documentUrl: window.location.origin + "/playground/app/index.html",
    digest: snapshot.manifest.digest,
  });
  window.history.replaceState(null, "", encodeAddress("/projects/archer-tour/"));
});
afterEach(cleanup);
it("keeps the project picker aligned with App navigation and Back", () => {
  const runtime = createStaticRuntime({ snapshot, href: () => decodeAddress(window.location.href), storage: null });
  render(<PlaygroundShell snapshot={snapshot} runtime={runtime} />);
  expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue("archer-tour");
  act(() => {
    window.history.pushState(null, "", encodeAddress("/projects/rfc-2324-htcpcp/"));
    window.dispatchEvent(new Event(IN_APP_NAVIGATION));
  });
  expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue("rfc-2324-htcpcp");
  act(() => {
    window.history.replaceState(null, "", encodeAddress("/projects/archer-tour/"));
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue("archer-tour");
});
it("explains a direct editor route without mounting an unusable editor", () => {
  window.history.replaceState(null, "", encodeAddress("/projects/archer-tour/-/edit/"));
  const runtime = createStaticRuntime({ snapshot, href: () => decodeAddress(window.location.href), storage: null });
  render(<PlaygroundShell snapshot={snapshot} runtime={runtime} />);
  expect(screen.getByText("Source editing is unavailable in this example.")).toBeInTheDocument();
});
