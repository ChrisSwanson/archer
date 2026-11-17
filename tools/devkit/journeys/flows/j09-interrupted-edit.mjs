// J9 interrupted edit (user-flows.md §6): J6 unsaved → reload; close the tab and reopen it in the same profile;
// Discard. Mandatory outcome: the draft is offered back with words saying so; Discard leaves the file unchanged
// and the draft gone. Collectors: G1 at the reload and close/reopen boundaries (§6 promise list: draft source,
// target id and base revision captured before, read back from the restored editor after; the file untouched),
// G4 (the restored draft is said to be restored, not shown as saved), and G1's "storage denied or full" boundary
// (the page must say the draft cannot be kept).
//
// The edit happens in a second tab of the same browser context (ui.openContext()): closing the journey's first
// page ends a harness run, and a person's "close the tab" is a tab of a profile that stays open.
import { assertFlowChecks } from "../../harness/flows-state.mjs";
import { flowRecorder } from "../../harness/flow-metrics.mjs";
import { FLOW, FLOW_INVARIANTS, g1Editor, reopenTab, sessionOf } from "./state-lib.mjs";

const TO = "Interrupted label";
const RESTORED = /Restored your unsaved changes/;
const OFFERED = /unsaved changes from an earlier edit/;
const OPEN_ELSEWHERE = /open in another tab/;
export const meta = {
  name: "flows-j09-interrupted-edit",
  invariants: { ...FLOW_INVARIANTS, "dirty-navigation": false },
  flow: {
    id: "J9",
    baseline: [
      { action: "click Edit", class: "essential" },
      { action: "double-click node a", class: "essential" },
      { action: "type the new label", class: "essential" },
      { action: "press Enter", class: "essential" },
      { action: "reload (F5)", class: "essential" },
      { action: "close the tab (Ctrl+W)", class: "essential" },
      { action: "reopen the closed tab (Ctrl+Shift+T)", class: "essential" },
      { action: "click Discard them", class: "essential" },
      { action: "click Discard (confirm)", class: "safety" },
    ],
  },
};

