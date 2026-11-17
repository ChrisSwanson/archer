// @vitest-environment jsdom
import { setGroupNumbersPreference } from "../src/emphasis/group-numbers";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ExportControls } from "../src/export/ExportControls";
import { PageOperationError } from "../src/accuracy/client";
import { Staleness, readStaleView } from "../src/accuracy/Staleness";
import { readArtifact } from "../src/export/download";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const props = {
  viewId: "flow",
  revision: "sha256:valid",
  annotation: "Caption",
  activeEmphasisId: "focus",
  theme: "light" as const,
  onClose: () => {},
};
test("last-good requires explicit consent and a second user download action, never a retry", async () => {
  const call = vi.fn(async (_name: string, _args: Readonly<Record<string, unknown>>) => {
    throw new PageOperationError("export_last_good_requires_opt_in", "backend text is arbitrary");
  });
  render(<ExportControls {...props} callOperation={call} />);
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  await screen.findByLabelText("I choose the last-good drawing");
  expect(call).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Download" })).toBeDisabled();
  fireEvent.click(screen.getByLabelText("I choose the last-good drawing"));
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
  expect(call.mock.calls[0]![1]).toMatchObject({
    allowLastGood: false,
    expectedRevision: props.revision,
    activeEmphasisId: null,
  });
  expect(call.mock.calls[1]![1]).toMatchObject({ allowLastGood: true });
});
test("presentation request carries exact visible emphasis including explicit local dismissal", async () => {
  const call = vi.fn(async (_name: string, _args: Readonly<Record<string, unknown>>) => {
    throw new Error("test refusal");
  });
  const view = render(<ExportControls {...props} callOperation={call} />);
  fireEvent.change(screen.getByLabelText("Content"), { target: { value: "presentation" } });
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  await screen.findByRole("alert");
  expect(call.mock.calls[0]![1]).toMatchObject({
    activeEmphasisId: "focus",
    annotation: "Caption",
    diagramKey: true,
    expectedRevision: props.revision,
  });
  view.rerender(<ExportControls {...props} activeEmphasisId={null} callOperation={call} />);
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
  expect(call.mock.calls[1]![1]).toMatchObject({ activeEmphasisId: null });
});
test("accuracy checks only the requested view after explicit action", async () => {
  const call = vi.fn(async () => ({
    status: "available",
    views: [{ viewId: "flow", status: "not-covered", covers: [], baselineCommit: null, changedPaths: [] }],
  }));
  render(<Staleness viewId="flow" callOperation={call} onClose={() => {}} />);
  expect(call).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Check covered files" }));
  await screen.findByText("No code paths are declared for this diagram.");
  expect(call).toHaveBeenCalledExactlyOnceWith("list_stale_diagrams", { viewId: "flow" });
});
test("artifact bytes and current revision are validated before downloading", () => {
  const value = {
    encoding: "base64",
    mimeType: "image/svg+xml",
    width: 100,
    height: 100,
    revision: "rev",
    lastGood: false,
    data: btoa("<svg/>"),
  };
  expect(readArtifact(value, "svg", "rev")).toMatchObject({ width: 100 });
  expect(() => readArtifact(value, "svg", "changed")).toThrow(/invalid/);
  expect(() => readArtifact({ ...value, data: "!" }, "svg", "rev")).toThrow(/bytes/);
});
test("stale status must be a literal string rather than a coercible value", () => {
  expect(() =>
    readStaleView(
      {
        status: "available",
        views: [{ viewId: "flow", status: ["stale"], covers: [], baselineCommit: null, changedPaths: [] }],
      },
      "flow",
    ),
  ).toThrow(/valid accuracy/);
});
test.each([
  ["current", "Covered files match the last diagram commit."],
  ["stale", "Covered files changed since the last diagram commit."],
  ["not-covered", "No code paths are declared for this diagram."],
  ["never-reviewed", "This diagram has no committed baseline yet."],
  ["unavailable", "Git accuracy is unavailable for this diagram."],
])("accuracy exposes honest %s status", async (status, copy) => {
  const call = vi.fn(async () => ({
    status: status === "unavailable" ? "unavailable" : "available",
    views: [{ viewId: "flow", status, covers: [], baselineCommit: null, changedPaths: [] }],
  }));
  render(<Staleness viewId="flow" callOperation={call} onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Check covered files" }));
  await screen.findByText(copy);
});
test("numbering the highlight groups is a presentation choice, off unless the reader's default turns it on", async () => {
  const call = vi.fn(async (_name: string, _args: Readonly<Record<string, unknown>>) => {
    throw new Error("test refusal");
  });
  const view = render(<ExportControls {...props} callOperation={call} />);
  expect(screen.queryByLabelText("Number the highlight groups")).toBeNull();
  fireEvent.change(screen.getByLabelText("Content"), { target: { value: "presentation" } });
  const box = screen.getByLabelText("Number the highlight groups") as HTMLInputElement;
  expect(box.checked).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  await screen.findByRole("alert");
  expect(call.mock.calls[0]![1]).toMatchObject({ accessible: false });
  fireEvent.click(box);
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
  expect(call.mock.calls[1]![1]).toMatchObject({ accessible: true });
  // No emphasis to number: no choice, and none sent.
  view.rerender(<ExportControls {...props} activeEmphasisId={null} callOperation={call} />);
  expect(screen.queryByLabelText("Number the highlight groups")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  await waitFor(() => expect(call).toHaveBeenCalledTimes(3));
  expect(call.mock.calls[2]![1]).toMatchObject({ accessible: false });
  view.unmount();
});
test("the export's numbering starts as the reader's Group numbers setting", () => {
  setGroupNumbersPreference("on");
  try {
    render(<ExportControls {...props} callOperation={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Content"), { target: { value: "presentation" } });
    expect((screen.getByLabelText("Number the highlight groups") as HTMLInputElement).checked).toBe(true);
  } finally {
    setGroupNumbersPreference("auto");
  }
});
