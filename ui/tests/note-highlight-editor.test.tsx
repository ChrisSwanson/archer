// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NoteHighlightEditor } from "../src/comments/NoteHighlightEditor";

afterEach(cleanup);

it("assigns a selection to an existing agent-provided label without presenting the agent set as editable", async () => {
  const onSave = vi.fn(async () => ({ ok: true as const }));
  const rendered = render(
    <NoteHighlightEditor
      groups={[
        {
          key: "reader-highlights:evidence",
          id: "evidence",
          label: "Needs evidence",
          author: "person",
          setTitle: "Reader highlights",
        },
        {
          key: "design-review:boundary",
          id: "boundary",
          label: "Trust boundary",
          author: "agent",
          setTitle: "Design review",
        },
      ]}
      onSave={onSave}
      onCancel={() => {}}
    />,
  );

  fireEvent.change(screen.getByRole("textbox", { name: "Group label" }), { target: { value: "Unsent new label" } });

  fireEvent.change(screen.getByRole("combobox", { name: "Highlight group" }), {
    target: { value: "design-review:boundary" },
  });
  expect(
    screen.getByText("This label came from an agent review. Your highlight will be saved in Reader highlights."),
  ).toBeVisible();
  expect(screen.queryByRole("textbox", { name: "Group label" })).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: "Color" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(onSave).toHaveBeenCalledWith("Trust boundary", expect.any(Function)));

  rendered.rerender(<NoteHighlightEditor groups={[]} onSave={onSave} onCancel={() => {}} />);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "That highlight group is no longer available. Choose another group.",
  );
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  fireEvent.submit(screen.getByRole("form", { name: "Highlight selection" }));
  expect(onSave).toHaveBeenCalledTimes(1);
});