export default async ({ ui, step, expect, run }) => {
  const flow = flowRecorder({ step, run }, meta.flow);
  const B = Object.fromEntries(meta.flow.baseline.map((b) => [b.action, b]));
  const act = (action, fn) => flow.act(action, B[action].class, fn);
  await ui.resetProject(FLOW.slug);
  const before = ui.fileState(FLOW.slug, FLOW.file);
  const a = await ui.openContext();
  await a.ui.openDiagram(FLOW.slug, FLOW.path);
  await act("click Edit", () => a.ui.enterEdit());
  await flow.actions([B["double-click node a"], B["type the new label"], B["press Enter"]], () =>
    a.ui.rename(FLOW.node, TO),
  );
  const captured = await a.ui.captureEditor(FLOW.slug, a.ui);
  await step("captured draft: the edit, from the file's revision", () => {
    expect(captured.text).toContain(TO);
    expect(captured.baseRevision, "the draft keeps the revision it was opened from").toBe(before.revision);
  });

  // Boundary 1: reload.
  const reloaded = await act("reload (F5)", () => a.ui.reload());
  ui.flowCheck("G4", "reload: the restored draft says so", RESTORED.test(reloaded?.status ?? ""), {
    status: reloaded?.status ?? null,
  });
  await g1Editor(a.ui, "reload", captured, { diskBefore: before.revision });

  // Boundary 2: close the tab, reopen it (Ctrl+Shift+T restores its address) in the same profile.
  const session = await sessionOf(a.page);
  const address = a.page.url();
  await act("close the tab (Ctrl+W)", () => a.page.close({ runBeforeUnload: false }));
  const b = await reopenTab(ui, session);
  await act("reopen the closed tab (Ctrl+Shift+T)", async () => {
    await b.page.goto(address);
    await expect(b.ui.locators.editor()).toBeVisible();
    await b.ui.canvasReady();
    await b.ui.settle();
  });
  const reopened = await b.ui.editorState();
  ui.flowCheck("G4", "close and reopen: the restored draft says so", RESTORED.test(reopened?.status ?? ""), {
    status: reopened?.status ?? null,
  });
  await g1Editor(b.ui, "close the tab and reopen it", captured, { diskBefore: before.revision });

  // The same profile opening the diagram's plain edit address while the draft's tab is open (claude-303, O117): it is
  // not offered there (two tabs would write one working copy); the page says it is open in another tab.
  const c = await ui.openContext();
  await step("open the plain edit address in another tab", async () => {
    await c.page.goto(
      address.replace(/[?&]draftId=[^&]+/, "").replace(/\?$/, "") + (address.includes("?") ? "" : "?edit"),
    );
    await expect(c.ui.locators.editor()).toBeVisible();
    await c.ui.settle();
  });
  const offered = await c.ui.editorState();
  ui.flowCheck(
    "G1",
    "plain edit address, the draft's tab open: not offered, said to be open in another tab",
    !OFFERED.test(offered?.status ?? "") && OPEN_ELSEWHERE.test(offered?.status ?? ""),
    { status: offered?.status ?? null },
  );
  await step("close the extra tab", () => c.page.close({ runBeforeUnload: false }));

  // A duplicated editor tab (window.open copies the session and the address with its draft; claude-303).
  const d0 = await ui.duplicateTab(b.page);
  await step("duplicated editor tab: open", async () => {
    await expect(d0.ui.locators.editor()).toBeVisible({ timeout: 15_000 });
    await d0.ui.canvasReady();
    await d0.ui.settle();
  });
  const dupState = await d0.ui.editorState();
  const dupSource = (await d0.ui.editorSource().catch(() => "")) ?? "";
  ui.flowCheck(
    "G1",
    "duplicated editor tab: not given the first tab's unsaved change, and told it is open in another tab",
    !dupSource.includes(TO) && OPEN_ELSEWHERE.test(dupState?.status ?? "") && !RESTORED.test(dupState?.status ?? ""),
    { status: dupState?.status ?? null, hasFirstTabsChange: dupSource.includes(TO) },
  );
  await d0.ui.rename("b", "Duplicate label");
  const dupSession = await sessionOf(d0.page),
    dupAddress = d0.page.url();
  const firstKept = captured.target.draftId ? await b.ui.storedDraft(captured.target.draftId) : null;
  ui.flowCheck(
    "G1",
    "duplicated editor tab: its change does not write over the first tab's working copy",
    (firstKept?.source ?? "").includes(TO) && !(firstKept?.source ?? "").includes("Duplicate label"),
    { firstTabKeeps: (firstKept?.source ?? "").slice(0, 200) },
  );
  await step("duplicated editor tab: close it", () => d0.page.close({ runBeforeUnload: false }));
  const d1 = await reopenTab(ui, dupSession);
  await step("duplicated editor tab: reopen it", async () => {
    await d1.page.goto(dupAddress);
    await expect(d1.ui.locators.editor()).toBeVisible({ timeout: 15_000 });
    await d1.ui.canvasReady();
    await d1.ui.settle();
  });
  const dupBack = (await d1.ui.editorSource().catch(() => "")) ?? "";
  const dupDraft = new URL(dupAddress).searchParams.get("draftId");
  const dupKept = dupDraft ? await d1.ui.storedDraft(dupDraft) : null;
  ui.flowCheck(
    "G1",
    "duplicated editor tab, closed and reopened: its own change is back, and the first tab's is not in it",
    dupBack.includes("Duplicate label") && !dupBack.includes(TO),
    {
      source: dupBack.slice(0, 200),
      address: dupAddress.replace(/^https?:\/\/[^/]+/, ""),
      kept: (dupKept?.source ?? null)?.slice(0, 200) ?? null,
      status: (await d1.ui.editorState())?.status ?? null,
    },
  );
  await step("close the reopened duplicate", () => d1.page.close({ runBeforeUnload: false }));

  // Discard: the file unchanged, the draft gone.
  await flow.actions([B["click Discard them"], B["click Discard (confirm)"]], () => b.ui.discardRestored());
  await step("after Discard: the file is unchanged and the draft is gone", async () => {
    const disk = ui.fileState(FLOW.slug, FLOW.file);
    const stored = captured.target.draftId ? await b.ui.storedDraft(captured.target.draftId) : null;
    // Another tab's own clean draft (the plain edit address above opened one) is not the person's work.
    const holding = (await b.ui.storedDrafts()).filter((x) => (x.source ?? "").includes(TO));
    const problems = [];
    if (disk.revision !== before.revision) problems.push("the file changed");
    if (stored !== null) problems.push("the discarded draft is still stored in the browser");
    if (holding.length !== 0) problems.push(`${holding.length} stored draft(s) still hold the discarded edit`);
    ui.flowCheck("G1", "discard: explicit, file unchanged, draft gone", problems.length === 0, {
      problems,
      holding: holding.map((x) => x.draftId),
    });
    expect(problems).toEqual([]);
  });
  const d = await ui.openContext();
  await step("reopening the edit address offers nothing back", async () => {
    await d.page.goto(address.replace(/[?&]draftId=[^&]+/, ""));
    await expect(d.ui.locators.editor()).toBeVisible();
    await d.ui.settle();
    const s = await d.ui.editorState();
    ui.flowCheck(
      "G1",
      "discard: nothing offered back afterwards",
      !OFFERED.test(s?.status ?? "") && !RESTORED.test(s?.status ?? ""),
      { status: s?.status ?? null },
    );
    await d.page.close({ runBeforeUnload: false });
  });
  // §6 promise boundary "storage denied or full (the page must say so)": a tab whose localStorage refuses writes.
  await resumeProbes({ ui, step, expect });
  await copiesProbe({ ui, step, expect });
  await copiesRowsProbe({ ui, step, expect });
  await fileMatchProbe({ ui, step, expect });
  await fileMatchNewestProbe({ ui, step, expect });

  const e = await ui.openContext();
  await e.page.addInitScript(() => {
    const deny = () => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    };
    try {
      Object.defineProperty(Storage.prototype, "setItem", { value: deny, configurable: true });
    } catch {
      /* already denied */
    }
  });
  await e.ui.openDiagram(FLOW.slug, FLOW.path);
  await e.ui.enterEdit();
  await e.ui.rename(FLOW.node, "Unkept label");
  await step("storage denied: the page says the draft cannot be kept", async () => {
    const s = await e.ui.editorState();
    const said =
      s?.storageFailed === true ||
      /recovery (is )?unavailable|cannot be kept|not be kept|copy your mermaid/i.test(
        `${s?.status ?? ""} ${s?.feedback?.text ?? ""} ${(await e.ui.alerts()).join(" ")}`,
      );
    ui.flowCheck("G1", "storage denied: the page says so before the person relies on it", said, {
      status: s?.status ?? null,
      feedback: s?.feedback?.text ?? null,
      storageFailed: s?.storageFailed ?? null,
    });
    await e.page.close({ runBeforeUnload: false });
  });
  await assertFlowChecks({ step, run, flow });
};

