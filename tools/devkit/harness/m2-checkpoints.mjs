// M2 focus checkpoints (docs/quality/rubrics/ui-ux-v1.1-lists.md §1, F01–F91): run each scripted action from a
// fresh context and record the active element (computed role + accessible name from the browser's accessibility
// tree via CDP, plus tag/id/class, ARIA states and the nearest named landmark/dialog) NEXT TO the list's expected
// focus. Records execution/coverage separately from destination correctness; retains raw focus observations. Checkpoints that need a person, or whose control is absent, are logged with why.
// Default cell 1500x900 light; F58/F60 also at 390x844. Writes (edit + Save, a comment, its deletion) go to the
// `journeys` project only; the comment is deleted again by F75.
// usage: node m2-checkpoints.mjs <target options> [--only F01,F02] --out dir
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import * as S from "./surfaces.mjs";
import {
  collectCheckpoint,
  columnCheckbox,
  highlights,
  deleteShape,
  commentPin,
  dirtySettings,
  noteDiscussion,
  openWalkthrough,
  walkthroughAction,
  markNotificationRead,
  highlightMember,
} from "./m2-probes.mjs";

export async function main() {
  const { values } = parseArgs({ options: { ...S.TARGET_OPTIONS, only: { type: "string" } } });
  const target = S.resolveTarget(values);
  const out = values.out ?? S.defaultOut("m2-checkpoints");
  mkdirSync(join(out, "shots"), { recursive: true });
  const only = values.only ? new Set(values.only.split(",")) : null;
  const O = target.origin;
  const PT = `/projects/${target.slug}`;
  const JF = "/projects/journeys/diagrams/flow.mmd";
  const READY = ".react-flow__node, .archer-seq-participant, .archer-journey-tools, .archer-journey";

  const browser = await chromium.launch();
  const storageState = await S.loginState(browser, target);
  const results = [];
  const shared = {}; // facts carried between checkpoints (thread id)

  async function observe(page, label = "") {
    const cdp = await page.context().newCDPSession(page);
    try {
      const { result } = await cdp.send("Runtime.evaluate", {
        expression:
          "(function(){let a=document.activeElement;while(a&&a.shadowRoot&&a.shadowRoot.activeElement)a=a.shadowRoot.activeElement;return a})()",
      });
      let role = null,
        name = null,
        ignored = null;
      if (result.objectId) {
        const ax = await cdp
          .send("Accessibility.getPartialAXTree", { objectId: result.objectId, fetchRelatives: false })
          .catch((e) => ({ err: String(e) }));
        const n = ax.nodes?.[0];
        if (n) {
          role = n.role?.value ?? null;
          name = n.name?.value ?? "";
          ignored = n.ignored || undefined;
        }
      }
      const dom = await page.evaluate(() => {
        const a = document.activeElement;
        if (!a) return { tag: null };
        const attr = (n) => a.getAttribute(n);
        const st = {};
        for (const k of [
          "aria-pressed",
          "aria-expanded",
          "aria-current",
          "aria-selected",
          "aria-checked",
          "aria-disabled",
          "aria-activedescendant",
          "disabled",
          "tabindex",
        ]) {
          const v = attr(k);
          if (v !== null) st[k] = v;
        }
        if (a.disabled) st.disabledProp = true;
        if ("checked" in a && (a.type === "checkbox" || a.type === "radio")) st.checked = a.checked;
        let land = null;
        for (let el = a.parentElement; el; el = el.parentElement) {
          const r =
            el.getAttribute("role") ||
            {
              NAV: "navigation",
              HEADER: "banner",
              MAIN: "main",
              ASIDE: "complementary",
              DIALOG: "dialog",
              FORM: "form",
              MENU: "menu",
            }[el.tagName] ||
            (el.tagName === "SECTION" && (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby"))
              ? "region"
              : null);
          if (
            r &&
            /^(navigation|banner|main|complementary|dialog|alertdialog|region|form|menu|toolbar|tablist|group|search|contentinfo|listbox|application)$/.test(
              r,
            )
          ) {
            const lb = el.getAttribute("aria-labelledby");
            const nm =
              el.getAttribute("aria-label") ||
              (lb
                ? lb
                    .split(/\s+/)
                    .map((id) => document.getElementById(id)?.textContent?.trim())
                    .filter(Boolean)
                    .join(" ")
                : "");
            (land ??= []).push(`${r}${nm ? ` "${nm.slice(0, 60)}"` : ""}`);
            if (land.length >= 3) break;
          }
        }
        const cls = typeof a.className === "string" ? a.className : (a.getAttribute("class") ?? "");
        return {
          tag: a.tagName.toLowerCase(),
          id: a.id || undefined,
          class: cls.slice(0, 80) || undefined,
          text: (a.innerText ?? "").trim().replace(/\s+/g, " ").slice(0, 60) || undefined,
          states: Object.keys(st).length ? st : undefined,
          within: land ?? undefined,
          inDrawing: !!a.closest(".react-flow, .archer-seq-viewport, .archer-journey") || undefined,
        };
      });
      return { at: label, role, name, ...(ignored ? { axIgnored: true } : {}), ...dom };
    } finally {
      await cdp.detach().catch(() => {});
    }
  }
  const fmt = (o) =>
    !o
      ? "—"
      : o.error
        ? `error: ${o.error}`
        : `${o.role ?? "?"} "${(o.name ?? "").slice(0, 70)}" <${o.tag}${o.id ? "#" + o.id : ""}${o.class ? "." + o.class.split(/\s+/)[0] : ""}>${o.states ? " " + JSON.stringify(o.states) : ""}${o.within ? " in " + o.within.join(" < ") : ""}`;

  async function fresh(vp = "1500x900") {
    const ctx = await S.cellContext(browser, { viewport: vp, theme: "light", storageState });
    const page = await ctx.newPage();
    return { ctx, page };
  }
  async function go(page, path, ready) {
    await page.goto(O + path, { waitUntil: "domcontentloaded" });
    if (ready)
      await page
        .locator(ready)
        .first()
        .waitFor({ timeout: 15000 })
        .catch(() => {});
    await S.settle(page);
  }
  async function blurAll(page) {
    await page.evaluate(() => {
      document.activeElement?.blur?.();
    });
  }
  async function kbActivate(page, loc, key = "Enter") {
    await loc.focus({ timeout: 5000 });
    await page.keyboard.press(key);
    await S.settle(page, 400);
  }
  const btn = (page, name, exact = true) => page.getByRole("button", { name, exact }).first();
  async function exists(loc) {
    return (
      (await loc.count().catch(() => 0)) > 0 &&
      (await loc
        .first()
        .isVisible()
        .catch(() => false))
    );
  }
  async function navCount(page) {
    return page.evaluate(
      () =>
        performance.getEntriesByType("navigation").length +
        ":" +
        (window.__m2doc ??= Math.random().toString(36).slice(2)),
    );
  }

  async function tabInto(page, pred, max = 60) {
    // Tab until the active element satisfies pred (in-page); returns observations of the hit and stops count.
    for (let i = 0; i < max; i++) {
      await page.keyboard.press("Tab");
      await page.waitForTimeout(60);
      if (await page.evaluate(pred).catch(() => false)) return i + 1;
    }
    return null;
  }
  const IN_DRAWING = () => !!document.activeElement?.closest(".react-flow, .archer-seq-viewport, .archer-journey, svg");

  /** cp(id, cell, action, expected, fn): fn(page, rec) returns nothing; it pushes observations through rec(). */
  let ran = false;
  async function cp(id, meta, fn, { vp = "1500x900" } = {}) {
    ran = false;
    if (only && !only.has(id)) return;
    ran = true;
    const row = {
      id,
      cell: meta.cell,
      viewport: vp,
      theme: "light",
      action: meta.action,
      expected: meta.expected,
      then: meta.then ?? null,
      observed: [],
      notes: [],
    };
    const { ctx, page } = await fresh(vp);
    const rec = async (label) => {
      row.observed.push(await observe(page, label).catch((e) => ({ at: label, error: String(e).split("\n")[0] })));
    };
    const note = (s) => row.notes.push(s);
    try {
      const r = await collectCheckpoint(page, async () => fn(page, rec, note));
      row.outcome = r.outcome;
      if (r.evidence) row.evidence = r.evidence;
      if (r.executed !== undefined) row.executed = r.executed;
      if (r.skip) {
        row.status = "skipped";
        row.reason = r.skip;
      } else if (r.manual) {
        row.status = "manual";
        row.outcome = "coverage absent";
        row.reason = r.manual;
      } else {
        row.status = r.status;
        row.reason = r.reason;
      }
    } catch (e) {
      row.status = "error";
      row.outcome = "action not executed";
      row.reason = String(e?.message ?? e)
        .split("\n")[0]
        .replace(/token=[0-9a-f]+/g, "token=<redacted>");
    }
    try {
      await page.screenshot({ path: join(out, "shots", `${id}${vp !== "1500x900" ? "-" + vp : ""}.png`) });
    } catch {}
    row.url = S.redact(page.url());
    await ctx.close().catch(() => {});
    results.push(row);
    console.log(id, row.status, row.reason ?? "", row.observed.map(fmt).join(" || ").slice(0, 300));
  }
  const manual = (id, meta, why) => {
    if (only && !only.has(id)) return;
    results.push({
      id,
      cell: meta.cell,
      action: meta.action,
      expected: meta.expected,
      then: meta.then ?? null,
      observed: [],
      notes: [],
      status: "manual",
      outcome: "coverage absent",
      reason: why,
    });
    console.log(id, "manual", why);
  };

  // ---------- Opening surfaces ----------
  await cp(
    "F01",
    {
      cell: "P1 with projects",
      action: "Load the overview URL in a fresh tab; then Tab once",
      expected: "`body`",
      then: "first Tab lands on a visible control inside navigation or banner, not inside main",
    },
    async (page, rec) => {
      await go(page, "/projects/");
      await rec("after load");
      await page.keyboard.press("Tab");
      await S.settle(page, 200);
      await rec("after first Tab");
    },
  );
  await cp(
    "F02",
    {
      cell: "P1",
      action: "Press `/` with focus on body; then type `pa`",
      expected: 'searchbox/textbox ~"Search" (the primary search field)',
      then: "typing filters in place; no result opens",
    },
    async (page, rec, note) => {
      await go(page, "/projects/");
      await blurAll(page);
      await page.keyboard.press("/");
      await S.settle(page, 300);
      await rec("after /");
      const u = page.url();
      await page.keyboard.type("pa");
      await S.settle(page, 500);
      await rec("after typing 'pa'");
      note(`URL before typing ${S.redact(u)}; after ${S.redact(page.url())}`);
    },
  );
  for (const [where, path] of [
    ["P1", "/projects/"],
    ["P2", `${PT}/`],
  ]) {
    await cp(
      `F03`,
      {
        cell: where,
        action: "Activate the Cards or Table choice (keyboard: focus, Enter)",
        expected: "stays, now pressed, checked or selected",
      },
      async (page, rec, note) => {
        await go(page, path);
        const c = page
          .getByRole("radio", { name: /^(Table|Cards)$/ })
          .or(page.getByRole("button", { name: /^(Table|Cards)( view)?$/ }))
          .or(page.getByRole("tab", { name: /^(Table|Cards)$/ }));
        const n = await c.count();
        if (!n) return { skip: "no Cards/Table control found" };
        const names = [];
        for (let i = 0; i < n; i++)
          names.push((await c.nth(i).getAttribute("aria-pressed")) + "|" + (await c.nth(i).textContent())?.trim());
        note(`controls: ${names.join(", ")}`);
        // activate the one not currently pressed/checked
        let target = c.first();
        for (let i = 0; i < n; i++) {
          const el = c.nth(i);
          const on =
            (await el.getAttribute("aria-pressed")) === "true" ||
            (await el.getAttribute("aria-checked")) === "true" ||
            (await el.isChecked().catch(() => false));
          if (!on) {
            target = el;
            break;
          }
        }
        await target.focus();
        await rec("focused, before");
        await page.keyboard.press(
          ((await target.getAttribute("role")) ?? (await target.getAttribute("type"))) === "radio" ? "Space" : "Enter",
        );
        await S.settle(page, 400);
        await rec("after activate");
      },
    );
    ran && (results.at(-1).id = `F03 (${where})`);
  }
  async function openFilters(page) {
    await go(page, "/projects/");
    const f = page.getByRole("button", { name: /^Filters/ }).first();
    await kbActivate(page, f);
    return f;
  }
  await cp(
    "F04",
    {
      cell: "Project Filters",
      action: 'Activate button ~"Filters" (Enter)',
      expected:
        'inside dialog "Project Filters": the dialog / button "Close filters" / the first control of the Filters section',
      then: "Tab and Shift+Tab wrap inside; Filters is the marked section",
    },
    async (page, rec, note) => {
      await openFilters(page);
      await rec("after open");
      const seq = [];
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press("Tab");
        seq.push(
          await page.evaluate(() => {
            const a = document.activeElement;
            return (
              (a.closest("[role=dialog],dialog") ? "in" : "OUT") +
              ":" +
              (a.getAttribute("aria-label") || a.innerText || a.tagName).trim().slice(0, 24)
            );
          }),
        );
      }
      note(
        `40 Tabs: ${[...new Set(seq)].length} distinct stops; outside dialog: ${seq.filter((s) => s.startsWith("OUT")).length}; sequence: ${seq.join(" → ")}`,
      );
      const back = [];
      for (let i = 0; i < 20; i++) {
        await page.keyboard.press("Shift+Tab");
        back.push(await page.evaluate(() => (document.activeElement.closest("[role=dialog],dialog") ? "in" : "OUT")));
      }
      note(`20 Shift+Tabs, outside dialog: ${back.filter((s) => s === "OUT").length}`);
      note(
        `marked section: ${await page
          .locator("[role=dialog] [aria-current], dialog [aria-current]")
          .allInnerTexts()
          .then((t) => t.join("|"))
          .catch(() => "?")}`,
      );
    },
  );
  for (const sec of [/Table Columns/, /Card Details/]) {
    await cp(
      "F05",
      {
        cell: "Project Filters",
        action: `Activate the ${sec.source} section control`,
        expected: "stays on that control, now marked current",
        then: "the next Tab goes into that section's first control",
      },
      async (page, rec) => {
        await openFilters(page);
        const s = page
          .getByRole("dialog")
          .getByRole("button", { name: sec })
          .or(page.getByRole("dialog").getByRole("link", { name: sec }))
          .or(page.getByRole("dialog").getByRole("tab", { name: sec }))
          .first();
        if (!(await exists(s))) return { skip: `no ${sec.source} control in the dialog` };
        await kbActivate(page, s);
        await rec("after activate");
        await page.keyboard.press("Tab");
        await S.settle(page, 200);
        await rec("after next Tab");
      },
    );
    ran && (results.at(-1).id = `F05 (${sec.source})`);
  }
  async function columnsSection(page) {
    await openFilters(page);
    const s = page
      .getByRole("dialog")
      .getByRole("button", { name: /Table Columns/ })
      .or(page.getByRole("dialog").getByRole("link", { name: /Table Columns/ }))
      .or(page.getByRole("dialog").getByRole("tab", { name: /Table Columns/ }))
      .first();
    if (await exists(s)) await kbActivate(page, s);
  }
  await cp(
    "F06",
    {
      cell: "Project Filters",
      action: "Toggle a column checkbox in Table Columns (Space), then toggle back",
      expected: "stays on that checkbox",
    },
    async (page, rec) => {
      await columnsSection(page);
      return columnCheckbox(page, rec);
    },
  );
  await cp(
    "F07",
    {
      cell: "Project Filters",
      action: 'Move a column by keys (a move button with Enter, or arrows on button "Move <label> column")',
      expected: "stays on the moved column's control",
    },
    async (page, rec, note) => {
      await go(page, `${PT}/`);
      note("the Filters dialog has no column controls; the Move buttons are in the P2 table header");
      const mv = page.getByRole("button", { name: /^Move .* column$/ }).filter({ visible: true });
      const n = await mv.count();
      if (!n) return { skip: "no Move … column control visible" };
      note(
        `move controls: ${(await mv.evaluateAll((els) => els.slice(0, 6).map((e) => e.getAttribute("aria-label") || e.textContent))).join(" | ")}`,
      );
      const m = mv.nth(1 < n ? 1 : 0);
      await m.focus();
      await rec("focused, before");
      await page.keyboard.press("ArrowDown");
      await S.settle(page, 300);
      await rec("after ArrowDown");
      await page.keyboard.press("ArrowUp");
      await S.settle(page, 300);
      await rec("after ArrowUp (restore)");
      await m.focus().catch(() => {});
      await page.keyboard.press("Enter");
      await S.settle(page, 300);
      await rec("after Enter on a move control");
    },
  );
  await cp(
    "F08",
    { cell: "Project Filters", action: "Activate Done", expected: 'the launcher, button ~"Filters"' },
    async (page, rec) => {
      await openFilters(page);
      const d = page.getByRole("dialog").getByRole("button", { name: "Done", exact: true }).first();
      if (!(await exists(d))) return { skip: "no Done button" };
      await kbActivate(page, d);
      await rec("after Done");
    },
  );
  await cp(
    "F09",
    { cell: "Project Filters", action: "Press Escape", expected: 'the launcher, button ~"Filters"' },
    async (page, rec) => {
      await openFilters(page);
      await page.keyboard.press("Escape");
      await S.settle(page, 300);
      await rec("after Escape");
    },
  );
  await cp(
    "F10",
    {
      cell: "P3",
      action: "Open a note from P2 (Enter on its title)",
      expected:
        "in-app navigation: heading level 1 named the note title / document load: body, then F01's first-Tab rule",
    },
    async (page, rec, note) => {
      await go(page, `${PT}/`);
      const before = await navCount(page);
      const l = page
        .getByRole("button", { name: /^Scenario: The Card Is Declined/ })
        .or(page.getByRole("link", { name: /card is declined/ }))
        .first();
      if (!(await exists(l))) return { skip: "no note link on the project page" };
      note(`link: ${(await l.textContent())?.trim().slice(0, 60)}`);
      await kbActivate(page, l);
      await page.waitForTimeout(800);
      await S.settle(page);
      const after = await navCount(page).catch(() => "?");
      note(
        before.split(":")[1] === after.split(":")[1]
          ? "in-app navigation (same document)"
          : "document load (new document)",
      );
      await rec("after open");
      await page.keyboard.press("Tab");
      await S.settle(page, 200);
      await rec("after first Tab");
    },
  );
  const NOTE_PARAGRAPH = ".archer-note-body p";
  async function selectPassage(page) {
    // The note body renders after load: wait for its paragraphs, or the first run finds none (round 1, F11 "no paragraph").
    await go(page, `${PT}/notes/scenario-declined-card.md`, NOTE_PARAGRAPH);
    return page.evaluate(() => {
      const p = [...document.querySelectorAll(".archer-note-body p")].find((e) =>
        /\S{3,}( \S+){8,}/.test(e.textContent),
      );
      if (!p) return false;
      const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      let t = null;
      while (w.nextNode()) {
        if (w.currentNode.textContent.trim().length > 20) {
          t = w.currentNode;
          break;
        }
      }
      if (!t) return false;
      const r = document.createRange();
      r.setStart(t, 0);
      r.setEnd(t, Math.min(t.length, 40));
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
      document.dispatchEvent(new Event("selectionchange"));
      p.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return true;
    });
  }
  await cp(
    "F11",
    {
      cell: "P3",
      action: "Select a passage (selection made by script — no caret browsing — then keyup), then press C",
      expected: 'textbox in form "New comment"',
    },
    async (page, rec, note) => {
      if (!(await selectPassage(page))) return { skip: "no paragraph" };
      note("selection set with a DOM Range by script, not by keyboard (the reading view has no caret)");
      await page.keyboard.press("Shift");
      await page.waitForTimeout(400);
      await rec("after selection");
      await page.keyboard.press("c");
      await S.settle(page, 500);
      await rec("after C");
    },
  );
  await cp(
    "F12",
    {
      cell: "P3",
      action: "Select a passage (script), then Shift+F10; then Escape",
      expected: 'first menuitem "Comment on selection" in the selection menu',
      then: "Escape returns focus to where focus was before the menu",
    },
    async (page, rec, note) => {
      if (!(await selectPassage(page))) return { skip: "no paragraph" };
      note("selection set with a DOM Range by script");
      await page.keyboard.press("Shift");
      await page.waitForTimeout(400);
      await rec("before Shift+F10");
      await page.keyboard.press("Shift+F10");
      await S.settle(page, 500);
      await rec("after Shift+F10");
      await page.keyboard.press("Escape");
      await S.settle(page, 300);
      await rec("after Escape");
    },
  );
  async function dragSelect(page) {
    await go(page, `${PT}/notes/scenario-declined-card.md`, NOTE_PARAGRAPH);
    const para = page
      .locator(".archer-note-body p")
      .filter({ hasText: /\S{3,}( \S+){8,}/ })
      .first();
    const box = await para.boundingBox().catch(() => null);
    if (!box) return false;
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + Math.min(box.width - 2, 220), box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    return true;
  }
  await cp(
    "F11m",
    {
      cell: "P3 (variant)",
      action: "Select a passage with a pointer drag (the P3.selection recipe), then press C",
      expected: 'textbox in form "New comment"',
    },
    async (page, rec, note) => {
      if (!(await dragSelect(page))) return { skip: "no paragraph" };
      note("variant of F11: pointer selection, because the scripted Range selection was not taken up by the page");
      await rec("after drag selection");
      await page.keyboard.press("c");
      await S.settle(page, 500);
      await rec("after C");
    },
  );
  await cp(
    "F12m",
    {
      cell: "P3 (variant)",
      action: "Select a passage with a pointer drag, then Shift+F10; then Escape",
      expected: 'first menuitem "Comment on selection" in the selection menu',
      then: "Escape returns focus to where focus was before the menu",
    },
    async (page, rec, note) => {
      if (!(await dragSelect(page))) return { skip: "no paragraph" };
      note("variant of F12: pointer selection");
      await rec("after drag selection");
      await page.keyboard.press("Shift+F10");
      await S.settle(page, 500);
      await rec("after Shift+F10");
      await page.keyboard.press("Escape");
      await S.settle(page, 300);
      await rec("after Escape");
    },
  );
  await cp(
    "F13",
    {
      cell: "P3 discussion margin",
      action: "Activate a margin bubble; then collapse it",
      expected: "stays on the bubble, now aria-expanded=true / the thread's first control",
      then: "collapsing returns focus to the bubble",
    },
    async (page, rec) => {
      await go(page, `${PT}/notes/0001-hosted-payment-page.md`);
      return noteDiscussion(page, rec);
    },
  );
  await cp(
    "F14",
    {
      cell: "P4 Explore",
      action: "Open a diagram from P2 (Enter on its title)",
      expected:
        "in-app navigation: heading level 1 named the diagram title / document load: body, then F01's first-Tab rule",
    },
    async (page, rec, note) => {
      await go(page, `${PT}/`);
      const before = await navCount(page);
      const l = page
        .getByRole("button", { name: "System Context", exact: true })
        .or(page.getByRole("link", { name: "System Context", exact: true }))
        .first();
      if (!(await exists(l))) return { skip: "no diagram link on the project page" };
      note(`link: ${(await l.textContent())?.trim().slice(0, 60)}`);
      await kbActivate(page, l);
      await page
        .locator(READY)
        .first()
        .waitFor({ timeout: 15000 })
        .catch(() => {});
      await S.settle(page);
      const after = await navCount(page).catch(() => "?");
      note(
        before.split(":")[1] === after.split(":")[1]
          ? "in-app navigation (same document)"
          : "document load (new document)",
      );
      await rec("after open");
      await page.keyboard.press("Tab");
      await S.settle(page, 200);
      await rec("after first Tab");
    },
  );
  await cp(
    "F15",
    {
      cell: "P4 Explore, graph (system-context flowchart)",
      action: "Tab from the last control before the drawing; one more Tab; then ArrowRight, ArrowDown",
      expected: "an edge of the drawing, with its label in its name; one more Tab reaches a node",
      then: "arrows move between edges or between nodes, and the selection doesn't change",
    },
    async (page, rec, note) => {
      await go(page, `${PT}/diagrams/system-context.mmd`, READY);
      await blurAll(page);
      const n = await tabInto(page, IN_DRAWING);
      if (n == null) return { skip: "60 Tabs never reached the drawing" };
      note(`drawing reached after ${n} Tabs from body`);
      await rec("first stop in drawing");
      await page.keyboard.press("Tab");
      await S.settle(page, 200);
      await rec("one more Tab");
      const sel0 = await page.locator("[aria-selected=true], .selected").count();
      await page.keyboard.press("ArrowRight");
      await S.settle(page, 200);
      await rec("after ArrowRight");
      await page.keyboard.press("ArrowDown");
      await S.settle(page, 200);
      await rec("after ArrowDown");
      note(
        `selected elements before/after arrows: ${sel0}/${await page.locator("[aria-selected=true], .selected").count()}`,
      );
    },
  );
  for (const [fam, file] of [
    ["sequence", "checkout.mmd"],
    ["journey", "buying-a-book.mmd"],
  ]) {
    await cp(
      "F16",
      {
        cell: `P4 Explore, ${fam}`,
        action: "Tab into the drawing; one more Tab; then ArrowDown, ArrowRight",
        expected: "sequence: a participant, then the messages / journey: the first section heading",
        then: "↑/↓ and ←/→ as the Help rows say",
      },
      async (page, rec, note) => {
        await go(page, `${PT}/diagrams/${file}`, READY);
        await blurAll(page);
        const n = await tabInto(page, IN_DRAWING);
        if (n == null) return { skip: "60 Tabs never reached the drawing" };
        note(`drawing reached after ${n} Tabs from body`);
        await rec("first stop in drawing");
        await page.keyboard.press("Tab");
        await S.settle(page, 200);
        await rec("one more Tab");
        await page.keyboard.press("ArrowDown");
        await S.settle(page, 200);
        await rec("after ArrowDown");
        await page.keyboard.press("ArrowRight");
        await S.settle(page, 200);
        await rec("after ArrowRight");
      },
    );
    ran && (results.at(-1).id = `F16 (${fam})`);
  }

  // ---------- P4 modes and actions ----------
  async function focusNode(page, file = `${PT}/diagrams/system-context.mmd`) {
    await go(page, file, READY);
    await blurAll(page);
    const n = await tabInto(page, IN_DRAWING);
    if (n == null) return false;
    // prefer a node: Tab once more if on an edge
    if (await page.evaluate(() => !!document.activeElement.closest(".react-flow__edge"))) {
      await page.keyboard.press("Tab");
      await page.waitForTimeout(100);
    }
    return true;
  }
  await cp(
    "F20",
    {
      cell: "Explore (system-context)",
      action: "Enter on a focused node; Space on a focused node",
      expected: "stays on it, now selected",
    },
    async (page, rec) => {
      if (!(await focusNode(page))) return { skip: "could not focus the drawing" };
      await rec("focused");
      await page.keyboard.press("Enter");
      await S.settle(page, 300);
      await rec("after Enter");
      await page.keyboard.press("Escape");
      await S.settle(page, 200);
      await page.keyboard.press("Space");
      await S.settle(page, 300);
      await rec("after Escape then Space");
    },
  );
  await cp(
    "F21",
    { cell: "Explore (system-context)", action: "Escape with a selection", expected: "stays; the selection clears" },
    async (page, rec, note) => {
      if (!(await focusNode(page))) return { skip: "could not focus the drawing" };
      await page.keyboard.press("Enter");
      await S.settle(page, 300);
      await rec("selected");
      const a = await page.locator("[aria-selected=true], .selected").count();
      await page.keyboard.press("Escape");
      await S.settle(page, 300);
      await rec("after Escape");
      note(
        `selected elements before/after Escape: ${a}/${await page.locator("[aria-selected=true], .selected").count()}`,
      );
    },
  );
  const HL = target.emphasisDiagram ? `/projects/${target.emphasisDiagram}` : `${PT}/diagrams/containers.mmd`;
  const WALK = `${PT}/diagrams/containers.mmd`;
  await cp(
    "F22",
    {
      cell: `Highlights (${HL.replace(/^\/projects\//, "")}, corpus checkout-highlights)`,
      action: 'Activate button ~"Highlights ·" (Enter)',
      expected: "stays, aria-pressed=true; the mode reads Highlights",
    },
    async (page, rec) => {
      await go(page, HL, READY);
      return highlights(page, rec);
    },
  );
  await cp(
    "F23",
    {
      cell: "Highlights → Explore",
      action: "Activate the same button again",
      expected: 'stays, aria-pressed=false; the text "Explore" shows',
    },
    async (page, rec, note) => {
      await go(page, HL, READY);
      return highlights(page, rec, { off: true });
    },
  );
  await cp(
    "F24",
    {
      cell: "Highlights",
      action: "Activate a member button under the legend's Members",
      expected: "the named element on the drawing, panned into view",
    },
    async (page, rec, note) => {
      await go(page, HL, READY);
      return highlightMember(page, rec);
    },
  );
  await cp(
    "F25",
    {
      cell: "Walkthrough (containers, checkout-tour)",
      action: "Activate Walkthroughs",
      expected: "the first chooser button / the current step row",
    },
    async (page, rec) => {
      await go(page, WALK, READY);
      return openWalkthrough(page, rec);
    },
  );
  await cp(
    "F26",
    {
      cell: "Walkthrough (containers, checkout-tour)",
      action: "Choose a walkthrough from its list (open the picker when the sole tour is already chosen)",
      expected: "the step-1 row with aria-current=step",
    },
    async (page, rec) => {
      await go(page, WALK, READY);
      return openWalkthrough(page, rec, { choose: true });
    },
  );
  for (const [id, action, expected] of [
    ["F27", "Activate Next repeatedly through the last step", "stays on Next at the end; live region names each step"],
    ["F28", "ArrowRight/ArrowLeft on Steps/Sequence tabs", "the newly selected tab"],
    ["F29", "Activate Follow steps", "stays on Follow steps and toggles aria-pressed"],
    ["F30", "Activate Close walkthrough", "Walkthroughs launcher with aria-pressed=false"],
  ])
    await cp(id, { cell: "Walkthrough (containers, checkout-tour)", action, expected }, async (page, rec) => {
      await go(page, WALK, READY);
      return walkthroughAction(page, rec, { id });
    });

  // Edit (journeys project: writes allowed)
  async function enterEdit(page) {
    await go(page, JF, READY);
    const e = page.getByRole("button", { name: "Edit", exact: true }).first();
    if (!(await exists(e))) return null;
    await kbActivate(page, e);
    await page
      .locator(".authoring-workspace")
      .first()
      .waitFor({ timeout: 15000 })
      .catch(() => {});
    await S.settle(page, 600);
    return e;
  }
  async function focusShape(page) {
    await blurAll(page);
    const shape = page.locator(".authoring-workspace .react-flow__node").first();
    if (await exists(shape)) {
      await shape.focus().catch(() => {});
      if (await page.evaluate(() => !!document.activeElement.closest(".react-flow__node")))
        return "focused node directly";
    }
    const n = await tabInto(page, () => !!document.activeElement.closest(".react-flow__node"), 80);
    return n == null ? null : `node reached after ${n} Tabs`;
  }
  await cp(
    "F31",
    {
      cell: "Edit (journeys flow.mmd)",
      action: 'Activate button "Edit" (Enter)',
      expected:
        'a named element inside region "Diagram Editor": the drawing / the first item of toolbar "Editing tools"; never an element without role and name',
    },
    async (page, rec) => {
      if (!(await enterEdit(page))) return { skip: "no Edit button" };
      await rec("after Edit");
      await page
        .getByRole("button", { name: "Cancel", exact: true })
        .first()
        .click()
        .catch(() => {});
    },
  );
  manual(
    "F32",
    { cell: "Edit", action: "Rename a node inline, then Enter", expected: "the renamed node" },
    "inline rename needs the double-click/F2 text-edit flow; covered by the harness journeys (editor-entry, flowchart-create), not scripted here",
  );
  manual(
    "F33",
    { cell: "Edit", action: 'Open "Connect to…", choose a target', expected: 'button ~"Connect to"' },
    "Connect-to menu flow not scripted; covered by the harness flowchart-create journey",
  );
  await cp(
    "F34",
    {
      cell: "Edit (journeys flow.mmd)",
      action: "Focus a shape; ArrowRight; Alt+ArrowRight",
      expected: "stays on the moved shape or message",
    },
    async (page, rec, note) => {
      if (!(await enterEdit(page))) return { skip: "no Edit button" };
      const how = await focusShape(page);
      if (!how) return { skip: "no shape focusable in the editor" };
      note(how);
      await rec("focused shape");
      const b0 = await page.evaluate(() => document.activeElement.closest(".react-flow__node")?.style.transform ?? "");
      await page.keyboard.press("ArrowRight");
      await S.settle(page, 300);
      await rec("after ArrowRight");
      await page.keyboard.press("Alt+ArrowRight");
      await S.settle(page, 300);
      await rec("after Alt+ArrowRight");
      note(
        `node transform before/after: ${b0} / ${await page.evaluate(() => document.activeElement.closest(".react-flow__node")?.style.transform ?? "(focus not in a node)")}`,
      );
      shared.f34page = true;
      // F36 on the same page: Save
      const save = page.getByRole("button", { name: "Save", exact: true }).first();
      const dis = await save
        .evaluate((e) => ({ disabled: e.disabled, aria: e.getAttribute("aria-disabled") }))
        .catch(() => null);
      note(`Save state after the move: ${JSON.stringify(dis)}`);
      if (dis && !dis.disabled && dis.aria !== "true") {
        await kbActivate(page, save);
        await page.waitForTimeout(1500);
        await S.settle(page);
        await rec("F36: after Save (Enter), changes present");
      } else {
        note("F36 not reached here: the key move left Save disabled (no unsaved change)");
      }
      await page
        .getByRole("button", { name: "Cancel", exact: true })
        .first()
        .click({ timeout: 2000 })
        .catch(() => {});
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Discard" })
        .click({ timeout: 2000 })
        .catch(() => {});
    },
  );
  await cp(
    "F35",
    {
      cell: "Edit (journeys flow.mmd)",
      action:
        "Add an unconnected Process, select it with Space, press Delete and verify count decreases; Cancel → Discard",
      expected: "the drawing / the nearest remaining shape",
    },
    async (page, rec) => {
      if (!(await enterEdit(page))) return { skip: "no Edit button" };
      const result = await deleteShape(page, rec);
      await page
        .getByRole("button", { name: "Cancel", exact: true })
        .first()
        .click()
        .catch(() => {});
      const discard = page.getByRole("alertdialog").getByRole("button", { name: "Discard", exact: true });
      if (await exists(discard)) await discard.click();
      return result;
    },
  );
  await cp(
    "F36",
    {
      cell: "Edit (journeys flow.mmd)",
      action:
        "Make a change (rename via the source/inspector is not scripted; a key move or a Process part), then Save (Enter)",
      expected:
        'editing continues: stays on button "Save" (aria-disabled while nothing is unsaved) / editing ends: button "Edit"',
    },
    async (page, rec, note) => {
      if (!(await enterEdit(page))) return { skip: "no Edit button" };
      if (!(await focusShape(page))) return { skip: "no shape focusable" };
      await page.keyboard.press("ArrowDown");
      await S.settle(page, 300);
      const save = page.getByRole("button", { name: "Save", exact: true }).first();
      let st = await save
        .evaluate((e) => ({ disabled: e.disabled, aria: e.getAttribute("aria-disabled") }))
        .catch(() => null);
      note(`Save after ArrowDown on a shape: ${JSON.stringify(st)}`);
      if (!st || st.disabled || st.aria === "true") {
        const part = page.locator(".authoring-parts").getByRole("button", { name: "Process", exact: true });
        if (await part.count()) {
          await part.click();
          await page.keyboard.type("M2probe");
          await page.keyboard.press("Enter");
          await S.settle(page, 400);
        }
        st = await save
          .evaluate((e) => ({ disabled: e.disabled, aria: e.getAttribute("aria-disabled") }))
          .catch(() => null);
        note(`Save after adding a Process part "M2probe": ${JSON.stringify(st)}`);
      }
      if (!st || st.disabled || st.aria === "true") return { skip: "no unsaved change could be made by script" };
      await kbActivate(page, save);
      await page.waitForTimeout(1500);
      await S.settle(page);
      await rec("after Save (Enter)");
      note(
        `editor still open after Save: ${await page
          .locator(".authoring-workspace")
          .first()
          .isVisible()
          .catch(() => false)}`,
      );
      await page
        .getByRole("button", { name: "Cancel", exact: true })
        .first()
        .click({ timeout: 2000 })
        .catch(() => {});
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Discard" })
        .click({ timeout: 2000 })
        .catch(() => {});
    },
  );
  await cp(
    "F37",
    { cell: "Edit, nothing changed", action: "Activate Cancel (Enter)", expected: 'button "Edit" on the reading page' },
    async (page, rec) => {
      if (!(await enterEdit(page))) return { skip: "no Edit button" };
      await kbActivate(page, page.getByRole("button", { name: "Cancel", exact: true }).first());
      await S.settle(page, 500);
      await rec("after Cancel");
    },
  );
  await cp(
    "F38",
    {
      cell: "Edit, with changes",
      action:
        "Make a change (add Process part), activate Cancel; F39: Keep editing; Cancel again, Escape; F40: Cancel again, Discard",
      expected:
        'F38: button "Keep editing" in alertdialog "Discard your changes?"; F39: button "Cancel"; F40: button "Edit" on the reading page',
    },
    async (page, rec, note) => {
      if (!(await enterEdit(page))) return { skip: "no Edit button" };
      const part = page.locator(".authoring-parts").getByRole("button", { name: "Process", exact: true });
      if (!(await part.count())) return { skip: "no Process part to make a change" };
      await part.click();
      await page.keyboard.type("M2probe");
      await page.keyboard.press("Enter");
      await S.settle(page, 400);
      const cancel = page.getByRole("button", { name: "Cancel", exact: true }).first();
      await kbActivate(page, cancel);
      await rec("F38 after Cancel");
      const keep = page.getByRole("alertdialog").getByRole("button", { name: "Keep editing" }).first();
      if (await exists(keep)) {
        await kbActivate(page, keep);
        await rec("F39 after Keep editing");
      } else note("no Keep editing button");
      await kbActivate(page, cancel);
      await page.keyboard.press("Escape");
      await S.settle(page, 400);
      await rec("F39 after Cancel then Escape");
      await kbActivate(page, cancel);
      const disc = page.getByRole("alertdialog").getByRole("button", { name: "Discard" }).first();
      if (await exists(disc)) {
        await kbActivate(page, disc);
        await S.settle(page, 600);
        await rec("F40 after Discard");
      } else note("no Discard button");
    },
  );
  ran && (results.at(-1).id = "F38–F40");
  await cp(
    "F41",
    {
      cell: "P5 (journeys project)",
      action: "Open New → Diagram (keyboard)",
      expected:
        'a named control inside region "Diagram Editor" (the flowchart starter\'s drawing / the first editing tool)',
    },
    async (page, rec) => {
      await go(page, "/projects/journeys/");
      const n = btn(page, "New");
      if (!(await exists(n))) return { skip: "no New" };
      await kbActivate(page, n);
      const d = page.getByRole("menu", { name: "New" }).getByRole("menuitem", { name: "Diagram", exact: true });
      await d.focus().catch(() => {});
      await page.keyboard.press("Enter");
      await page
        .locator(".authoring-workspace")
        .first()
        .waitFor({ timeout: 15000 })
        .catch(() => {});
      await S.settle(page, 600);
      await rec("after New → Diagram");
      await page
        .getByRole("button", { name: "Cancel", exact: true })
        .first()
        .click()
        .catch(() => {});
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Discard" })
        .click({ timeout: 2000 })
        .catch(() => {});
    },
  );
  await cp(
    "F42",
    {
      cell: "Nested view (containers.mmd)",
      action: 'Activate button "Nested view" (Enter); F43: Open <label>; F44: Close <label>',
      expected:
        'F42: stays, aria-pressed flips; F43: the same button, now "Close <label>" aria-expanded=true; F44: the same button, now "Open <label>"',
    },
    async (page, rec, note) => {
      await go(page, `${PT}/diagrams/containers.mmd`, READY);
      const nv = btn(page, "Nested view");
      if (!(await exists(nv))) return { skip: "no Nested view" };
      await kbActivate(page, nv);
      await page.waitForTimeout(800);
      await rec("F42 after Nested view");
      const op = page
        .getByRole("button", { name: /^Open / })
        .filter({ visible: true })
        .first();
      if (!(await exists(op))) {
        note("no Open <label> button");
        return;
      }
      note(`container control: ${(await op.getAttribute("aria-label")) ?? (await op.textContent())}`);
      await kbActivate(page, op);
      await page.waitForTimeout(600);
      await rec("F43 after Open");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(600);
      await S.settle(page);
      await rec("F44 after Enter again (Close)");
    },
  );
  ran && (results.at(-1).id = "F42–F44");
  const FC = `${PT}/diagrams/system-context.mmd`;
  await cp(
    "F45",
    {
      cell: "Explore",
      action: 'Activate button "Hand mode", then button "Select mode"',
      expected: "stays each time; aria-pressed=true on the pressed one",
    },
    async (page, rec) => {
      await go(page, FC, READY);
      const h = btn(page, "Hand mode");
      if (!(await exists(h))) return { skip: "no Hand mode" };
      await kbActivate(page, h);
      await rec("after Hand mode");
      const s = btn(page, "Select mode");
      await kbActivate(page, s);
      await rec("after Select mode");
    },
  );
  await cp(
    "F46",
    {
      cell: "Explore",
      action: "Zoom in to the maximum, and zoom out to the minimum (Enter repeatedly on the focused button)",
      expected: "stays on the button at the limit (aria-disabled, still focusable)",
    },
    async (page, rec, note) => {
      await go(page, FC, READY);
      for (const nm of ["Zoom in", "Zoom out"]) {
        const z = btn(page, nm);
        if (!(await exists(z))) {
          note(`no ${nm}`);
          continue;
        }
        await z.focus();
        let i = 0;
        for (; i < 60; i++) {
          const st = await z.evaluate((e) => e.disabled || e.getAttribute("aria-disabled") === "true");
          if (st) break;
          await page.keyboard.press("Enter");
          await page.waitForTimeout(80);
        }
        note(`${nm}: limit reached after ${i} presses`);
        await S.settle(page, 200);
        await rec(`at the ${nm} limit`);
      }
    },
  );
  await cp(
    "F47",
    { cell: "Explore", action: 'Activate button "Fit view"; then press 1', expected: "stays" },
    async (page, rec) => {
      await go(page, FC, READY);
      const f = btn(page, "Fit view");
      if (!(await exists(f))) return { skip: "no Fit view" };
      await kbActivate(page, f);
      await rec("after Fit view");
      await page.keyboard.press("1");
      await S.settle(page, 300);
      await rec("after 1");
    },
  );
  await cp(
    "F48",
    {
      cell: "Explore",
      action: 'Activate button "Source"; then Close source',
      expected: "stays, aria-pressed=true; the source panel shows",
      then: 'button "Close source" returns focus to button "Source"',
    },
    async (page, rec) => {
      await go(page, FC, READY);
      const s = btn(page, "Source");
      if (!(await exists(s))) return { skip: "no Source" };
      await kbActivate(page, s);
      await rec("after Source");
      const c = btn(page, "Close source");
      if (await exists(c)) {
        await kbActivate(page, c);
        await rec("after Close source");
      }
    },
  );
  async function graphTools(page) {
    await go(page, FC, READY);
    const g = btn(page, "Export, compare and more");
    await kbActivate(page, g);
    return g;
  }
  await cp(
    "F49",
    {
      cell: "Explore",
      action: 'Activate button "Export, compare and more"; then Escape',
      expected: "stays, aria-expanded=true (disclosure) / first item (if it is a menu)",
      then: 'Escape returns to button "Graph tools"',
    },
    async (page, rec) => {
      await graphTools(page);
      await rec("after the tools launcher");
      await page.keyboard.press("Escape");
      await S.settle(page, 300);
      await rec("after Escape");
    },
  );
  for (const [id, item, cell] of [
    ["F50", /Export/, "Explore"],
    ["F51", /Compare/, "P11"],
  ]) {
    await cp(
      id,
      {
        cell,
        action: `Export, compare and more → ${item.source} (keyboard); then Escape; then Close if still open`,
        expected: id === "F50" ? "the export region's first control" : "the compare panel's first control",
        then: 'Close or Escape: the launcher, or button "Graph tools" when the launcher\'s menu has closed',
      },
      async (page, rec, note) => {
        await graphTools(page);
        const it = page
          .getByRole("menuitem", { name: item })
          .or(page.getByRole("button", { name: item }))
          .filter({ visible: true })
          .first();
        if (!(await exists(it))) return { skip: `no ${item.source} item` };
        note(`item: ${(await it.textContent())?.trim()}`);
        await kbActivate(page, it);
        await page.waitForTimeout(600);
        await rec("after item");
        await page.keyboard.press("Escape");
        await S.settle(page, 400);
        await rec("after Escape");
      },
    );
  }
  await cp(
    "F53",
    {
      cell: "Explore (journeys flow.mmd)",
      action: "Select a node (Enter), then press C; then Escape",
      expected: 'textbox in form "New comment"',
      then: "Escape: the node",
    },
    async (page, rec) => {
      if (!(await focusNode(page, JF))) return { skip: "could not focus the drawing" };
      await page.keyboard.press("Enter");
      await S.settle(page, 300);
      await rec("selected node");
      await page.keyboard.press("c");
      await S.settle(page, 500);
      await rec("after C");
      await page.keyboard.press("Escape");
      await S.settle(page, 400);
      await rec("after Escape");
    },
  );
  await cp(
    "F54",
    {
      cell: "P4 composer (journeys flow.mmd) — writes one comment, deleted again in F75",
      action: "Select a node, C, type, send with Ctrl+Enter",
      expected: "the new thread (its card or bubble)",
    },
    async (page, rec, note) => {
      if (!(await focusNode(page, JF))) return { skip: "could not focus the drawing" };
      await page.keyboard.press("Enter");
      await S.settle(page, 300);
      await page.keyboard.press("c");
      await S.settle(page, 500);
      const tb = await page.evaluate(
        () =>
          document.activeElement?.tagName === "TEXTAREA" ||
          document.activeElement?.getAttribute("role") === "textbox" ||
          document.activeElement?.isContentEditable,
      );
      if (!tb) return { skip: "C did not put focus in a text box (see F53)" };
      await page.keyboard.type("M2 checkpoint probe comment (r1 re-score 3), delete me");
      await page.keyboard.press("Control+Enter");
      await page.waitForTimeout(1500);
      await S.settle(page);
      await rec("after Ctrl+Enter");
      note(`url after send: ${S.redact(page.url())}`);
      const m = page.url().match(/[?&]thread=([^&#]+)/);
      if (m) shared.thread = m[1];
      if (!shared.thread)
        shared.thread = await page.evaluate(
          () =>
            document.activeElement?.id?.match(/^archer-thread-(.+)$/)?.[1] ??
            document.querySelector("[data-thread-id]")?.getAttribute("data-thread-id") ??
            null,
        );
      note(`thread id found: ${shared.thread ? "yes" : "no"}`);
    },
  );
  await cp(
    "F52",
    {
      cell: "Explore, comments (journeys flow.mmd, the F54 comment)",
      action: "Activate a numbered comment pin; then Escape",
      expected: "the opened thread (its card or first control)",
      then: "Escape: the pin",
    },
    async (page, rec, note) => {
      await go(page, JF, READY);
      return commentPin(page, rec);
    },
  );
  await cp(
    "F17",
    {
      cell: "P7 (journeys flow.mmd, F54 thread)",
      action: "Load a page with the review open by its address (?thread=)",
      expected: "body / the opened thread, once that target's thread has loaded",
    },
    async (page, rec) => {
      if (!shared.thread) return { skip: "no thread id available (F54 did not yield one)" };
      await go(page, `${JF}?thread=${shared.thread}`, READY);
      await page.waitForTimeout(1500);
      await S.settle(page);
      await rec("after load + 1.5 s");
    },
  );
  await cp(
    "F55",
    {
      cell: "Explore, nothing selected",
      action: "Press C; then Escape",
      expected: "the chat's message textbox, in a dialog named for the document",
      then: "Escape: the launcher",
    },
    async (page, rec) => {
      await go(page, FC, READY);
      await blurAll(page);
      await page.keyboard.press("c");
      await S.settle(page, 600);
      await rec("after C");
      await page.keyboard.press("Escape");
      await S.settle(page, 400);
      await rec("after Escape");
    },
  );
  await cp(
    "F56",
    {
      cell: "P4 panel",
      action: 'Activate button "Collapse diagram panel"; then the expand button',
      expected: 'button "Expand diagram panel"',
      then: 'expanding moves focus to button "Collapse diagram panel"',
    },
    async (page, rec) => {
      await go(page, FC, READY);
      const c = btn(page, "Collapse diagram panel");
      if (!(await exists(c))) return { skip: "no Collapse diagram panel" };
      await kbActivate(page, c);
      await rec("after Collapse");
      const e = btn(page, "Expand diagram panel");
      if (await exists(e)) {
        await kbActivate(page, e);
        await rec("after Expand");
      }
    },
  );
  await cp(
    "F57",
    {
      cell: "P4 key (system-context, Explore)",
      action: "Pop the key out of the panel, then dock it again",
      expected: "the floating key's dock button; after docking, the pop-out button",
    },
    async (page, rec, note) => {
      await go(page, FC, READY);
      note("system-context (Explore key); the emphasis diagram's panel shows no key pop-out");
      const pop = page
        .getByRole("button", { name: /pop.?out|float|undock|detach/i })
        .filter({ visible: true })
        .first();
      if (!(await exists(pop))) {
        note(
          `buttons: ${(
            await page
              .getByRole("button")
              .filter({ visible: true })
              .evaluateAll((e) =>
                e
                  .map((x) => x.getAttribute("aria-label") || x.textContent.trim())
                  .filter(Boolean)
                  .slice(0, 40),
              )
          ).join(" | ")}`,
        );
        return { skip: "no pop-out control found for the key" };
      }
      note(`pop-out: ${(await pop.getAttribute("aria-label")) ?? (await pop.textContent())}`);
      await kbActivate(page, pop);
      await rec("after pop out");
      await page.keyboard.press("Enter");
      await S.settle(page, 400);
      await rec("after Enter on the focused control (dock)");
    },
  );
  for (const vp of ["1500x900", "390x844"]) {
    await cp(
      "F58",
      {
        cell: `P1, ${vp}`,
        action:
          vp === "1500x900"
            ? 'Press ?; Escape; then activate button "Keyboard shortcuts"; Escape'
            : "Menu → Keyboard shortcuts; Escape",
        expected: 'inside dialog "Keyboard & Pointer" (the dialog or its first control)',
        then: 'Escape: the launcher; on a phone, when the opener sat in the closed drawer, button "Menu"',
      },
      async (page, rec) => {
        await go(page, "/projects/");
        if (vp === "1500x900") {
          await blurAll(page);
          await page.keyboard.press("?");
          await S.settle(page, 400);
          await rec("after ?");
          await page.keyboard.press("Escape");
          await S.settle(page, 300);
          await rec("after Escape");
          const k = btn(page, "Keyboard shortcuts");
          if (await exists(k)) {
            await kbActivate(page, k);
            await rec("after Keyboard shortcuts button");
            await page.keyboard.press("Escape");
            await S.settle(page, 300);
            await rec("after Escape");
          }
        } else {
          const m = btn(page, "Menu");
          if (!(await exists(m))) return { skip: "no Menu" };
          await kbActivate(page, m);
          const k = page
            .getByRole("button", { name: /^(Keyboard shortcuts|Help)$/ })
            .filter({ visible: true })
            .first();
          if (!(await exists(k))) return { skip: "no Keyboard shortcuts in the drawer" };
          await kbActivate(page, k);
          await rec("after Keyboard shortcuts (via Menu)");
          await page.keyboard.press("Escape");
          await S.settle(page, 400);
          await rec("after Escape");
        }
      },
      { vp },
    );
    ran && (results.at(-1).id = `F58 (${vp})`);
  }
  await cp(
    "F59",
    {
      cell: "P1",
      action: 'Activate the theme toggle (button ~"Switch to")',
      expected: "stays; the name now offers the other theme",
    },
    async (page, rec) => {
      await go(page, "/projects/");
      const t = page.getByRole("button", { name: /Switch to/ }).first();
      if (!(await exists(t))) return { skip: "no theme toggle" };
      await t.focus();
      await rec("before");
      await page.keyboard.press("Enter");
      await S.settle(page, 300);
      await rec("after activate");
    },
  );
  await cp(
    "F60",
    {
      cell: "390×844, P1",
      action: 'Activate button "Menu"; then Escape',
      expected: "the first control in navigation",
      then: 'Escape: button "Menu"',
    },
    async (page, rec) => {
      await go(page, "/projects/");
      const m = btn(page, "Menu");
      if (!(await exists(m))) return { skip: "no Menu" };
      await kbActivate(page, m);
      await rec("after Menu");
      await page.keyboard.press("Escape");
      await S.settle(page, 400);
      await rec("after Escape");
    },
    { vp: "390x844" },
  );
  for (const [where, path] of [
    ["P1", "/projects/"],
    ["P2", `${PT}/`],
  ]) {
    await cp(
      "F61",
      {
        cell: where,
        action: 'Activate button "New"; then Escape',
        expected: 'first menuitem ("Diagram") in menu "New"',
        then: 'Escape: button "New"',
      },
      async (page, rec) => {
        await go(page, path);
        const n = btn(page, "New");
        if (!(await exists(n))) return { skip: "no New" };
        await kbActivate(page, n);
        await rec("after New");
        await page.keyboard.press("Escape");
        await S.settle(page, 300);
        await rec("after Escape");
      },
    );
    ran && (results.at(-1).id = `F61 (${where})`);
  }

  // ---------- P7 ----------
  for (const [where, path] of [
    ["P1", "/projects/"],
    ["P6", `${PT}/-/repo/archer.toml`],
  ]) {
    await cp(
      "F70",
      {
        cell: `P7 on ${where}`,
        action: 'Activate button ~"Notifications"; then Escape',
        expected: 'inside dialog "Notifications" (non-modal): the dialog or its first control',
        then: 'Escape: button ~"Notifications"',
      },
      async (page, rec) => {
        await go(page, path);
        const n = page.getByRole("button", { name: /Notifications/ }).first();
        if (!(await exists(n))) return { skip: "no Notifications" };
        await kbActivate(page, n);
        await rec("after Notifications");
        await page.keyboard.press("Escape");
        await S.settle(page, 300);
        await rec("after Escape");
      },
    );
    ran && (results.at(-1).id = `F70 (${where})`);
  }
  async function openReview(page, path = JF) {
    await go(page, path, READY);
    if (await exists(btn(page, "Close project review"))) return "already open";
    const n = page.getByRole("button", { name: /Notifications/ }).first();
    await kbActivate(page, n);
    await page.waitForTimeout(500);
    return "opened";
  }
  await cp(
    "F71",
    {
      cell: "P7 on a project page (journeys flow.mmd)",
      action:
        'Activate button ~"Notifications" (opens the project review); F72: Close project review; then reopen and Escape',
      expected: 'F71: the selected tab in tablist "Show", inside region "Project review"; F72: button ~"Notifications"',
    },
    async (page, rec, note) => {
      note(await openReview(page));
      await rec("F71 after Notifications");
      const c = btn(page, "Close project review");
      if (await exists(c)) {
        await kbActivate(page, c);
        await rec("F72 after Close project review");
      }
      const n = page.getByRole("button", { name: /Notifications/ }).first();
      await kbActivate(page, n);
      await page.waitForTimeout(400);
      await page.keyboard.press("Escape");
      await S.settle(page, 400);
      await rec("F72 after reopen + Escape");
    },
  );
  ran && (results.at(-1).id = "F71–F72");
  await cp(
    "F73",
    {
      cell: "P7 thread open (journeys, the F54 thread)",
      action: "Expand a thread entry, then collapse it (Enter twice)",
      expected: "stays on the entry's control (aria-expanded flips both ways)",
    },
    async (page, rec) => {
      await openReview(page);
      const r = page.getByRole("region", { name: "Project Review" });
      const e = r.locator("[aria-expanded]").filter({ visible: true }).first();
      if (!(await exists(e))) return { skip: "no expandable thread entry in the review" };
      await kbActivate(page, e);
      await rec("after expand");
      await page.keyboard.press("Enter");
      await S.settle(page, 400);
      await rec("after collapse");
    },
  );
  await cp(
    "F77",
    { cell: "P7", action: 'Press ArrowRight, then ArrowLeft in tablist "Show"', expected: "the newly selected tab" },
    async (page, rec) => {
      await openReview(page);
      const t = page.getByRole("tablist", { name: "Show" }).getByRole("tab", { selected: true }).first();
      if (!(await exists(t))) return { skip: "no tablist Show" };
      await t.focus();
      await page.keyboard.press("ArrowRight");
      await S.settle(page, 300);
      await rec("after ArrowRight");
      await page.keyboard.press("ArrowLeft");
      await S.settle(page, 300);
      await rec("after ArrowLeft");
    },
  );
  await cp(
    "F74",
    {
      cell: "P7 destructive confirm (journeys, the F54 comment)",
      action: "Activate Delete on a comment; then Keep; F75: Delete again and confirm",
      expected:
        'F74: button "Keep" in group "Delete this comment?", Keep: back to Delete; F75: the entry that takes its place / the selected tab when the list is empty',
    },
    async (page, rec, note) => {
      await openReview(page);
      const r = page.getByRole("region", { name: "Project Review" });
      const ex = r.locator("[aria-expanded=false]").filter({ visible: true }).first();
      if (await exists(ex)) await kbActivate(page, ex);
      let del = page
        .getByRole("button", { name: /^Delete/ })
        .filter({ visible: true })
        .first();
      if (!(await exists(del))) {
        // open the thread from the drawing pin
        if (shared.thread) {
          await go(page, `${JF}?thread=${shared.thread}`, READY);
          await page.waitForTimeout(1200);
          del = page
            .getByRole("button", { name: /^Delete/ })
            .filter({ visible: true })
            .first();
          note("opened via ?thread=");
        }
      }
      if (!(await exists(del))) return { skip: "no Delete control on a comment" };
      note(`delete control: ${(await del.getAttribute("aria-label")) ?? (await del.textContent())}`);
      await kbActivate(page, del);
      await rec("F74 after Delete");
      const keep = page.getByRole("button", { name: "Keep", exact: true }).first();
      if (await exists(keep)) {
        await kbActivate(page, keep);
        await rec("F74 after Keep");
      }
      await kbActivate(page, del);
      const conf = page
        .getByRole("group", { name: /Delete this comment/ })
        .getByRole("button", { name: /^Delete/ })
        .or(page.getByRole("alertdialog").getByRole("button", { name: /^Delete/ }))
        .first();
      if (await exists(conf)) {
        await kbActivate(page, conf);
        await page.waitForTimeout(800);
        await S.settle(page);
        await rec("F75 after confirming Delete");
        shared.deleted = true;
      } else note("no confirming Delete button");
    },
  );
  ran && (results.at(-1).id = "F74–F75");
  await cp(
    "F76",
    {
      cell: "P7 unread",
      action: "Mark read on a Notifications item",
      expected: "the next item's Mark read / the dialog when none is left",
    },
    async (page, rec) => {
      await go(page, "/projects/");
      return markNotificationRead(page, rec);
    },
  );

  // ---------- P8 ----------
  await cp(
    "F80",
    {
      cell: "Archer settings (P1)",
      action: 'Activate button "Archer settings"; then Tab ×12',
      expected: 'inside dialog "Archer Settings": the dialog / its h2 / button "Close settings"',
      then: 'Tab order: Close settings, then checkbox "Single-character shortcuts", then the rest in visual order; Tab wraps',
    },
    async (page, rec, note) => {
      await go(page, "/projects/");
      const a = btn(page, "Archer settings");
      if (!(await exists(a))) return { skip: "no Archer settings" };
      await kbActivate(page, a);
      await rec("after open");
      const seq = [];
      for (let i = 0; i < 14; i++) {
        await page.keyboard.press("Tab");
        seq.push(
          await page.evaluate(() => {
            const x = document.activeElement;
            return (
              (x.closest("[role=dialog],dialog") ? "" : "OUT:") +
              (x.getAttribute("aria-label") || x.labels?.[0]?.textContent || x.innerText || x.tagName)
                .trim()
                .slice(0, 30)
            );
          }),
        );
      }
      note(`Tab sequence: ${seq.join(" → ")}`);
    },
  );
  await cp(
    "F81",
    { cell: "Archer settings", action: "Escape; then reopen and Close settings", expected: 'button "Archer settings"' },
    async (page, rec) => {
      await go(page, "/projects/");
      const a = btn(page, "Archer settings");
      if (!(await exists(a))) return { skip: "no Archer settings" };
      await kbActivate(page, a);
      await page.keyboard.press("Escape");
      await S.settle(page, 300);
      await rec("after Escape");
      await kbActivate(page, a);
      const c = btn(page, "Close settings");
      if (await exists(c)) {
        await kbActivate(page, c);
        await rec("after Close settings");
      }
    },
  );
  async function projSettings(page, path = `${PT}/`) {
    await go(page, path);
    const g = btn(page, "Project settings");
    if (!(await exists(g))) return null;
    await kbActivate(page, g);
    await page.waitForTimeout(400);
    return g;
  }
  await cp(
    "F82",
    {
      cell: "Project settings (pageturner)",
      action: 'Activate button "Project settings"; then Tab ×40',
      expected: 'inside dialog "Project Settings": the dialog / its h2 / its first control',
      then: "Tab wraps",
    },
    async (page, rec, note) => {
      if (!(await projSettings(page))) return { skip: "no Project settings" };
      await rec("after open");
      const seq = [];
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press("Tab");
        seq.push(await page.evaluate(() => (document.activeElement.closest("[role=dialog],dialog") ? "in" : "OUT")));
      }
      note(`40 Tabs: outside dialog ${seq.filter((s) => s === "OUT").length}`);
    },
  );
  for (const sec of ["General", "Diagrams", "Notes", "Discovery", "Feedback", "Visibility", "archer.toml"]) {
    await cp(
      "F83–F89",
      {
        cell: `Project settings, ${sec}`,
        action: `Activate the ${sec} button in navigation "Settings sections"; then Tab`,
        expected: `heading level 3 named "${sec}" (tabindex=-1); its nav button has aria-current`,
        then: "the next Tab lands on that section's first control",
      },
      async (page, rec, note) => {
        if (!(await projSettings(page))) return { skip: "no Project settings" };
        const nav = page.getByRole("navigation", { name: "Settings sections" });
        const rx = new RegExp(`^${sec.replace(".", "\\.")}( \\d+)?$`);
        const b = nav
          .getByRole("button", { name: rx })
          .or(nav.getByRole("link", { name: rx }))
          .first();
        if (!(await exists(b))) return { skip: `no ${sec} in Settings sections` };
        await kbActivate(page, b);
        await rec("after activate");
        note(
          `nav aria-current on: ${(
            await nav
              .locator("[aria-current]")
              .allInnerTexts()
              .catch(() => [])
          ).join("|")}`,
        );
        await page.keyboard.press("Tab");
        await S.settle(page, 200);
        await rec("after next Tab");
      },
    );
    ran && (results.at(-1).id = `F8x (${sec})`);
  }
  await cp(
    "F90",
    {
      cell: "Project settings, unsaved changes (journeys)",
      action: "Change an unchecked editable visibility radio, Escape, Keep editing; Close settings and discard",
      expected: 'button "Keep editing" in the confirmation',
      then: "Keep editing: back to Close settings",
    },
    async (page, rec, note) => {
      if (!(await projSettings(page, "/projects/journeys/"))) return { skip: "no Project settings" };
      const result = await dirtySettings(page, rec);
      const close = btn(page, "Close settings");
      if (await exists(close)) await close.click();
      const discard = page.getByRole("button", { name: /^(Discard|Discard changes|Leave without saving)$/ }).first();
      if (await exists(discard)) {
        await discard.click();
        note("discarded the change; no settings saved");
      }
      return result;
    },
  );
  await cp(
    "F91",
    {
      cell: "Project settings (pageturner)",
      action: "Close with nothing changed (Close settings; then reopen and Escape)",
      expected: 'button "Project settings" (the gear)',
    },
    async (page, rec) => {
      if (!(await projSettings(page))) return { skip: "no Project settings" };
      const c = btn(page, "Close settings");
      if (await exists(c)) {
        await kbActivate(page, c);
        await rec("after Close settings");
      }
      await kbActivate(page, btn(page, "Project settings"));
      await page.waitForTimeout(400);
      await page.keyboard.press("Escape");
      await S.settle(page, 400);
      await rec("after reopen + Escape");
    },
  );

  await browser.close();
  const json = {
    tool: "m2-checkpoints",
    list: "docs/quality/rubrics/ui-ux-v1.1-lists.md §1",
    target: { origin: O, slug: target.slug, emphasisDiagram: target.emphasisDiagram ?? null },
    generatedAt: new Date().toISOString(),
    note: "observed vs expected only; no pass/fail",
    shared: { commentCreated: !!shared.thread || undefined, commentDeleted: !!shared.deleted },
    results,
  };
  writeFileSync(join(out, "m2-checkpoints.json"), S.redact(JSON.stringify(json, null, 2)) + "\n");
  const rows = results.map((r) => [
    r.id,
    r.outcome,
    r.cell,
    r.action,
    r.expected + (r.then ? ` — then: ${r.then}` : ""),
    r.status === "observed"
      ? r.observed.map((o) => `[${o.at}] ${fmt(o)}`).join("<br>")
      : `${r.status.toUpperCase()}: ${r.reason}`,
    r.notes.join("; "),
  ]);
  writeFileSync(
    join(out, "m2-checkpoints.md"),
    S.redact(
      `# M2 focus checkpoints — observed vs expected\n\nOutcomes distinguish coverage absent, action not executed, destination wrong and destination correct for calibrated probes. Other rows remain observed and need review. Role/name are the browser's computed accessibility role and name (CDP Accessibility.getPartialAXTree) of document.activeElement; "in" lists the nearest named landmarks/dialogs/groups.\n\n` +
        S.mdTable(["ID", "Outcome", "Cell", "Action (scripted)", "Expected (list)", "Observed", "Notes"], rows),
    ),
  );
  console.log("done", results.length);
}

if (S.isMain(import.meta.url)) await main();
