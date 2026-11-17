// U7 navigation outcomes (user-flows rubric §3 U7, §8): the round-trip table.
//
//   const rt = roundTrip({ ui, step, run, page });
//   await rt.visit("walkthrough step 3");     // records this page's address and what it shows
//   await rt.back("diagram, Explore");         // page.goBack(): must show the entry visited before, exactly
//   await rt.inboxRow(row, threadId);          // a Notifications row must land on that exact thread
//   await rt.check();                          // every visited URL, reopened in ui.openContext({ fresh: true })
//
// What a page "shows" is `viewState(page)`: the document (path and h1), the project and document cue (h1 or the
// shell trail), the mode (the diagram panel's data-mode, ?edit's editor, ?source's panel), the walkthrough step
// ("Step n of m"), the open thread (?thread= and the open discussion) and, on a diagram, the picture (every canvas
// control's accessible name, which carries walked/current/selected state). The table is kept in run.roundTrip
// (rows: { kind, label, url, ok, diffs }); any row with diffs fails its step. Tokens never reach the table.
import { expect } from "@playwright/test";

const redact = (url) => String(url).replace(/([?&]token=)[^&#]+/g, "$1…");

/** What the page shows now, as comparable data. */
export async function viewState(page) {
  return page.evaluate(() => {
    const clean = (t) => (t ?? "").replace(/\s+/g, " ").trim();
    const u = new URL(location.href);
    const h1 = clean(document.querySelector("h1")?.textContent);
    const trail = clean(
      document.querySelector("nav[aria-label='Breadcrumb']")?.textContent ??
        document.querySelector(".primary-document-trail")?.textContent,
    );
    const panel = document.querySelector(".archer-diagram-panel[data-mode]");
    const editor = document.querySelector(
      "section[aria-label='Diagram Editor'], [role='region'][aria-label='Diagram Editor']",
    );
    const source = document.querySelector("section.archer-source-panel");
    const mode = editor
      ? "edit"
      : source
        ? "source"
        : (panel?.getAttribute("data-mode") ??
          (document.querySelector("article[aria-label^='Reading ']") ? "reading" : "page"));
    const stepText = clean(
      [...document.querySelectorAll("[role='group'][aria-label='Step controls']")].map((g) => g.textContent).join(" "),
    ).match(/Step (\d+) of (\d+)/);
    const canvas = document.querySelector(
      "[role='application'][aria-label='Diagram canvas'], [role='group'][aria-label='Sequence diagram canvas']",
    );
    const picture = canvas
      ? [...canvas.querySelectorAll("[role='button'], button")]
          .map((b) => clean(b.getAttribute("aria-label") ?? b.textContent))
          .filter(
            (n) =>
              n &&
              !/^(Zoom in|Zoom out|Fit view|Select mode|Hand mode|Source|Follow steps|Export, compare and more)$/.test(
                n,
              ),
          )
          .sort()
      : null;
    const discussion = document.querySelector("[role='region'][aria-label='Contextual discussion']");
    return {
      path: u.pathname,
      params: Object.fromEntries(
        [...u.searchParams].filter(([k]) => ["walkthrough", "step", "edit", "source", "thread", "q"].includes(k)),
      ),
      h1,
      trail,
      mode,
      step: stepText ? { n: Number(stepText[1]), of: Number(stepText[2]) } : null,
      thread: {
        address: u.searchParams.get("thread"),
        open: discussion ? clean(discussion.querySelector("p")?.textContent) : null,
      },
      picture,
    };
  });
}

/** Wait until the page has drawn what it is going to show: an h1, a drawn canvas when there is one, and two equal reads. */
export async function settled(page, { timeout = 15_000 } = {}) {
  await expect(page.locator("h1").first()).toBeVisible({ timeout });
  const deadline = Date.now() + timeout;
  let last = JSON.stringify(await viewState(page));
  for (;;) {
    await page.waitForTimeout(350);
    const now = JSON.stringify(await viewState(page));
    if (now === last || Date.now() > deadline) return JSON.parse(now);
    last = now;
  }
}

/** The fields that differ between two states (`fields`: which to compare). */
export function diffState(want, got, fields = ["path", "h1", "mode", "step", "params", "thread", "picture"]) {
  const diffs = [];
  for (const f of fields) {
    let a = want[f],
      b = got[f];
    if (f === "thread") {
      a = want.thread?.address ?? null;
      b = got.thread?.address ?? null;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push({ field: f, want: a, got: b });
  }
  return diffs;
}

/** The U7 "each page names its project and document in the shell h1 or trail" cue. */
export function namesProjectAndDocument(state, { project, document }) {
  const text = `${state.h1} ${state.trail}`;
  return (!project || text.includes(project)) && (!document || text.includes(document));
}

export function roundTrip({ ui, step, run, page }) {
  const visited = [];
  const history = []; // states in the order this page visited them (for Back)
  const table = (run.roundTrip ??= { rows: [] });
  const row = (r) => {
    table.rows.push({ ...r, url: r.url ? redact(r.url) : undefined, ok: r.diffs.length === 0 });
    return r;
  };
  const fail = (what, diffs) => {
    if (diffs.length)
      throw new Error(
        `${what}: ${diffs.map((d) => `${d.field} want ${JSON.stringify(d.want)} got ${JSON.stringify(d.got)}`).join("; ")}`,
      );
  };
  return {
    visited,
    /** Record the page's current address and state. `cue`: { project, document } names the page must show. */
    visit: (label, { cue, fields } = {}) =>
      step(
        `U7 visit: ${label}`,
        async () => {
          const state = await settled(page);
          const entry = { label, url: page.url(), state, fields };
          visited.push(entry);
          history.push(entry);
          if (cue) {
            const ok = namesProjectAndDocument(state, cue);
            row({
              kind: "cue",
              label,
              url: entry.url,
              diffs: ok ? [] : [{ field: "cue", want: cue, got: { h1: state.h1, trail: state.trail } }],
            });
            if (!ok)
              throw new Error(
                `${label}: the page does not name ${JSON.stringify(cue)} in its h1 or trail (h1 "${state.h1}", trail "${state.trail}")`,
              );
          }
          return state;
        },
        { selectionMayChange: true },
      ),
    /** page.goBack(): the page must show the entry visited before the current one, exactly. */
    back: (label) =>
      step(
        `U7 Back: ${label}`,
        async () => {
          if (history.length < 2) throw new Error("Back needs two visited entries");
          const current = history.pop();
          const want = history.at(-1);
          await page.goBack();
          const got = await settled(page);
          const diffs = diffState(want.state, got, want.fields);
          row({ kind: "back", label: `${current.label} → Back → ${want.label}`, url: page.url(), diffs });
          fail(`Back from ${current.label}`, diffs);
          return got;
        },
        { selectionMayChange: true, leavesEditor: true },
      ),
    /** Click an inbox row; the page must land on `threadId` (?thread=, or that thread's card open in place) with the open discussion or card naming `anchor`. */
    inboxRow: (rowLocator, { threadId, anchor, label = "inbox row" }) =>
      step(
        `U7 ${label} lands on its thread`,
        async () => {
          await rowLocator.click();
          const got = await settled(page);
          const diffs = [];
          if (
            threadId &&
            got.thread.address !== threadId &&
            !(await page
              .locator(
                `#primary-inbox-card-${threadId}, #archer-note-margin-${threadId}, [data-thread-id="${threadId}"]`,
              )
              .filter({ visible: true })
              .count())
          )
            diffs.push({ field: "thread", want: threadId, got: got.thread.address });
          if (anchor && !(got.thread.open ?? "").includes(anchor)) {
            const card = await page
              .locator(`#primary-inbox-card-${threadId}`)
              .textContent()
              .catch(() => null);
            if (!card?.includes(anchor)) diffs.push({ field: "anchor", want: anchor, got: got.thread.open ?? card });
          }
          row({ kind: "inbox", label, url: page.url(), diffs });
          fail(label, diffs);
          return got;
        },
        { selectionMayChange: true },
      ),
    /**
     * Reopen every visited URL in a fresh signed-in context: same document, mode and walkthrough step (and the
     * fields the visit named). `before(page)` runs in each fresh page before it opens the URL (a seeded fault
     * installs its stub route there).
     */
    check: ({ before, expects } = {}) =>
      step(
        "U7 round trip: every visited URL in a fresh signed-in context",
        async () => {
          const bad = [];
          // One fresh context per URL: no history, storage or drafts carried from another round trip (and each page is
          // its own document for the harness's per-document request checks). It is signed in with this page's session
          // cookie rather than by following the link again: each link exchange mints a session, and the service refuses
          // a 21st within a minute (MAX_SESSION_MINTS_PER_MINUTE, access-grants.ts) with a 404 (known failure O70).
          const cookies = await page.context().cookies();
          for (const v of visited) {
            const { page: fresh, context } = await ui.openContext({ fresh: true, login: false });
            await context.addCookies(cookies);
            try {
              if (before) await before(fresh);
              await fresh.goto(v.url);
              const got = await settled(fresh);
              const diffs = diffState(v.state, got, v.fields ?? ["path", "h1", "mode", "step", "params"]);
              row({ kind: "url", label: v.label, url: v.url, diffs });
              if (diffs.length)
                bad.push(
                  `${v.label}: ${diffs.map((d) => `${d.field} want ${JSON.stringify(d.want)} got ${JSON.stringify(d.got)}`).join("; ")}`,
                );
            } finally {
              await context.close().catch(() => {});
            }
          }
          if (bad.length) throw new Error(`round trip differs:\n${bad.join("\n")}`);
          return table.rows;
        },
        { selectionMayChange: true, ...(expects ? { expects } : {}) },
      ), // expects: what a visited address deliberately says (errors.mjs)
  };
}
