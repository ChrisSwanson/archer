import { KNOWN, tools } from "./lib.mjs";
export const meta = { name: "smoke-b-state-probe", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, page } = ctx;
  const t = tools(ctx);
  await ui.resetProject("awkward");
  await ui.openDiagram("awkward", "diagrams/state-composite.mmd", { edit: true });
  await t.probe("nodes", async () =>
    page.locator(".react-flow__node").evaluateAll((e) =>
      e.map((b) => [
        b.getAttribute("data-id"),
        b.className
          .replace(/react-flow__node/, "")
          .trim()
          .slice(0, 60),
        Math.round(b.getBoundingClientRect().width),
      ]),
    ),
  );
  await t.probe("edges", async () =>
    page.locator(".react-flow__edge").evaluateAll((e) => e.map((b) => b.getAttribute("data-id"))),
  );
  await t.probe("parts", async () => page.locator(".authoring-parts button").allTextContents());
  await t.shot("state-open");
};