/**
 * Resume them, pressed (PC-401; codex-401, claude-401/402, codex-403; O127, O129), as probes outside the pinned trace.
 * A tab edits and closes. Two new tabs of the profile open the plain edit address: both are offered the closed tab's
 * work. B resumes it and edits; C's offer is withdrawn, or refused if pressed: C never takes B's live copy, and B's
 * reload has B's work. Then B closes, and a new tab opens B's full draft address: Resume shows B's work at once, under
 * the address's draft. Seeded faults: `stale-recovery-read` (each recovery record read as first read, as takeRecovery
 * did before codex-401) fails the two-tab check; `inert-resume` (Resume them does nothing, as from a full draft address
 * before codex-403) fails the full-address check.
 */
async function resumeProbes({ ui, step, expect }) {
  const RESUMED = "Closed tab work",
    B_WORK = "B unique work",
    C_WORK = "C replacement";
  const OFFER = /from another tab, now closed/;
  const ready = async (u) => {
    await expect(u.locators.editor()).toBeVisible({ timeout: 15_000 });
    await u.canvasReady();
    await u.settle();
  };
  const resumeButton = (p) =>
    p.locator(".authoring-statusline").getByRole("button", { name: "Resume them", exact: true });
  // Its own browser storage: the closed tabs of the earlier sections leave copies of the same diagram, and which of
  // several closed-tab copies is offered is not what this checks (the probe once resumed one of those).
  const x = await ui.openContext({ fresh: true });
  const within = x.context;
  await x.ui.openDiagram(FLOW.slug, FLOW.path);
  await x.ui.enterEdit();
  await x.ui.rename(FLOW.node, RESUMED);
  const fullX = x.page.url();
  await step("resume: close the tab with unsaved work", () => x.page.close({ runBeforeUnload: false }));
  const plain = fullX
    .replace(/[?&]draftId=[^&]+/, "")
    .replace(/[?&]checkpoint=[^&]+/, "")
    .replace(/\?$/, "");
  const b = await ui.openContext({ within }),
    c = await ui.openContext({ within });
  for (const [name, t] of [
    ["B", b],
    ["C", c],
  ])
    await step(`resume: tab ${name} opens the plain edit address`, async () => {
      await t.page.goto(plain);
      await ready(t.ui);
    });
  const offeredBoth =
    OFFER.test((await b.ui.editorState())?.status ?? "") && OFFER.test((await c.ui.editorState())?.status ?? "");
  await step("resume: tab B clicks Resume them", () => resumeButton(b.page).click());
  // Resume remounts the editor on the taken draft: wait for the offer to go (editorSource toggles the source panel, so
  // it is read once, not polled), then read the editor that is there now.
  const settled = async (p, u) => {
    await expect(resumeButton(p))
      .toHaveCount(0, { timeout: 8_000 })
      .catch(() => {});
    await ready(u);
  };
  await settled(b.page, b.ui);
  const bSource = (await b.ui.editorSource().catch(() => "")) ?? "";
  const bTook = bSource.includes(RESUMED);
  await b.ui.rename("b", B_WORK);
  await c.page.waitForTimeout(800);
  const cStillOffers = (await resumeButton(c.page).count()) > 0;
  if (cStillOffers) {
    await step("resume: tab C clicks its stale Resume them", () => resumeButton(c.page).click());
    await c.page.waitForTimeout(800);
    await ready(c.ui);
  }
  const cSource = (await c.ui.editorSource().catch(() => "")) ?? "";
  const cTook = cSource.includes(RESUMED);
  if (cTook) await c.ui.rename("b", C_WORK);
  await step("resume: reload tab B", async () => {
    await b.page.reload();
    await ready(b.ui);
  });
  const bAfter = (await b.ui.editorSource().catch(() => "")) ?? "";
  ui.flowCheck(
    "G1",
    "resume, two tabs: the first keeps the closed tab's work and its own; the second never takes it",
    offeredBoth && bTook && !cTook && bAfter.includes(B_WORK),
    {
      offeredBoth,
      bTook,
      bSource: bSource.slice(0, 300),
      cStillOffers,
      cTook,
      bKeeps: bAfter.includes(B_WORK),
      cStatus: (await c.ui.editorState())?.status ?? null,
    },
  );
  const fullB = b.page.url();
  await step("resume: close tabs B and C", async () => {
    await c.page.close({ runBeforeUnload: false });
    await b.page.close({ runBeforeUnload: false });
  });
  const f = await ui.openContext({ within });
  await step("resume: a new tab opens B's full draft address", async () => {
    await f.page.goto(fullB);
    await ready(f.ui);
  });
  const fOffered = OFFER.test((await f.ui.editorState())?.status ?? "");
  if (fOffered) await step("resume: click Resume them (full draft address)", () => resumeButton(f.page).click());
  await settled(f.page, f.ui);
  const fSource = (await f.ui.editorSource().catch(() => "")) ?? "";
  const fState = await f.ui.editorState();
  // The resumed work is unsaved: the status line never says Saved (as it did after the no-op Resume before codex-403).
  const saidSaved = /\bSaved\b/.test(fState?.status ?? "") && !/Saved in this browser/.test(fState?.status ?? "");
  const named = new URL(f.page.url()).searchParams.get("draftId") === new URL(fullB).searchParams.get("draftId");
  ui.flowCheck(
    "G1",
    "resume, full draft address: Resume shows the closed tab's work at once, under the draft the address names, not Saved",
    fOffered && fSource.includes(B_WORK) && !OFFER.test(fState?.status ?? "") && named && !saidSaved,
    {
      fOffered,
      shows: fSource.includes(B_WORK),
      stillOffers: OFFER.test(fState?.status ?? ""),
      named,
      saidSaved,
      status: fState?.status ?? null,
    },
  );
  await step("resume: close the tab", () => f.page.close({ runBeforeUnload: false }));
}

