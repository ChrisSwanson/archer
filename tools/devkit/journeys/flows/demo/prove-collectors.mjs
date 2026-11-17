#!/usr/bin/env node
// Prove each user-flows collector on a known passing case and a seeded failing one (rubric §8: "Before a collector
// is used to score, it is shown working on a known passing case and on a known failing one").
//
//   node tools/devkit/journeys/flows/demo/prove-collectors.mjs --sandbox <name> [--only <case-prefix>…]
//
// Each case runs real journeys against the sandbox and checks what the collector reported. A case is OK when the
// collector said pass on the passing case and caught the seeded fault on the failing one. Writes prove.json under
// tools/devkit/runs/<stamp>-prove-collectors/; exit 1 if any case is not OK.
//
//   flow-metrics      J2 as pinned → matches, ratchet pass │ J2 + one seeded overhead action → ratchet fail, extra names it
//   stability         J2 ×2 → stable                        │ J2 ×2, run 2 seeded → run 1's counts differ: FAIL
//   round-trip url    J2's URLs in fresh contexts → same    │ a stub route drops ?step= → the step row differs
//   round-trip back   J2's Back → the project page          │ a route that replaces history → Back lands elsewhere
//   round-trip inbox  the corpus agent thread's row → it    │ the same row, another thread expected → flagged
//   ui.agent          list_diagrams → JSON, logged           │ read_diagram of a missing view → AgentRefusal diagram_not_found
//   flow-report       J2 against its own report → same      │ seeded J2 against it → ratchet FAIL (U2 and overhead)
//   pin rule          run.mjs on J2 as pinned → PASS, exit 0 │ run.mjs on J2 with its pin's scroll removed → FAIL, exit 1, the diff names it (O96)
//   navigations       J2 → its loads all issued, 0 unrequested │ J2 + self-reload (the page reloads itself after load) → counted, report ratchet FAIL
//   navigations link  a declared click on a real <a href>, a declared target=_blank link → issued
//                                                             │ the same link undeclared, a button running location.reload(), a tab the page opens → each counted
//   errors            J2 → 0 unseeded, row pass                │ an alert and a 500 the step did not declare → both counted, report ratchet FAIL;
//                                                             │ the same two declared ({ expects }) → expected, not counted
//   errors stale      an offline alert taken down on reconnect → not counted; its text kept in the digest (PC-601)
//                                                             │ one still shown past the condition's grace → counted once, stale
//   errors demoted    (the same-kind case is errors stale's)   │ an absorbed alert demoted to a notice (role=status, same class and
//                                                             │ text) past the grace → counted once, unseeded (codex-702)
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { RUNS, openSandbox, withPage } from "../../../harness/index.mjs";
import { AgentRefusal } from "../../../harness/agent.mjs";
import { roundTrip } from "../../../harness/round-trip.mjs";
import { cellsOf, errorsDigest, runCell, stability } from "../run.mjs";
import { CONDITION_GRACE_MS } from "../../../harness/errors.mjs";
import { buildReport, mergeRuns } from "../../../../quality/flow-report.mjs";

const { values } = parseArgs({ options: { sandbox: { type: "string" }, only: { type: "string", multiple: true } } });
if (!values.sandbox) {
  process.stderr.write("usage: prove-collectors.mjs --sandbox <name> [--only case…]\n");
  process.exit(2);
}
const sandbox = openSandbox(values.sandbox);
const out = join(RUNS, `${new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "")}-prove-collectors`);
mkdirSync(out, { recursive: true });
const J2 = await import(pathToFileURL(join(import.meta.dirname, "../j02-find-diagram.mjs")).href);
const cell = cellsOf(J2.meta)[0];
const SEED = { extraOverhead: { after: "open project Pageturner" } };
const cases = [];
const want = (name, collector, expected, observed, ok, evidence) => {
  cases.push({ name, collector, expected, observed, ok: Boolean(ok), evidence });
  process.stdout.write(`${ok ? "OK  " : "BAD "} ${name.padEnd(34)} expected ${expected}; observed ${observed}\n`);
};
const run = (prefix) => !values.only?.length || values.only.some((o) => prefix.startsWith(o));
/** flows.json-shaped wrapper around one cell's runs, for flow-report. */
const asFlows = (runs) => ({
  journeys: [
    {
      id: J2.meta.flow.id,
      name: J2.meta.name,
      baseline: J2.meta.flow.baseline,
      cells: [
        {
          ...cell,
          runs,
          stable: stability(runs.map((r) => r.flow)).stable,
          verdict: runs.every((r) => r.ok) ? "PASS" : "FAIL",
        },
      ],
    },
  ],
});

