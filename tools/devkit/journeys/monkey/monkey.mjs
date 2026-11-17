// Seeded random-action ("monkey") journey: one editable diagram type, one seed, a fixed time budget.
//
//   MONKEY_TYPE=flowchart|c4|er|state|sequence  MONKEY_SEED=<int>  MONKEY_SOURCE=corpus|alt|new  MONKEY_MS=180000
//   node tools/devkit/harness/smoke.mjs --sandbox monkey --journey tools/devkit/journeys/monkey/monkey.mjs
//
// corpus: open the corpus diagram from the reading page and press Edit. alt: open another corpus diagram
// straight at ?edit. new: New > Diagram in the journeys project with the type chosen.
//
// Every action is one harness step (the invariants run after it) and one line in <run dir>/monkey.jsonl:
// seed, source, action kind, the concrete target and coordinates, errors, failed invariants and ui/svc
// warnings. The sequence is drawn from the seed, so the same seed against the same app state repeats the
// same choices; the log holds the concrete targets for an exact replay. Stops early on a page error
// (uncaught exception, unhandled rejection, ui.page-error/ui.react-error other than the ResizeObserver
// notice) and keeps the last 20 actions in summary.json under monkey.stop.last20.
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

const TYPE_SPECS = {
  flowchart: {
    newType: "Flowchart",
    corpus: ["pageturner", "diagrams/fulfilment.mmd"],
    alt: ["awkward", "diagrams/flow-styled.mmd"],
  },
  c4: {
    newType: "C4 container",
    corpus: ["pageturner", "diagrams/containers.mmd"],
    alt: ["awkward", "diagrams/c4-boundaries.mmd"],
  },
  er: {
    newType: "Entity relationship",
    corpus: ["pageturner", "diagrams/data-model.mmd"],
    alt: ["awkward", "diagrams/er-awkward.mmd"],
  },
  state: {
    newType: "State",
    corpus: ["pageturner", "diagrams/order-lifecycle.mmd"],
    alt: ["awkward", "diagrams/state-composite.mmd"],
  },
  sequence: {
    newType: "Sequence",
    corpus: ["pageturner", "diagrams/checkout.mmd"],
    alt: ["awkward", "diagrams/seq-awkward.mmd"],
  },
};

const TARGET_SELECTORS = [
  ".react-flow__node",
  ".react-flow__edge",
  ".react-flow__edge-path",
  ".react-flow__handle",
  ".react-flow__edgeupdater",
  "g.archer-seq-participant",
  ".archer-seq-participant-box",
  "line.archer-seq-lifeline-hit",
  "g.archer-seq-message",
  "g.archer-seq-note",
  "g.archer-seq-fragment",
  "circle[data-seq-end]",
];

const ACTIONS = [
  ["canvasClick", 10],
  ["elementClick", 16],
  ["elementDouble", 8],
  ["elementDrag", 12],
  ["canvasDrag", 4],
  ["typeText", 10],
  ["key", 18],
  ["partsBar", 7],
  ["toggleSource", 3],
  ["toggleStructure", 3],
  ["panel", 4],
  ["undoRedo", 5],
  ["deleteSelected", 2],
  ["cancel", 1],
  ["save", 1],
  ["reload", 1],
];

// Save, Cancel (discard), reload and reopen leave the editor on purpose: not a dirty-navigation.
const LEAVES = new Set(["save", "cancel", "reload", "reopen"]);
const LABEL_CHANGING = new Set(["typeText", "key", "undoRedo", "elementDouble", "reload", "cancel", "save", "reopen"]);

const KEYS = [
  "Enter",
  "Escape",
  "Delete",
  "Backspace",
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Alt+ArrowUp",
  "Alt+ArrowDown",
  "Alt+ArrowLeft",
  "Alt+ArrowRight",
  "Shift+ArrowRight",
  "Control+z",
  "Control+Shift+z",
  "Control+y",
  "?",
  "c",
  "Space",
  "Control+a",
  "Control+c",
  "Control+v",
  "Control+d",
];

