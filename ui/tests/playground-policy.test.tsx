// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const holder = vi.hoisted(() => ({ static: true }));
vi.mock("../src/app/runtime", async (original) => {
  const live = ((await original()) as typeof import("../src/app/runtime")).runtime;
  const local = (await import("../src/playground/runtime")).createStaticRuntime();
  return {
    get runtime() {
      return holder.static ? local : live;
    },
  };
});
import { Composer } from "../src/comments/Composer";
afterEach(cleanup);
const composer = () =>
  render(
    <Composer
      requestKey={1}
      anchor={{ kind: "view" }}
      choices={[]}
      anchorLabel="Diagram"
      onSave={async () => true}
      onCancel={() => {}}
    />,
  );
it("calls the local commit Save comment in the real composer", () => {
  holder.static = true;
  composer();
  expect(screen.getByRole("button", { name: "Save comment" })).toBeDisabled();
  expect(screen.getByText(/Use Save comment or Ctrl\/Command Enter/)).toBeInTheDocument();
  expect(screen.queryByText(/send to agent/i)).toBeNull();
});
it("calls the live commit Add comment in the real composer", () => {
  holder.static = false;
  composer();
  expect(screen.getByRole("button", { name: "Add comment" })).toBeDisabled();
  expect(screen.getByText(/Use Add comment or Ctrl\/Command Enter/)).toBeInTheDocument();
});
