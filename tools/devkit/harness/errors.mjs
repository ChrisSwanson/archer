// The error census of a run (rubric docs/quality/rubrics/user-flows.md §5 "Unseeded errors": per journey,
// `failures[]`, alerts and refusals outside seeded steps, ratcheted at 0), written to `summary.errors`. In the style of
// navigations.mjs: every page of every context the run opens is watched, and every event is marked expected or not.
//
// What it records:
//   alert       an element with role="alert" or aria-live="assertive" that appears, or whose text changes, with text
//               (found in the page by a MutationObserver installed in every document)
//   notice      an element the page marks as an error notice (a class naming `error`: authoring-error,
//               archer-review-error …) that appears or changes, with text
//   http        an answer with status 400 or more
//   failed      a request that failed (no answer); a cancelled one (net::ERR_ABORTED: a page leaving, a stream
//               closed) is not an error
//   console     a console.error ("Failed to load resource" lines are the browser's echo of an http/failed event and
//               are not counted twice)
//   pageerror   an uncaught exception in the page
//   refusal     a refused edit in the service log (svc.edit-refused, svc.edit-postcondition), given by the step
// The harness's own traffic (/-/debug/ telemetry) is left out.
//
// Expected, not unseeded:
//   - declared by the step that deliberately causes it: `step(title, fn, { expects: [...] })` (or `flow.act(…, { expects })`).
//     An entry is a kind ("alert", "http", …) or `{ kind, text?, url?, status? }` (RegExp or string matchers). A
//     declaration covers its step and GRACE_MS after it, never once the next step has started; one that matched
//     nothing is listed (`unusedDeclarations`).
//   - caused by a harness condition the journey seeds: the browser offline, the network stalled, the service stopped
//     or restarting (`condition(label, expects)` … `close()`, then CONDITION_GRACE_MS while the page reconnects), and
//     a request whose answer the harness dropped on purpose (`dropped(request)`).
//   - anything else is unseeded: `unseeded` is the count, `unseededEvents[]` names each with its step and text.
// Stale (PC-601): an alert or notice is recorded when it appears or changes, not while it stays. At the end of each step
// (`stepEnded`), one still shown that a condition absorbed, once that condition and its grace have ended, is recorded
// again, once, with `stale` naming the condition: expected only if a window open then expects it (the step declares it).
// Each is followed by its element (codex-702): one that changes kind but keeps its text (an alert demoted to a notice) is
// reported again as what it is now, and the end-of-step look matches the element, not its kind and text.
// The per-run digest keeps the absorbed texts (`absorbed`: kind, text, what absorbed it, how often), not only counts.
//
//   const census = errorCensus({ stepTitle: () => current });
//   await census.watch(context);             // every context, before its pages open
//   const off = census.condition("browser offline", ["failed", "console", "alert"]); … off();
//   summary.errors = census.summary();
import { cleanUrl } from "./navigations.mjs";

export const ERRORS_SCHEMA = "archer-errors/1";
export const KINDS = ["alert", "notice", "http", "failed", "console", "pageerror", "refusal"];
export const GRACE_MS = 1000;
export const CONDITION_GRACE_MS = 8000;

// What each seeded condition causes, as narrowly as the page says it: a real bug inside a condition's window (a stale
// alert, a 404, a page error) is still counted. From the first census matrix (flows fix r5b): every event a condition
// absorbed there is one of these, except the ones that were bugs or a step's own doing (O157, J9d).
const LOST =
  /reconnect|did not answer|may have been sent|not known|uncertain|offline|could not reach|not (?:yet )?(?:sent|saved)/i;
const FETCH =
  /Failed to fetch|NetworkError|ERR_(?:INTERNET_DISCONNECTED|CONNECTION_REFUSED|CONNECTION_RESET|ADDRESS_UNREACHABLE|EMPTY_RESPONSE)/;
const said = [
  { kind: "alert", text: LOST },
  { kind: "notice", text: LOST },
  { kind: "console", text: FETCH },
];
const DOWN = /ERR_(?:CONNECTION_REFUSED|CONNECTION_RESET|EMPTY_RESPONSE|INCOMPLETE_CHUNKED_ENCODING)/;
const service = [{ kind: "failed", text: DOWN }, { kind: "http", status: /^50[234]$/ }, ...said];
export const CAUSES = {
  "browser offline": [
    { kind: "failed", text: /ERR_(?:INTERNET_DISCONNECTED|CONNECTION_RESET|NETWORK_CHANGED)/ },
    ...said,
  ],
  "network stalled": [{ kind: "failed", text: /ERR_(?:ADDRESS_UNREACHABLE|TIMED_OUT|CONNECTION_RESET)/ }, ...said],
  "service down": service,
  "service restarting": service,
  "service killed": service,
  "an answer the harness dropped": said,
};