let passRuns = null,
  seededRuns = null;
if (
  run("flow-metrics") ||
  run("stability") ||
  run("round-trip url") ||
  run("round-trip back") ||
  run("flow-report") ||
  run("navigations") ||
  run("errors")
) {
  passRuns = await runCell(J2, cell, sandbox, { runs: 2, name: "prove-j02-pass" });
  seededRuns = await runCell(J2, cell, sandbox, {
    runs: 2,
    name: "prove-j02-seeded",
    seedFor: (i) => (i === 2 ? SEED : undefined),
  });
}

if (run("flow-metrics")) {
  const p = passRuns[0].flow,
    s = seededRuns[1].flow;
  want(
    "flow-metrics: pass",
    "flow-metrics.mjs",
    "matches pinned, ratchet pass, 3 essential",
    `matches ${p.comparison.matches}, ratchet ${p.comparison.ratchet}, counts ${JSON.stringify(p.counts)}`,
    passRuns[0].ok &&
      p.comparison.matches &&
      p.comparison.ratchet === "pass" &&
      p.counts.essential === 3 &&
      p.counts.overhead === 0,
    passRuns[0].summary,
  );
  want(
    "flow-metrics: seeded overhead",
    "flow-metrics.mjs",
    "ratchet fail, extra = the seeded scroll, +1 overhead",
    `ratchet ${s.comparison.ratchet}, extra ${JSON.stringify(s.comparison.extra.map((e) => e.action))}, +${s.comparison.overheadOverBaseline}`,
    s.comparison.ratchet === "fail" &&
      s.comparison.extra.length === 1 &&
      s.comparison.extra[0].action === "seeded: scroll the page" &&
      s.comparison.overheadOverBaseline === 1 &&
      s.goal?.reached,
    seededRuns[1].summary,
  );
}

if (run("stability")) {
  const a = stability(passRuns.map((r) => r.flow)),
    b = stability(seededRuns.map((r) => r.flow));
  want(
    "stability: pass",
    "flows/run.mjs",
    "stable",
    JSON.stringify(a),
    a.stable === true,
    passRuns.map((r) => r.summary),
  );
  want(
    "stability: seeded run 2",
    "flows/run.mjs",
    "not stable",
    JSON.stringify(b),
    b.stable === false && /differs/.test(b.reason),
    seededRuns.map((r) => r.summary),
  );
}

if (run("round-trip url") || run("round-trip back")) {
  const rows = passRuns[0].roundTrip?.rows ?? [];
  const urls = rows.filter((r) => r.kind === "url"),
    backs = rows.filter((r) => r.kind === "back");
  if (run("round-trip url"))
    want(
      "round-trip url: pass",
      "round-trip.mjs",
      "every URL row ok",
      `${urls.filter((r) => r.ok).length}/${urls.length} ok`,
      urls.length >= 3 && urls.every((r) => r.ok),
      passRuns[0].summary,
    );
  if (run("round-trip back"))
    want(
      "round-trip back: pass",
      "round-trip.mjs",
      "Back row ok",
      `${backs.filter((r) => r.ok).length}/${backs.length} ok`,
      backs.length >= 1 && backs.every((r) => r.ok),
      passRuns[0].summary,
    );
}

/** Run an inline journey once; returns its summary. */
const once = (name, fn, options = {}) =>
  withPage(fn, {
    name: `prove-${name}`,
    sandbox,
    invariants: { "duplicate-requests": false },
    stopOnFailure: false,
    ...options,
  });
const stepOf = (summary, title) => summary.steps.find((s) => s.title === title);