/**
 * O137: three closed tabs each kept an unsaved copy of the diagram. The copies' stamps are arranged so the newest is
 * the one this browser lists LAST (storage order is the browser's; a page that offers the first listed then offers
 * the oldest). A new tab offers the newest, names the 2 others, lists all three, and Resume keeps the other two in the
 * browser. Seeded fault `offer-first-listed` (the stamps unread, as before O137) fails it.
 */
async function copiesProbe({ ui, step, expect }) {
  const LABELS = ["Copy one", "Copy two", "Copy three"];
  const ready = async (u) => {
    await expect(u.locators.editor()).toBeVisible({ timeout: 15_000 });
    await u.canvasReady();
    await u.settle();
  };
  const first = await ui.openContext({ fresh: true });
  const within = first.context;
  await first.ui.openDiagram(FLOW.slug, FLOW.path);
  await first.ui.enterEdit();
  const plain = first.page
    .url()
    .replace(/[?&]draftId=[^&]+/, "")
    .replace(/[?&]checkpoint=[^&]+/, "")
    .replace(/\?$/, "");
  await first.ui.rename(FLOW.node, LABELS[0]);
  await step("copies: close the first tab with unsaved work", () => first.page.close({ runBeforeUnload: false }));
  for (const label of LABELS.slice(1)) {
    const t = await ui.openContext({ within });
    await step(`copies: a tab edits its own copy (${label}) and closes`, async () => {
      await t.page.goto(plain);
      await ready(t.ui);
      await t.ui.rename(FLOW.node, label);
      await t.page.close({ runBeforeUnload: false });
    });
  }
  const n = await ui.openContext({ within });
  await step("copies: a new tab opens the project", () => n.page.goto(new URL(`/projects/${FLOW.slug}/`, plain).href));
  // Stamps arranged by this browser's listing order: the last listed is the newest.
  const listed = await n.page.evaluate((labels) => {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith("archer.authoring.v1:")) continue;
      const r = JSON.parse(localStorage.getItem(k) ?? "null");
      const label = labels.find((l) => (r?.source ?? "").includes(l));
      if (label) out.push({ k, label });
    }
    const base = Date.now() - 60_000;
    out.forEach(({ k }, i) => {
      const r = JSON.parse(localStorage.getItem(k));
      r.savedAt = base + i * 1000;
      localStorage.setItem(k, JSON.stringify(r));
    });
    return out.map((x) => x.label);
  }, LABELS);
  const newest = listed.at(-1),
    others = listed.slice(0, -1);
  await step("copies: a new tab opens the plain edit address", async () => {
    await n.page.goto(plain);
    await ready(n.ui);
  });
  const line = n.page.locator(".authoring-statusline");
  const named = (await line.getByRole("button", { name: "2 other unsaved copies", exact: true }).count()) === 1;
  if (named)
    await step("copies: open the list of copies", () =>
      line.getByRole("button", { name: "2 other unsaved copies", exact: true }).click(),
    );
  const rows = await n.page.locator(".authoring-copies li").count();
  await step("copies: click Resume them (the offered copy)", () =>
    line.getByRole("button", { name: "Resume them", exact: true }).click(),
  );
  await expect(line.getByRole("button", { name: "Resume them", exact: true }))
    .toHaveCount(0, { timeout: 8_000 })
    .catch(() => {});
  await ready(n.ui);
  const source = (await n.ui.editorSource().catch(() => "")) ?? "";
  const kept = await n.page.evaluate((labels) => {
    const found = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith("archer.authoring.v1:")) continue;
      const r = JSON.parse(localStorage.getItem(k) ?? "null");
      for (const l of labels) if ((r?.source ?? "").includes(l)) found.push(l);
    }
    return found;
  }, others);
  const offeredNewest = source.includes(newest) && others.every((l) => !source.includes(l));
  ui.flowCheck(
    "G1",
    "three closed copies: the newest is offered, the 2 others named and listed, and Resume keeps them",
    listed.length === 3 && offeredNewest && named && rows === 3 && others.every((l) => kept.includes(l)),
    { listed, newest, offeredNewest, named, rows, kept },
  );
  await step("copies: close the tab", () => n.page.close({ runBeforeUnload: false }));
}