const test = (m, value) =>
  m === undefined || (m instanceof RegExp ? m.test(String(value ?? "")) : String(value ?? "").includes(String(m)));
/** A declaration entry → { kind, text, url, status }. */
export function expectation(entry) {
  if (typeof entry === "string") {
    if (!KINDS.includes(entry)) throw new Error(`expects: unknown kind ${entry}; one of ${KINDS.join(", ")}`);
    return { kind: entry };
  }
  if (!entry || !KINDS.includes(entry.kind))
    throw new Error(`expects: an entry needs kind, one of ${KINDS.join(", ")}`);
  return entry;
}
/** Does an event match one expectation? */
export function matches(e, x) {
  if (x.kind !== e.kind) return false;
  if (x.status !== undefined && (typeof x.status === "number" ? x.status !== e.status : !test(x.status, e.status)))
    return false;
  return test(x.text, e.text) && test(x.url, e.url);
}

/** In every document: report alerts and error notices as they appear or change (exposed binding __harnessError). */
export function alertWatch() {
  if (window.__harnessAlertWatch) return;
  window.__harnessAlertWatch = true;
  // Per element (codex-702): what it was last reported as, kind and text, and its identity, so a role change that keeps
  // the text (an alert demoted to a notice) is reported, and the census's end-of-step look follows the element.
  const last = new WeakMap(),
    ids = new WeakMap();
  const doc = Math.random().toString(36).slice(2, 8);
  let nextId = 0;
  const idOf = (el) => {
    if (!ids.has(el)) ids.set(el, `${doc}:${++nextId}`);
    return ids.get(el);
  };
  const SELECTOR = '[role="alert"], [aria-live="assertive"], [class*="error"]';
  const kindOf = (el) =>
    el.getAttribute("role") === "alert" || el.getAttribute("aria-live") === "assertive"
      ? "alert"
      : /(^|[\s_-])error($|[\s_-])/.test(el.className && typeof el.className === "string" ? el.className : "")
        ? "notice"
        : null;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
  };
  const look = (el) => {
    const kind = kindOf(el);
    if (!kind) return;
    // An error notice inside an alert is the alert's own text: reported once, as the alert.
    if (kind === "notice" && el.closest('[role="alert"], [aria-live="assertive"]')) return;
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (!text || !visible(el)) {
      last.delete(el);
      return;
    }
    const seen = `${kind}\n${text}`;
    if (last.get(el) === seen) return;
    last.set(el, seen);
    try {
      window.__harnessError?.({
        kind,
        text,
        el: idOf(el),
        cls: (typeof el.className === "string" ? el.className : "").slice(0, 80),
        role: el.getAttribute("role"),
      });
    } catch {
      /* page closing */
    }
  };
  // What is shown now, for the census's end-of-step look (PC-601).
  window.__harnessShownErrors = () =>
    [...document.querySelectorAll(SELECTOR)].flatMap((el) => {
      const kind = kindOf(el);
      if (!kind || (kind === "notice" && el.closest('[role="alert"], [aria-live="assertive"]'))) return [];
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
      return text && visible(el) ? [{ kind, text, el: idOf(el) }] : [];
    });
  let queued = false;
  const scan = () => {
    queued = false;
    for (const el of document.querySelectorAll(SELECTOR)) look(el);
  };
  const schedule = () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(scan);
    }
  };
  const start = () => {
    new MutationObserver(schedule).observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["role", "class", "aria-live", "hidden", "style"],
    });
    schedule();
  };
  if (document.documentElement) start();
  else addEventListener("DOMContentLoaded", start, { once: true });
}

