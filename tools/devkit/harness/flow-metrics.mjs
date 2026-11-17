// The action trace of a user-flows journey (rubric docs/quality/rubrics/user-flows.md §5 "Actions by class",
// §6 "Counting actions", U2), written to `summary.flow`.
//
// One entry per semantic action, taken from the journey's own steps: a journey takes each person action through
// `flow.act(action, class, fn, { kind })`, which runs it as a harness step and records it. Setup (reset, opening the
// start state) and assertions are plain `step` calls and are not actions. The harness's `__harnessInput` stream is
// not used: it also fires on focus, wheel and visibility, so it counts input events, not actions.
//
//   kind: "click" (a click or tap; the navigation it causes is not counted again), "key" (a key chord),
//         "type" (text entered into one field), "scroll" (only when needed to reveal the target), "navigate" (the
//         person opens an address: a link they were given, or a URL typed or pasted).
//   class: "essential" (the goal needs it), "safety" (a documented confirmation or choice protecting work),
//          "overhead" (anything else).
// Agent CLI calls (ui.agent, logged in run.agentCalls) are agent operations, never person actions.
//
// Scrolls a person needs. Playwright's click (tap, fill, check, hover, selectOption) scrolls a hidden target into view
// by itself, so a journey's trace showed no scroll where the person needs one (claude-07, codex-05: J1/J2's Pageturner
// link at y = 1611 in a 900 px window; J10 at 320×640, the note link scrolled out of the walkthrough sheet's body).
// installRevealWatch(page) wraps those Locator methods once per process: inside a `flow.act`, before the action it
// measures the target (its box, the window, every ancestor that clips it) and, when its centre is not on screen
// (`revealedAt`), records an essential "scroll to: <action>" entry before the action's own. The harness installs it
// for every page (index.mjs), so every journey that acts through flow.act is covered. Seeded fault
// `drop-reveal-scroll` (flows-state.mjs) makes the recorder forget those entries: the collector as it was.
//
// The baseline is the journey's pinned trace, `meta.flow.baseline: [{ action, class }]`. The comparison reports
// actions missing from or extra to it, class changes, and the U2 ratchet: more overhead than the baseline fails.
//
//   import { flowRecorder } from "../../harness/flow-metrics.mjs";
//   export const meta = { name: "j02-find-diagram", flow: { id: "J2", baseline: [{ action: "open project", class: "essential" }] } };
//   export default async (ctx) => { const flow = flowRecorder(ctx, meta.flow); await flow.act("open project", "essential", () => …, { kind: "click" }); … await flow.goal("checkout shown", () => …); };
import { AsyncLocalStorage } from "node:async_hooks";
import { activeFaults } from "./flows-state.mjs";

export const CLASSES = ["essential", "safety", "overhead"];
export const KINDS = ["click", "key", "type", "scroll", "navigate"];
export const FLOW_SCHEMA = "archer-flow/1";

/** An action's kind from its words: a key chord (press, F-keys, Ctrl+…), text entered, a scroll, else a click. */
export function kindOf(action) {
  const words = action.replace(/^[^:]*: (?=\S)/, (m) => (/^(scroll to|seeded)/.test(m) ? m : ""));
  if (/^scroll\b|^scroll to:|^seeded: scroll/.test(words)) return "scroll";
  if (/^type\b/.test(words)) return "type";
  if (/^press\b|\((?:F\d+|Ctrl\+[^)]*|Cmd\+[^)]*)\)$/.test(words)) return "key";
  return "click";
}

/**
 * Is a target on screen for a person? Its centre (where Playwright presses) must be inside the window and inside
 * every clipping ancestor's visible box. Pure. `rect` {left, top, width, height} and `clips` [{left, top, right,
 * bottom, name}] in window coordinates; `viewport` {width, height}. A box with no area is not judged (revealed).
 */
