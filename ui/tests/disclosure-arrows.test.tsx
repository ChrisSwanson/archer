// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { FilterSection } from "../src/app/FilterSection";

afterEach(cleanup);

it("renders filter groups as permanent labelled sections", () => {
  const rendered = render(
    <FilterSection title="Files" activeCount={2}>
      Filters
    </FilterSection>,
  );
  expect(screen.getByRole("heading", { name: "Files 2 active" })).toBeInTheDocument();
  expect(rendered.container.querySelector("details")).toBeNull();
  expect(screen.getByText("Filters")).toBeVisible();
});