export function errorCensus({ stepTitle = () => null, now = () => Date.now() } = {}) {
  const events = [],
    windows = [];
  const tabs = new WeakMap();
  let tabCount = 0;
  const dropped = new WeakSet();
  const tabOf = (pg) => {
    if (!pg) return "(context)";
    if (!tabs.has(pg)) tabs.set(pg, `p${++tabCount}`);
    return tabs.get(pg);
  };
  const watched = new WeakSet();
  const pages = [];
  const claimedBy = new WeakMap(); // event → the window that absorbed it
  const staleSeen = new WeakSet(); // events already recorded again as stale

  /** The open window that expects `e` now: a step's declaration first, then a seeded condition. */
  const claim = (e) => {
    const live = windows.filter(
      (w) =>
        e.at >= w.opened &&
        (w.closedAt === null || (w.grace > 0 && e.at <= w.closedAt + w.grace)) &&
        w.expects.some((x) => matches(e, x)),
    );
    const w = live.find((x) => x.declared) ?? live[0];
    if (w) {
      w.used++;
      claimedBy.set(e, w);
    }
    return w ?? null;
  };
  const add = (pg, e) => {
    const rec = { tab: tabOf(pg), at: now(), step: stepTitle(), ...e };
    if (rec.url) rec.url = cleanUrl(rec.url);
    const w = rec.seededBy ? null : claim(rec);
    rec.expected = Boolean(rec.seededBy) || w !== null;
    rec.expectedBy = rec.seededBy ?? w?.label ?? null;
    delete rec.seededBy;
    events.push(rec);
    return rec;
  };
  const harness = (url) => /\/-\/debug\//.test(url);
  const pageOf = (r) => {
    try {
      return r.frame().page();
    } catch {
      return null;
    }
  };
  const onResponse = (res) => {
    const status = res.status();
    if (status < 400 || harness(res.url())) return;
    add(pageOf(res.request()), {
      kind: "http",
      status,
      method: res.request().method(),
      url: res.url(),
      text: `${res.request().method()} ${status}`,
    });
  };
  const onFailed = (r) => {
    const failure = r.failure()?.errorText ?? "failed";
    if (/ERR_ABORTED/.test(failure) || harness(r.url())) return;
    add(pageOf(r), {
      kind: "failed",
      method: r.method(),
      url: r.url(),
      text: failure,
      ...(dropped.has(r) ? { seededBy: "an answer the harness dropped" } : {}),
    });
  };
  const watchPage = (pg) => {
    if (watched.has(pg)) return;
    watched.add(pg);
    pages.push(pg);
    tabOf(pg);
    pg.on("console", (m) => {
      if (m.type() !== "error") return;
      const text = m.text();
      if (/^Failed to load resource\b/.test(text)) return;
      add(pg, { kind: "console", text: text.slice(0, 300) });
    });
    pg.on("pageerror", (e) => add(pg, { kind: "pageerror", text: String(e.message ?? e).slice(0, 300) }));
  };

  const census = {
    /** Connect a context: its requests, its pages now and later, and the alert watch in its documents. */
    async watch(context) {
      context.on("response", onResponse);
      context.on("requestfailed", onFailed);
      for (const pg of context.pages()) watchPage(pg);
      context.on("page", watchPage);
      await context
        .exposeBinding("__harnessError", (source, e) => {
          if (!e || (e.kind !== "alert" && e.kind !== "notice")) return;
          add(source.page ?? null, {
            kind: e.kind,
            text: String(e.text ?? "").slice(0, 300),
            ...(e.el ? { el: String(e.el) } : {}),
            ...(e.cls ? { cls: e.cls } : {}),
          });
        })
        .catch(() => {});
      await context.addInitScript(alertWatch);
    },
    /** The harness's tab names (t0 first), as navigations.mjs. */
    name(pg, tab) {
      const was = tabs.get(pg),
        next = `t${tab}`;
      tabs.set(pg, next);
      if (was && was !== next) for (const e of events) if (e.tab === was) e.tab = next;
    },
    /** The refused edits the service log gave for the step running now (index.mjs step). */
    refusals(list, expects = []) {
      const declared = (expects ?? []).map(expectation);
      for (const r of list) {
        const e = { kind: "refusal", text: `${r.code}${r.refusal ? ` ${r.refusal}` : ""}${r.op ? ` (${r.op})` : ""}` };
        if (!declared.some((x) => matches(e, x))) {
          add(null, e);
          continue;
        }
        const w = windows.findLast((x) => x.declared && x.expects.some((y) => matches(e, y)));
        if (w) w.used += 1;
        add(null, { ...e, seededBy: w?.label ?? `step: ${stepTitle() ?? "declared"}` });
      }
    },
    /** A request whose answer the harness drops on purpose (dropResponseAfterCommit): its failure is seeded. */
    // The page's own word that the answer was lost (an alert, a notice, a console line) comes after its retries give up,
    // often once the step has ended: expected for a condition's grace from the drop, as for offline.
    dropped(request) {
      dropped.add(request);
      census.condition("an answer the harness dropped", CAUSES["an answer the harness dropped"])();
    },
    /** A seeded condition (offline, stalled, service down): what it causes is expected until `close()` and a grace after. */
    condition(label, expects) {
      const w = {
        label: `condition: ${label}`,
        expects: expects.map(expectation),
        grace: CONDITION_GRACE_MS,
        used: 0,
        opened: now(),
        closedAt: null,
        declared: false,
      };
      windows.push(w);
      return () => {
        if (w.closedAt === null) w.closedAt = now();
      };
    },
    /** Run `fn` with the step's declaration of what it deliberately causes. */
    async declared(expects, fn, label = stepTitle() ?? "declared") {
      if (!expects?.length) return fn();
      const w = {
        label: `step: ${label}`,
        expects: expects.map(expectation),
        grace: GRACE_MS,
        used: 0,
        opened: now(),
        closedAt: null,
        declared: true,
      };
      windows.push(w);
      try {
        return await fn();
      } finally {
        w.closedAt = now();
      }
    },
    /**
     * A step ends (PC-601): an alert or notice still shown in any open page, which a condition absorbed when it appeared,
     * once that condition and its grace have ended, is recorded again, once, as stale.
     */
    async stepEnded() {
      for (const pg of pages) {
        if (pg.isClosed?.()) continue;
        let shown = [];
        try {
          shown = (await pg.evaluate(() => window.__harnessShownErrors?.() ?? [])) ?? [];
        } catch {
          continue;
        }
        const at = now(),
          tab = tabOf(pg);
        for (const x of shown) {
          // The element's own last report (codex-702): one that changed kind keeps its history; by kind and text when the
          // page gave no identity.
          const first = x.el
            ? events.findLast((e) => e.tab === tab && e.el === x.el)
            : events.findLast((e) => e.tab === tab && e.kind === x.kind && e.text === x.text);
          const w = first && claimedBy.get(first);
          if (!w || w.declared || w.closedAt === null || at <= w.closedAt + w.grace || staleSeen.has(first)) continue;
          staleSeen.add(first);
          add(pg, { kind: x.kind, text: x.text, ...(x.el ? { el: x.el } : {}), stale: w.label });
        }
      }
    },
    /** A step starts: an earlier step's declaration expects nothing more. */
    stepStarted() {
      for (const w of windows) if (w.declared && w.closedAt !== null) w.grace = 0;
    },
    summary({ failures = [] } = {}) {
      const unseeded = events.filter((e) => !e.expected);
      const byKind = Object.fromEntries(KINDS.map((k) => [k, unseeded.filter((e) => e.kind === k).length]));
      return {
        schema: ERRORS_SCHEMA,
        events: events.length,
        expected: events.length - unseeded.length,
        unseeded: unseeded.length,
        failures: failures.length,
        unseededByKind: byKind,
        unseededEvents: unseeded.map(({ tab, step, kind, text, url, status, stale }) => ({
          tab,
          step,
          kind,
          text,
          ...(url ? { url } : {}),
          ...(status ? { status } : {}),
          ...(stale ? { stale } : {}),
        })),
        unusedDeclarations: windows.filter((w) => w.declared && w.used === 0).map((w) => w.label),
        all: events,
      };
    },
  };
  return census;
}