export function revealedAt({ rect, viewport, clips = [] }) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return { revealed: true };
  const x = rect.left + rect.width / 2,
    y = rect.top + rect.height / 2;
  if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) return { revealed: false, hiddenBy: "viewport" };
  for (const c of clips)
    if (x < c.left || y < c.top || x >= c.right || y >= c.bottom)
      return { revealed: false, hiddenBy: c.name ?? "an ancestor" };
  return { revealed: true };
}

/**
 * In the page: the element's box, the window, and the visible box of every ancestor that clips it (overflow other than
 * visible), after two frames so a box still settling is measured where it lands. An absolutely positioned element
 * escapes the clipping of ancestors up to its containing block; a fixed one escapes them all.
 */
export async function measureReveal(el) {
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const r = el.getBoundingClientRect();
  const clips = [];
  let positioning = getComputedStyle(el).position; // "absolute": until a positioned ancestor; "fixed": all
  for (let a = el.parentElement; a && a !== document.documentElement && positioning !== "fixed"; a = a.parentElement) {
    const cs = getComputedStyle(a);
    const containing = cs.position !== "static" || cs.transform !== "none";
    if (positioning !== "absolute" || containing) {
      // The body's overflow moves to the window when the root's is visible: then the body clips nothing.
      const propagated = a === document.body && getComputedStyle(document.documentElement).overflow === "visible";
      if (!propagated && (cs.overflowX !== "visible" || cs.overflowY !== "visible")) {
        const b = a.getBoundingClientRect();
        const left = b.left + a.clientLeft,
          top = b.top + a.clientTop;
        clips.push({
          left,
          top,
          right: left + a.clientWidth,
          bottom: top + a.clientHeight,
          name: `${a.tagName.toLowerCase()}${a.classList.length ? `.${[...a.classList].join(".")}` : ""}`,
        });
      }
      positioning =
        cs.position === "fixed"
          ? "fixed"
          : cs.position === "absolute"
            ? "absolute"
            : positioning === "absolute"
              ? "static"
              : positioning;
    }
  }
  return {
    rect: { left: r.left, top: r.top, width: r.width, height: r.height },
    viewport: { width: innerWidth, height: innerHeight },
    clips,
  };
}

/** The action collector of the running `flow.act`, across its awaits; undefined outside one. */
const acting = new AsyncLocalStorage();
const WATCHED = ["click", "dblclick", "tap", "check", "uncheck", "setChecked", "fill", "selectOption", "hover"];
const WATCH = Symbol.for("archer.flowRevealWatch");

/** Wrap Playwright's Locator actions (once per process) so a hidden target inside a flow.act records its scroll. */
export function installRevealWatch(page) {
  const proto = Object.getPrototypeOf(page.locator("html"));
  if (proto[WATCH]) return;
  proto[WATCH] = true;
  for (const name of WATCHED) {
    const original = proto[name];
    if (typeof original !== "function") continue;
    proto[name] = async function watched(...args) {
      const store = acting.getStore();
      const opts = args.at(-1);
      if (!store || store.inside || (opts && typeof opts === "object" && opts.force)) return original.apply(this, args);
      store.inside = true;
      try {
        await this.waitFor({
          state: "visible",
          ...(opts && typeof opts === "object" && typeof opts.timeout === "number" ? { timeout: opts.timeout } : {}),
        });
        const verdict = revealedAt(await this.evaluate(measureReveal));
        if (!verdict.revealed) store.scrolls.push(verdict.hiddenBy);
        return await original.apply(this, args);
      } finally {
        store.inside = false;
      }
    };
  }
}

const countBy = (actions) => {
  const counts = { essential: 0, safety: 0, overhead: 0, total: 0 };
  for (const a of actions) {
    counts[a.class]++;
    counts.total++;
  }
  return counts;
};

/**
 * Compare a trace with its pinned baseline (both arrays of {action, class}). Pure: also used by flow-report.mjs.
 * The alignment is by action name in order (a longest common subsequence), so an injected step shows as extra and a
 * skipped one as missing, wherever they fall.
 */
