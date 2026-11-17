import { KNOWN, tools } from "./lib.mjs";
export const meta = { name: "smoke-b-state-gestures", invariants: KNOWN };
export default async (ctx) => {
  const { ui, step, page, expect } = ctx;
  const t = tools(ctx);
  const P = "diagrams/state-composite.mmd";
  const fit = async () => {
    await page.getByRole("button", { name: "Fit view" }).click();
    await page.waitForTimeout(900);
  };
  const lines = async (re) => (await t.src()).split("\n").filter((l) => re.test(l));
  const fresh = async () => {
    await page.goto(page.url().split("?")[0] + "?edit");
    await ui.canvasReady();
    await ui.settle();
    await fit();
  };
  const dismissLabel = async () => {
    const i = ui.locators.openLabelInput();
    if (await i.isVisible().catch(() => false)) {
      await i.press("Enter");
      await ui.settle();
      return true;
    }
    return false;
  };
  const vp = () => page.locator(".react-flow__viewport").evaluate((e) => e.style.transform);
  await ui.resetProject("awkward");
  await ui.openDiagram("awkward", P, { edit: true });
  await fit();
  // A. double-click on each kind: input opens? zoom?
  for (const id of ["Idle", "Checking", "Route", "Split", "Working", "Fetch", "root_start", "Merge"]) {
    await step(`dblclick ${id}`, async () => {
      const v0 = await vp();
      const n = ui.locators.node(id);
      const b = await n.boundingBox();
      await page.mouse.dblclick(b.x + b.width / 2, b.y + b.height / 2);
      await page.waitForTimeout(400);
      const open = await ui.locators
        .openLabelInput()
        .isVisible()
        .catch(() => false);
      console.log(
        "PROBE dblclick",
        id,
        "editor:",
        open,
        "zoomed:",
        v0 !== (await vp()),
        "alerts:",
        JSON.stringify(await t.alerts()),
      );
      if (open) await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    });
  }
  // B. transitions by drag, various
  const drags = [
    ["Notify", "Report", "top-level to top-level"],
    ["Report", "Working", "to composite frame"],
    ["Fetch", "Idle", "nested to outer"],
    ["Idle", "Fetch", "outer to nested"],
    ["Compile", "Execute", "nested same-scope (exists)"],
    ["Idle", "Idle", "self loop"],
    ["Idle", "Merge", "to join"],
    ["Route", "Split", "choice to fork"],
  ];
  for (const [a, b, why] of drags) {
    await step(`drag transition ${a} -> ${b} (${why})`, async () => {
      await fresh();
      await t.part("Transition").click();
      const before = await lines(/-->/);
      await t.gconnect(a, b);
      const opened = await ui.locators
        .openLabelInput()
        .isVisible()
        .catch(() => false);
      const after = await lines(/-->/);
      console.log(
        "PROBE drag",
        a,
        "->",
        b,
        `(${why})`,
        "labelEditor:",
        opened,
        "added:",
        JSON.stringify(after.filter((x) => !before.includes(x))),
        "alerts:",
        JSON.stringify(await t.alerts()),
      );
      await dismissLabel();
    });
  }
  // C. reattach
  const re = [
    ["Idle--Checking", "target", "Report"],
    ["Idle--Checking", "source", "Notify"],
    ["root_start--Idle", "target", "Report"],
    ["root_start--Idle", "source", "Notify"],
    ["Idle--root_end", "target", "Report"],
    ["Route--Working", "target", "Report"],
    ["Working--Split", "source", "Report"],
    ["Fetch--Run", "target", "Idle"],
    ["Run_start--Compile", "target", "Execute"],
    ["Checking--Route", "target", "Merge"],
  ];
  for (const [e, end, to] of re) {
    await step(`reattach ${e} ${end} -> ${to}`, async () => {
      await fresh();
      const r = await t.reattach(e, end, to);
      const diff = (await t.src()).split("\n").filter((l) => /-->/.test(l));
      const orig = (await ui.readProjectFile("awkward", ".archer/diagrams/state-composite.mmd"))
        .split("\n")
        .filter((l) => /-->/.test(l));
      console.log(
        "PROBE reattach",
        e,
        end,
        "->",
        to,
        JSON.stringify(r),
        "changed lines:",
        JSON.stringify(diff.filter((x) => !orig.includes(x))),
        "alerts:",
        JSON.stringify(await t.alerts()),
      );
      await ui.cancel({ discard: true }).catch(() => {});
      await ui.openDiagram("awkward", P, { edit: true });
    });
  }
  await t.shot("state-gestures-final");
};
