// The navigation census of a run (rubric docs/quality/rubrics/user-flows.md §5 "Unrequested reloads": navigations
// the journey didn't issue, from the harness's navigations, ratcheted at 0), written to `summary.navigations`.
//
// It records every main-frame document load in every page of every context the run opens (the first page, ui.newTab,
// ui.openContext, duplicated tabs, and tabs the page opens itself), from the browser's navigation requests: a
// full-document load counts, whatever its outcome (loaded, failed, an error page, no content); a redirect hop is part
// of the load that followed it. Same-document changes (pushState, replaceState, a hash) do not count; they are
// recorded separately (`sameDocument`).
//
// Each load is marked issued or not:
//   - issued by the harness API: a load that starts while the journey's own page.goto / reload / goBack / goForward
//     on that page is running (Page methods, wrapped once per process);
//   - declared by the journey step: `step(title, fn, { navigates: true })` (or `flow.act(…, { navigates: true })`)
//     says the step's own action opens a document (a click on a real <a href>, a submitted form, a duplicated tab).
//     `navigates` may be a RegExp or a string the load's address must match, or `{ url, count }`; a declaration
//     absorbs at most `count` loads (default 1), starting in the step or within GRACE_MS after it ends (never once the
//     next step has started: `stepStarted`). A declaration
//     that absorbed nothing is listed (`unusedDeclarations`): a stale one is visible, never a silent allowance.
//   - anything else is unrequested: the page reloading or navigating itself, a link click the step did not declare,
//     a tab the page opened by itself. `unrequested` is the count; `documents[]` names each with its step and address.
//
// Attribution is decided when the load's request starts, not from what its address looks like: a load the page starts
// itself during a long wait is never absorbed by an earlier step's goto. Addresses are written without credentials
// (long opaque path segments and query values are replaced with "…").
//
//   const census = navigationCensus({ stepTitle: () => current });
//   census.watch(context);                       // every context, before its pages open
//   await census.declared({ url: /\/p\// }, () => link.click());
//   summary.navigations = census.summary();
export const NAVIGATION_SCHEMA = "archer-navigations/1";
/** How long after a declared step ends its declaration still absorbs a load that has not started yet. */
export const GRACE_MS = 1000;

const bare = (u) => String(u).split("#")[0];
const OPAQUE = /^[A-Za-z0-9_~.-]{24,}$/;

/** An address with no credentials in it: long opaque path segments and query values, and any hash with a value, become "…". */
export function cleanUrl(u) {
  let url;
  try {
    url = new URL(u);
  } catch {
    return String(u).slice(0, 200);
  }
  if (!/^https?:$/.test(url.protocol)) return `${url.protocol}${url.pathname}`.slice(0, 200);
  const path = url.pathname
    .split("/")
    .map((s) => (OPAQUE.test(s) ? "…" : s))
    .join("/");
  const query = [...url.searchParams]
    .map(([k, v]) => (v === "" ? k : `${k}=${v.length >= 20 || OPAQUE.test(v) ? "…" : v}`))
    .join("&");
  const hash = url.hash && !url.hash.includes("=") && url.hash.length < 40 ? url.hash : url.hash ? "#…" : "";
  return `${url.origin}${path}${query ? `?${query}` : ""}${hash}`;
}

const CENSUS = new WeakMap(); // BrowserContext → its census
const WRAP = Symbol.for("archer.navigationWatch");
const ISSUING = ["goto", "reload", "goBack", "goForward"];

/** Wrap Page's navigation methods (once per process) so a load they start is marked issued by the journey. */
export function installNavigationWatch(page) {
  const proto = Object.getPrototypeOf(page);
  if (proto[WRAP]) return;
  proto[WRAP] = true;
  for (const name of ISSUING) {
    const original = proto[name];
    if (typeof original !== "function") continue;
    proto[name] = async function issuing(...args) {
      const census = CENSUS.get(this.context());
      if (!census) return original.apply(this, args);
      const w = census.open({
        page: this,
        label: `page.${name}${name === "goto" ? ` ${cleanUrl(args[0])}` : ""}`,
        grace: 0,
        count: Infinity,
      });
      try {
        return await original.apply(this, args);
      } finally {
        census.close(w);
      }
    };
  }
}

