// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { followDocsTheme, startDocsTheme } from "../src/playground/docs-theme";

afterEach(() => document.documentElement.removeAttribute("data-theme"));
const theme = () => document.documentElement.getAttribute("data-theme");

it("starts in the theme the docs page named, and ignores anything else", () => {
  expect(startDocsTheme("https://site.test/archer/playground/app/index.html?scene=hero&theme=dark")).toBe(true);
  expect(theme()).toBe("dark");
  for (const href of [
    "https://site.test/a?theme=blue",
    "https://site.test/a",
    "https://site.test/a?theme=light&theme=dark",
  ])
    expect(startDocsTheme(href)).toBe(false);
  expect(theme()).toBe("dark");
});

it("follows only well-formed theme messages from its parent on its own origin", () => {
  const parent = {} as Window;
  const stop = followDocsTheme(window, parent);
  const send = (data: unknown, origin = window.location.origin, source: unknown = parent) =>
    window.dispatchEvent(new MessageEvent("message", { data, origin, source: source as Window }));
  send({ type: "archer-docs-theme", theme: "dark" });
  expect(theme()).toBe("dark");
  send({ type: "archer-docs-theme", theme: "light" }, "https://evil.test");
  send({ type: "archer-docs-theme", theme: "light" }, window.location.origin, window);
  send({ type: "archer-docs-theme", theme: "sepia" });
  send({ type: "archer-docs-theme", theme: "light", extra: true });
  send("archer-docs-theme light");
  expect(theme()).toBe("dark");
  send({ type: "archer-docs-theme", theme: "light" });
  expect(theme()).toBe("light");
  stop();
  send({ type: "archer-docs-theme", theme: "dark" });
  expect(theme()).toBe("light");
});