export function compareTrace(actions, baseline) {
  const a = actions.map((x) => x.action),
    b = baseline.map((x) => x.action);
  const L = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const extra = [],
    missing = [],
    reclassed = [];
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      if (actions[i].class !== baseline[j].class)
        reclassed.push({ action: a[i], at: i, baseline: baseline[j].class, now: actions[i].class });
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || L[i][j + 1] >= L[i + 1][j]))
      missing.push({ action: b[j], class: baseline[j].class, at: j++ });
    else extra.push({ action: a[i], class: actions[i].class, at: i++ });
  }
  const now = countBy(actions),
    base = countBy(baseline);
  return {
    matches: extra.length === 0 && missing.length === 0 && reclassed.length === 0,
    counts: now,
    baselineCounts: base,
    extra,
    missing,
    reclassed,
    overheadOverBaseline: Math.max(0, now.overhead - base.overhead),
    // U2 level 1: more overhead than the baseline. Missing baseline actions are U2 level 0 only when the goal was
    // not reached (the goal assertion says that), so they are reported, not judged here.
    ratchet: now.overhead > base.overhead ? "fail" : "pass",
  };
}

/**
 * §5 "Elapsed task time", first action to goal assertion, from the harness's step timings: `ms` from the first action's
 * start to the goal step's end; `stepsMs` the time inside the steps (the product's waits and the journey's own);
 * `harnessMs` the rest (the harness's probes and invariants between steps), reported separately. Null when either end
 * is missing. Not performance's shared timing collector, and one run: flow-report.mjs reports it inconclusive.
 */
export function elapsedOf(steps, first, goal) {
  const a = steps[first],
    g = steps[goal];
  if (first === null || !a || !g || typeof a.startedMs !== "number" || typeof g.startedMs !== "number") return null;
  const ms = g.startedMs + (g.durationMs ?? 0) - a.startedMs;
  const stepsMs = steps.slice(first, goal + 1).reduce((n, s) => n + (s.durationMs ?? 0), 0);
  return { ms, stepsMs, harnessMs: ms - stepsMs };
}

/** Do two runs' traces have the same action counts (the §5 rule: run 1 of N must match runs 2…N)? */
export function sameCounts(x, y) {
  return (
    ["essential", "safety", "overhead", "total"].every((k) => x.counts[k] === y.counts[k]) && x.agentOps === y.agentOps
  );
}

/**
 * The recorder for one journey run. `ctx` is the journey's context ({ step, run }); `spec` is meta.flow
 * ({ id, baseline }). Writes run.flow after every action, so a journey that fails part-way still leaves its trace.
 */
