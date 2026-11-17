// J11 Agent answers by showing (user-flows §6, U9): signed in, at `/`; the agent, in a shell with the sandbox env:
// list_diagrams → read_diagram → present_diagram with emphasis; the person opens the returned URL → selects → comments;
// the agent: get_comments → reply_comment; then writes an elaboration in notes/scratch/ with `based-on`.
// Mandatory outcome: the page shows the presented view and emphasis at that revision; the target and revision match in
// get_comments; the original is byte-identical.
//
// The view is `containers` (C4): a graph, so the emphasis lands on boxes and lines. Every step's comparison of the CLI
// result with the page is kept in summary.flow.notes.u9 ({ step, cli, page, same }).
// There is no note-writing operation (archer tools): the agent writes the elaboration with its file tools
// (ui.agentWrite), then checks it with validate_diagram, as the plugin's instructions say. A file write is not an
// agent CLI operation, so it is not counted in agentOps.
// The link stays the diagram's (decided 2026-11-02; claude-08): after the agent presents another view, a fresh
// context given only the link opens the presented view with its emphasis (flow check U7 "stable link…"; the seeded
// fault follow-presented-link hands over the `?follow` address instead and fails it).
// The link after the file is deleted (claude-204, PC-203): containers.mmd is registered, so the service keeps the last
// drawing; a fresh context given the link must say the file is gone (the compile notice), date no change and offer no
// Edit, and read_diagram must say the source is missing. The seeded fault hide-missing-source (the page drops a
// failure that has no source revision, as before the fix) fails the G4 check. The notice says "no longer at this
// address", not "deleted", and list_diagrams flags the view (flows-r1 S4). Then the same bytes come back under a new
// name: the old address must say where the file moved and link it (flow check U7 "renamed file…").
import { begin, at } from "./lib.mjs";

const VIEW = "containers",
  FILE = ".archer/diagrams/containers.mmd",
  TITLE = "Pageturner Containers";
const EMPHASIS = {
  id: "j11-card-payment",
  groups: [
    {
      id: "card-payment",
      style: "flow",
      label: "Card payment",
      nodes: ["web", "api", "payments"],
      edges: ["web--api", "api--payments", "payments--api"],
    },
  ],
};
const BODY = "Where does the Shop API keep the payment session id?";
const REPLY = "In the orders table, next to the order; the webhook looks it up there.";
const NOTE = "notes/scratch/j11-payment-session.md";

export const meta = {
  name: "flows-j11-agent-shows",
  invariants: {
    // Owned by performance (S3 request counts), not deducted here; see J5.
    "duplicate-requests": {
      severity: "warn",
      reason: "performance-owned: a comment send re-reads comments/pending and comments?target several times",
    },
  },
  flow: {
    id: "J11",
    baseline: [
      { action: "open the URL the agent gave", class: "essential" },
      { action: "press Select mode", class: "overhead" },
      { action: "select node Shop API", class: "essential" },
      { action: "press c", class: "essential" },
      { action: "type the comment", class: "essential" },
      { action: "send (Add comment)", class: "essential" },
    ],
  },
};