/**
 * PC-502, codex-502, claude-502: three tabs edit their own copies and close, in that real order (no written stamps).
 * Tabs P and Q open the plain edit address and expand the list. Each row says what its copy changes. P presses Resume
 * this copy on a NON-primary row (the middle one): Q's list withdraws that row by itself (count and rows follow, the
 * other tab named), and Q never offers it. Q then presses Discard on the other non-primary row: it asks first, and
 * Discard it removes only that copy; the newest stays. Seeded fault `drop-copy-withdrawal` (the storage events not
 * acted on, as the list was before codex-502 for every row but the offered one) fails the withdrawal check.
 */
async function copiesRowsProbe({ ui, step, expect }) {
  const LABELS = ["Row one", "Row two", "Row three"]; // closed in this order: "Row three" is the newest
  const ready = async (u) => {
    await expect(u.locators.editor()).toBeVisible({ timeout: 15_000 });
    await u.canvasReady();
    await u.settle();
  };
  const first = await ui.openContext({ fresh: true });
  const within = first.context;
  await first.ui.openDiagram(FLOW.slug, FLOW.path);
  await first.ui.enterEdit();
  const plain = first.page
    .url()
    .replace(/[?&]draftId=[^&]+/, "")
    .replace(/[?&]checkpoint=[^&]+/, "")
    .replace(/\?$/, "");
  await first.ui.rename(FLOW.node, LABELS[0]);
  await step("copy rows: close the first tab with unsaved work", () => first.page.close({ runBeforeUnload: false }));
  for (const label of LABELS.slice(1)) {
    const t = await ui.openContext({ within });
    await step(`copy rows: a tab edits its own copy (${label}) and closes`, async () => {
      await t.page.goto(plain);
      await ready(t.ui);
      await t.ui.rename(FLOW.node, label);
      await t.page.close({ runBeforeUnload: false });
    });
  }
  const p = await ui.openContext({ within }),
    q = await ui.openContext({ within });
  const toggle = (t) => t.page.locator(".authoring-statusline").getByRole("button", { name: /other unsaved cop/ });
  const row = (t, label) => t.page.locator(".authoring-copies li").filter({ hasText: label });
  for (const [name, t] of [
    ["P", p],
    ["Q", q],
  ])
    await step(`copy rows: tab ${name} opens the plain edit address and the list`, async () => {
      await t.page.goto(plain);
      await ready(t.ui);
      await toggle(t).click();
      await expect(t.page.locator(".authoring-copies li")).toHaveCount(3);
    });
  const rowsText = await q.page.locator(".authoring-copies li").allTextContents();
  const ordered = LABELS.slice()
    .reverse()
    .every((l, i) => rowsText[i]?.includes(l));
  ui.flowCheck("U5", "copy rows: newest first by real closing order, each row says what its copy changes", ordered, {
    rows: rowsText.map((x) => x.replace(/\s+/g, " ").slice(0, 160)),
  });
  await step("copy rows: tab P clicks Resume this copy on the middle row", () =>
    row(p, LABELS[1]).getByRole("button", { name: "Resume this copy", exact: true }).click(),
  );
  await expect(p.page.locator(".authoring-copies"))
    .toHaveCount(0, { timeout: 8_000 })
    .catch(() => {});
  await ready(p.ui);
  const pTook = ((await p.ui.editorSource().catch(() => "")) ?? "").includes(LABELS[1]);
  const withdrawn = await expect(row(q, LABELS[1]))
    .toHaveCount(0, { timeout: 5_000 })
    .then(
      () => true,
      () => false,
    );
  const qRows = await q.page.locator(".authoring-copies li").count();
  const qCount = (
    (await toggle(q)
      .textContent()
      .catch(() => "")) ?? ""
  ).trim();
  const qNamed = /open in another tab/.test((await q.ui.editorState())?.status ?? "");
  ui.flowCheck(
    "G1",
    "copy rows: a non-primary copy resumed in another tab leaves this tab's list at once, the count follows, and that tab is named",
    pTook && withdrawn && qRows === 2 && qCount === "1 other unsaved copy" && qNamed,
    { pTook, withdrawn, qRows, qCount, qNamed },
  );
  const discard = row(q, LABELS[0]);
  await step("copy rows: tab Q clicks Discard on the oldest row", () =>
    discard.getByRole("button", { name: "Discard", exact: true }).click(),
  );
  const asked = (await discard.getByRole("group", { name: "Discard this copy?" }).count()) === 1;
  const stillThere = async () =>
    q.page.evaluate((l) => {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith("archer.authoring.v1:") && (localStorage.getItem(k) ?? "").includes(l)) return true;
      }
      return false;
    }, LABELS[0]);
  const keptWhileAsked = await stillThere();
  if (asked)
    await step("copy rows: confirm Discard it", () =>
      discard.getByRole("button", { name: "Discard it", exact: true }).click(),
    );
  await q.page.waitForTimeout(300);
  const gone = !(await stillThere());
  const newestKept = await q.page.evaluate((l) => {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith("archer.authoring.v1:") && (localStorage.getItem(k) ?? "").includes(l)) return true;
    }
    return false;
  }, LABELS[2]);
  ui.flowCheck(
    "G1",
    "copy rows: Discard on a row asks first, then removes only that copy; the newest stays",
    asked && keptWhileAsked && gone && newestKept,
    { asked, keptWhileAsked, gone, newestKept },
  );
  await step("copy rows: close tabs P and Q", async () => {
    await p.page.close({ runBeforeUnload: false });
    await q.page.close({ runBeforeUnload: false });
  });
}

