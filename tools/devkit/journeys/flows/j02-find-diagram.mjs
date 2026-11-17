// J2 Find a diagram (user-flows §6): signed in, at `/` → project → diagram → `checkout` shown, h1 its title, canonical URL.
// The project page opens on its Folders list; the diagram's title there is the entry a person meets first (the
// Diagrams tab's cards are one more press away, so going through them would be overhead).
import { begin, at, CHECKOUT } from "./lib.mjs";
export const meta = {
  name: "flows-j02-find-diagram",
  flow: {
    id: "J2",
    baseline: [
      // Pageturner is below the fold on the overview (J1's note; claude-07).
      { action: "scroll to: open project Pageturner", class: "essential" },
      { action: "open project Pageturner", class: "essential" },
      { action: "open diagram Checkout", class: "essential" },
    ],
  },
};
export default async (ctx) => {
  const { page, step, expect } = ctx;
  const { flow, rt, O } = await begin(ctx, meta);
  await step("start: signed in, at /", async () => {
    await page.goto(`${O}/`);
    await expect(page.getByRole("link", { name: "Pageturner", exact: true })).toBeVisible();
  });
  await rt.visit("overview", { cue: { project: "Projects" } });
  await flow.act("open project Pageturner", "essential", async () => {
    await page.getByRole("link", { name: "Pageturner", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Pageturner" })).toBeVisible();
  });
  await rt.visit("project", { cue: { project: "Pageturner" } });
  await flow.act("open diagram Checkout", "essential", async () => {
    await page
      .getByRole("treegrid", { name: "Project files" })
      .getByRole("button", { name: "Checkout", exact: true })
      .click();
    await expect(page.locator("g.archer-seq-participant").first()).toBeVisible();
  });
  await flow.goal("checkout shown, h1 its title, canonical URL", async () => {
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Checkout");
    expect(new URL(page.url()).pathname).toBe(new URL(at(O, CHECKOUT)).pathname);
  });
  await rt.visit("checkout", { cue: { project: "Pageturner", document: "Checkout" } });
  await rt.back("project");
  await rt.check();
};
