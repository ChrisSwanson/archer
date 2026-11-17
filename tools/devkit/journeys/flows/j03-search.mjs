// J3 Search (user-flows §6): signed in, on /projects/pageturner/ with no query and focus on the body → focus the
// search → type "declined" → open the result. Mandatory outcome: scenario-declined-card.md opens at the matching
// passage. The project page has no view named "Cards": it opens on its Folders list, the view that lists notes
// (the Diagrams tab's cards hold no notes), so that is the start state here.
import { begin, at } from "./lib.mjs";
const NOTE = "notes/scenario-declined-card.md";
export const meta = {
  name: "flows-j03-search",
  flow: {
    id: "J3",
    baseline: [
      { action: "focus search (/)", class: "essential" },
      { action: "type declined", class: "essential" },
      { action: "open the note's match", class: "essential" },
    ],
  },
};
export default async (ctx) => {
  const { page, step, expect } = ctx;
  const { flow, rt, O } = await begin(ctx, meta);
  const search = page.getByRole("searchbox", { name: "Search projects and files" });
  await step("start: project page, no query, focus on the body", async () => {
    await page.goto(at(O));
    await expect(search).toBeVisible();
    await expect(search).toHaveValue("");
    await page.evaluate(() => {
      document.activeElement?.blur?.();
      document.body.focus();
    });
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  });
  await rt.visit("project, no query", { cue: { project: "Pageturner" } });
  await flow.act(
    "focus search (/)",
    "essential",
    async () => {
      await page.keyboard.press("/");
      await expect(search).toBeFocused();
    },
    { kind: "key" },
  );
  await flow.act(
    "type declined",
    "essential",
    async () => {
      await page.keyboard.type("declined");
      await expect(page.getByRole("list", { name: "Matches in Scenario: The Card Is Declined" })).toBeVisible();
    },
    { kind: "type" },
  );
  await rt.visit("results for declined", { cue: { project: "Pageturner" } });
  let snippet = "";
  await flow.act("open the note's match", "essential", async () => {
    const match = page
      .getByRole("list", { name: "Matches in Scenario: The Card Is Declined" })
      .getByRole("button")
      .first();
    snippet = ((await match.getAttribute("aria-label")) ?? (await match.textContent()) ?? "")
      .replace(/^Note · /, "")
      .replace(/…$/, "");
    await match.click();
    await expect(page.getByRole("heading", { level: 1, name: "Scenario: The Card Is Declined" })).toBeVisible();
  });
  await flow.goal("scenario-declined-card.md opens at the matching passage", async () => {
    expect(new URL(page.url()).pathname).toBe(new URL(at(O, NOTE)).pathname);
    // The matching passage is the one the result's snippet quotes: the note's blocks whose words begin the snippet
    // (Markdown marks such as "#" dropped), in view without a scroll. The page marks the query's word in it once the
    // note has loaded (J3-F1, fixed in 0.10.0): the mark is asserted, and in view.
    const mark = page.locator("article[aria-label^='Reading '] mark[data-search-match]").first();
    await expect(mark, "the page marks the match in the note").toBeVisible();
    const markInView = await mark.evaluate((m) => {
      const r = m.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight;
    });
    flow.note("mark", {
      text: await mark.textContent(),
      inView: markInView,
      block: await mark.evaluate((m) =>
        (m.closest("h1, h2, h3, p, li")?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
      ),
    });
    expect(markInView, "the marked match is in view").toBe(true);
    const words = snippet
      .replace(/[#*_>`]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .slice(0, 6)
      .join(" ");
    const passage = await page.evaluate((words) => {
      const clean = (t) => (t ?? "").replace(/\s+/g, " ").trim();
      const article = document.querySelector("article[aria-label^='Reading ']") ?? document.querySelector("main");
      const blocks = [...article.querySelectorAll("h1, h2, h3, p, li")].filter(
        (el) => clean(el.textContent).length > 0,
      );
      const first = words.split(" ").slice(0, 3).join(" ");
      const hit = blocks.find((el) => clean(el.textContent).includes(first)) ?? null;
      const r = hit?.getBoundingClientRect();
      const marks = [...document.querySelectorAll("mark, [data-search-match]")].filter((m) =>
        /declin/i.test(m.textContent ?? ""),
      ).length;
      return {
        hash: location.hash,
        found: Boolean(hit),
        text: clean(hit?.textContent).slice(0, 80),
        inView: r ? r.top >= 0 && r.bottom <= innerHeight : false,
        marked: marks > 0,
        scrollY: scrollY,
      };
    }, words);
    flow.note("passage", { snippetStart: words, ...passage });
    expect(passage.found, `a block of the note quotes the result's snippet "${words}"`).toBe(true);
    expect(passage.inView, `the matching passage "${passage.text}" is in view`).toBe(true);
  });
  await rt.visit("note at the match", { cue: { project: "Pageturner", document: "Scenario: The Card Is Declined" } });
  await rt.back("results for declined");
  // flows-r1 S4: one spelling. Typing writes `q`; an old `?search=` link opens the same results and takes `q` in place.
  const typed = new URL(page.url()).searchParams;
  await step("an old ?search= link opens the same results under ?q=", async () => {
    await page.goto(`${at(O)}?search=declined`);
    await expect(search).toHaveValue("declined");
    await expect(page.getByRole("list", { name: "Matches in Scenario: The Card Is Declined" })).toBeVisible();
  });
  const opened = new URL(page.url()).searchParams;
  ctx.ui.flowCheck(
    "U7",
    "search words have one spelling: typing writes q, an old ?search= link is read and rewritten to q",
    typed.get("q") === "declined" && !typed.has("search") && opened.get("q") === "declined" && !opened.has("search"),
    { typed: typed.toString(), opened: opened.toString() },
  );
  await rt.check();
};
