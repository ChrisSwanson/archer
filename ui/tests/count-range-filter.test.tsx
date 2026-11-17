// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CountRangeFilter } from "../src/app/CountRangeFilter";

afterEach(cleanup);

const group = (): HTMLElement => screen.getByRole("group", { name: "Total threads" });
const operator = (): HTMLElement => within(group()).getByRole("combobox", { name: "Total threads condition" });

it("maps each operator onto the existing inclusive min/max range", () => {
  const onChange = vi.fn();
  const rendered = render(<CountRangeFilter label="Total threads" range={null} onChange={onChange} />);

  fireEvent.change(operator(), { target: { value: "equals" } });
  fireEvent.change(within(group()).getByRole("spinbutton", { name: "Count" }), { target: { value: "4" } });
  expect(onChange).toHaveBeenLastCalledWith({ min: 4, max: 4 });

  rendered.rerender(<CountRangeFilter label="Total threads" range={{ min: 4, max: 4 }} onChange={onChange} />);
  fireEvent.change(operator(), { target: { value: "at-least" } });
  expect(onChange).toHaveBeenLastCalledWith({ min: 4 });

  rendered.rerender(<CountRangeFilter label="Total threads" range={{ min: 4 }} onChange={onChange} />);
  fireEvent.change(operator(), { target: { value: "at-most" } });
  expect(onChange).toHaveBeenLastCalledWith({ max: 4 });

  rendered.rerender(<CountRangeFilter label="Total threads" range={{ max: 4 }} onChange={onChange} />);
  fireEvent.change(operator(), { target: { value: "any" } });
  expect(onChange).toHaveBeenLastCalledWith(null);
});

it("keeps incomplete, inverted and unsafe drafts local until they become valid", () => {
  const onChange = vi.fn();
  render(<CountRangeFilter label="Total threads" range={{ min: 2 }} onChange={onChange} />);
  fireEvent.change(operator(), { target: { value: "between" } });
  const minimum = within(group()).getByRole("spinbutton", { name: "Minimum" });
  const maximum = within(group()).getByRole("spinbutton", { name: "Maximum" });
  fireEvent.change(minimum, { target: { value: "9007199254740992" } });
  expect(within(group()).getByRole("alert")).toHaveTextContent("non-negative whole number");
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.change(minimum, { target: { value: "9" } });
  fireEvent.change(maximum, { target: { value: "3" } });
  expect(within(group()).getByRole("alert")).toHaveTextContent("Minimum cannot exceed maximum");
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.change(maximum, { target: { value: "12" } });
  expect(onChange).toHaveBeenCalledWith({ min: 9, max: 12 });
});

it("resynchronizes its operator and inputs when address state changes or clears", () => {
  const onChange = vi.fn();
  const rendered = render(<CountRangeFilter label="Total threads" range={{ min: 3, max: 8 }} onChange={onChange} />);
  expect(operator()).toHaveValue("between");
  rendered.rerender(<CountRangeFilter label="Total threads" range={{ max: 5 }} onChange={onChange} />);
  expect(operator()).toHaveValue("at-most");
  expect(within(group()).getByRole("spinbutton", { name: "Maximum" })).toHaveValue(5);
  rendered.rerender(<CountRangeFilter label="Total threads" range={null} onChange={onChange} />);
  expect(operator()).toHaveValue("any");
  expect(within(group()).queryByRole("spinbutton")).toBeNull();
});

it("keeps Between selected while an equal-range draft is being widened", () => {
  const onChange = vi.fn();
  render(<CountRangeFilter label="Total threads" range={{ min: 4, max: 4 }} onChange={onChange} />);
  fireEvent.change(operator(), { target: { value: "between" } });
  expect(operator()).toHaveValue("between");
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.change(within(group()).getByRole("spinbutton", { name: "Maximum" }), { target: { value: "8" } });
  expect(onChange).toHaveBeenCalledWith({ min: 4, max: 8 });
});
