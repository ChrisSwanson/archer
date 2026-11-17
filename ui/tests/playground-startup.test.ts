// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { showStartupFailure } from "../src/playground/startup-failure";

it("replaces a blank page with an announced failure and a Retry that starts again", () => {
  const root = document.createElement("div");
  root.append(document.createElement("span"));
  const retry = vi.fn();
  showStartupFailure(root, retry);
  const alert = root.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("This example could not load.");
  expect(alert?.textContent).toContain("Check your connection");
  expect(root.querySelector("span")).toBeNull();
  const button = [...root.querySelectorAll("button")].find((candidate) => candidate.textContent === "Retry");
  expect(button?.type).toBe("button");
  button!.click();
  expect(retry).toHaveBeenCalledOnce();
  // Never takes focus: the hero runs it inside the docs page's iframe.
  expect(document.activeElement).not.toBe(button);
});
