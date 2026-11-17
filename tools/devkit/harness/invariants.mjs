// Invariant checks run after every step. Each takes the step's evidence window and returns
// {name, ok, severity:'fail'|'warn', details}. A check that cannot run (missing surface) returns
// ok with `skipped`. Configure with run options: {invariants: {<name>: false | {...options}}}.

import { isPollTick } from "../../perf/lib/requests.mjs";
import { VITALS_SCRIPT, inpOf, interactionsOf, loafSummary, untimedInteractions } from "../../perf/lib/vitals.mjs";

/** Editor chrome that must never intersect (contract: ui.edit.chrome-overlap). */
export const CHROME = [
  { name: "editing cluster", selector: ".authoring-edit-cluster" },
  { name: "parts bar", selector: ".authoring-parts" },
  { name: "message panel", selector: ".authoring-message-panel" },
  { name: "canvas controls", selector: ".react-flow__controls, .archer-canvas-controls:not(.authoring-edit-cluster)" },
  { name: "structure panel", selector: ".authoring-panel:not(.authoring-panel-collapsed)" },
  { name: "top toolbar", selector: ".authoring-toolbar" },
  // The reading page's side panel (0.6.4, D5): beside the drawing, never over its toolbar or anything above.
  { name: "diagram panel", selector: ".archer-diagram-panel:not(.archer-diagram-panel--sheet)" },
];