const matcher = (url) =>
  url === undefined || url === true
    ? () => true
    : url instanceof RegExp
      ? (u) => url.test(u)
      : (u) => bare(u) === bare(url) || u.includes(String(url));

/** The `navigates` option of a step → a declaration ({ url, count }), or null. */
export function declarationOf(navigates) {
  if (navigates === undefined || navigates === false || navigates === null) return null;
  if (navigates === true || typeof navigates === "string" || navigates instanceof RegExp)
    return { url: navigates, count: 1 };
  return { url: navigates.url, count: navigates.count ?? 1 };
}

/**
 * One run's census. `stepTitle()` names the step running now (null between steps). Pure bookkeeping over
 * Playwright's events; `watch(context)` connects one context.
 */
export function navigationCensus({ stepTitle = () => null, now = () => Date.now() } = {}) {
  const documents = [],
    sameDocument = [],
    windows = [];
  const tabs = new WeakMap();
  let tabCount = 0;
  const pages = new WeakMap(); // page → { current: committed address | null }
  const records = new WeakMap(); // navigation request (every hop) → its document record
  // The harness names its tabs (t0 is the first page, then ui.newTab / openContext / duplicateTab in order); a page
  // it has not named yet (one the page opened, or one whose first load started before it was attached) is p1, p2…
  const tabOf = (pg) => {
    if (!tabs.has(pg)) tabs.set(pg, `p${++tabCount}`);
    return tabs.get(pg);
  };
  const stateOf = (pg) => {
    if (!pages.has(pg)) pages.set(pg, { current: null, records: [] });
    return pages.get(pg);
  };

  /** The open window that issued a load starting now on `pg` at `url`: the page's own goto first, then a declaration. */
  const claim = (pg, url, at) => {
    const live = windows.filter(
      (w) =>
        w.used < w.count &&
        at >= w.opened &&
        (w.closedAt === null || (w.grace > 0 && at <= w.closedAt + w.grace)) &&
        (w.page === null || w.page === pg) &&
        w.test(url),
    );
    const w = live.find((x) => x.page !== null) ?? live[0];
    if (w) w.used++;
    return w ?? null;
  };

  // A new tab's first load can be requested before its frame exists (Playwright: request.frame() then throws): it is
  // recorded with no tab yet, and given to the tab whose main frame commits its address first.
  const unframed = [];
  const onRequest = (r) => {
    if (!r.isNavigationRequest()) return;
    let frame = null;
    try {
      frame = r.frame();
    } catch {
      frame = null;
    } // a service worker's request, or a new tab's first load
    const pg = frame?.page() ?? null;
    if (frame !== null && (!pg || frame !== pg.mainFrame())) return; // a frame inside the page
    if (frame === null && r.serviceWorker?.()) return;
    const from = r.redirectedFrom();
    if (from && records.has(from)) {
      const rec = records.get(from);
      records.set(r, rec);
      rec.url = cleanUrl(r.url());
      rec.redirects++;
      return;
    }
    const st = pg ? stateOf(pg) : null,
      at = now();
    const w = claim(pg, r.url(), at);
    const rec = {
      tab: pg ? tabOf(pg) : "new tab",
      at,
      step: stepTitle(),
      url: cleanUrl(r.url()),
      method: r.method(),
      kind:
        st === null || st.current === null
          ? "first load of the tab"
          : bare(r.url()) === bare(st.current)
            ? "reload"
            : "navigate",
      issued: w !== null,
      issuedBy: w?.label ?? null,
      outcome: "started",
      redirects: 0,
    };
    documents.push(rec);
    records.set(r, rec);
    if (st) st.records.push({ rec, url: r.url() });
    else unframed.push({ rec, url: r.url() });
  };
  const onResponse = (res) => {
    const rec = records.get(res.request());
    if (!rec) return;
    const status = res.status();
    if (status >= 300 && status < 400) return; // a redirect hop: the next request continues it
    rec.status = status;
    rec.outcome = status === 204 || status === 205 ? "no content" : "answered";
  };
  const onFailed = (r) => {
    const rec = records.get(r);
    if (rec) rec.outcome = `failed: ${r.failure()?.errorText ?? "unknown"}`;
  };
  const watchPage = (pg) => {
    if (pages.has(pg) && pages.get(pg).watched) return;
    const st = stateOf(pg);
    st.watched = true;
    tabOf(pg);
    installNavigationWatch(pg);
    pg.on("framenavigated", (f) => {
      if (f !== pg.mainFrame()) return;
      const url = f.url();
      if (url.startsWith("chrome-error:")) {
        const last = st.records.at(-1);
        if (last) last.rec.outcome = `${last.rec.outcome}, error page shown`;
        return;
      }
      const i = st.records.findIndex(
        (x) => !x.rec.committed && x.rec.outcome === "answered" && bare(x.url) === bare(url),
      );
      if (i >= 0) {
        st.records[i].rec.committed = true;
        st.records.splice(0, i + 1);
        st.current = url;
        return;
      }
      // A load whose answer is not seen yet (a page's first load, seen before its 'page' event): its address commits it.
      const j = st.records.findIndex((x) => !x.rec.committed && bare(x.url) === bare(url));
      if (j >= 0) {
        st.records[j].rec.committed = true;
        st.records.splice(0, j + 1);
        st.current = url;
        return;
      }
      if (st.current === null) {
        const k = unframed.findIndex((x) => !x.rec.committed && bare(x.url) === bare(url));
        if (k >= 0) {
          const [x] = unframed.splice(k, 1);
          x.rec.committed = true;
          x.rec.tab = tabOf(pg);
          x.rec.page = pg;
          st.current = url;
          return;
        }
      }
      if (url === "about:blank" && st.current === null) return;
      sameDocument.push({ tab: tabOf(pg), at: now(), step: stepTitle(), url: cleanUrl(url) });
      st.current = url;
    });
  };

  const census = {
    /** Connect a context: its requests, its pages now and later. Call before its first page opens. */
    watch(context) {
      if (CENSUS.get(context) === census) return;
      CENSUS.set(context, census);
      context.on("request", onRequest);
      context.on("response", onResponse);
      context.on("requestfailed", onFailed);
      for (const pg of context.pages()) watchPage(pg);
      context.on("page", watchPage);
    },
    /** A tab's name in the census (t0 is the run's first page), given by the harness in its own order. */
    name(pg, tab) {
      const was = tabs.get(pg),
        now_ = `t${tab}`;
      tabs.set(pg, now_);
      if (was && was !== now_) for (const r of [...documents, ...sameDocument]) if (r.tab === was) r.tab = now_;
    },
    /** A step starts: an earlier step's declaration absorbs nothing more. */
    stepStarted() {
      for (const w of windows) if (w.declared && w.closedAt !== null) w.grace = 0;
    },
    open({ page = null, label, url, grace = GRACE_MS, count = 1, declared = false }) {
      const w = { page, label, test: matcher(url), grace, count, used: 0, opened: now(), closedAt: null, declared };
      windows.push(w);
      return w;
    },
    close(w) {
      w.closedAt = now();
    },
    /** Run `fn` with a declaration that it opens a document (see `navigates` above). */
    async declared(navigates, fn, label = stepTitle() ?? "declared") {
      const d = declarationOf(navigates);
      if (d === null) return fn();
      const w = census.open({ label: `step: ${label}`, url: d.url, count: d.count, declared: true });
      try {
        return await fn();
      } finally {
        census.close(w);
      }
    },
    summary() {
      const unrequested = documents.filter((d) => !d.issued);
      return {
        schema: NAVIGATION_SCHEMA,
        documents: documents.length,
        issued: documents.length - unrequested.length,
        unrequested: unrequested.length,
        unrequestedLoads: unrequested.map(({ tab, step, url, kind, outcome }) => ({ tab, step, url, kind, outcome })),
        sameDocument: sameDocument.length,
        unusedDeclarations: windows.filter((w) => w.declared && w.used === 0).map((w) => w.label),
        loads: documents.map(({ page, ...d }) => d),
        sameDocumentChanges: sameDocument,
      };
    },
  };
  return census;
}
