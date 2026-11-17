// @vitest-environment jsdom
// ADR 0028: with editing off, the reading page's Edit entry is absent, not disabled; D6: without a grant it explains.
import { cleanup, render } from "@testing-library/react";
import type { JSX } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const status = vi.fn();
vi.mock("../src/authoring/client", () => ({ authoringClient: () => ({ status }) }));
import { AuthoringEntry, useAuthoringAllowed } from "../src/authoring/AuthoringEntry";
import { forgetAuthoringStatus } from "../src/authoring/status-cache";

beforeEach(() => {
  status.mockReset();
  forgetAuthoringStatus();
});
afterEach(cleanup);

function Probe(): JSX.Element {
  return <span>{useAuthoringAllowed("p") ? "yes" : "no"}</span>;
}

it("with editing off, Edit is greyed out, names the setting and never opens the editor", async () => {
  status.mockResolvedValue({
    authorized: true,
    storeId: "s",
    generation: "g",
    drafts: [],
    operations: [],
    edit: { enabled: false, reason: "project" },
  });
  const onEdit = vi.fn();
  const { container, findByRole, getByRole } = render(
    <>
      <AuthoringEntry projectSlug="p" onEdit={onEdit} />
      <Probe />
    </>,
  );
  const edit = await findByRole("button", { name: "Edit" });
  expect(edit).toHaveAttribute("aria-disabled", "true");
  expect(edit).toHaveAttribute("data-off");
  expect(edit).toHaveAttribute("title", "Editing is off: edit = false in this project's archer.toml");
  const { fireEvent } = await import("@testing-library/react");
  fireEvent.click(edit);
  expect(getByRole("dialog", { name: "Editing is turned off" })).toHaveTextContent(
    "Your agent can still change diagrams.",
  );
  expect(onEdit).not.toHaveBeenCalled();
  expect(container).toHaveTextContent("no");
});

it("a page opened without a sign-in link gets an Edit that explains how to get one, never the editor (D6)", async () => {
  status.mockResolvedValue({ authorized: false });
  const onEdit = vi.fn();
  const { findByRole, getByRole } = render(<AuthoringEntry projectSlug="p" projectName="Bookshop" onEdit={onEdit} />);
  const { fireEvent } = await import("@testing-library/react");
  fireEvent.click(await findByRole("button", { name: "Edit" }));
  expect(getByRole("dialog", { name: "Editing needs a sign-in link" })).toHaveTextContent(
    "Please give me a new Archer link for Bookshop.",
  );
  expect(onEdit).not.toHaveBeenCalled();
});
