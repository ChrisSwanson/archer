// J10 Phone reading (user-flows §6, U8): signed in at `/`, each phone size → project → the walkthrough diagram →
// walkthrough step 2 → note 0001. Each stop must be readable and reachable: its h1 visible, no sideways overflow,
// and every control pressed visible with the pointer away from it (no hover-only step). A control off screen is
// reached by a recorded scroll action (§6: a scroll counts when it is needed to reveal the target), which the action
// collector adds (flow-metrics.mjs: below the fold, or clipped by a scrolling panel).
//
// Host: the corpus walkthrough `order-to-courier` on Order Fulfilment (lib.mjs WALK); `checkout` is a sequence
// diagram and cannot host one. The walkthrough names note 0001 as its related note, and the walkthrough panel links
// it ("Related note: …"; finding J10-F1, fixed in 0.10.0), so the person opens it from there.
//
// Matrix (§1): 1440×900 for all journeys, and 390×844 and 320×640 for J10. On a phone the walkthrough list is in a
// sheet behind the "Walkthroughs · 1" chip, one press more than the desktop panel, which lists it in Explore; so the
// pinned trace differs by width (meta.flow.baselines, keyed by cell viewport; meta.flow.baseline is the 1440 one).
import { begin, at, cellOf, ownLinkUi, WALK, NOTE_0001 } from "./lib.mjs";
import { roundTrip } from "../../harness/round-trip.mjs";

const NOTE_TITLE = "0001: Take Card Payments on the Provider's Hosted Page";
const E = (action) => ({ action, class: "essential" });
const scroll = (action) => E(`scroll to: ${action}`);
// The overview lists every project's files expanded, so Pageturner (the third project) is below the fold at every
// size: one scroll reveals it. At 320×640 the diagram's row is below the fold on the project page too (y≈795), one
// more scroll. (The page lists files most recently edited first; a sandbox whose copy gave Order Fulfilment a newer
// mtime by a few ms listed it first and needed no scroll: O72. Corpus copies and resets now share one time.)
// At 320×640 the walkthrough sheet scrolls its body to the active step, which takes the Related note link out of
// the body's visible part (under the sheet's header): one more scroll, in the sheet (codex-05; at 390 it stays shown).
const desktop = [
  scroll("open project Pageturner"),
  E("open project Pageturner"),
  E(`open diagram ${WALK.h1}`),
  E(`start walkthrough ${WALK.title}`),
  E("next step"),
  E("open the walkthrough's note 0001"),
];
const phone = (small) => [
  scroll("open project Pageturner"),
  E("open project Pageturner"),
  ...(small ? [scroll(`open diagram ${WALK.h1}`)] : []),
  E(`open diagram ${WALK.h1}`),
  E("open the Walkthroughs sheet"),
  E(`start walkthrough ${WALK.title}`),
  E("next step"),
  ...(small ? [scroll("open the walkthrough's note 0001")] : []),
  E("open the walkthrough's note 0001"),
];
export const BASELINES = { "1440x900": desktop, "390x844": phone(false), "320x640": phone(true) };

export const meta = {
  name: "flows-j10-phone-reading",
  flow: {
    id: "J10",
    baseline: desktop,
    baselines: BASELINES,
    matrix: {
      viewports: [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
        { width: 320, height: 640 },
      ],
    },
  },
};