const DEFAULTS = {
  "page-errors": {},
  // Chromium logs every HTTP error response as a console error; http-errors already judges those.
  "console-errors": {
    ignore: [
      /favicon/i,
      /Download the React DevTools/i,
      /^Failed to load resource: the server responded with a status of \d{3}/,
    ],
  },
  "failed-requests": { ignoreAborted: true },
  "http-errors": { failAt: 500, warnAt: 400 },
  // A scheduled poll's tick (tagged by the debug build; tools/perf/lib/requests.mjs isPollTick) is no duplicate.
  "duplicate-requests": { count: 3, windowMs: 2000, ignore: [/\/events(\?|$)/, /\/-\/debug\//] },
  "requests-per-view": { max: 40 },
  "chrome-overlap": { tolerancePx: 1 },
  "pointer-mode": {},
  "label-focus": {},
  "editor-alert": {},
  // The visible-and-uncovered check: an alert that exists but sits off screen, or under another element, tells nobody.
  "alert-visible": {},
  // A browser CSP report (securitypolicyviolation) or a console line saying so: a blocked image/script is silent otherwise.
  "csp-violations": {},
  // Chrome (toolbar, parts bar, panels, their buttons) cut off by an ancestor's overflow or by the viewport.
  // A scroll container with hidden items is only a warning (chrome-scrolls): reachable, but not at a glance.
  "chrome-clipped": { tolerancePx: 2 },
  "chrome-scrolls": {},
  // What was selected before a step still points at the same thing afterwards (same id, same label). Steps that
  // legitimately change it (renames, undo/redo, source edits) are exempt through step meta.
  "selection-identity": {},
  // The editor had unsaved changes and the page left it without Save/Discard (not an explicit navigation by the journey).
  "dirty-navigation": {},
  // The same write (method + URL + whole body: operation id, base revision, payload) sent twice in one step window.
  "duplicate-writes": { count: 2, windowMs: 2000, ignore: [/\/-\/debug\//] },
  // A shortcut pressed while editing with focus outside any text field that no handler took (defaultPrevented false),
  // e.g. Ctrl+Z with focus fallen to <body>; and a key typed into a text field that a shortcut swallowed (prevented,
  // or focus moved out, and the field's value did not change). Keys are recorded by an init script (index.mjs).
  "shortcut-focus": { typing: /^(.|Backspace|Delete| )$/ },
  // benign: messages that match failOn codes but are known browser noise (kept as warnings). The page reports the
  // ResizeObserver notice as info `ui.resize-observer-loop` (not ui.page-error) since batch PB, so nothing is listed.
  // ui.edit.edit-refused is the page echoing a refusal the service answered (a product rule such as "the last element of a
  // boundary"): editor-alert reports it, and journeys that expect one assert it. Every other ui.edit.* code fails.
  // Event Timing per step (rubric performance.md §6 INP, S4/G7): the step's worst interaction and the journey INP so far.
  // Report only by default; failAtMs (e.g. 200, the G7 band on the default profile) fails a step whose worst interaction
  // is over it while the journey INP is too. A step that declares meta.interaction but whose input never reached the
  // page is NOT EVALUATED.
  "interaction-latency": { failAtMs: null, bandMs: 200 },
  // Long animation frames (> minMs) per step (§6 LoAF, S5): each attributed to a script, or listed with
  // styleAndLayoutStart/renderStart so a reviewer can name the cause. Report only by default; failOnUnattributed fails
  // an interaction step with an unattributed long frame, failAtMs a step with a frame longer than it.
  "long-frame": { minMs: 50, failOnUnattributed: false, failAtMs: null },
  warnings: {
    failOn:
      /^(ui\.(page-error|unhandled-rejection|react-error|edit\.(?!edit-refused$))|svc\.(unhandled|edit-postcondition))/,
    benign: [],
  },
};

export function resolveInvariants(config = {}) {
  const out = {};
  for (const [name, defaults] of Object.entries(DEFAULTS)) {
    const c = config[name];
    if (c === false) continue;
    out[name] = { ...defaults, ...(typeof c === "object" ? c : {}) };
  }
  return out;
}

/** Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl/Cmd+Y always; Delete/Backspace with something selected; Alt+arrows with one thing selected. */
export function expectedShortcut(k) {
  const mod = k.ctrl || k.meta,
    key = String(k.key ?? "").toLowerCase();
  if (mod && !k.alt && (key === "z" || key === "y")) return true;
  if (k.selection > 0 && !mod && !k.alt && (key === "delete" || key === "backspace")) return true;
  // Alt+arrows move ONE selected sequence participant or message; with several picked the editor rightly does nothing,
  // and a graph canvas never takes them (Alt+← is the browser's Back). Records without `sequence` (older) count as one.
  if (k.selection === 1 && k.alt && !mod && k.sequence !== false && /^arrow(up|down|left|right)$/.test(key))
    return true;
  return false;
}

/** The TG-a4 judgement over the step's recorded key presses (pure, so it is unit-tested). */
export function shortcutFocus(keys, { typing = /^(.|Backspace|Delete| )$/ } = {}) {
  const dead = [],
    stolen = [],
    busy = [],
    maybe = [];
  for (const k of keys) {
    const combo = [k.ctrl && "Ctrl", k.meta && "Meta", k.alt && "Alt", k.shift && "Shift", k.key]
      .filter(Boolean)
      .join("+");
    if (k.inEditable) {
      const plain = !k.ctrl && !k.meta && !k.alt && typing.test(k.key ?? "");
      if (plain && (k.prevented || k.focusMoved) && !k.valueChanged)
        stolen.push({
          key: combo,
          field: k.target,
          prevented: k.prevented,
          focusAfter: k.focusAfter,
          reason: "a key typed into a text field was taken by a shortcut (the text did not change)",
        });
      continue;
    }
    if (!k.editing || k.inDialog || !expectedShortcut(k) || k.prevented) continue;
    const item = {
      key: combo,
      focus: k.target,
      onBody: k.onBody,
      selection: k.selection,
      reason: `no handler took ${combo} while editing with focus on ${k.onBody ? "<body>" : (k.target?.tag ?? "?")}`,
    };
    // Alt+arrows legitimately do nothing at the end of the row (the last participant, the first message) or for the
    // other axis (a message moves up/down, a participant left/right), and the record cannot tell which: a warning.
    (k.busy ? busy : k.alt ? maybe : dead).push(item);
  }
  if (dead.length || stolen.length)
    return fail("shortcut-focus", {
      dead,
      stolen,
      ...(busy.length ? { whileBusy: busy } : {}),
      ...(maybe.length ? { altArrowsIgnored: maybe } : {}),
    });
  if (maybe.length)
    return fail(
      "shortcut-focus",
      {
        altArrowsIgnored: maybe,
        reason:
          "Alt+arrows not taken: fine at the end of the row or for the other axis; a bug if focus fell out of the canvas",
      },
      "warn",
    );
  if (busy.length)
    return fail("shortcut-focus", { whileBusy: busy, reason: "shortcuts ignored while the editor was busy" }, "warn");
  return keys.length ? pass("shortcut-focus", { keys: keys.length }) : skip("shortcut-focus", "no key presses");
}

/** The name an element shows: its aria-label, else its text; a sequence message's "N. " number is not part of it
 * (autonumber renumbers every later message on an insert or delete). */
export const shownName = (t) => {
  const [aria, txt] = String(t ?? "").split("|");
  return (aria || txt || "").trim().replace(/^\d+\.\s+/, "");
};

/**
 * selection-identity (pure): the selection kept its id but now shows another element. A rename keeps the element and
 * changes its name: the old name is gone, the new one is new. A renumbered selection (msg-2 now names what msg-3 named)
 * shows a name another element showed before the step, or its own old name moved to another id. Counted as a multiset
 * of names per kind, so duplicate labels ("Process", "Process") do not read as a move.
 */
export function selectionMoved(beforeSel, afterSel, beforeItems, afterItems) {
  const count = (items, kind, name, exceptId) =>
    items.filter((x) => x.kind === kind && x.id !== exceptId && shownName(x.text) === name).length;
  const moved = [];
  for (const b of beforeSel ?? []) {
    const a = (afterSel ?? []).find((x) => x.kind === b.kind && x.id === b.id);
    const nb = shownName(b.text),
      na = shownName(a?.text);
    if (!a || !nb || !na || nb === na) continue;
    // Without the full item lists (an old probe) fall back to "same id, different name".
    if (!beforeItems || !afterItems) {
      moved.push({ id: b.id, kind: b.kind, before: b.text, after: a.text });
      continue;
    }
    const oldNameWentElsewhere = count(afterItems, b.kind, nb, b.id) > count(beforeItems, b.kind, nb, b.id);
    const newNameCameFromElsewhere = count(beforeItems, b.kind, na, b.id) > count(afterItems, b.kind, na, b.id);
    if (oldNameWentElsewhere || newNameCameFromElsewhere)
      moved.push({
        id: b.id,
        kind: b.kind,
        before: b.text,
        after: a.text,
        ...(oldNameWentElsewhere
          ? {
              oldNameNowOn: afterItems
                .filter((x) => x.kind === b.kind && x.id !== b.id && shownName(x.text) === nb)
                .map((x) => x.id),
            }
          : {}),
      });
  }
  return moved;
}

/** A successful Save in this step: the editor's write (POST …/api/authoring) answered below 400. Saving exits in place. */
export const savedInStep = (w) =>
  (w.responses ?? []).some(
    (r) => r.method === "POST" && /\/api\/authoring$/.test(new URL(r.url, "http://x").pathname) && r.status < 400,
  );

/**
 * duplicate-writes (pure): the same write (method + URL + whole body) twice within windowMs in one document with
 * nothing in between: no key press or pointer press (inputs, page time in ms) and no other write. A person deleting,
 * undoing and deleting again sends an identical body for a reason; a double commit (Enter then blur) does not.
 */
export function duplicateWrites(requests, { count = 2, windowMs = 2000, ignore = [] } = {}, inputs = []) {
  const writes = requests.filter(
    (r) => /^(POST|PUT|PATCH|DELETE)$/.test(r.method) && r.body !== undefined && !ignore.some((re) => re.test(r.url)),
  );
  const keyOf = (r) => `${r.method} ${r.url.split("?")[0]}#${r.body}#doc${r.doc ?? 0}`;
  const byKey = new Map();
  for (const r of writes) (byKey.get(keyOf(r)) ?? byKey.set(keyOf(r), []).get(keyOf(r))).push(r);
  const dups = [];
  for (const [key, list] of byKey) {
    let run = 1;
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1],
        cur = list[i];
      const between = (t) => t > prev.at && t < cur.at;
      const separated =
        inputs.some(between) ||
        writes.some(
          (r) => r !== prev && r !== cur && (r.doc ?? 0) === (cur.doc ?? 0) && keyOf(r) !== key && between(r.at),
        );
      run = !separated && cur.at - prev.at < windowMs ? run + 1 : 1;
      if (run >= count) {
        dups.push({
          write: key.split("#")[0],
          identicalBodies: list.length,
          bodyHash: key.split("#")[1],
          document: key.split("#doc").pop(),
          gapMs: cur.at - prev.at,
        });
        break;
      }
    }
  }
  return dups;
}

const pass = (name, details) => ({ name, ok: true, severity: "fail", ...(details ? { details } : {}) });
const fail = (name, details, severity = "fail") => ({ name, ok: false, severity, details });
const skip = (name, why) => ({ name, ok: true, severity: "fail", skipped: why });

// Key and pointer presses in page time, for duplicate-writes (an identical write after a new user input is a new
// action). Installed on each page once, for this document and every later one.
const recorded = new WeakSet();
const RECORDER = () => {
  if (window.__harnessInputs) return;
  window.__harnessInputs = [];
  for (const t of ["pointerdown", "keydown"])
    addEventListener(
      t,
      () => {
        window.__harnessInputs.push(Date.now());
        if (window.__harnessInputs.length > 500) window.__harnessInputs.shift();
      },
      true,
    );
};

/** Browser-side probe for overlap, pointer mode and focus; one evaluate per step. */
export async function probe(page) {
  if (page && !recorded.has(page)) {
    recorded.add(page);
    await page.addInitScript(RECORDER).catch(() => {});
    await page.evaluate(RECORDER).catch(() => {});
    // The vitals observers (tools/perf/lib/vitals.mjs) for interaction-latency and long-frame; buffered, so a late
    // install still sees the document's earlier entries.
    await page.addInitScript(VITALS_SCRIPT).catch(() => {});
    await page.evaluate(VITALS_SCRIPT).catch(() => {});
  }
  return page
    .evaluate(
      (chrome) => {
        const visible = (el) => {
          const r = el.getBoundingClientRect(),
            s = getComputedStyle(el);
          return (
            r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0
          );
        };
        const boxes = [];
        for (const c of chrome)
          for (const el of document.querySelectorAll(c.selector)) {
            if (!visible(el)) continue;
            const r = el.getBoundingClientRect();
            boxes.push({ name: c.name, el, box: { x: r.x, y: r.y, width: r.width, height: r.height } });
          }
        const editing = document.querySelector(".authoring-workspace") !== null;
        const canvases = [...document.querySelectorAll(".react-flow, .archer-seq-canvas")].filter(visible);
        const hand = canvases.filter((c) => c.classList.contains("archer-pan-hand")).length;
        const select = document.querySelector('button[aria-label="Select mode"], button[title="Select items"]');
        const a = document.activeElement;
        const describe = (el) =>
          el === null
            ? null
            : {
                tag: el.tagName.toLowerCase(),
                id: el.id || undefined,
                cls: typeof el.className === "string" ? el.className.slice(0, 120) : undefined,
                label: el.getAttribute?.("aria-label") ?? undefined,
                connected: el.isConnected,
              };
        const pairs = [];
        for (let i = 0; i < boxes.length; i++)
          for (let j = i + 1; j < boxes.length; j++) {
            const p = boxes[i],
              q = boxes[j];
            if (p.el === q.el || p.el.contains(q.el) || q.el.contains(p.el)) continue;
            const w = Math.min(p.box.x + p.box.width, q.box.x + q.box.width) - Math.max(p.box.x, q.box.x);
            const h = Math.min(p.box.y + p.box.height, q.box.y + q.box.height) - Math.max(p.box.y, q.box.y);
            if (w > 0 && h > 0)
              pairs.push({
                a: p.name,
                b: q.name,
                overlap: { w: Math.round(w), h: Math.round(h) },
                boxA: p.box,
                boxB: q.box,
              });
          }
        // ---- alerts: visible in the viewport and not under something else (hit-test at the centre) ----
        const vw = window.innerWidth,
          vh = window.innerHeight;
        const alertEls = [
          ...document.querySelectorAll(".authoring-error, [role=alert], .authoring-interaction-error"),
        ].filter((el) => visible(el) && el.textContent.trim());
        const alertGeometry = alertEls.map((el) => {
          const r = el.getBoundingClientRect(),
            cx = r.x + r.width / 2,
            cy = r.y + r.height / 2;
          const inViewport = cx >= 0 && cy >= 0 && cx < vw && cy < vh;
          // A callout drawn with pointer-events: none (so clicks reach the canvas) is invisible to hit-testing: make it
          // hit-testable for the probe only, or every such alert reads as "covered by" whatever lies beneath it.
          const saved = el.style.pointerEvents;
          el.style.pointerEvents = "auto";
          const top = inViewport ? document.elementFromPoint(cx, cy) : null;
          el.style.pointerEvents = saved;
          // An open modal dialog (the keyboard help) takes over the page on purpose: an alert behind it is not "covered".
          const behindModal =
            top !== null && top.closest('[aria-modal="true"]') !== null && el.closest('[aria-modal="true"]') === null;
          const covered = inViewport && top !== null && !(el.contains(top) || top.contains(el)) && !behindModal;
          return {
            text: el.textContent.trim().slice(0, 120),
            box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
            inViewport,
            covered,
            coveredBy: covered ? describe(top) : undefined,
          };
        });
        // ---- selection: what the canvas says is selected, by id and by what it shows ----
        const text = (el) =>
          ((el.getAttribute("aria-label") || "") + "|" + (el.textContent || ""))
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 160);
        const selection = [
          ...[...document.querySelectorAll(".react-flow__node.selected")].map((el) => ({
            kind: "node",
            id: el.getAttribute("data-id"),
            text: text(el),
          })),
          ...[...document.querySelectorAll(".react-flow__edge.selected")].map((el) => ({
            kind: "edge",
            id: el.getAttribute("data-id"),
            text: text(el),
          })),
          ...[...document.querySelectorAll(".archer-seq-selected")].map((el) => ({
            kind: el.getAttribute("class").match(/archer-seq-(participant|message|note|fragment)\b/)?.[1] ?? "seq",
            id: el.getAttribute("data-seq-id"),
            text: text(el),
          })),
        ].filter((x) => x.id);
        // Every item the canvas shows, by kind: selection-identity tells a rename from a renumbered selection with it.
        const items = [
          ...[...document.querySelectorAll(".react-flow__node")].map((el) => ({
            kind: "node",
            id: el.getAttribute("data-id"),
            text: text(el),
          })),
          ...[...document.querySelectorAll(".react-flow__edge")].map((el) => ({
            kind: "edge",
            id: el.getAttribute("data-id"),
            text: text(el),
          })),
          ...[
            ...document.querySelectorAll(
              "g.archer-seq-participant, g.archer-seq-message, g.archer-seq-note, g.archer-seq-fragment",
            ),
          ].map((el) => ({
            kind: el.getAttribute("class").match(/archer-seq-(participant|message|note|fragment)\b/)?.[1] ?? "seq",
            id: el.getAttribute("data-seq-id"),
            text: text(el),
          })),
        ].filter((x) => x.id);
        const inputs = window.__harnessInputs ? window.__harnessInputs.splice(0) : [];
        // ---- dirty: the editor is open and Save is enabled ----
        const save = [...document.querySelectorAll(".authoring-toolbar button")].find(
          (b) => b.textContent.trim() === "Save",
        );
        const dirty = editing && !!save && !save.disabled;
        // ---- clipping: chrome (and its buttons) cut off by an overflow ancestor or by the viewport ----
        const tol = 2;
        const docScrolls =
          document.documentElement.scrollHeight > vh + 1 || document.documentElement.scrollWidth > vw + 1;
        const clipped = [],
          scrolls = [];
        const targets = [
          ...boxes.map((b) => ({ name: b.name, el: b.el, container: true })),
          ...[...document.querySelectorAll(".authoring-workspace")]
            .filter(visible)
            .map((el) => ({ name: "editor", el, container: true })),
          ...[
            ...document.querySelectorAll(
              ".authoring-parts button, .authoring-toolbar button, .authoring-edit-cluster button",
            ),
          ]
            .filter((el) => getComputedStyle(el).display !== "none")
            .map((el) => ({ name: "button " + (text(el) || el.className).slice(0, 30), el, container: false })),
        ];
        for (const t of targets) {
          const r = t.el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          let blocker = null;
          for (let p = t.el.parentElement; p; p = p.parentElement) {
            const s = getComputedStyle(p);
            if (s.overflowX === "visible" && s.overflowY === "visible") continue;
            const pr = p.getBoundingClientRect();
            const outX = s.overflowX !== "visible" && (r.right > pr.right + tol || r.left < pr.left - tol);
            const outY = s.overflowY !== "visible" && (r.bottom > pr.bottom + tol || r.top < pr.top - tol);
            if (!outX && !outY) continue;
            const canScroll =
              (outX && /auto|scroll/.test(s.overflowX) && p.scrollWidth > p.clientWidth + 1) ||
              (outY && /auto|scroll/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 1);
            blocker = { by: describe(p), scrollable: canScroll };
            break;
          }
          const off = r.right > vw + tol || r.bottom > vh + tol || r.left < -tol || r.top < -tol;
          const item = {
            name: t.name,
            box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
          };
          if (blocker) (blocker.scrollable ? scrolls : clipped).push({ ...item, ...blocker });
          else if (off && !docScrolls) clipped.push({ ...item, by: "viewport", viewport: { width: vw, height: vh } });
        }
        return {
          pageNow: performance.now(),
          timeOrigin: performance.timeOrigin,
          alertGeometry,
          selection,
          items,
          inputs,
          dirty,
          location: location.pathname + location.search,
          clipped,
          scrolls,
          editing,
          canvases: canvases.length,
          hand,
          selectPressed: select ? select.getAttribute("aria-pressed") : null,
          active: describe(a),
          activeIsLabelInput:
            !!a &&
            (a.classList?.contains("archer-node-label-input") || a.closest?.(".archer-seq-label-editor") !== null),
          overlaps: pairs,
          chrome: boxes.map((b) => ({ name: b.name, box: b.box })),
          alerts: [...document.querySelectorAll(".authoring-error, [role=alert]")]
            .filter(visible)
            .map((el) => el.textContent.trim().slice(0, 300))
            .filter(Boolean),
        };
      },
      CHROME.map((c) => ({ name: c.name, selector: c.selector })),
    )
    .catch((error) => ({ error: String(error.message ?? error) }));
}

/**
 * The step's vitals: flush (double rAF, then takeRecords), then take the page's Event Timing, LoAF and input records
 * since the step began (`before`: the probe before the step, its document and page time). Drained, so the page's
 * lists stay short. A step that changed document reads the new document's records from its start. Null when the
 * page has no observers (it closed, or a dialog blocks it).
 */
export async function stepVitals(page, before) {
  if (!page) return null;
  return page
    .evaluate(async () => {
      const lab = window.__perfLab;
      if (!lab || typeof lab.flush !== "function") return null;
      await lab.flush();
      return {
        timeOrigin: performance.timeOrigin,
        now: performance.now(),
        events: lab.events.splice(0),
        loaf: lab.loaf.splice(0),
        inputs: lab.inputs.splice(0),
      };
    })
    .then(
      (v) => {
        if (v === null) return null;
        const from =
          before && before.timeOrigin === v.timeOrigin && typeof before.pageNow === "number" ? before.pageNow : 0;
        const inWindow = (e) => e.startTime >= from;
        return {
          from,
          to: v.now,
          sameDocument: from > 0,
          events: v.events.filter(inWindow),
          loaf: v.loaf.filter(inWindow),
          inputs: v.inputs.filter(inWindow),
        };
      },
      () => null,
    );
}

// Each page's interactions so far (the journey INP): timed interactions and the count that landed under 16 ms.
const journeys = new WeakMap();
const journeyOf = (page) => {
  const key = page ?? journeys;
  let j = journeys.get(key);
  if (!j) journeys.set(key, (j = { events: [], untimed: 0 }));
  return j;
};

/**
 * interaction-latency (pure): one step's Event Timing and inputs judged, the journey's record updated.
 * @param {{events:object[], inputs:object[]}|null} v stepVitals
 * @param {{events:object[], untimed:number}} journey the page's interactions so far (mutated)
 * @param {{failAtMs?:number|null, bandMs?:number}} config
 * @param {{interaction?:boolean}} meta the step's meta
 */
export function interactionLatency(v, journey, { failAtMs = null, bandMs = 200 } = {}, meta = {}) {
  const NAME = "interaction-latency";
  if (v === null)
    return meta.interaction
      ? skip(
          NAME,
          "NOT EVALUATED: no Event Timing records (the vitals observers are missing or the page could not be read)",
        )
      : skip(NAME, "no vitals in this step");
  const timed = interactionsOf(v.events);
  const untimed = untimedInteractions(v.inputs, v.events);
  if (timed.length === 0 && untimed === 0)
    return meta.interaction
      ? skip(
          NAME,
          "NOT EVALUATED: the step declares an input but the page received none and Event Timing has no interaction",
        )
      : skip(NAME, "no input in this step");
  journey.events.push(...v.events.filter((e) => e.interactionId));
  journey.untimed += untimed;
  const j = inpOf(journey.events, { untimed: journey.untimed });
  const worst = timed.reduce((w, x) => (w === null || x.latencyMs > w.latencyMs ? x : w), null);
  const details = {
    worstMs: worst ? worst.latencyMs : "< 16",
    ...(worst ? { worst: { names: worst.names, target: worst.target, startTime: worst.startTime } } : {}),
    interactions: timed.length + untimed,
    under16: untimed,
    journey: { inpMs: j.inpMs ?? "< 16", interactions: j.interactions, ignored: j.ignored },
    bandMs,
    overBand: (j.inpMs ?? 0) > bandMs,
  };
  if (failAtMs !== null && worst && worst.latencyMs > failAtMs && (j.inpMs ?? 0) > failAtMs)
    return fail(NAME, {
      ...details,
      reason: `an interaction took ${worst.latencyMs} ms, over ${failAtMs} ms, and the journey INP is ${j.inpMs} ms`,
    });
  return pass(NAME, details);
}

/**
 * The run summary's vitals (pure). The page's own `__archerTelemetry` vitals when it has an INP (a --debug-ui page);
 * otherwise the journey INP the interaction-latency invariant recorded at its last evaluated step (Event Timing on
 * the journey's main page, any build), with `INPSource` naming it. No such record leaves INP absent, never 0.
 * @param {object|null|undefined} telemetry `__archerTelemetry.vitals()`, or null on a production page
 * @param {{title?:string, invariants?:object[]}[]} steps the run's steps
 * @returns {object|null}
 */
export function summaryVitals(telemetry, steps = []) {
  if (telemetry && typeof telemetry.INP === "number") return { ...telemetry, INPSource: "telemetry" };
  let last = null;
  for (const s of steps)
    for (const i of s.invariants ?? [])
      if (i.name === "interaction-latency" && i.details?.journey) last = { step: s.title, journey: i.details.journey };
  if (!last) return telemetry ? { ...telemetry } : null;
  return {
    ...(telemetry ?? {}),
    INP: last.journey.inpMs,
    interactions: last.journey.interactions,
    ignored: last.journey.ignored,
    INPSource: `interaction-latency invariant (Event Timing), journey INP at step "${last.step}"`,
  };
}

/**
 * long-frame (pure): the step's long animation frames, each attributed (its scripts) or listed for diagnosis.
 * @param {{loaf:object[], inputs:object[], events:object[], from:number, to:number}|null} v stepVitals
 * @param {{minMs?:number, failOnUnattributed?:boolean, failAtMs?:number|null}} config
 */
export function longFrames(v, { minMs = 50, failOnUnattributed = false, failAtMs = null } = {}, meta = {}) {
  const NAME = "long-frame";
  if (v === null) return skip(NAME, "no vitals in this step");
  const s = loafSummary(v.loaf, { minMs });
  const interactionStep = v.inputs.length > 0 || interactionsOf(v.events).length > 0 || meta.interaction === true;
  if (s.count === 0) return pass(NAME, { count: 0, interactionStep });
  const top = (scripts) =>
    [...scripts]
      .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
      .slice(0, 3)
      .map((x) => ({
        invoker: x.invoker,
        invokerType: x.invokerType,
        source: x.sourceURL
          ? `${(x.sourceURL.split(/[?#]/)[0].split("/").filter(Boolean).pop() ?? x.sourceURL).slice(0, 60)}:${x.sourceCharPosition}`
          : "",
        fn: x.sourceFunctionName || undefined,
        duration: x.duration,
      }));
  const details = {
    count: s.count,
    blockingMs: s.blockingMs,
    longestMs: s.longestMs,
    interactionStep,
    attributed: s.frames
      .filter((f) => f.attributed)
      .slice(0, 10)
      .map((f) => ({
        startTime: f.startTime,
        duration: f.duration,
        blockingDuration: f.blockingDuration,
        scripts: top(f.scripts),
      })),
    unattributed: s.unattributed.slice(0, 10).map((f) => ({
      startTime: f.startTime,
      duration: f.duration,
      blockingDuration: f.blockingDuration,
      styleAndLayoutStart: f.styleAndLayoutStart,
      renderStart: f.renderStart,
      renderMs: f.renderStart ? Math.round((f.startTime + f.duration - f.renderStart) * 10) / 10 : null,
    })),
  };
  if (failAtMs !== null && s.longestMs > failAtMs)
    return fail(NAME, { ...details, reason: `a ${s.longestMs} ms frame, over ${failAtMs} ms` });
  if (failOnUnattributed && interactionStep && s.unattributed.length)
    return fail(NAME, {
      ...details,
      reason:
        "a long frame on an interaction step has no script attribution: name its cause from styleAndLayoutStart/renderStart or a trace",
    });
  return pass(NAME, details);
}

/**
 * @param ctx {page, window:{pageErrors, console, failed, responses, requests}, viewRequests, warnings, meta}
 */
export async function runInvariants(ctx, config) {
  const results = [];
  const w = ctx.window;
  const on = (n) => config[n] !== undefined;
  if (on("csp-violations")) {
    const fromConsole = w.console
      .filter((m) => /Content Security Policy|violates the following Content Security/i.test(m.text))
      .map((m) => ({ console: m.text.slice(0, 300) }));
    const reports = (w.csp ?? []).map((c) => ({
      directive: c.directive,
      blocked: c.blocked,
      document: c.document,
      sample: c.sample || undefined,
    }));
    const all = reports.length ? reports : fromConsole; // the report and the console line are the same event
    // The page's own telemetry (ui.csp-violation, with the source file and line) counts too: it also covers loads
    // the init script missed (a report raised before the listener was installed).
    const telemetry = (ctx.warnings ?? [])
      .filter((x) => x.code === "ui.csp-violation")
      .map((x) => ({ telemetry: x.data ?? x.msg }));
    const found = [...all, ...(all.length ? [] : telemetry)];
    results.push(found.length ? fail("csp-violations", found.slice(0, 20)) : pass("csp-violations"));
  }
  if (on("page-errors")) results.push(w.pageErrors.length ? fail("page-errors", w.pageErrors) : pass("page-errors"));
  if (on("console-errors")) {
    const ignore = config["console-errors"].ignore ?? [];
    const errs = w.console.filter((m) => m.type === "error" && !ignore.some((re) => re.test(m.text)));
    results.push(errs.length ? fail("console-errors", errs.slice(0, 20)) : pass("console-errors"));
  }
  if (on("failed-requests")) {
    const bad = w.failed.filter(
      (f) => !(config["failed-requests"].ignoreAborted && /ERR_ABORTED|NS_BINDING_ABORTED/.test(f.failure ?? "")),
    );
    const aborted = w.failed.length - bad.length;
    results.push(
      bad.length
        ? fail("failed-requests", { failed: bad.slice(0, 20), aborted })
        : pass("failed-requests", aborted ? { aborted } : undefined),
    );
  }
  if (on("http-errors")) {
    const { failAt, warnAt } = config["http-errors"];
    const server = w.responses.filter((r) => r.status >= failAt),
      client = w.responses.filter((r) => r.status >= warnAt && r.status < failAt);
    if (server.length) results.push(fail("http-errors", { server: server.slice(0, 20), client: client.slice(0, 20) }));
    else if (client.length) results.push(fail("http-errors", { client: client.slice(0, 20) }, "warn"));
    else results.push(pass("http-errors"));
  }
  if (on("duplicate-requests")) {
    const { count, windowMs, ignore } = config["duplicate-requests"];
    const byKey = new Map();
    for (const r of w.requests) {
      if (ignore.some((re) => re.test(r.url))) continue;
      if (!/^(GET|HEAD)$/.test(r.method)) continue; // writes are judged by duplicate-writes (identity = whole body)
      if (isPollTick(r)) continue;
      // Per document: a navigation legitimately refetches everything.
      const key = `${r.method} ${r.url}#doc${r.doc ?? 0}`;
      (byKey.get(key) ?? byKey.set(key, []).get(key)).push(r.at);
    }
    const dups = [];
    for (const [key, times] of byKey) {
      for (let i = 0; i + count - 1 < times.length; i++)
        if (times[i + count - 1] - times[i] < windowMs) {
          dups.push({
            request: key.replace(/#doc\d+$/, ""),
            times: times.length,
            document: Number(key.split("#doc").pop()),
          });
          break;
        }
    }
    results.push(dups.length ? fail("duplicate-requests", dups) : pass("duplicate-requests"));
  }
  if (on("requests-per-view")) {
    const { max } = config["requests-per-view"];
    const v = ctx.viewRequests();
    // Reported once per page view, on the step that crossed the cap.
    if (v.count > max && !v.reported) {
      ctx.markViewReported?.();
      results.push(fail("requests-per-view", { view: v.url, count: v.count, max, top: v.top }));
    } else
      results.push(
        pass("requests-per-view", { view: v.url, count: v.count, ...(v.reported ? { alreadyReported: true } : {}) }),
      );
  }
  const needsProbe =
    on("chrome-overlap") ||
    on("pointer-mode") ||
    on("label-focus") ||
    on("editor-alert") ||
    on("alert-visible") ||
    on("chrome-clipped") ||
    on("chrome-scrolls") ||
    on("selection-identity") ||
    on("dirty-navigation") ||
    on("duplicate-writes");
  const p = needsProbe && ctx.page ? await probe(ctx.page) : null;
  if (on("duplicate-writes")) {
    // Per document, as for duplicate-requests: a reload legitimately sends the same preview again.
    const inputs = [...(ctx.before?.inputs ?? []), ...(p?.inputs ?? [])];
    const dups = duplicateWrites(w.requests, config["duplicate-writes"], inputs);
    results.push(dups.length ? fail("duplicate-writes", dups) : pass("duplicate-writes"));
  }
  if (p?.error) results.push(fail("probe", p.error, "warn"));
  else if (p) {
    if (on("chrome-overlap")) {
      const tol = config["chrome-overlap"].tolerancePx;
      const o = p.overlaps.filter((x) => x.overlap.w > tol && x.overlap.h > tol);
      results.push(
        !p.editing
          ? skip("chrome-overlap", "not editing")
          : o.length
            ? fail("chrome-overlap", o)
            : pass("chrome-overlap", { chrome: p.chrome.map((c) => c.name) }),
      );
    }
    if (on("pointer-mode")) {
      if (!p.editing || p.canvases === 0) results.push(skip("pointer-mode", p.editing ? "no canvas" : "not editing"));
      else if (p.hand > 0 || p.selectPressed === "false")
        results.push(fail("pointer-mode", { handCanvases: p.hand, selectPressed: p.selectPressed }));
      else results.push(pass("pointer-mode"));
    }
    if (on("editor-alert")) {
      // An alert on screen after a step (a refused edit, a failed save) is worth a look, not a failure:
      // journeys that expect one assert it themselves.
      const refusals = ctx.refusals ?? [];
      results.push(
        p.alerts.length || refusals.length
          ? fail("editor-alert", { alerts: p.alerts, refusals }, "warn")
          : pass("editor-alert"),
      );
    }
    if (on("alert-visible")) {
      const bad = (p.alertGeometry ?? []).filter((a) => !a.inViewport || a.covered);
      results.push(
        bad.length
          ? fail(
              "alert-visible",
              bad.map((a) => ({
                text: a.text,
                box: a.box,
                reason: a.inViewport
                  ? "covered by another element at its centre"
                  : "its centre is outside the viewport",
                coveredBy: a.coveredBy,
              })),
            )
          : pass("alert-visible"),
      );
    }
    if (on("chrome-clipped")) {
      results.push(
        !p.editing
          ? skip("chrome-clipped", "not editing")
          : p.clipped.length
            ? fail("chrome-clipped", p.clipped.slice(0, 20))
            : pass("chrome-clipped"),
      );
    }
    if (on("chrome-scrolls")) {
      results.push(
        !p.editing
          ? skip("chrome-scrolls", "not editing")
          : p.scrolls.length
            ? fail(
                "chrome-scrolls",
                {
                  hiddenUntilScrolled: p.scrolls.length,
                  items: p.scrolls.slice(0, 20).map((x) => x.name),
                  container: p.scrolls[0].by,
                },
                "warn",
              )
            : pass("chrome-scrolls"),
      );
    }
    if (on("selection-identity")) {
      const before = ctx.before?.selection,
        exempt = ctx.meta?.labelEdit || ctx.meta?.selectionMayChange;
      if (!before || exempt)
        results.push(
          skip("selection-identity", exempt ? "step may change what is selected" : "no state before the step"),
        );
      else {
        // The visible text half is empty while an inline editor replaces the label: only a different non-empty name
        // counts (monkey runs flagged "Process|" vs "Process|Process"). A rename in a step without labelEdit (a relabel
        // through a panel, a retarget renaming an edge, a participant rename re-reading every message) is told apart
        // from a renumbered selection by where the names went (selectionMoved).
        const moved = selectionMoved(before, p.selection, ctx.before?.items, p.items);
        results.push(
          moved.length
            ? fail("selection-identity", {
                reason: "the selection kept its id but now shows a different element",
                moved,
              })
            : pass("selection-identity"),
        );
      }
    }
    if (on("dirty-navigation")) {
      const before = ctx.before;
      // Not silent: the step saved (in-place Save exits the editor), or the page asked before leaving (a beforeunload
      // prompt the harness answered Leave, as for a journey's own page.goto or reload away from a dirty editor).
      const asked = (w.dialogs ?? []).some((d) => d.type === "beforeunload" && d.tab === undefined);
      const why = ctx.meta?.leavesEditor
        ? "explicit navigation"
        : !before?.dirty
          ? "editor not dirty"
          : savedInStep(w)
            ? "saved in this step"
            : asked
              ? "the page asked before leaving (beforeunload)"
              : null;
      if (!before || why) results.push(skip("dirty-navigation", why ?? "no state before the step"));
      else {
        const samePage = p.editing && p.location.split("?")[0] === before.location.split("?")[0];
        results.push(
          samePage
            ? pass("dirty-navigation")
            : fail("dirty-navigation", {
                reason: "the editor had unsaved changes and the page left it without Save or a Discard answer",
                from: before.location,
                to: p.location,
                editing: p.editing,
                navigations: (w.navigations ?? []).map((n) => n.url),
              }),
        );
      }
    }
    if (on("label-focus") && ctx.meta?.labelEdit) {
      if (p.activeIsLabelInput)
        results.push(
          fail("label-focus", {
            reason: "an inline label editor still has focus after the edit was committed",
            active: p.active,
          }),
        );
      else if (p.active && p.active.connected === false)
        results.push(fail("label-focus", { reason: "focus is on a detached element", active: p.active }));
      else if (!p.active || p.active.tag === "body")
        results.push(
          fail(
            "label-focus",
            { reason: "focus fell to <body> after the label edit (keyboard users lose their place)", active: p.active },
            "warn",
          ),
        );
      else results.push(pass("label-focus", { active: p.active }));
    }
  }
  if (on("interaction-latency") || on("long-frame")) {
    const v = ctx.vitals !== undefined ? ctx.vitals : await stepVitals(ctx.page, ctx.before);
    if (on("interaction-latency"))
      results.push(
        interactionLatency(v, ctx.journey ?? journeyOf(ctx.page), config["interaction-latency"], ctx.meta ?? {}),
      );
    if (on("long-frame")) results.push(longFrames(v, config["long-frame"], ctx.meta ?? {}));
  }
  if (on("shortcut-focus")) results.push(shortcutFocus(w.keys ?? [], config["shortcut-focus"]));
  if (on("warnings")) {
    const re = config.warnings.failOn;
    const benign = config.warnings.benign ?? [];
    const hard = ctx.warnings.filter((x) => re.test(x.code ?? "") && !benign.some((b) => b.test(x.msg ?? "")));
    if (hard.length) results.push(fail("warnings", hard.slice(0, 30)));
    else if (ctx.warnings.length) results.push(fail("warnings", ctx.warnings.slice(0, 30), "warn"));
    else results.push(pass("warnings"));
  }
  // A journey may downgrade a known, already-reported issue: {"<name>": {severity: "warn", reason}}.
  for (const r of results)
    if (!r.ok && config[r.name]?.severity === "warn") {
      r.severity = "warn";
      if (config[r.name].reason) r.downgraded = config[r.name].reason;
    }
  return results;
}