const WORDS = [
  "a",
  "db",
  "Order",
  "x1",
  "call API",
  "é ü",
  "a→b",
  "Hello world",
  "Retry",
  "1234567890abcdef",
  "<b>",
  "%%",
  "&amp;",
  "a;b",
  "end",
];

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s) => {
  let h = 2166136261;
  for (const c of s) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
const fmt = (p) => `(${Math.round(p.x)},${Math.round(p.y)})`;

export const meta = { name: `monkey-${process.env.MONKEY_TYPE ?? "unset"}-${process.env.MONKEY_SEED ?? "0"}` };

export default async ({ ui, step, page, run, sandbox }) => {
  const type = process.env.MONKEY_TYPE;
  const spec = TYPE_SPECS[type];
  if (!spec) throw new Error(`MONKEY_TYPE must be one of ${Object.keys(TYPE_SPECS).join(", ")}`);
  const seed = Number(process.env.MONKEY_SEED ?? 1);
  const source = process.env.MONKEY_SOURCE ?? "corpus";
  const budget = Number(process.env.MONKEY_MS ?? 180_000);
  const rng = mulberry32((seed ^ hash(`${type}/${source}`)) >>> 0);
  const pick = (a) => a[Math.floor(rng() * a.length)];
  const int = (n) => Math.floor(rng() * n);
  const logFile = join(dirname(run.artifacts.summary), "monkey.jsonl");
  const saveAs = `diagrams/monkey-${type}-${seed}.mmd`;
  run.monkey = {
    type,
    seed,
    source,
    budgetMs: budget,
    log: logFile,
    replay: `MONKEY_TYPE=${type} MONKEY_SEED=${seed} MONKEY_SOURCE=${source} node tools/devkit/harness/smoke.mjs --sandbox ${sandbox.name} --journey tools/devkit/journeys/monkey/monkey.mjs`,
  };

  // Current diagram: where Save/Cancel/reload leave us, so the monkey can get back in.
  const cur =
    source === "new"
      ? { isNew: true, slug: "journeys", path: null }
      : {
          isNew: false,
          ...(source === "alt"
            ? { slug: spec.alt[0], path: spec.alt[1] }
            : { slug: spec.corpus[0], path: spec.corpus[1] }),
        };
  const editor = () => ui.locators.editor().first();
  const editorOpen = () =>
    editor()
      .isVisible()
      .catch(() => false);
  const canvas = () => page.locator(".react-flow, .archer-seq-canvas").first();
  const canvasBox = async () =>
    (await canvas()
      .boundingBox()
      .catch(() => null)) ?? { x: 0, y: 0, width: 1440, height: 900 };
  const randomPoint = async () => {
    const b = await canvasBox();
    return { x: b.x + 8 + rng() * (b.width - 16), y: b.y + 8 + rng() * (b.height - 16) };
  };
  const targets = () =>
    page
      .evaluate((sels) => {
        const out = [];
        for (const s of sels)
          for (const el of document.querySelectorAll(s)) {
            const r = el.getBoundingClientRect();
            if (
              r.width < 2 ||
              r.height < 2 ||
              r.bottom < 0 ||
              r.top > innerHeight ||
              r.right < 0 ||
              r.left > innerWidth
            )
              continue;
            out.push({
              kind: s.replace(/^g\.|^line\.|^circle/, ""),
              id: el.getAttribute("data-id") ?? el.getAttribute("data-seq-id") ?? el.getAttribute("data-seq-end") ?? "",
              x: r.left,
              y: r.top,
              w: r.width,
              h: r.height,
            });
          }
        return out;
      }, TARGET_SELECTORS)
      .catch(() => []);
  const pickTarget = async (filter = () => true) => {
    const list = (await targets()).filter(filter);
    if (!list.length) return null;
    const t = pick(list);
    // Aim inside the box, not always at its centre.
    return { ...t, x: t.x + t.w * (0.2 + rng() * 0.6), y: t.y + t.h * (0.2 + rng() * 0.6) };
  };
  const tryDo = async (fn) => {
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      return {
        ok: false,
        reason: String(e.message ?? e)
          .split("\n")[0]
          .slice(0, 200),
      };
    }
  };
  // The canvas controls sit over the canvas, so a random click or double-click can land on "Hand mode". That is the
  // person choosing Hand mode, not the editor falling into it (pointer-mode judges the latter): when the action's own
  // coordinates hit the Hand button, switch back to Select within the same action and say so.
  const handButton = () => page.getByRole("button", { name: "Hand mode", exact: true }).first();
  const withHandGuard = async (fn) => {
    const hand = handButton();
    const before = await hand.getAttribute("aria-pressed", { timeout: 500 }).catch(() => null);
    const box = await hand.boundingBox({ timeout: 500 }).catch(() => null);
    const r = await fn();
    if (!r.ok || !box || before === "true") return r;
    if ((await hand.getAttribute("aria-pressed", { timeout: 500 }).catch(() => null)) !== "true") return r;
    const points = [...String(r.value ?? "").matchAll(/\((-?\d+),(-?\d+)\)/g)].map((m) => ({
      x: Number(m[1]),
      y: Number(m[2]),
    }));
    const onHand = points.some(
      (q) => q.x >= box.x - 4 && q.x <= box.x + box.width + 4 && q.y >= box.y - 4 && q.y <= box.y + box.height + 4,
    );
    if (!onHand) return r;
    await page
      .getByRole("button", { name: "Select mode", exact: true })
      .first()
      .click({ timeout: 2000 })
      .catch(() => {});
    return { ...r, value: `${r.value} (pressed Hand mode; back to Select)` };
  };
  const reopen = () =>
    cur.isNew
      ? ui.newDiagram("journeys", { type: spec.newType, saveAs })
      : ui.openDiagram(cur.slug, cur.path, { edit: true });

  // Start: resetProject restores the copy so each run begins from the snapshot.
  await ui.resetProject(cur.slug);
  if (source === "corpus") {
    await ui.openDiagram(cur.slug, cur.path);
    await ui.enterEdit();
  } else await reopen();

  const A = {
    async canvasClick() {
      const p = await randomPoint();
      await page.mouse.click(p.x, p.y);
      return `click canvas ${fmt(p)}`;
    },
    async elementClick() {
      const t = await pickTarget();
      if (!t) return A.canvasClick();
      await page.mouse.click(t.x, t.y);
      return `click ${t.kind} ${t.id} ${fmt(t)}`;
    },
    async elementDouble() {
      const t = await pickTarget();
      if (!t) {
        const p = await randomPoint();
        await page.mouse.dblclick(p.x, p.y);
        return `dblclick canvas ${fmt(p)}`;
      }
      await page.mouse.dblclick(t.x, t.y);
      return `dblclick ${t.kind} ${t.id} ${fmt(t)}`;
    },
    async elementDrag() {
      const from = (await pickTarget()) ?? (await randomPoint());
      const to = rng() < 0.5 ? ((await pickTarget()) ?? (await randomPoint())) : await randomPoint();
      await ui.drag(from, to);
      return `drag ${from.kind ?? "canvas"} ${from.id ?? ""} ${fmt(from)} -> ${fmt(to)}`;
    },
    async canvasDrag() {
      const from = await randomPoint(),
        to = await randomPoint();
      await ui.drag(from, to);
      return `drag canvas ${fmt(from)} -> ${fmt(to)}`;
    },
    async typeText() {
      const text = pick(WORDS);
      const label = ui.locators.openLabelInput();
      if (await label.isVisible().catch(() => false)) {
        await label.fill(text);
        const commit = pick(["Enter", "Enter", "Enter", "Escape", "Tab"]);
        await page.keyboard.press(commit);
        return `label "${text}" then ${commit}`;
      }
      const focused = await page.evaluate(() => {
        const a = document.activeElement;
        return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA");
      });
      if (focused) {
        await page.keyboard.type(text);
        return `typed "${text}" into focused field`;
      }
      await page.keyboard.type(text.slice(0, 3));
      return `typed "${text.slice(0, 3)}" with nothing focused (shortcuts)`;
    },
    async key() {
      const n = 1 + int(3);
      const keys = [];
      for (let i = 0; i < n; i++) {
        const k = pick(KEYS);
        keys.push(k);
        await page.keyboard.press(k === "Space" ? " " : k);
      }
      return `keys ${keys.join(" ")}`;
    },
    async partsBar() {
      const idx = await page
        .locator(".authoring-parts button")
        .evaluateAll((els) =>
          els.map((e, i) => (!e.disabled && e.offsetParent !== null ? i : -1)).filter((i) => i >= 0),
        );
      if (!idx.length) return "no parts visible";
      const i = pick(idx);
      const b = page.locator(".authoring-parts button").nth(i);
      const label = (await b.textContent())?.trim();
      await b.click({ timeout: 2000 });
      return `part "${label}"`;
    },
    // The editor's Source toggle: visible text "Source", accessible name "Mermaid source", aria-pressed. Families
    // whose pane is always open have no toggle.
    async toggleSource() {
      const toggle = editor()
        .or(page.getByRole("banner"))
        .getByRole("button", { name: "Mermaid source", exact: true })
        .first();
      if (!(await toggle.isVisible().catch(() => false))) return "no Source toggle (pane always open)";
      const was = await toggle.getAttribute("aria-pressed");
      await toggle.click({ timeout: 2000 });
      return `toggle Source (${was === "true" ? "hide" : "show"})`;
    },
    async toggleStructure() {
      await page.getByRole("button", { name: "Structure and properties", exact: true }).click({ timeout: 2000 });
      return "toggle Structure and properties";
    },
    async panel() {
      if (rng() < 0.6) {
        const t = await pickTarget(
          (x) => x.kind === "g.archer-seq-message" || x.kind === "react-flow__edge" || x.kind === "react-flow__node",
        );
        if (t) await page.mouse.click(t.x, t.y);
      }
      const panel = page
        .locator('section.authoring-message-panel, [role="region"][aria-label="Selected message"]')
        .first();
      if (!(await panel.isVisible().catch(() => false))) return "no message panel";
      const selects = panel.locator("select");
      const n = await selects.count();
      if (n && rng() < 0.7) {
        const s = selects.nth(int(n));
        const opts = await s.locator("option").count();
        const i = int(opts);
        await s.selectOption({ index: i });
        return `panel select #${i}`;
      }
      const pos = panel.getByLabel("Position in the sequence");
      if (await pos.count()) {
        const v = String(int(6));
        await pos.fill(v);
        await pos.press("Enter");
        return `panel position ${v}`;
      }
      return "panel idle";
    },
    async undoRedo() {
      const k = pick(["Undo", "Redo"]);
      if (rng() < 0.5) {
        await page.keyboard.press(k === "Undo" ? "Control+z" : "Control+Shift+z");
        return `key for ${k}`;
      }
      const b = page.getByRole("toolbar", { name: "Editing tools" }).getByRole("button", { name: k, exact: true });
      if (!(await b.isEnabled().catch(() => false))) return `${k} disabled`;
      await b.click({ timeout: 2000 });
      return `click ${k}`;
    },
    async deleteSelected() {
      const b = page
        .getByRole("toolbar", { name: "Editing tools" })
        .getByRole("button", { name: "Delete selected", exact: true });
      if (!(await b.isEnabled().catch(() => false))) return "Delete selected disabled";
      await b.click({ timeout: 2000 });
      return "click Delete selected";
    },
    async cancel() {
      const discard = rng() < 0.5;
      await ui.cancel({ discard });
      return `Cancel (${discard ? "Discard" : "Keep editing"})`;
    },
    async save() {
      const save = page.locator(".authoring-toolbar").getByRole("button", { name: "Save", exact: true });
      if (!(await save.isEnabled().catch(() => false))) return "Save disabled";
      await ui.save({ expectExit: false });
      await editor()
        .waitFor({ state: "hidden", timeout: 15_000 })
        .catch(() => {});
      if (cur.isNew && !(await editorOpen())) {
        cur.isNew = false;
        cur.slug = "journeys";
        cur.path = saveAs;
      }
      return `Save (editor ${(await editorOpen()) ? "still open" : "closed"})`;
    },
    async reload() {
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
      return "reload";
    },
    async reopen() {
      await reopen();
      return "reopen editor";
    },
  };
  const totalWeight = ACTIONS.reduce((n, [, w]) => n + w, 0);
  const chooseKind = () => {
    let r = rng() * totalWeight;
    for (const [k, w] of ACTIONS) {
      if ((r -= w) < 0) return k;
    }
    return ACTIONS[0][0];
  };

  const started = Date.now();
  const history = [];
  let stop = null;
  while (Date.now() - started < budget) {
    const idx = history.length + 1;
    const kind = (await editorOpen()) ? chooseKind() : "reopen";
    // Typing, keys (Enter commits a label, Ctrl+Z undoes), undo/redo and double-clicks change labels on purpose:
    // selection-identity would read that as "the selection now points at another element".
    const r = await step(
      `m${String(idx).padStart(3, "0")} ${kind}`,
      () => withHandGuard(() => tryDo(() => A[kind]())),
      {
        ...(LABEL_CHANGING.has(kind) ? { selectionMayChange: true } : {}),
        ...(LEAVES.has(kind) ? { leavesEditor: true } : {}),
      },
    );
    const s = run.steps.at(-1);
    // The harness skips every step after a failed one (returns undefined): stop instead of spinning.
    if (!s || s.skipped || s.ok === false) {
      stop = {
        at: idx,
        reason: `harness step ${s?.skipped ? "skipped" : "failed"}: ${s?.error ?? s?.skipped ?? "no step"}`.slice(
          0,
          400,
        ),
        last20: history.slice(-20),
      };
      break;
    }
    const pageErrors = (s?.invariantFailures ?? []).includes("page-errors");
    const uiErrors = (s?.warnings ?? []).filter(
      (w) =>
        /^ui\.(page-error|unhandled-rejection|react-error)$/.test(w.code ?? "") &&
        !/ResizeObserver loop/.test(w.msg ?? ""),
    );
    const rec = {
      i: idx,
      t: Date.now() - started,
      seed,
      type,
      source,
      kind,
      detail: r?.ok ? r.value : null,
      error: r && !r.ok ? r.reason : undefined,
      url: s?.url,
      invariantFailures: s?.invariantFailures ?? [],
      warnings: (s?.warnings ?? []).map((w) => ({ code: w.code, msg: String(w.msg ?? "").slice(0, 240) })),
      pageErrors: pageErrors || undefined,
    };
    history.push(rec);
    appendFileSync(logFile, JSON.stringify(rec) + "\n");
    if (pageErrors || uiErrors.length) {
      stop = {
        at: idx,
        reason: pageErrors ? "page-errors invariant" : `${uiErrors[0].code}: ${uiErrors[0].msg}`,
        last20: history.slice(-20),
      };
      break;
    }
  }
  run.monkey.actions = history.length;
  run.monkey.stop = stop ?? { reason: "time budget reached" };
  if (stop) run.monkey.stop.last20 = stop.last20;
  else delete run.monkey.stop.last20;
};
