// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useLegendFocus } from "../src/emphasis/useLegendFocus";

afterEach(cleanup);

function Harness({ contextKey, ids }: { contextKey: string; ids: readonly string[] }) {
  const focus = useLegendFocus(contextKey, ids);
  return (
    <>
      {ids.map((id) => (
        <button key={id} {...focus.bind(id)} aria-pressed={focus.heldId === id}>
          {id}
        </button>
      ))}
      <output data-testid="effective">{focus.effectiveId ?? "none"}</output>
    </>
  );
}

describe("shared legend focus", () => {
  it("lets a preview override a held row and restores the held row on departure", () => {
    render(<Harness contextKey="view/set" ids={["one", "two"]} />);
    fireEvent.click(screen.getByRole("button", { name: "one" }));
    expect(screen.getByTestId("effective").textContent).toBe("one");

    fireEvent.mouseEnter(screen.getByRole("button", { name: "two" }));
    expect(screen.getByTestId("effective").textContent).toBe("two");
    fireEvent.mouseLeave(screen.getByRole("button", { name: "two" }));
    expect(screen.getByTestId("effective").textContent).toBe("one");
  });

  it("clears a hold when its context changes or its group disappears", () => {
    const { rerender } = render(<Harness contextKey="view/first" ids={["same"]} />);
    fireEvent.click(screen.getByRole("button", { name: "same" }));
    rerender(<Harness contextKey="view/second" ids={["same"]} />);
    expect(screen.getByTestId("effective").textContent).toBe("none");

    fireEvent.click(screen.getByRole("button", { name: "same" }));
    rerender(<Harness contextKey="view/second" ids={[]} />);
    expect(screen.getByTestId("effective").textContent).toBe("none");
  });

  it("does not leave click focus acting as a keyboard preview after pointer departure", () => {
    render(<Harness contextKey="view/set" ids={["one"]} />);
    const row = screen.getByRole("button", { name: "one" });
    fireEvent.pointerDown(row);
    fireEvent.focus(row);
    fireEvent.click(row);
    fireEvent.pointerLeave(row);
    fireEvent.click(row);
    expect(screen.getByTestId("effective").textContent).toBe("none");
  });

  it("toggles a keyboard-focused row off without requiring blur", () => {
    render(<Harness contextKey="view/set" ids={["one"]} />);
    const row = screen.getByRole("button", { name: "one" });
    fireEvent.focus(row);
    fireEvent.click(row, { detail: 0 });
    fireEvent.click(row, { detail: 0 });
    expect(screen.getByTestId("effective").textContent).toBe("none");
  });

  it("owns Escape at a focused row instead of passing it to the page", () => {
    render(<Harness contextKey="view/set" ids={["one"]} />);
    const row = screen.getByRole("button", { name: "one" });
    fireEvent.focus(row);
    fireEvent.click(row, { detail: 0 });
    expect(row).toHaveAttribute("aria-pressed", "true");

    let pageEscapes = 0;
    const pageKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") pageEscapes += 1;
    };
    window.addEventListener("keydown", pageKeydown);
    try {
      fireEvent.keyDown(row, { key: "Escape" });
      expect(row).toHaveAttribute("aria-pressed", "false");
      expect(screen.getByTestId("effective").textContent).toBe("none");
      expect(pageEscapes).toBe(0);
    } finally {
      window.removeEventListener("keydown", pageKeydown);
    }
  });

  it("keeps a hovered preview during pointer press and releases it on departure", () => {
    render(<Harness contextKey="view/set" ids={["one"]} />);
    const row = screen.getByRole("button", { name: "one" });
    fireEvent.pointerEnter(row);
    fireEvent.pointerDown(row);
    expect(screen.getByTestId("effective").textContent).toBe("one");
    fireEvent.pointerLeave(row);
    expect(screen.getByTestId("effective").textContent).toBe("none");
  });

  it("previews on keyboard refocus after a press is released outside the row", () => {
    render(<Harness contextKey="view/set" ids={["one"]} />);
    const row = screen.getByRole("button", { name: "one" });
    fireEvent.pointerEnter(row);
    fireEvent.pointerDown(row);
    fireEvent.focus(row);
    fireEvent.pointerLeave(row);
    fireEvent.pointerUp(document.body);
    fireEvent.blur(row);
    fireEvent.focus(row);
    expect(screen.getByTestId("effective").textContent).toBe("one");
  });
});
