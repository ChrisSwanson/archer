// J1 First entry (user-flows §6, U6): a clean context (no cookies, `login: false`) opens an ordinary access link
// (`sandbox.mjs link --reader`: no authoring roots) → open project. Mandatory outcome: the overview lists the
// projects, and a reload without the link still admits.
//
// Then U6's renewed entry by pairing (decided 2026-11-02; claude-09), in steps, not person actions, so J1's pinned
// trace is unchanged: a second clean context opens a diagram's address at a walkthrough step, is refused, follows
// "Enter it here", types a code from issue_pairing_code and lands on that address (flow check U6 "pairing from a
// refused address…"; the seeded fault drop-pairing-return sends the code alone and fails it).
import { issueLink } from "../../sandbox.mjs";
import { roundTrip } from "../../harness/round-trip.mjs";
import { assertFlowChecks } from "../../harness/flows-state.mjs";
import { begin, WALK } from "./lib.mjs";
export const meta = {
  name: "flows-j01-first-entry",
  login: false,
  flow: {
    id: "J1",
    baseline: [
      { action: "open the access link", class: "essential" },
      // The overview lists every project's files expanded: Pageturner, the third project, sits below the fold
      // (top ≈ 1611 px in a 900 px window), so a person scrolls to it first (claude-07; flow-metrics.mjs records it).
      { action: "scroll to: open project Pageturner", class: "essential" },
      { action: "open project Pageturner", class: "essential" },
    ],
  },
};
export default async (ctx) => {
  const { step, expect, ui, sandbox, run } = ctx;
  const { flow, O } = await begin(ctx, meta);
  const PROJECTS = sandbox.projects.map((p) => p.name);
  const clean = await step("start: a clean context, no cookies", async () => {
    const opened = await ui.openContext({ fresh: true, login: false });
    const cookies = await opened.context.cookies(O);
    if (cookies.length)
      throw new Error(`the clean context already has cookies: ${cookies.map((c) => c.name).join(", ")}`);
    return opened;
  });
  const pg = clean.page;
  const rt = roundTrip({ ui, step, run, page: pg });
  // The `.url` of `sandbox.mjs link --name … --reader` (issued here; the token is never written down).
  const link = issueLink({ name: sandbox.name, reader: true }).url;
  await flow.act(
    "open the access link",
    "essential",
    async () => {
      const res = await pg.goto(link);
      if (!res || res.status() >= 400) throw new Error(`the access link answered ${res?.status()}`);
      await expect(pg.getByRole("heading", { level: 1 })).toBeVisible();
    },
    { kind: "navigate" },
  );
  await step("the address no longer carries the token", async () =>
    expect(new URL(pg.url()).searchParams.has("token")).toBe(false),
  );
  await rt.visit("overview after the link", { cue: { project: "Projects" } });
  await step("the overview lists the projects", async () => {
    for (const name of PROJECTS) await expect(pg.getByRole("link", { name, exact: true }).first()).toBeVisible();
  });
  await flow.act("open project Pageturner", "essential", async () => {
    await pg.getByRole("link", { name: "Pageturner", exact: true }).first().click();
    await expect(pg.getByRole("heading", { level: 1, name: "Pageturner" })).toBeVisible();
  });
  await rt.visit("project", { cue: { project: "Pageturner" } });
  await flow.goal("the overview lists the projects; a reload without the link still admits", async () => {
    // A person comes back by typing the address: no token in it.
    const res = await pg.goto(`${O}/`);
    expect(res?.status() ?? 0, "the service admits the cookie the link set").toBeLessThan(400);
    await expect(pg.getByRole("heading", { level: 1 })).toHaveText("Projects");
    for (const name of PROJECTS) await expect(pg.getByRole("link", { name, exact: true }).first()).toBeVisible();
    await pg.reload();
    await expect(pg.getByRole("heading", { level: 1 })).toHaveText("Projects");
    for (const name of PROJECTS) await expect(pg.getByRole("link", { name, exact: true }).first()).toBeVisible();
  });
  await rt.check();
  await clean.context.close();

  const PAIRED = "pairing from a refused address: lands on that address";
  const wanted = `/projects/pageturner/${WALK.path}?walkthrough=${WALK.id}&step=2`;
  const second = await step(
    "a second clean context opens a diagram's address: refused, with a way to pair",
    async () => {
      const opened = await ui.openContext({ fresh: true, login: false });
      const res = await opened.page.goto(`${O}${wanted}`);
      expect(res?.status()).toBe(404);
      await expect(opened.page.getByRole("heading", { level: 1 })).toHaveText("Open the link Archer gave you");
      return opened;
    },
    { expects: [{ kind: "http", status: 404, url: WALK.path }] },
  ); // the refusal this step is about (errors.mjs)
  const p2 = second.page;
  await step(
    "follow Enter it here to the pairing form",
    async () => {
      await p2.getByRole("link", { name: "Enter it here" }).click();
      await expect(p2.getByRole("textbox", { name: "Enter your pairing code" })).toBeVisible();
    },
    { navigates: true },
  ); // a real link to the pairing form: a document load the person asked for (navigations.mjs)
  // Through archerCall, not ui.agent: this part is past J1's path, so J1's agentOps stay comparable with its pin.
  const { code } = await step("agent: issue_pairing_code", () => ui.archerCall("pageturner", "issue_pairing_code", {}));
  await step(
    "type the code and open: the page lands where it was going",
    async () => {
      await p2.getByRole("textbox", { name: "Enter your pairing code" }).fill(code);
      await p2.getByRole("button", { name: "Open" }).click();
      await p2.waitForURL((u) => u.pathname !== "/" && u.pathname !== "/-/pair", { timeout: 15_000 });
      // The page's own loading headings come first ("Archer"; for a moment "Project Overview" beside "Pageturner", two
      // h1s, which made a strict locator throw at once instead of waiting: O98). Wait, bounded, for the one h1 the
      // diagram shows, then read every h1 there is.
      const h1s = () =>
        p2
          .getByRole("heading", { level: 1 })
          .allTextContents()
          .then((t) => t.map((x) => x.trim()));
      await expect
        .poll(h1s, { timeout: 15_000 })
        .toEqual([WALK.h1])
        .catch(() => {});
      const at = new URL(p2.url());
      const shown = await h1s();
      const landed = { address: `${at.pathname}${at.search}`, h1: shown.length === 1 ? shown[0] : shown };
      const ok = landed.address === wanted && landed.h1 === WALK.h1;
      ui.flowCheck("U6", PAIRED, ok, {
        expected: { address: wanted, h1: WALK.h1 },
        landed,
        ...(ok ? {} : { problem: `landed on ${JSON.stringify(landed)}` }),
      });
    },
    { navigates: true },
  ); // the pairing form is submitted: its answer redirects to the address it was going to
  await second.context.close();
  await assertFlowChecks({ step, run });
};