if (run("round-trip url")) {
  const walk = "diagrams/fulfilment.mmd?walkthrough=order-to-courier&step=3";
  const summary = await once("rt-url-seeded", async ({ page, step, ui, run: r, sandbox: sb }) => {
    await ui.resetProject("pageturner");
    const rt = roundTrip({ ui, step, run: r, page });
    await step("open walkthrough step 3", async () => {
      await page.goto(`${sb.origin}/projects/pageturner/${walk}`);
      await page.getByText("Step 3 of 4").first().waitFor();
    });
    await rt.visit("walkthrough step 3");
    // The seeded fault: a stub route in the fresh context that answers the step's address with a redirect dropping ?step=.
    await rt.check({
      before: (fresh) =>
        fresh.route(
          (u) => u.searchParams.get("step") === "3",
          (route) => {
            const u = new URL(route.request().url());
            u.searchParams.delete("step");
            return route.fulfill({ status: 302, headers: { location: u.toString() } });
          },
        ),
    });
  });
  const rows = summary.roundTrip?.rows.filter((x) => x.kind === "url") ?? [];
  const checkStep = stepOf(summary, "U7 round trip: every visited URL in a fresh signed-in context");
  const stepDiff = rows.flatMap((x) => x.diffs).find((d) => d.field === "step");
  want(
    "round-trip url: seeded ?step= dropped",
    "round-trip.mjs",
    "check step fails; the step row differs",
    `check ok=${checkStep?.ok}; diffs ${JSON.stringify(rows.flatMap((x) => x.diffs.map((d) => d.field)))}`,
    checkStep?.ok === false && stepDiff && stepDiff.want?.n === 3,
    summary.artifacts.summary,
  );
}

if (run("round-trip back")) {
  const summary = await once("rt-back-seeded", async ({ page, step, ui, run: r, sandbox: sb }) => {
    await ui.resetProject("pageturner");
    const rt = roundTrip({ ui, step, run: r, page });
    await step("open the project", () => page.goto(`${sb.origin}/projects/pageturner/`));
    await rt.visit("project");
    await step("open fulfilment", () => page.goto(`${sb.origin}/projects/pageturner/diagrams/fulfilment.mmd`));
    await rt.visit("fulfilment");
    // The seeded fault: a route that replaces the history entry instead of pushing one.
    await step("seeded: replace the entry with checkout", () =>
      page
        .evaluate((u) => location.replace(u), `${sb.origin}/projects/pageturner/diagrams/checkout.mmd`)
        .then(() => page.waitForURL(/checkout\.mmd/)),
    );
    await rt.visit("checkout");
    await rt.back("fulfilment");
  });
  const backRow = summary.roundTrip?.rows.find((x) => x.kind === "back");
  want(
    "round-trip back: seeded replace",
    "round-trip.mjs",
    "Back step fails; path differs",
    `back ok=${backRow?.ok}; ${JSON.stringify(backRow?.diffs?.find((d) => d.field === "path"))}`,
    backRow && backRow.ok === false && backRow.diffs.some((d) => d.field === "path"),
    summary.artifacts.summary,
  );
}

if (run("round-trip inbox")) {
  // The corpus's agent thread on note 0001 (0001-hosted-payment-page.comments.json).
  const THREAD = "t-04d24318b203",
    ANCHOR = "The Shop API creates a payment session";
  for (const seeded of [false, true]) {
    const summary = await once(
      `rt-inbox-${seeded ? "seeded" : "pass"}`,
      async ({ page, step, ui, run: r, sandbox: sb }) => {
        await ui.resetProject("pageturner");
        const rt = roundTrip({ ui, step, run: r, page });
        await step("open the project and Notifications", async () => {
          await page.goto(`${sb.origin}/projects/pageturner/`);
          await page.getByRole("button", { name: /^Notifications/ }).click();
          await page.getByRole("region", { name: "Project Review" }).waitFor();
        });
        const row = page
          .getByRole("region", { name: "Project Review" })
          .getByRole("button", { name: new RegExp(ANCHOR) })
          .first();
        // Seeded: the harness is told to expect another thread than the row's.
        await rt.inboxRow(
          row,
          seeded
            ? {
                threadId: "t-000000000000",
                anchor: "No such passage",
                label: "inbox row (seeded: another thread expected)",
              }
            : { threadId: THREAD, anchor: ANCHOR },
        );
      },
    );
    const inbox = summary.roundTrip?.rows.find((x) => x.kind === "inbox");
    if (!seeded)
      want(
        "round-trip inbox: pass",
        "round-trip.mjs",
        "row lands on its thread",
        `ok=${inbox?.ok} ${JSON.stringify(inbox?.diffs)}`,
        inbox?.ok === true,
        summary.artifacts.summary,
      );
    else
      want(
        "round-trip inbox: seeded wrong thread",
        "round-trip.mjs",
        "flagged: thread/anchor differ",
        `ok=${inbox?.ok} ${JSON.stringify(inbox?.diffs?.map((d) => d.field))}`,
        inbox && inbox.ok === false && inbox.diffs.length > 0,
        summary.artifacts.summary,
      );
  }
}