/**
 * codex-701: a tab edits and closes; tab B opens the plain edit address and is offered that copy. An outside writer
 * then writes exactly the copy's text to the file. B reads the new file in place, and the copy changes nothing any
 * more: B no longer offers it as unsaved work (before codex-701 the offer stayed until B was reloaded). The file is
 * put back afterwards.
 */
async function fileMatchProbe({ ui, step, expect }) {
  const LABEL = "Externally adopted copy";
  const OFFER = /from another tab, now closed/;
  const ready = async (u) => {
    await expect(u.locators.editor()).toBeVisible({ timeout: 15_000 });
    await u.canvasReady();
    await u.settle();
  };
  const before = ui.fileState(FLOW.slug, FLOW.file);
  const x = await ui.openContext({ fresh: true });
  await x.ui.openDiagram(FLOW.slug, FLOW.path);
  await x.ui.enterEdit();
  await x.ui.rename(FLOW.node, LABEL);
  const mine = (await x.ui.captureEditor(FLOW.slug, x.ui)).text;
  const plain = x.page
    .url()
    .replace(/[?&]draftId=[^&]+/, "")
    .replace(/[?&]checkpoint=[^&]+/, "")
    .replace(/\?$/, "");
  await step("file match: close the tab with unsaved work", () => x.page.close({ runBeforeUnload: false }));
  const b = await ui.openContext({ within: x.context });
  await step("file match: tab B opens the plain edit address", async () => {
    await b.page.goto(plain);
    await ready(b.ui);
  });
  const offered = OFFER.test((await b.ui.editorState())?.status ?? "");
  await ui.agentWrite(FLOW.slug, FLOW.file, mine);
  const gone = await expect(
    b.page.locator(".authoring-statusline").getByRole("button", { name: "Resume them", exact: true }),
  )
    .toHaveCount(0, { timeout: 8_000 })
    .then(
      () => true,
      () => false,
    );
  const bSource = (await b.ui.editorSource().catch(() => "")) ?? "";
  const status = (await b.ui.editorState())?.status ?? "";
  ui.flowCheck(
    "G4",
    "file match: an outside write of the offered copy's exact text withdraws the offer in place",
    offered && bSource === mine && gone && !OFFER.test(status),
    { offered, same: bSource === mine, gone, status },
  );
  await step("file match: close tab B", () => b.page.close({ runBeforeUnload: false }));
  await ui.agentWrite(FLOW.slug, FLOW.file, before.text);
}

