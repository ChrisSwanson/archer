// @vitest-environment jsdom
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StaleConnectionNotice } from "../src/app/PageNotice";

afterEach(cleanup);
describe("connection recovery notices", () => {
  it.each([
    ["lost", "Reconnecting to Archer"],
    ["unsynced", "Synchronizing with Archer"],
    ["incompatible", "This page needs a compatible Archer version"],
    ["access-required", "Archer access is no longer available"],
  ] as const)("explains %s without discarding the displayed view", (status, text) => {
    render(<StaleConnectionNotice status={status} />);
    expect(screen.getByRole("status").textContent).toContain(text);
    expect(screen.getByRole("status").getAttribute("data-connection")).toBe(status);
  });
});