if (run("ui.agent")) {
  const summary = await once("agent", async ({ ui, step, run: r }) => {
    await step("agent: list_diagrams", async () => {
      r.proveListed = (await ui.agent("list_diagrams", {})).views?.map((v) => v.id ?? v.viewId) ?? null;
    });
    await step("agent: read_diagram of a missing view", async () => {
      try {
        await ui.agent("read_diagram", { viewId: "no-such-view" });
        r.proveRefusal = { thrown: false };
      } catch (e) {
        r.proveRefusal = { thrown: true, isRefusal: e instanceof AgentRefusal, code: e.code };
      }
      r.proveRefusalValue = await ui.agent("read_diagram", { viewId: "no-such-view" }, { refusal: true });
    });
  });
  const listed = summary.proveListed ?? [],
    calls = summary.agentCalls ?? [];
  want(
    "ui.agent: pass",
    "agent.mjs",
    "list_diagrams JSON names checkout; call logged ok",
    `views ${listed.length}, checkout ${listed.includes("checkout")}, logged ${JSON.stringify(calls[0])}`,
    listed.includes("checkout") && calls[0]?.op === "list_diagrams" && calls[0]?.ok === true,
    summary.artifacts.summary,
  );
  want(
    "ui.agent: seeded missing view",
    "agent.mjs",
    "AgentRefusal diagram_not_found; refusal:true resolves it",
    `${JSON.stringify(summary.proveRefusal)}; ${summary.proveRefusalValue?.code}`,
    summary.proveRefusal?.isRefusal &&
      summary.proveRefusal.code === "diagram_not_found" &&
      summary.proveRefusalValue?.refused &&
      calls[1]?.ok === false &&
      calls[1]?.code === "diagram_not_found",
    summary.artifacts.summary,
  );
}

if (run("flow-report")) {
  const base = buildReport(mergeRuns([asFlows(passRuns)]), null);
  const same = buildReport(mergeRuns([asFlows(passRuns)]), base);
  const worse = buildReport(mergeRuns([asFlows([seededRuns[1]])]), base);
  want(
    "flow-report: pass",
    "flow-report.mjs",
    "first round 'baseline set'; against itself no ratchet failure",
    `baselineSet ${base.baselineSet}; ratchets ${JSON.stringify(same.ratchetFailures)}; overhead row ${same.rows.find((r) => r.key === "overhead J2")?.comparison}`,
    base.baselineSet &&
      base.ratchetFailures.length === 0 &&
      same.ratchetFailures.length === 0 &&
      same.rows.find((r) => r.key === "overhead J2")?.comparison === "same",
    null,
  );
  want(
    "flow-report: seeded overhead",
    "flow-report.mjs",
    "ratchet FAIL on u2 J2 and overhead J2",
    JSON.stringify(worse.ratchetFailures),
    worse.ratchetFailures.includes("u2 J2 1440x900-immediate") && worse.ratchetFailures.includes("overhead J2"),
    null,
  );
  writeFileSync(join(out, "report-baseline.json"), JSON.stringify(base, null, 2));
  writeFileSync(join(out, "report-seeded.json"), JSON.stringify(worse, null, 2));
}