/**
 * codex-801: two tabs edit and close, older then newest; tab B opens the plain edit address and is offered the newest,
 * with one other copy. An outside writer writes exactly the newest copy's text. B reads it in place; the older copy
 * still differs, so B still offers it (before codex-801 the promotion was overridden and nothing was offered or
 * listed). A fresh plain Edit visit offers it too, and Resume there restores the older copy's text. The file is put
 * back afterwards.
 */
async function fileMatchNewestProbe({ ui, step, expect }) {
  const OLDER = "Older kept copy",
    NEWEST = "Newest adopted copy";
  const ready = async (u) => {
    await expect(u.locators.editor()).toBeVisible({ timeout: 15_000 });
    await u.canvasReady();
    await u.settle();
  };
  const resume = (t) =>
    t.page.locator(".authoring-statusline").getByRole("button", { name: "Resume them", exact: true });
  const before = ui.fileState(FLOW.slug, FLOW.file);
  const x = await ui.openContext({ fresh: true });
  const within = x.context;
  await x.ui.openDiagram(FLOW.slug, FLOW.path);
  await x.ui.enterEdit();
  const plain = x.page
    .url()
    .replace(/[?&]draftId=[^&]+/, "")
    .replace(/[?&]checkpoint=[^&]+/, "")
    .replace(/\?$/, "");
  await x.ui.rename(FLOW.node, OLDER);
  await step("newest match: close the older tab with unsaved work", () => x.page.close({ runBeforeUnload: false }));
  const y = await ui.openContext({ within });
  let newest = "";
  await step("newest match: a second tab edits its own copy and closes", async () => {
    await y.page.goto(plain);
    await ready(y.ui);
    await y.ui.rename(FLOW.node, NEWEST);
    newest = (await y.ui.captureEditor(FLOW.slug, y.ui)).text;
    await y.page.close({ runBeforeUnload: false });
  });
  const b = await ui.openContext({ within });
  await step("newest match: tab B opens the plain edit address", async () => {
    await b.page.goto(plain);
    await ready(b.ui);
  });
  const count = () =>
    b.page
      .locator(".authoring-statusline")
      .getByRole("button", { name: /other unsaved cop/ })
      .count();
  const offeredBoth = (await resume(b).count()) === 1 && (await count()) === 1;
  await ui.agentWrite(FLOW.slug, FLOW.file, newest);
  const adopted = await expect
    .poll(async () => (await b.ui.editorSource().catch(() => "")) ?? "", { timeout: 8_000 })
    .toBe(newest)
    .then(
      () => true,
      () => false,
    );
  await b.page.waitForTimeout(300);
  const stillOffered = (await resume(b).count()) === 1;
  await step("newest match: close tab B", () => b.page.close({ runBeforeUnload: false }));
  const f = await ui.openContext({ within });
  await step("newest match: a fresh tab opens the plain edit address", async () => {
    await f.page.goto(plain);
    await ready(f.ui);
  });
  const freshOffered = await expect(resume(f))
    .toHaveCount(1, { timeout: 5_000 })
    .then(
      () => true,
      () => false,
    );
  let restored = false;
  if (freshOffered)
    await step(
      "newest match: Resume them in the fresh tab",
      async () => {
        await resume(f).click();
        await ready(f.ui);
        restored = await expect
          .poll(async () => (await f.ui.editorSource().catch(() => "")) ?? "", { timeout: 8_000 })
          .toContain(OLDER)
          .then(
            () => true,
            () => false,
          );
      },
      // The file moved on since the older copy was kept: that is said at once (claude-306), as it should be.
      { expects: [{ kind: "alert", text: "changed outside the editor" }] },
    );
  ui.flowCheck(
    "G1",
    "newest match: an outside write of the newest copy's text leaves the older differing copy offered, in place and on a fresh plain visit",
    offeredBoth && adopted && stillOffered && freshOffered && restored,
    { offeredBoth, adopted, stillOffered, freshOffered, restored },
  );
  await step("newest match: close the fresh tab", () => f.page.close({ runBeforeUnload: false }));
  await ui.agentWrite(FLOW.slug, FLOW.file, before.text);
}
