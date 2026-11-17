import { expect, it } from "vitest";
import config from "../../../site/.vitepress/config.mts";
it("opens the Playground app straight from the nav, and keeps how to use it in the docs sidebar", () => {
  const theme = config.themeConfig!;
  expect(theme.nav).toContainEqual(expect.objectContaining({ text: "Playground", link: "/playground/app/index.html" }));
  expect(theme.nav).not.toContainEqual(expect.objectContaining({ text: "Examples" }));
  expect(theme.sidebar).toContainEqual({ text: "Using the Playground", link: "/using-the-playground" });
  expect(theme.sidebar).not.toContainEqual(expect.objectContaining({ text: "Examples" }));
});