export function flowRecorder({ step, run, page, faults = activeFaults() }, spec) {
  if (!spec || typeof spec.id !== "string" || !Array.isArray(spec.baseline))
    throw new Error("meta.flow needs { id, baseline: [{ action, class }] }");
  for (const b of spec.baseline)
    if (!CLASSES.includes(b.class))
      throw new Error(`baseline action "${b.action}" has class ${b.class}; one of ${CLASSES.join(", ")}`);
  const actions = [];
  let firstStep = null; // the step index of the first action (§5 elapsed task time starts there)
  const agentMark = (run.agentCalls ?? []).length;
  if (page) installRevealWatch(page);
  const dropScrolls = faults.has("drop-reveal-scroll");
  /** Run `fn` as an action, then the scrolls its targets needed: one essential "scroll to: <action>" each. */
  const watching = async (action, fn) => {
    const store = { scrolls: [], inside: false };
    const value = await acting.run(store, fn);
    return {
      value,
      scrolls: dropScrolls
        ? []
        : store.scrolls.map((hiddenBy) => ({
            action: `scroll to: ${action}`,
            class: "essential",
            kind: "scroll",
            hiddenBy,
          })),
    };
  };
  const flow = {
    schema: FLOW_SCHEMA,
    id: spec.id,
    cell: spec.cell ?? null,
    actions,
    counts: countBy([]),
    agentOps: 0,
    agentCalls: [],
    goal: null,
    comparison: null,
  };
  const write = () => {
    const calls = (run.agentCalls ?? []).slice(agentMark);
    flow.counts = countBy(actions);
    flow.agentOps = calls.length;
    flow.agentCalls = calls.map((c) => ({ op: c.op, ok: c.ok, ...(c.code ? { code: c.code } : {}) }));
    flow.comparison = compareTrace(actions, spec.baseline);
    return flow;
  };
  // A getter, so summary.json (written when the journey ends) also counts agent calls made after the last action.
  Object.defineProperty(run, "flow", { get: write, enumerable: true, configurable: true });
  return {
    /** A person's action: runs `fn` as a step titled after it and records one trace entry. */
    async act(action, cls, fn, { kind = "click", ...meta } = {}) {
      if (!CLASSES.includes(cls)) throw new Error(`action "${action}": class must be one of ${CLASSES.join(", ")}`);
      if (!KINDS.includes(kind)) throw new Error(`action "${action}": kind must be one of ${KINDS.join(", ")}`);
      const before = run.steps.length;
      firstStep ??= before;
      const { value, scrolls } = await watching(action, () => step(`[${cls}] ${action}`, fn, meta));
      const s = run.steps[before];
      const ok = s ? s.ok !== false && !s.skipped : false;
      for (const x of scrolls) actions.push({ ...x, step: before, ok });
      actions.push({ action, class: cls, kind, step: before, ok });
      write();
      return value;
    },
    /**
     * Several of a person's actions that one helper performs in one step (ui.rename: double-click, type, Enter):
     * `list` is [{ action, class, kind? }] (kind from the words when absent); one step, one trace entry each.
     */
    async actions(list, fn, meta = {}) {
      for (const a of list) {
        if (!CLASSES.includes(a.class))
          throw new Error(`action "${a.action}": class must be one of ${CLASSES.join(", ")}`);
        if (a.kind !== undefined && !KINDS.includes(a.kind))
          throw new Error(`action "${a.action}": kind must be one of ${KINDS.join(", ")}`);
      }
      const before = run.steps.length;
      firstStep ??= before;
      const { value, scrolls } = await watching(list[0]?.action ?? "", () =>
        step(list.map((a) => `[${a.class}] ${a.action}`).join(" → "), fn, meta),
      );
      const s = run.steps[before];
      for (const x of scrolls) actions.push({ ...x, step: before, ok: s ? s.ok !== false && !s.skipped : false });
      for (const a of list)
        actions.push({
          action: a.action,
          class: a.class,
          kind: a.kind ?? kindOf(a.action),
          step: before,
          ok: s ? s.ok !== false && !s.skipped : false,
        });
      write();
      return value;
    },
    /**
     * A `step` for helpers that take one (composeComment, addComment): a title that names an action in `baseline`
     * is recorded as that action, with its class; any other title is a plain step, not an action.
     */
    stepFor(baseline) {
      return (title, fn, meta = {}) => {
        const b = baseline.find((x) => x.action === title);
        return b ? this.act(title, b.class, fn, { kind: b.kind ?? kindOf(title), ...meta }) : step(title, fn, meta);
      };
    },
    /** The journey's mandatory-outcome assertion (a step, not an action): records whether the goal was reached. */
    async goal(title, fn, meta = {}) {
      const before = run.steps.length;
      const value = await step(`goal: ${title}`, fn, meta);
      const s = run.steps[before];
      flow.goal = { title, reached: Boolean(s && s.ok !== false && !s.skipped) };
      flow.elapsed = elapsedOf(run.steps, firstStep, before);
      write();
      return value;
    },
    /** A cell or round note, kept with the trace (e.g. a sub-check that is NOT EVALUATED and why). */
    note(key, value) {
      (flow.notes ??= {})[key] = value;
      write();
    },
    get trace() {
      return actions;
    },
  };
}