if (run("pin rule")) {
  // The real CLI, twice: J2 as it is, and a seeded copy whose pinned trace leaves out the scroll the person needs.
  const runner = join(import.meta.dirname, "../run.mjs");
  const j2 = pathToFileURL(join(import.meta.dirname, "../j02-find-diagram.mjs")).href;
  const seededFile = join(out, "j02-seeded-pin.mjs");
  writeFileSync(
    seededFile,
    `import * as J2 from ${JSON.stringify(j2)};
// Seeded fault (prove-collectors "pin rule"): J2's own pin made deliberately wrong, its first action left out. The
// journey reads its module's meta object, so the pin is changed in place (in this process only).
J2.meta.flow.baseline = J2.meta.flow.baseline.slice(1);
J2.meta.name = "prove-j02-seeded-pin";
export const meta = J2.meta;
export default J2.default;
`,
  );
  const cli = (journey, dir) => {
    const r = spawnSync(
      process.execPath,
      [runner, "--sandbox", sandbox.name, "--runs", "1", "--journey", journey, "--out", join(out, dir)],
      { encoding: "utf8", timeout: 300_000 },
    );
    let flows = null;
    try {
      flows = JSON.parse(readFileSync(join(out, dir, "flows.json"), "utf8"));
    } catch {
      /* none written */
    }
    return { status: r.status, stdout: r.stdout, cell: flows?.journeys?.[0]?.cells?.[0] ?? null };
  };
  const good = cli(join(import.meta.dirname, "../j02-find-diagram.mjs"), "pin-pass");
  want(
    "pin rule: pass",
    "flows/run.mjs",
    "PASS, pinned, exit 0",
    `${good.cell?.verdict}, pinned ${good.cell?.pinned}, exit ${good.status}`,
    good.status === 0 && good.cell?.verdict === "PASS" && good.cell?.pinned === true,
    join(out, "pin-pass", "flows.json"),
  );
  const bad = cli(seededFile, "pin-seeded");
  const missingScroll = bad.cell?.pinDiff?.[0]?.extra?.some((e) => e.action === "scroll to: open project Pageturner");
  want(
    "pin rule: seeded wrong pin",
    "flows/run.mjs",
    "FAIL, exit 1, diff '+ scroll to: open project Pageturner'",
    `${bad.cell?.verdict}, ok ${bad.cell?.runs?.[0]?.ok}, exit ${bad.status}, printed ${/\+ scroll to: open project Pageturner/.test(bad.stdout)}`,
    bad.status === 1 &&
      bad.cell?.verdict === "FAIL" &&
      bad.cell?.runs?.[0]?.ok === true &&
      missingScroll &&
      /\+ scroll to: open project Pageturner \(essential/.test(bad.stdout),
    join(out, "pin-seeded", "flows.json"),
  );
}

if (run("navigations")) {
  const n = passRuns[0].navigations;
  want(
    "navigations: pass",
    "navigations.mjs",
    "every load issued, 0 unrequested, same-document changes recorded apart",
    JSON.stringify(
      n && { documents: n.documents, issued: n.issued, unrequested: n.unrequested, sameDocument: n.sameDocument },
    ),
    n && n.documents >= 1 && n.unrequested === 0 && n.issued === n.documents && n.sameDocument >= 1,
    passRuns[0].summary,
  );
  const was = process.env.ARCHER_FLOWS_FAULT;
  process.env.ARCHER_FLOWS_FAULT = "self-reload";
  let faulted;
  try {
    faulted = await runCell(J2, cell, sandbox, { runs: 1, name: "prove-j02-self-reload" });
  } finally {
    if (was === undefined) delete process.env.ARCHER_FLOWS_FAULT;
    else process.env.ARCHER_FLOWS_FAULT = was;
  }
  const m = faulted[0].navigations;
  const report = buildReport(mergeRuns([asFlows(faulted)]), null);
  const row = report.rows.find((r) => r.key === "reloads J2");
  want(
    "navigations: seeded self-reload",
    "navigations.mjs + flow-report.mjs",
    "≥1 unrequested reload counted; reloads J2 ratchet FAIL",
    `unrequested ${m?.unrequested} ${JSON.stringify(m?.unrequestedLoads?.map((l) => l.kind))}; row ${row?.value} ${row?.comparison}`,
    m &&
      m.unrequested >= 1 &&
      m.unrequestedLoads.some((l) => l.kind === "reload") &&
      row?.comparison === "ratchet FAIL" &&
      report.ratchetFailures.includes("reloads J2"),
    faulted[0].summary,
  );
}

if (run("navigations link")) {
  const LINK = "/projects/pageturner/diagrams/checkout.mmd";
  const summary = await once("navigations-link", async ({ page, step, ui, sandbox: sb }) => {
    await ui.resetProject("pageturner");
    await step("open the project", () => page.goto(`${sb.origin}/projects/pageturner/`));
    // Test fixtures put in the page: a real link, a real link to a new tab, and a button that reloads the page.
    const plant = () =>
      page.evaluate((href) => {
        const box = document.createElement("div");
        box.id = "prove-nav";
        box.style.cssText = "position:fixed;top:0;left:0;z-index:99999;background:#fff";
        box.innerHTML = `<a id="prove-link" href="${href}">a real link</a> <a id="prove-tab" href="${href}" target="_blank">a new tab</a> <button id="prove-reload" type="button">reload</button> <button id="prove-open" type="button">open a tab later</button>`;
        document.body.append(box);
        box.querySelector("#prove-reload").addEventListener("click", () => location.reload());
        box
          .querySelector("#prove-open")
          .addEventListener("click", () => setTimeout(() => window.open(href, "_blank"), 50));
      }, LINK);
    await plant();
    await step(
      "declared: click a real link",
      async () => {
        await page.locator("#prove-link").click();
        await page.waitForURL(/checkout\.mmd/);
      },
      { navigates: LINK },
    );
    await step("open the project again", () => page.goto(`${sb.origin}/projects/pageturner/`));
    await plant();
    await step(
      "declared: click a link to a new tab",
      async () => {
        const [tab] = await Promise.all([page.context().waitForEvent("page"), page.locator("#prove-tab").click()]);
        await tab.waitForLoadState();
        await tab.close();
      },
      { navigates: true },
    );
    await step("seeded: the same link, undeclared", async () => {
      await page.locator("#prove-link").click();
      await page.waitForURL(/checkout\.mmd/);
    });
    await step("open the project a third time", () => page.goto(`${sb.origin}/projects/pageturner/`));
    await plant();
    await step("seeded: a button whose page code reloads", async () => {
      await Promise.all([page.waitForEvent("load"), page.locator("#prove-reload").click()]);
    });
    await plant();
    await step("seeded: the page opens a tab by itself", async () => {
      const [tab] = await Promise.all([page.context().waitForEvent("page"), page.locator("#prove-open").click()]);
      await tab.waitForLoadState();
      await tab.close();
    });
  });
  const n = summary.navigations;
  const by = (step) => n?.loads.filter((l) => l.step === step) ?? [];
  const issued = [...by("declared: click a real link"), ...by("declared: click a link to a new tab")];
  want(
    "navigations link: declared",
    "navigations.mjs",
    "the declared link and new-tab loads issued; no unused declaration",
    JSON.stringify(issued.map((l) => ({ tab: l.tab, issued: l.issued, by: l.issuedBy }))) +
      ` unused ${JSON.stringify(n?.unusedDeclarations)}`,
    issued.length === 2 && issued.every((l) => l.issued) && n.unusedDeclarations.length === 0,
    summary.artifacts.summary,
  );
  const counted = (n?.unrequestedLoads ?? []).map((l) => `${l.step}: ${l.kind}`);
  want(
    "navigations link: seeded",
    "navigations.mjs",
    "3 unrequested: the undeclared link, the page's reload, the tab it opened",
    JSON.stringify(counted),
    n?.unrequested === 3 &&
      by("seeded: the same link, undeclared").some((l) => !l.issued) &&
      by("seeded: a button whose page code reloads").some((l) => !l.issued && l.kind === "reload") &&
      by("seeded: the page opens a tab by itself").some((l) => !l.issued && l.kind === "first load of the tab"),
    summary.artifacts.summary,
  );
}

if (run("errors")) {
  const e = passRuns[0].errors;
  const clean = buildReport(mergeRuns([asFlows([passRuns[0]])]), null).rows.find((r) => r.key === "unseeded J2");
  want(
    "errors: pass",
    "errors.mjs + flow-report.mjs",
    "J2: 0 unseeded, 0 failures; unseeded J2 row 0, not a ratchet failure",
    `${JSON.stringify(e && { events: e.events, expected: e.expected, unseeded: e.unseeded })} failures ${passRuns[0].failures.length}; row ${clean?.value} ${clean?.comparison}`,
    e &&
      e.unseeded === 0 &&
      passRuns[0].failures.length === 0 &&
      clean?.value === 0 &&
      clean.comparison !== "ratchet FAIL",
    passRuns[0].summary,
  );
  const PROBE = "/api/prove-errors-500";
  // Test fixtures: an alert the page shows and a request the service answers 500 (a route standing in for it).
  const raise = (text) =>
    page_.evaluate((t) => {
      const a = document.createElement("div");
      a.setAttribute("role", "alert");
      a.textContent = t;
      a.style.cssText = "position:fixed;top:0;left:0;z-index:99999;background:#fff";
      document.body.append(a);
      setTimeout(() => a.remove(), 400);
    }, text);
  const fetch500 = () => page_.evaluate((u) => fetch(u).then((r) => r.status), PROBE);
  let page_;
  const summary = await once("errors", async ({ page, step, ui, sandbox: sb }) => {
    page_ = page;
    await ui.resetProject("pageturner");
    await page.route(`**${PROBE}`, (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"seeded"}' }),
    );
    await step("open the project", () => page.goto(`${sb.origin}/projects/pageturner/`));
    await step("seeded: an alert no step declared", async () => {
      await raise("Seeded: could not save");
      await page.waitForTimeout(300);
    });
    await step("seeded: a 500 no step declared", fetch500);
    await step(
      "declared: the same alert and 500",
      async () => {
        await raise("Seeded: could not save");
        await page.waitForTimeout(300);
        await fetch500();
      },
      {
        expects: [
          { kind: "alert", text: "Seeded: could not save" },
          { kind: "http", status: 500, url: PROBE },
        ],
      },
    );
    await step("a step after the declared one", () => page.waitForTimeout(200));
  });
  const c = summary.errors;
  const of = (step) => (c?.all ?? []).filter((x) => x.step === step);
  const undeclared = [...of("seeded: an alert no step declared"), ...of("seeded: a 500 no step declared")];
  const declared = of("declared: the same alert and 500");
  const report = buildReport(
    mergeRuns([asFlows([{ run: 1, ok: true, flow: passRuns[0].flow, failures: [], errors: errorsDigest(c) }])]),
    null,
  );
  const row = report.rows.find((r) => r.key === "unseeded J2");
  want(
    "errors: seeded undeclared",
    "errors.mjs + flow-report.mjs",
    "the alert and the 500 counted unseeded; unseeded J2 ratchet FAIL",
    `${JSON.stringify(undeclared.map((x) => [x.kind, x.status ?? x.text, x.expected]))}; unseeded ${c?.unseeded}; row ${row?.value} ${row?.comparison}`,
    undeclared.some((x) => x.kind === "alert" && !x.expected) &&
      undeclared.some((x) => x.kind === "http" && x.status === 500 && !x.expected) &&
      c.unseeded === 2 &&
      row?.comparison === "ratchet FAIL" &&
      report.ratchetFailures.includes("unseeded J2"),
    summary.artifacts.summary,
  );
  want(
    "errors: declared",
    "errors.mjs",
    "the declared alert and 500 expected; no unused declaration",
    `${JSON.stringify(declared.map((x) => [x.kind, x.expected, x.expectedBy]))}; unused ${JSON.stringify(c?.unusedDeclarations)}`,
    declared.length === 2 && declared.every((x) => x.expected) && c.unusedDeclarations.length === 0,
    summary.artifacts.summary,
  );
}

if (run("errors stale")) {
  // An offline alert the page leaves up after reconnecting (claude-602) was absorbed by the condition and never seen
  // again (PC-601). Two alerts the condition causes: one taken down on reconnect, one left up past the grace.
  const show = (pg, text, id) =>
    pg.evaluate(
      ([t, i]) => {
        const a = document.createElement("div");
        a.setAttribute("role", "alert");
        a.dataset.prove = i;
        a.textContent = t;
        a.style.cssText = "position:fixed;top:0;left:0;z-index:99999;background:#fff";
        document.body.append(a);
      },
      [text, id],
    );
  const STAYS = "Seeded: Archer did not answer.",
    GOES = "Seeded: could not reach Archer.";
  const summary = await once("errors-stale", async ({ page, step, ui, sandbox: sb }) => {
    await ui.resetProject("pageturner");
    await step("open the project", () => page.goto(`${sb.origin}/projects/pageturner/`));
    await ui.setOffline(true);
    await step("offline: two alerts the condition causes", async () => {
      await show(page, STAYS, "stays");
      await show(page, GOES, "goes");
      await page.waitForTimeout(300);
    });
    await ui.setOffline(false);
    await step("online: one alert is taken down", () =>
      page.evaluate(() => document.querySelector('[data-prove="goes"]')?.remove()),
    );
    await step("past the condition's grace", () => page.waitForTimeout(CONDITION_GRACE_MS + 1000));
    await step("a step after", () => page.waitForTimeout(200));
  });
  const c = summary.errors;
  const stale = (c?.all ?? []).filter((x) => x.stale);
  const absorbed = errorsDigest(c)?.absorbed ?? [];
  const kept = [STAYS, GOES].every((t) =>
    absorbed.some((a) => a.kind === "alert" && a.text === t && a.by === "condition: browser offline"),
  );
  want(
    "errors stale: taken down, kept",
    "errors.mjs + run.mjs",
    "the alert taken down on reconnect not counted; both texts in the digest's absorbed list",
    `stale ${JSON.stringify(stale.map((x) => x.text))}; absorbed ${JSON.stringify(absorbed.map((a) => [a.kind, a.text.slice(0, 40), a.by]))}`,
    kept && !stale.some((x) => x.text === GOES),
    summary.artifacts.summary,
  );
  want(
    "errors stale: still shown",
    "errors.mjs",
    "the alert left up past the grace counted once, unseeded, as stale",
    `${JSON.stringify(stale.map((x) => [x.step, x.text, x.expected, x.stale]))}; unseeded ${c?.unseeded}`,
    stale.length === 1 &&
      stale[0].text === STAYS &&
      !stale[0].expected &&
      stale[0].stale === "condition: browser offline" &&
      stale[0].step === "past the condition's grace" &&
      c.unseeded === 1,
    summary.artifacts.summary,
  );
}

if (run("errors demoted")) {
  // codex-702: the same element still shown, but its role changed from alert to status with its class and text kept.
  // Followed by its kind and text only, the census lost it: the notice matched no earlier event, so no recheck was owed.
  const DEMOTED = "Seeded: Archer did not answer, demoted.";
  const summary = await once("errors-demoted", async ({ page, step, ui, sandbox: sb }) => {
    await ui.resetProject("pageturner");
    await step("open the project", () => page.goto(`${sb.origin}/projects/pageturner/`));
    await ui.setOffline(true);
    await step("offline: an alert the condition causes", async () => {
      await page.evaluate((t) => {
        const a = document.createElement("p");
        a.className = "authoring-error";
        a.setAttribute("role", "alert");
        a.dataset.prove = "demoted";
        a.textContent = t;
        a.style.cssText = "position:fixed;top:0;left:0;z-index:99999;background:#fff";
        document.body.append(a);
      }, DEMOTED);
      await page.waitForTimeout(300);
    });
    await ui.setOffline(false);
    await step("past the condition's grace, the alert demoted to a notice", async () => {
      await page.waitForTimeout(CONDITION_GRACE_MS + 1000);
      await page.evaluate(() => document.querySelector('[data-prove="demoted"]')?.setAttribute("role", "status"));
      await page.waitForTimeout(200);
    });
    await step("a step after", () => page.waitForTimeout(200));
  });
  const c = summary.errors;
  const unseeded = c?.unseededEvents ?? [];
  want(
    "errors demoted: still shown",
    "errors.mjs",
    "the absorbed alert demoted to a notice past the grace counted once, unseeded",
    `${JSON.stringify(unseeded.map((x) => [x.step, x.kind, x.text, x.stale ?? null]))}; unseeded ${c?.unseeded}`,
    c?.unseeded === 1 && unseeded[0]?.kind === "notice" && unseeded[0]?.text === DEMOTED,
    summary.artifacts.summary,
  );
}

writeFileSync(
  join(out, "prove.json"),
  JSON.stringify(
    { schema: "archer-flow-prove/1", at: new Date().toISOString(), sandbox: sandbox.name, cases },
    null,
    2,
  ),
);
const bad = cases.filter((c) => !c.ok);
process.stdout.write(
  `${cases.length - bad.length}/${cases.length} cases behaved as expected\nprove.json: ${join(out, "prove.json")}\n`,
);
process.exitCode = bad.length ? 1 : 0;