export default async (ctx) => {
  const { page, step, expect } = ctx;
  const cellBase = (c) => BASELINES[`${c.viewport.width}x${c.viewport.height}`] ?? desktop;
  const { flow, cell, O } = await begin(ctx, {
    ...meta,
    flow: { ...meta.flow, baseline: cellBase(cellOf(ctx, meta)) },
  });
  const rt = roundTrip({ ui: await ownLinkUi(ctx), step, run: ctx.run, page }); // fresh contexts sign in with this run's own link
  const isPhone = cell.viewport.width < 600;

  /**
   * Press `target` as a person would: visible with the pointer away (no hover). A target off screen (below the fold,
   * or scrolled out of a panel that clips it) gets its "scroll to:" entry from the action collector (flow-metrics.mjs,
   * installRevealWatch): this journey's own check looked at the window only and missed the sheet (codex-05).
   */
  const press = async (action, cls, target, then) => {
    await page.mouse.move(1, 1);
    await expect(target, `${action}: the control shows without hovering`).toBeVisible();
    return flow.act(action, cls, async () => {
      await target.click();
      await then();
    });
  };
  /** A stop is readable: its h1 shows, and the page does not scroll sideways. */
  const readable = (label, cue, visit = true) =>
    step(`readable at ${cell.viewport.width}×${cell.viewport.height}: ${label}`, async () => {
      await expect(page.locator("h1").first()).toBeVisible();
      const { sw, iw } = await page.evaluate(() => ({ sw: document.scrollingElement.scrollWidth, iw: innerWidth }));
      expect(sw, `${label}: the page is ${sw}px wide in a ${iw}px window`).toBeLessThanOrEqual(iw + 1);
      // The overview and project round trips are J2's; this journey's own addresses are the diagram, the step and the
      // note. (Each round trip is a sign-in with the link, and a link takes 20 a minute: MAX_SESSION_MINTS_PER_MINUTE.)
      if (cue && visit) await rt.visit(label, { cue });
      else if (cue) await expect(page.locator("h1").first()).toContainText(cue.document ?? cue.project);
    });

  await step("start: signed in, at /, the cell's viewport", async () => {
    const vp = page.viewportSize();
    if (vp.width !== cell.viewport.width || vp.height !== cell.viewport.height)
      await page.setViewportSize(cell.viewport);
    await page.goto(`${O}/`);
    await expect(page.getByRole("link", { name: "Pageturner", exact: true })).toBeVisible();
  });
  await readable("overview", { project: "Projects" }, false);

  await press("open project Pageturner", "essential", page.getByRole("link", { name: "Pageturner", exact: true }), () =>
    expect(page.getByRole("heading", { level: 1, name: "Pageturner" })).toBeVisible(),
  );
  await readable("project", { project: "Pageturner" }, false);

  await press(
    `open diagram ${WALK.h1}`,
    "essential",
    page.getByRole("treegrid", { name: "Project files" }).getByRole("button", { name: WALK.h1, exact: true }),
    () => expect(page.locator(".react-flow__node").first()).toBeVisible(),
  );
  await readable("diagram", { document: WALK.h1 });

  if (isPhone)
    await press(
      "open the Walkthroughs sheet",
      "essential",
      page.getByRole("button", { name: `Walkthroughs · 1`, exact: true }),
      () => expect(page.getByRole("dialog", { name: "Walkthroughs · 1" })).toBeVisible(),
    );
  const steps = page.getByRole("group", { name: "Step controls" });
  await press(
    `start walkthrough ${WALK.title}`,
    "essential",
    page.getByRole("button", { name: new RegExp(`^${WALK.title} ${WALK.steps} steps`) }),
    () => expect(steps).toContainText(`Step 1 of ${WALK.steps}`),
  );
  await press("next step", "essential", page.getByRole("button", { name: "Next step" }), () =>
    expect(steps).toContainText(`Step 2 of ${WALK.steps}`),
  );
  await readable("walkthrough step 2", { document: WALK.h1 });
  await step("walkthrough step 2: its text and the drawn step show", async () => {
    await expect(steps).toContainText("Check the payment");
    await expect(page.getByRole("button", { name: /Pick from Shelf, step 2, current/ }).first()).toBeAttached();
    flow.note("walkthroughNote", {
      field: NOTE_0001,
      linkOnPage: await page.getByRole("link", { name: /0001|Hosted Page/ }).count(),
    });
  });

  await press(
    "open the walkthrough's note 0001",
    "essential",
    page.getByRole("link", { name: NOTE_TITLE, exact: true }),
    () => expect(page.getByRole("article", { name: `Reading ${NOTE_TITLE}` })).toBeVisible(),
  );
  await flow.goal("note 0001 is readable and reachable at this size", async () => {
    expect(new URL(page.url()).pathname).toBe(new URL(at(O, NOTE_0001)).pathname);
    const { sw, iw } = await page.evaluate(() => ({ sw: document.scrollingElement.scrollWidth, iw: innerWidth }));
    expect(sw).toBeLessThanOrEqual(iw + 1);
    await expect(page.getByRole("heading", { level: 1, name: NOTE_TITLE })).toBeVisible();
  });
  await rt.visit("note 0001", { cue: { document: "0001" } });
  await rt.check();
};