export default async (ctx) => {
  const { page, step, expect, ui } = ctx;
  const { flow, rt, O } = await begin(ctx, meta);
  const u9 = [];
  const same = (s, cli, pg) => {
    const ok = JSON.stringify(cli) === JSON.stringify(pg);
    u9.push({ step: s, cli, page: pg, same: ok });
    flow.note("u9", u9);
    return ok;
  };
  const original = await ui.readProjectFile("pageturner", FILE);

  await step("start: signed in, at /", async () => {
    await page.goto(`${O}/`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  // The agent finds the diagram that answers the question and shows it.
  const read = await step("agent: list_diagrams → read_diagram", async () => {
    const listed = await ui.agent("list_diagrams", {});
    const view = listed.views.find((v) => v.id === VIEW);
    if (!view) throw new Error(`list_diagrams has no ${VIEW}`);
    expect(view.title).toBe(TITLE);
    const r = await ui.agent("read_diagram", { viewId: VIEW });
    expect(r.view.id).toBe(VIEW);
    return r;
  });
  const shown = await step("agent: present_diagram with emphasis, at the revision it read", async () => {
    const p = await ui.agent("present_diagram", {
      viewId: VIEW,
      expectedRevision: read.modelRevision,
      annotation: "The card payment path.",
      emphasis: EMPHASIS,
    });
    expect(p.presentation.viewId).toBe(VIEW);
    same(
      "present_diagram names the revision read_diagram read",
      { view: VIEW, revision: read.modelRevision },
      { view: p.presentation.viewId, revision: p.presentation.revision },
    );
    expect(p.presentation.revision).toBe(read.modelRevision);
    expect(p.ui?.url, "present_diagram returns the page URL").toBeTruthy();
    return p;
  });

  // The person opens the URL as returned. What the page rendered is what its bootstrap answered.
  const bootstrap = page
    .waitForResponse((r) => /\/api\/bootstrap(\?|$)/.test(r.url()) && r.status() === 200, { timeout: 15_000 })
    .then((r) => r.json())
    .catch(() => null);
  await flow.act(
    "open the URL the agent gave",
    "essential",
    async () => {
      await page.goto(shown.ui.url);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(TITLE);
      await expect(page.locator(".react-flow__node").first()).toBeVisible();
    },
    { kind: "navigate" },
  );
  await step("the page shows the presented view and emphasis at that revision", async () => {
    const b = await bootstrap;
    if (!b) throw new Error("the page's /api/bootstrap answer was not seen");
    same(
      "page presentation = present_diagram",
      { view: VIEW, revision: shown.presentation.revision },
      { view: b.presentation?.viewId, revision: b.presentation?.revision },
    );
    same("page drawing revision = present_diagram", shown.presentation.revision, b.envelope?.revision);
    expect(b.presentation?.revision).toBe(shown.presentation.revision);
    expect(b.envelope?.revision).toBe(shown.presentation.revision);
    expect(new URL(page.url()).searchParams.has("token"), "the address bar keeps no token").toBe(false);
    // The emphasis is on: the Highlights mode, its group pressed, and the emphasised boxes named as in it.
    await expect(page.locator(".archer-diagram-panel[data-mode]")).toHaveAttribute("data-mode", "highlights");
    // Storefront and Shop API are inside the system boundary, which opens closed in the Nested view: the emphasis
    // opens it (J11-F1, fixed in 0.10.0), so they are drawn, and emphasised, as themselves.
    const canvas = page.getByRole("application", { name: "Diagram canvas" });
    for (const label of ["Storefront", "Shop API", "Payment Provider"])
      await expect(
        canvas.getByRole("button", { name: new RegExp(`^${label}, .*in highlight \\d: Card payment`) }),
      ).toBeVisible();
    await expect(canvas.getByRole("button", { name: /^Back Office, .*in highlight/ })).toHaveCount(0);
  });
  await rt.visit("presented view", { cue: { project: "Pageturner", document: TITLE } });

  await flow.act("press Select mode", "overhead", () =>
    page.getByRole("button", { name: "Select mode", exact: true }).click(),
  );
  const node = page
    .getByRole("application", { name: "Diagram canvas" })
    .getByRole("button", { name: /^Shop API, container/ });
  await flow.act("select node Shop API", "essential", async () => {
    await node.click();
    await expect(page.locator('.react-flow__node.selected[data-id="api"]')).toHaveCount(1);
  });
  const discussion = page.getByRole("region", { name: "Contextual discussion" });
  await flow.act(
    "press c",
    "essential",
    async () => {
      await page.keyboard.press("c");
      await expect(discussion.getByRole("textbox", { name: "Comment" })).toBeVisible();
    },
    { kind: "key" },
  );
  await flow.act(
    "type the comment",
    "essential",
    () => discussion.getByRole("textbox", { name: "Comment" }).fill(BODY),
    { kind: "type" },
  );
  await flow.act("send (Add comment)", "essential", async () => {
    await discussion.getByRole("button", { name: "Add comment" }).click();
    await expect(discussion.getByText(BODY)).toBeVisible();
  });

  const thread = await step("agent: get_comments names the target the person commented on", async () => {
    const got = await ui.agent("get_comments", { target: `view:${VIEW}` });
    const t = got.threads.find((x) => x.comments.some((c) => c.body === BODY));
    if (!t) throw new Error("get_comments has no thread with the person's comment");
    same(
      "get_comments target = the page's",
      { target: `view:${VIEW}`, node: "api" },
      { target: t.target, node: t.anchor?.id },
    );
    expect(t.target).toBe(`view:${VIEW}`);
    expect(t.anchor).toMatchObject({ kind: "node", id: "api" });
    // U9's revision: the thread names the drawing revision the person commented on (Thread.modelRevision).
    same("get_comments names the revision the page showed", shown.presentation.revision, t.modelRevision ?? null);
    expect(t.modelRevision).toBe(shown.presentation.revision);
    return t;
  });
  await step("agent: reply_comment", async () => {
    const r = await ui.agent("reply_comment", { threadId: thread.id, body: REPLY, expectedRevision: thread.revision });
    expect(r.status).toBe("answered");
  });
  await step("the page shows the reply on that node's thread", async () => {
    await expect(discussion.getByText(REPLY)).toBeVisible({ timeout: 10_000 });
  });

  // The agent elaborates in a copy: a scratch note based on the view at the revision it read.
  const elaboration = [
    "---",
    "author: agent",
    `based-on: ${VIEW}@${read.sourceRevision}`,
    "description: Where the payment session id lives, in more detail than the containers view.",
    "---",
    "",
    "# Payment Session Id",
    "",
    "The Shop API keeps the provider's session id with the order; the webhook finds the order by it.",
    "",
    "```mermaid",
    "%% archer-id: session-lookup",
    "flowchart LR",
    "    api[Shop API]",
    "    db[(Shop Database)]",
    "    payments[Payment Provider]",
    "    api save@-->|saves session id| db",
    "    payments hook@-->|webhook with session id| api",
    "    api find@-->|finds the order| db",
    "```",
    "",
  ].join("\n");
  await ui.agentWrite("pageturner", `.archer/${NOTE}`, elaboration);
  await step("agent: validate_diagram on the elaboration", async () => {
    const v = await ui.agent("validate_diagram", {
      viewId: `${NOTE}#session-lookup`,
      source: elaboration.split("```mermaid\n")[1].split("```")[0],
    });
    const errors = (v.diagnostics ?? v.problems ?? []).filter((d) => d.severity === "error");
    expect(errors, JSON.stringify(v).slice(0, 400)).toEqual([]);
  });

  // claude-08: the link the person was given still opens what it named once the agent shows something else.
  const STABLE = "stable link: a fresh context opens the presented view and emphasis after another present";
  await step("agent: present_diagram another view", async () => {
    await ui.agent("present_diagram", { viewId: "checkout" });
  });
  await step("a fresh context opens the link the agent gave first", async () => {
    const fresh = await ui.openContext({ fresh: true, login: false });
    try {
      await fresh.page.goto(shown.ui.url);
      const heading = fresh.page.getByRole("heading", { level: 1 });
      // The page's loading heading ("Archer") comes first; give the diagram its moment, then read what landed.
      await expect(heading)
        .toHaveText(TITLE, { timeout: 15_000 })
        .catch(() => {});
      // The drawing and its emphasis have landed when one of the emphasised boxes is drawn as in the highlight.
      const lit = fresh.page
        .getByRole("application", { name: "Diagram canvas" })
        .getByRole("button", { name: /^Shop API, .*in highlight \d: Card payment/ });
      const shownLit = await lit.waitFor({ timeout: 15_000 }).then(
        () => true,
        () => false,
      );
      const landed = {
        h1: (await heading.textContent())?.trim() ?? null,
        path: new URL(fresh.page.url()).pathname,
        emphasised: shownLit,
      };
      const ok = landed.h1 === TITLE && landed.emphasised;
      ui.flowCheck("U7", STABLE, ok, {
        expected: { h1: TITLE, emphasised: true },
        landed,
        link: shown.ui.url.replace(/token=[^&#]+/, "token=[redacted]"),
        ...(ok ? {} : { problem: `the link opened ${JSON.stringify(landed)}` }),
      });
    } finally {
      await fresh.context.close();
    }
  });

  const after = await ui.readProjectFile("pageturner", FILE);
  // claude-204: the same link once the file is gone.
  const GONE = "removed file: the link says the file is gone, dates no change and offers no Edit";
  const GONE_SAID = { kind: "alert", text: "no longer at this address" },
    MOVED_SAID = { kind: "alert", text: "was moved to" };
  await ui.agentRemove("pageturner", FILE, { settleMs: 1500 });
  await step(
    "a fresh context opens the link after the file was deleted",
    async () => {
      const fresh = await ui.openContext({ fresh: true, login: false });
      try {
        await fresh.page.goto(shown.ui.url);
        const notice = fresh.page.locator(".archer-compile-notice-text");
        const said = await notice.waitFor({ timeout: 15_000 }).then(
          () => notice.textContent(),
          () => null,
        );
        const edit = await fresh.page.locator(".archer-diagram-edit").getByRole("button", { name: /^Edit/ }).count();
        const presence = await fresh.page
          .locator(".archer-presence")
          .first()
          .textContent({ timeout: 500 })
          .catch(() => null);
        // A harness read (ui.archerCall), not one of the journey's agent operations.
        const read = await ui
          .archerCall("pageturner", "read_diagram", { viewId: VIEW })
          .catch((e) => ({ error: String(e) }));
        // flows-r1 S4: list_diagrams flags it too, and the page claims no deletion it cannot know.
        const listed = await ui.archerCall("pageturner", "list_diagrams", {}).catch((e) => ({ error: String(e) }));
        const listedStatus = listed?.views?.find?.((v) => v.id === VIEW)?.sourceStatus ?? listed?.error ?? null;
        const ok =
          /no longer at this address/i.test(said ?? "") &&
          !/deleted/i.test(said ?? "") &&
          edit === 0 &&
          presence === null &&
          read?.source?.status === "missing" &&
          listedStatus === "missing";
        ui.flowCheck("G4", GONE, ok, {
          notice: said,
          editButtons: edit,
          presence,
          agentSource: read?.source?.status ?? read?.error ?? null,
          listed: listedStatus,
        });
      } finally {
        await fresh.context.close();
      }
    },
    { expects: [GONE_SAID] },
  ); // the deletion this journey makes, said by the page (errors.mjs)
  // flows-r1 S4: the same bytes under a new name. The old address says where the file went and links it.
  const MOVED = ".archer/diagrams/containers-v2.mmd";
  // The person's own tab leaves the diagram first: its live refreshes for two more file events are not this check's,
  // and would count against that one view's request budget.
  await step("the person's tab goes back to /", async () => {
    await page.goto(`${O}/`);
  });
  await ui.agentWrite("pageturner", MOVED, original, { settleMs: 1500 });
  await step(
    "a fresh context opens the link after the file was renamed",
    async () => {
      const fresh = await ui.openContext({ fresh: true, login: false });
      try {
        await fresh.page.goto(shown.ui.url);
        const notice = fresh.page.locator(".archer-compile-notice-text");
        const said = await notice.waitFor({ timeout: 15_000 }).then(
          () => notice.textContent(),
          () => null,
        );
        const link = fresh.page.locator(".archer-compile-notice").getByRole("link", { name: "Open it there" });
        const href = await link.getAttribute("href", { timeout: 2_000 }).catch(() => null);
        let landed = null;
        if (href !== null) {
          await link.click();
          await fresh.page.waitForURL(/containers-v2\.mmd/, { timeout: 10_000 }).catch(() => {});
          landed = fresh.page.url();
        }
        const ok = /moved to diagrams\/containers-v2\.mmd/i.test(said ?? "") && /containers-v2\.mmd/.test(landed ?? "");
        ui.flowCheck("U7", "renamed file: the old address says where it moved and its link lands there", ok, {
          notice: said,
          href,
          landed,
        });
      } finally {
        await fresh.context.close();
      }
    },
    { expects: [MOVED_SAID] },
  ); // the rename this journey makes, said by the page
  await ui.agentRemove("pageturner", MOVED, { settleMs: 800 });
  await flow.goal(
    "presented view and emphasis at that revision; target and revision match; the original byte-identical",
    async () => {
      expect(after === original, "the original diagram file is byte-identical").toBe(true);
      const mismatched = u9.filter((x) => !x.same);
      expect(mismatched, JSON.stringify(mismatched)).toEqual([]);
      const broken = (ctx.run.flowState?.checks ?? []).filter((c) => !c.ok);
      expect(broken, JSON.stringify(broken)).toEqual([]);
    },
  );
  await rt.check({ expects: [GONE_SAID] }); // a visited address is the deleted file's
  void at;
};
