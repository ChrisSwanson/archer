// J4 Walkthrough (user-flows §6): a diagram in Explore → start → Next ×3 → leave; step 3 opened by its URL shows the
// same picture as step 3 reached by Next; leaving restores Explore.
//
// Host: the corpus walkthrough `order-to-courier` on Order Fulfilment (lib.mjs WALK). The rubric names `checkout`,
// a sequence diagram, which cannot host a walkthrough (list_walkthroughs: "walkthroughs are on graph diagrams").
//
// "By its URL" is checked in a fresh signed-in context (ui.openContext({ fresh: true })), as the goal step, and again
// by the U7 round trip (rt.check). Back: stepping and starting a walkthrough replace the history entry (ADR 0034 §6
// "Back is unchanged"), so Back after leaving lands on the page before the diagram (the project); that is checked,
// and where Back from inside the walkthrough lands is kept as a note (flow.notes.backFromWalkthrough).
import { begin, at, ownLinkUi, WALK } from "./lib.mjs";
import { roundTrip, settled } from "../../harness/round-trip.mjs";

const PICTURE = ["path", "h1", "mode", "step", "params", "picture"];
/** The off-screen cue ("1 more to the right. Show all") is a canvas button too; it is compared on its own (finding F-J4-1). */
const HINT = /Show all$/;
const drawing = (picture) => (picture ?? []).filter((n) => !HINT.test(n));
const camera = (page) => page.evaluate(() => document.querySelector(".react-flow__viewport")?.style.transform ?? null);
export const meta = {
  name: "flows-j04-walkthrough",
  flow: {
    id: "J4",
    baseline: [
      { action: "start walkthrough From Order to Courier", class: "essential" },
      { action: "next step", class: "essential" },
      { action: "next step", class: "essential" },
      { action: "next step", class: "essential" },
      { action: "leave the walkthrough", class: "essential" },
    ],
  },
};

export default async (ctx) => {
  const { page, step, expect, ui, run } = ctx;
  const { flow, cell, O } = await begin(ctx, meta);
  const fui = await ownLinkUi(ctx); // fresh contexts sign in with this run's own link (lib.mjs ownLinkUi)
  const rt = roundTrip({ ui: fui, step, run, page });
  const nav = roundTrip({ ui, step, run, page }); // history as the browser keeps it (entries the page pushes)
  const panel = page.locator(".archer-diagram-panel[data-mode]").first();
  const stepIs = (n) =>
    expect(page.getByRole("group", { name: "Step controls" })).toContainText(`Step ${n} of ${WALK.steps}`);
  await step("start: the project, then the diagram in Explore", async () => {
    const vp = page.viewportSize();
    if (vp.width !== cell.viewport.width || vp.height !== cell.viewport.height)
      await page.setViewportSize(cell.viewport);
    await page.goto(at(O));
    await expect(page.getByRole("heading", { level: 1, name: "Pageturner" })).toBeVisible();
  });
  await nav.visit("project", { cue: { project: "Pageturner" } });
  await step("open the diagram (start state)", async () => {
    await page.goto(at(O, WALK.path));
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await expect(panel).toHaveAttribute("data-mode", "explore");
  });
  const explore = await rt.visit("diagram, Explore", {
    cue: { project: "Pageturner", document: WALK.h1 },
    fields: PICTURE,
  });
  const exploreCamera = await camera(page);

  await flow.act(`start walkthrough ${WALK.title}`, "essential", async () => {
    await page.getByRole("button", { name: new RegExp(`^${WALK.title} ${WALK.steps} steps`) }).click();
    await stepIs(1);
  });
  await flow.act("next step", "essential", async () => {
    await page.getByRole("button", { name: "Next step" }).click();
    await stepIs(2);
  });
  await flow.act("next step", "essential", async () => {
    await page.getByRole("button", { name: "Next step" }).click();
    await stepIs(3);
  });
  const byNext = await rt.visit("walkthrough step 3, reached by Next", { fields: PICTURE });
  await flow.act("next step", "essential", async () => {
    await page.getByRole("button", { name: "Next step" }).click();
    await stepIs(4);
  });
  await flow.act("leave the walkthrough", "essential", async () => {
    await page.getByRole("button", { name: "Close walkthrough" }).click();
    await expect(panel).toHaveAttribute("data-mode", "explore");
  });

  await flow.goal("same picture by either route; leaving restores Explore", async () => {
    // Leaving: Explore again, the same picture as before the walkthrough, and the address without walkthrough or step.
    const after = await settled(page);
    expect(after.mode, "the panel's mode after leaving").toBe("explore");
    await expect(page.locator(".archer-panel-mode").first()).toHaveText("Explore");
    expect(after.params, "leaving removes ?walkthrough and ?step").toEqual({});
    expect(drawing(after.picture), "the drawing after leaving equals the drawing before the walkthrough").toEqual(
      drawing(explore.picture),
    );
    expect(await camera(page), "leaving returns the camera to where it was (ADR 0034 D3)").toBe(exploreCamera);
    const lostHint = explore.picture.filter((n) => HINT.test(n) && !after.picture.includes(n));
    flow.note(
      "offScreenCueAfterLeaving",
      lostHint.length
        ? {
            lost: lostHint,
            finding: "F-J4-1: same camera, same nodes off screen, but the off-screen cue is gone after leaving",
          }
        : "kept",
    );
    // Step 3 by its URL, in a fresh signed-in context: the same step and picture as by Next.
    expect(byNext.step).toEqual({ n: 3, of: WALK.steps });
    expect(byNext.params).toEqual({ walkthrough: WALK.id, step: "3" });
    const { page: fresh, context } = await fui.openContext({ fresh: true });
    try {
      await fresh.goto(at(O, `${WALK.path}?walkthrough=${WALK.id}&step=3`));
      await expect(fresh.getByRole("group", { name: "Step controls" })).toContainText(`Step 3 of ${WALK.steps}`);
      const byUrl = await settled(fresh);
      expect(byUrl.step).toEqual(byNext.step);
      expect(byUrl.mode).toBe("walkthrough");
      expect(byUrl.picture, "step 3 by URL draws what step 3 by Next drew").toEqual(byNext.picture);
    } finally {
      await context.close();
    }
  });
  flow.note(
    "byUrl",
    "step 3 by URL is opened in a fresh signed-in context (ui.openContext({ fresh: true })), in the goal and again in the U7 round trip",
  );

  await nav.visit("diagram, Explore after leaving", { cue: { project: "Pageturner", document: WALK.h1 } });
  // Starting, stepping and leaving add no history entry (ADR 0034 §6), so Back lands on the project.
  await nav.back("project (the walkthrough added no history entry)");
  await step("observe: Back from inside the walkthrough", async () => {
    await page.goForward();
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await page.goto(at(O, `${WALK.path}?walkthrough=${WALK.id}&step=2`));
    await stepIs(2);
    await page.getByRole("button", { name: "Next step" }).click();
    await stepIs(3);
    await page.goBack();
    const landed = await settled(page);
    flow.note("backFromWalkthrough", {
      from: "step 3 (stepped from step 2, opened by URL)",
      landedOn: { path: landed.path, params: landed.params, mode: landed.mode, step: landed.step },
    });
    await page.goForward();
  });
  await rt.check();
};