/**
 * One line of words for a harness failure or warning (PC-18): the packet's digests kept `message`, which the harness
 * never wrote (its entries carry `error` or `details`), so every digest warning read "". From an action's error, an
 * invariant's details (a list of telemetry/service warnings: `code: msg`, a reason, or the details as JSON), or a string.
 */
export function issueMessage(w) {
  if (!w || typeof w !== "object") return String(w ?? "");
  if (typeof w.message === "string" && w.message) return w.message.slice(0, 300);
  if (typeof w.error === "string" && w.error) return w.error.split("\n")[0].slice(0, 300);
  const d = w.details;
  if (d === undefined || d === null)
    return w.invariant ? `invariant ${w.invariant}` : (w.kind ?? w.code ?? "unexplained");
  if (typeof d === "string") return d.slice(0, 300);
  const one = (x) =>
    x && typeof x === "object"
      ? [x.code, x.msg ?? x.message ?? x.reason ?? x.text].filter(Boolean).join(": ") || JSON.stringify(x)
      : String(x);
  if (Array.isArray(d)) {
    const parts = d.slice(0, 5).map(one);
    return `${parts.join("; ")}${d.length > 5 ? `; and ${d.length - 5} more` : ""}`.slice(0, 300);
  }
  if (typeof d.reason === "string") return d.reason.slice(0, 300);
  return JSON.stringify(d).slice(0, 300);
}
