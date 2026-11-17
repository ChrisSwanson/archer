// J9d save while offline (decided 2026-11-02; flows-r1 claude-11, O92): J6 with the browser offline at Save. The page
// keeps the change in browser recovery and says so ("Saved in this browser · will save when back online"); a second
// edit and Save while still offline leave one held save holding the latest text; reload while offline (the browser's
// own error page) and close the tab; back online, reopen it: the held save is sent once, under the operation identity
// it was kept with and from the revision the person edited, and the page says "Saved · time". Then the conflict
// variant: an outside write while offline, back online, the held save is refused (the banner), nothing overwritten,
// the person's text kept.
//
// Collectors: G4 (what the page says while offline is true: kept here, not saved; no raw "Failed to fetch"), G5
// (nothing sent while offline; exactly one save sent and recorded afterwards, under the held identity), G1 (the
// browser keeps the text, target and base revision across the reload and the closed tab; the file holds the person's
// bytes), G2 (the conflict variant). Seeded faults: fresh-save-identity (the held save goes out under a new
// operation id) fails G5's identity check; skip-revision-check (the save claims the file's current revision) fails G2.
//
// Lost-answer variant (claude-11): the page believes it is connected, and the Save never reaches Archer (the request
// fails at the network). The page checks by itself whether it was saved; with no record so far it says it is not known
// yet (never "Not saved", which only Archer can say: claude-307) and looks again; "Save again"
// sends that same operation once (ADR 0015: never resent by itself). fresh-save-identity fails its G5 check too.
//
// Gone variants (claude-203): the held save's file is deleted, or renamed, while the tab is closed. Reopened, the page
// shows the person's text with Copy and offers Save as a new diagram here, Save as a proposal or Discard (G1, G3);
// the held save is never sent to the missing file (G5). Deleted: Save as a new diagram here writes the text at the
// old path, once. Renamed: the diagram at its new path offers the work ("Bring them here"), and saving it there
// writes the new file and never recreates the old one (G2). Seeded faults: drop-draft (the browser loses the work)
// fails the G1 check; stale-open (the page is told the missing file is still there) fails the G5 check.
import { assertFlowChecks, g2Verdict } from "../../harness/flows-state.mjs";
import { flowRecorder } from "../../harness/flow-metrics.mjs";
import { DISCONNECT_INVARIANTS, FLOW, clickSave, savedClaim, within, reopenTab, sessionOf } from "./state-lib.mjs";

const ONE = "Offline one",
  TWO = "Offline two",
  MINE = "Mine offline",
  LOST = "Never received";
const e2eContext = (ui) => ui.openContext();
const HELD = "Saved in this browser · will save when back online";
export const meta = {
  name: "flows-j09d-offline-save",
  invariants: { ...DISCONNECT_INVARIANTS, "dirty-navigation": false, "editor-alert": false },
  flow: {
    id: "J9d",
    projects: ["journeys"],
    baseline: [
      { action: "click Edit", class: "essential" },
      { action: "double-click node a", class: "essential" },
      { action: "type the new label", class: "essential" },
      { action: "press Enter", class: "essential" },
      { action: "click Save (offline)", class: "essential" },
      { action: "click Mermaid source", class: "essential" },
      { action: "type the second label in the source", class: "essential" },
      { action: "click Save again (offline)", class: "essential" },
      { action: "reload (F5, offline)", class: "essential" },
      { action: "close the tab (Ctrl+W)", class: "essential" },
      { action: "reopen the closed tab (back online)", class: "essential" },
    ],
  },
};

const RENAMED = ".archer/diagrams/flow-renamed.mmd";
/**
 * The held save's file is deleted while its tab is closed, and its address is then opened in a NEW tab (another tab
 * id, as a pasted link or a bookmark does), not the reopened one (claude-403, PC-402): the gone screen says the work
 * from the closed tab is kept and offers Resume them, which shows the person's text with Save as a new diagram here;
 * nothing is sent to the missing file. Seeded fault `hide-closed-work` (the gone screen as before claude-403: "You
 * have no unsaved changes", no Resume) fails it.
 */
async function goneNewTab({ ui, step, expect, tried }) {
  await ui.resetProject(FLOW.slug);
  tried.length = 0;
  const t = await ui.openContext();
  await t.ui.openDiagram(FLOW.slug, FLOW.path);
  await t.page.evaluate(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith("archer.authoring.v1:")) localStorage.removeItem(k);
  });
  await t.ui.enterEdit();
  await t.ui.rename(FLOW.node, "Held deleted, new tab");
  const mine = await t.ui.captureEditor(FLOW.slug, t.ui);
  await ui.setOffline(true);
  await step("click Save (offline, then deleted; reopened in a new tab)", async () => {
    await clickSave(t.page);
    await expect(t.page.locator(".authoring-statusline")).toContainText(HELD, { timeout: 10_000 });
  });
  const address = t.page.url();
  await t.page.close({ runBeforeUnload: false });
  await ui.agentRemove(FLOW.slug, FLOW.file);
  await ui.setOffline(false);
  const n = await ui.openContext();
  const panel = n.page.locator(".authoring-missing");
  await step(
    "open the deleted file's address in a new tab",
    async () => {
      await n.page.goto(address);
      await within(
        n.page,
        async () => (await n.page.getByRole("heading", { name: "This Diagram’s File Is Gone" }).count()) > 0,
        { timeout: 15_000 },
      );
    },
    { leavesEditor: true, expects: [{ kind: "http", status: 404, url: "/api/authoring/open" }] },
  ); // the service refusing to open the file this part removed (errors.mjs)
  const said = (await panel.textContent().catch(() => "")) ?? "";
  const resume = panel.getByRole("button", { name: "Resume them", exact: true });
  const offered = /from another tab, now closed/.test(said) && (await resume.count()) > 0;
  if (offered)
    await step("click Resume them (new tab, file gone)", () => resume.click(), {
      leavesEditor: true,
      expects: [{ kind: "http", status: 404, url: "/api/authoring/open" }],
    });
  const text = offered
    ? await within(
        n.page,
        async () =>
          (await panel
            .getByLabel("Your Mermaid")
            .inputValue()
            .catch(() => null)) === mine.text,
        { timeout: 10_000 },
      ).then(
        () => true,
        () => false,
      )
    : false;
  const saveNew = await panel
    .getByRole("button", { name: "Save as a new diagram here", exact: true })
    .isEnabled()
    .catch(() => false);
  ui.flowCheck(
    "G1",
    "file deleted, new tab: the gone screen offers the closed tab's work, and Resume them shows it with Save as a new diagram here",
    offered && text && saveNew,
    { offered, said: said.slice(0, 240), shown: text, saveNew },
  );
  ui.flowCheck(
    "G5",
    "file deleted, new tab: the held save is not sent to the missing file",
    tried.every((x) => x.status === null) && !ui.fileState(FLOW.slug, FLOW.file).exists,
    {
      answered: tried.filter((x) => x.status !== null).map(({ source, ...x }) => x),
      recreated: ui.fileState(FLOW.slug, FLOW.file).exists,
    },
  );
  await n.page.close({ runBeforeUnload: false });
}

/**
 * The file is KEPT, and the closed tab held a save (offline) or sent one whose answer never came; the diagram is then
 * opened in a NEW tab at its plain edit address (claude-501, PC-501). The status line names the closed tab's save as a
 * save (held, or not known to have reached Archer) and offers Resume them; nothing is sent before Resume. Resumed: the
 * held save is sent once under its kept identity and the file holds it; an outside write meanwhile meets the revision
 * check (the conflict, nothing written over); the unconfirmed one says not known and Save again sends that same
 * operation once. Seeded fault `hide-pending-copies` (the plain-address scan as before claude-501: a record holding a
 * save is not offered) fails the G1 check.
 */
async function keptNewTab({ ui, step, expect, tried, variant }) {
  await ui.resetProject(FLOW.slug);
  tried.length = 0;
  const base = ui.fileState(FLOW.slug, FLOW.file);
  const t = await ui.openContext();
  await t.ui.openDiagram(FLOW.slug, FLOW.path);
  await t.page.evaluate(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith("archer.authoring.v1:")) localStorage.removeItem(k);
  });
  await t.ui.enterEdit();
  await t.ui.rename(FLOW.node, `Kept ${variant}`);
  const mine = await t.ui.captureEditor(FLOW.slug, t.ui);
  const lost = variant === "lost answer";
  if (lost) {
    await t.page.route("**/api/authoring", (route) =>
      route.request().method() === "POST" && /"op":"document\.apply"/.test(route.request().postData() ?? "")
        ? route.abort("connectionreset")
        : route.fallback(),
    );
    await step(
      `click Save (${variant}; then a new tab on the kept file)`,
      async () => {
        await clickSave(t.page);
        await within(t.page, async () => /Not known/.test((await t.ui.editorState())?.status ?? ""), {
          timeout: 15_000,
        });
      },
      { leavesEditor: true },
    );
  } else {
    await ui.setOffline(true);
    await step(`click Save (offline, ${variant}; then a new tab on the kept file)`, async () => {
      await clickSave(t.page);
      await expect(t.page.locator(".authoring-statusline")).toContainText(HELD, { timeout: 10_000 });
    });
  }
  // The kept save's identity, as the browser holds it (held offline, nothing went out to read it from).
  const heldId =
    (await t.ui.storedDraft(new URL(t.page.url()).searchParams.get("draftId")))?.pending?.operationId ??
    tried[0]?.operationId ??
    null;
  await t.page.close({ runBeforeUnload: false });
  if (!lost) await ui.setOffline(false);
  const other = base.text.replace("b[API]", "b[API by agent]");
  if (variant === "held, file changed") await ui.agentWrite(FLOW.slug, FLOW.file, other);
  tried.length = 0;
  const n = await ui.openContext();
  await n.ui.openDiagram(FLOW.slug, FLOW.path);
  await n.ui.enterEdit();
  const line = n.page.locator(".authoring-statusline");
  const named = lost ? "got no answer: not known whether it reached Archer" : "is held in this browser, not sent yet";
  const said =
    (await within(
      n.page,
      async () => {
        const x = (await line.textContent().catch(() => "")) ?? "";
        return x.includes(named) ? x : null;
      },
      { timeout: 5_000 },
    )) ??
    (await line.textContent().catch(() => "")) ??
    "";
  const resume = line.getByRole("button", { name: "Resume them", exact: true });
  const offered = said.includes(named) && /from another tab, now closed/.test(said) && (await resume.count()) > 0;
  const quiet = tried.length === 0;
  ui.flowCheck(
    "G1",
    `kept file, new tab (${variant}): the closed tab's save is offered on the plain edit address, named as a save, nothing sent before Resume`,
    offered && quiet,
    { offered, said: said.replace(/\s+/g, " ").slice(0, 240), sentBeforeResume: tried.length },
  );
  if (!offered) {
    await n.page.close({ runBeforeUnload: false });
    return;
  }
  // "held, file changed": the agent's write this variant makes meets the resumed save: the conflict (an alert), then
  // its refusal changing the banner's words (a notice). Nothing else is declared (PC-601).
  const CHANGED = [
    { kind: "alert", text: "changed outside the editor" },
    { kind: "notice", text: "Save is blocked" },
  ];
  await step(`click Resume them (kept file, new tab, ${variant})`, () => resume.click(), {
    leavesEditor: true,
    ...(variant === "held, file changed" ? { expects: CHANGED } : {}),
  });
  if (variant === "held") {
    await within(n.page, async () => tried.some((x) => x.status !== null), { timeout: 15_000 });
    await within(
      n.page,
      async () =>
        /saved/i.test(
          (await n.page
            .locator(".archer-presence")
            .first()
            .textContent({ timeout: 500 })
            .catch(() => "")) ?? "",
        ),
      { timeout: 15_000 },
    );
    const sent = tried.filter((x) => x.failed === null && x.status !== null);
    const disk = ui.fileState(FLOW.slug, FLOW.file);
    ui.flowCheck(
      "G5",
      "kept file, new tab (held): Resume sends the held save once, under its kept identity, and the file holds it",
      sent.length === 1 && sent[0].operationId === heldId && sent[0].outcome === "applied" && disk.text === mine.text,
      { sent: sent.map(({ source, ...x }) => x), heldId, fileHoldsIt: disk.text === mine.text },
    );
  } else if (variant === "held, file changed") {
    await within(n.page, async () => (await n.page.locator(".authoring-conflict").count()) > 0, { timeout: 15_000 });
    const answered = tried.filter((x) => x.status !== null);
    const editorSource = await n.ui.editorSource().catch(() => null);
    const verdict = g2Verdict({
      answer: answered.at(-1) ? { outcome: answered.at(-1).outcome } : null,
      sent: answered.length > 0,
      diskBeforeSave: other,
      diskAfterSave: ui.fileState(FLOW.slug, FLOW.file).text,
      otherWriter: other,
      personSource: mine.text,
      editorSource,
    });
    ui.flowCheck(
      "G2",
      "kept file, new tab (held, file changed): Resume meets the revision check (refused by the page, or sent once from its base and refused), nothing written over, text kept",
      verdict.ok && (answered.length === 0 || (answered.length === 1 && answered[0].operationId === heldId)),
      { ...verdict, answers: answered.map(({ source, ...x }) => x), heldId },
    );
  } else {
    const again = n.page.locator(".authoring-toolbar").getByRole("button", { name: "Save again", exact: true });
    const said2 =
      (await within(
        n.page,
        async () => ((await again.isEnabled().catch(() => false)) ? ((await n.ui.editorState())?.status ?? "") : null),
        { timeout: 15_000 },
      )) ?? "";
    const shown = (await n.ui.editorSource().catch(() => null)) === mine.text;
    await step(
      "click Save again (kept file, new tab, lost answer)",
      async () => {
        await again.click();
        await within(n.page, async () => tried.some((x) => x.status !== null), { timeout: 15_000 });
      },
      { leavesEditor: true },
    );
    const sent = tried.filter((x) => x.failed === null && x.status !== null);
    ui.flowCheck(
      "G5",
      "kept file, new tab (lost answer): resumed, it says not known with the person's text, and Save again sends that same operation once",
      /Not known/.test(said2) &&
        !/\bNot saved\b/.test(said2) &&
        shown &&
        sent.length === 1 &&
        sent[0].operationId === heldId &&
        ui.fileState(FLOW.slug, FLOW.file).text === mine.text,
      { status: said2, shown, sent: sent.map(({ source, ...x }) => x), heldId },
    );
  }
  await n.page.close({ runBeforeUnload: false });
}

/**
 * A closed tab's held save, kept in this browser, and the diagram opened in a new tab B at its plain edit address
 * (claude-601, claude-602). "reopened": B offers the held save; the closed tab is reopened (its session, so its owner
 * id) and sends it; B's offer goes by itself, with no reload, and nothing in B says it is still held. "resumed offline":
 * B goes offline and presses Resume them; the editor says it is not connected, with Try again, not a bare "Archer did
 * not answer."; back online it opens by itself and the held save is sent once.
 */
async function offeredElsewhere({ ui, step, expect, tried, variant }) {
  await ui.resetProject(FLOW.slug);
  tried.length = 0;
  const t = await ui.openContext();
  await t.ui.openDiagram(FLOW.slug, FLOW.path);
  await t.page.evaluate(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith("archer.authoring.v1:")) localStorage.removeItem(k);
  });
  await t.ui.enterEdit();
  await t.ui.rename(FLOW.node, `Offered ${variant}`);
  const mine = await t.ui.captureEditor(FLOW.slug, t.ui);
  await ui.setOffline(true);
  await step(`click Save (offline; then ${variant} while a new tab offers it)`, async () => {
    await clickSave(t.page);
    await expect(t.page.locator(".authoring-statusline")).toContainText(HELD, { timeout: 10_000 });
  });
  const heldId =
    (await t.ui.storedDraft(new URL(t.page.url()).searchParams.get("draftId")))?.pending?.operationId ?? null;
  const session = await sessionOf(t.page),
    address = t.page.url();
  await t.page.close({ runBeforeUnload: false });
  await ui.setOffline(false);
  const n = await ui.openContext();
  await n.ui.openDiagram(FLOW.slug, FLOW.path);
  await n.ui.enterEdit();
  const line = n.page.locator(".authoring-statusline"),
    HELD_OFFER = "is held in this browser, not sent yet";
  const offered = Boolean(
    await within(n.page, async () => ((await line.textContent().catch(() => "")) ?? "").includes(HELD_OFFER), {
      timeout: 5_000,
    }),
  );
  if (variant === "reopened") {
    const r = await reopenTab(ui, session);
    await step(
      "reopen the closed tab while the new tab offers its held save",
      async () => {
        await r.page.goto(address);
        await within(r.page, async () => tried.some((x) => x.status !== null), { timeout: 15_000 });
      },
      { leavesEditor: true },
    );
    const sent = tried.filter((x) => x.failed === null && x.status !== null);
    // No reload of B: its offer follows the record (claude-601).
    const withdrawn = Boolean(
      await within(n.page, async () => !((await line.textContent().catch(() => "")) ?? "").includes(HELD_OFFER), {
        timeout: 10_000,
      }),
    );
    const said = ((await line.textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").slice(0, 240);
    ui.flowCheck(
      "G4",
      "held save offered in a new tab, the closed tab reopened: it is sent once, and the new tab's offer goes by itself",
      offered &&
        withdrawn &&
        sent.length === 1 &&
        sent[0].operationId === heldId &&
        ui.fileState(FLOW.slug, FLOW.file).text === mine.text,
      { offered, withdrawn, said, sent: sent.map(({ source, ...x }) => x), heldId },
    );
    await r.page.close({ runBeforeUnload: false });
  } else {
    const resume = line.getByRole("button", { name: "Resume them", exact: true });
    await ui.setOffline(true);
    const stage = n.page.locator(".authoring-denied");
    await step(
      "click Resume them (offline)",
      async () => {
        await resume.click();
        await expect(stage).toContainText("Not connected to Archer", { timeout: 10_000 });
      },
      { leavesEditor: true },
    );
    const retry = (await stage.getByRole("button", { name: "Try again", exact: true }).count()) > 0;
    const bare = /^\s*Diagram Editor\s*Archer did not answer\.\s*$/.test(
      (await stage.textContent().catch(() => "")) ?? "",
    );
    const quiet = tried.length === 0;
    await ui.setOffline(false);
    // It opens, restores the held save as this tab's and sends it; in place, a saved editor then closes by itself, so
    // "opened" is the not-connected stage gone with the editor or the saved diagram in its place.
    const opened = Boolean(
      await within(
        n.page,
        async () =>
          (await stage.count()) === 0 &&
          ((await n.ui.editorState())?.editing === true || tried.some((x) => x.status !== null)),
        { timeout: 15_000 },
      ),
    );
    await within(n.page, async () => tried.some((x) => x.status !== null), { timeout: 15_000 });
    await n.page.waitForTimeout(1000);
    const sent = tried.filter((x) => x.failed === null && x.status !== null);
    ui.flowCheck(
      "G3",
      "Resume pressed offline: the editor says it is not connected, offers Try again, and opens by itself back online",
      offered && retry && !bare && opened,
      { offered, retry, bare, opened },
    );
    ui.flowCheck(
      "G5",
      "Resume pressed offline: nothing is sent offline, and back online the held save is sent once, under its kept identity",
      quiet &&
        sent.length === 1 &&
        sent[0].operationId === heldId &&
        tried.length === 1 &&
        ui.fileState(FLOW.slug, FLOW.file).text === mine.text,
      { sentOffline: !quiet, attempts: tried.map(({ source, ...x }) => x), heldId },
    );
  }
  await n.page.close({ runBeforeUnload: false });
}

/** A held save whose file is deleted or renamed while the tab is closed; the tab reopened online (claude-203). */
async function gone({ ui, step, expect, tried, variant }) {
  await ui.resetProject(FLOW.slug);
  tried.length = 0;
  const base = ui.fileState(FLOW.slug, FLOW.file);
  // "unsaved": the change is only typed (not Saved) before the tab is closed and the file deleted (codex-302).
  const unsaved = variant === "deleted, unsaved";
  const label = unsaved ? "Unsaved deleted" : `Held ${variant}`;
  const t = await ui.openContext();
  await t.ui.openDiagram(FLOW.slug, FLOW.path);
  // This browser's drafts from the variants before, as resetProject clears them from the journey's own tab.
  await t.page.evaluate(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith("archer.authoring.v1:")) localStorage.removeItem(k);
  });
  await t.ui.enterEdit();
  await t.ui.rename(FLOW.node, label);
  const mine = await t.ui.captureEditor(FLOW.slug, t.ui);
  if (!unsaved) {
    await ui.setOffline(true);
    await step(`click Save (offline, then ${variant})`, async () => {
      await clickSave(t.page);
      await expect(t.page.locator(".authoring-statusline")).toContainText(HELD, { timeout: 10_000 });
    });
  }
  const session = await sessionOf(t.page);
  const address = t.page.url();
  await t.page.close({ runBeforeUnload: false });
  await ui.agentRemove(FLOW.slug, FLOW.file);
  if (variant === "renamed") await ui.agentWrite(FLOW.slug, RENAMED, base.text);
  await ui.setOffline(false);
  const r = await reopenTab(ui, session);
  await step(
    `reopen the closed tab (${variant}, back online)`,
    async () => {
      // The tab had a page before the editor, as a person's does: Back from the saved diagram has somewhere to go.
      await r.page.goto(new URL(`/projects/${FLOW.slug}/`, address).href);
      await r.page.goto(address);
      await within(
        r.page,
        async () => (await r.page.getByRole("heading", { name: "This Diagram’s File Is Gone" }).count()) > 0,
        { timeout: 15_000 },
      );
    },
    { leavesEditor: true, expects: [{ kind: "http", status: 404, url: "/api/authoring/open" }] },
  ); // the service refusing to open the file this part removed (errors.mjs)
  const panel = r.page.locator(".authoring-missing");
  const text = await panel
    .getByLabel("Your Mermaid")
    .inputValue()
    .catch(() => null);
  const offered = await Promise.all(
    ["Save as a new diagram here", "Save as a proposal", "Copy my Mermaid", "Discard"].map((name) =>
      panel
        .getByRole("button", { name, exact: true })
        .isEnabled()
        .catch(() => false),
    ),
  );
  ui.flowCheck(
    "G1",
    `file ${variant} before reopen: the person's text is shown, with Copy`,
    text === mine.text && offered[2],
    { shown: text === mine.text, copy: offered[2] },
  );
  ui.flowCheck(
    "G3",
    `file ${variant} before reopen: Save as a new diagram here, Save as a proposal and Discard are offered`,
    offered.every(Boolean),
    { offered },
  );
  ui.flowCheck(
    "G5",
    `file ${variant} before reopen: the held save is not sent to the missing file`,
    tried.every((x) => x.status === null) && !ui.fileState(FLOW.slug, FLOW.file).exists,
    {
      answered: tried.filter((x) => x.status !== null).map(({ source, ...x }) => x),
      recreated: ui.fileState(FLOW.slug, FLOW.file).exists,
    },
  );
  if (variant !== "renamed") {
    const v = unsaved ? "file deleted, unsaved" : "file deleted";
    await step(
      `click Save as a new diagram here (${variant})`,
      async () => {
        await panel.getByRole("button", { name: "Save as a new diagram here", exact: true }).click();
        await within(r.page, async () => ui.fileState(FLOW.slug, FLOW.file).exists && (await panel.count()) === 0, {
          timeout: 15_000,
        });
      },
      { leavesEditor: true },
    );
    const disk = ui.fileState(FLOW.slug, FLOW.file);
    ui.flowCheck(
      "G1",
      `${v}: Save as a new diagram here writes the person's text at the old path`,
      disk.exists && disk.text === mine.text,
      { exists: disk.exists, same: disk.text === mine.text },
    );
    // Where the person lands (codex-302): the saved diagram, read, at an address that names it; reload and Back too.
    const at = async (p) => {
      await within(
        p,
        async () =>
          (await p.locator(".archer-presence").count()) > 0 ||
          (await p.getByText(/checkpoint|editor address/i).count()) > 0,
        { timeout: 10_000 },
      );
      const url = new URL(p.url());
      const invalid =
        (await p
          .getByText(/canonical checkpoint requires a diagram target|editor checkpoint is invalid|editor address/i)
          .count()) > 0;
      const goneShown = (await p.getByRole("heading", { name: "This Diagram’s File Is Gone" }).count()) > 0;
      const shown = (await p.getByText(label, { exact: true }).count()) > 0;
      const named = !url.pathname.includes("/-/edit/") || url.searchParams.has("viewId");
      return {
        url: `${url.pathname}${url.search}`,
        invalid,
        goneShown,
        shown,
        named,
        editing: (await r.ui.editorState())?.editing ?? null,
      };
    };
    const landed = await at(r.page);
    const saved = await savedClaim(r.page);
    ui.flowCheck(
      "U7",
      `${v}: after Save as a new diagram here, the saved diagram is shown at an address naming it, saying Saved`,
      !landed.invalid && !landed.goneShown && landed.shown && landed.named && saved.saidSaved,
      { ...landed, claim: saved.claim, voice: saved.voice },
    );
    await step(`reload the saved diagram (${variant})`, () => r.page.reload(), { leavesEditor: true });
    const reloaded = await at(r.page);
    ui.flowCheck(
      "U7",
      `${v}: reload keeps the saved diagram`,
      !reloaded.invalid && !reloaded.goneShown && reloaded.shown && reloaded.named,
      reloaded,
    );
    await step(`Back from the saved diagram (${variant})`, () => r.page.goBack().catch(() => null), {
      leavesEditor: true,
    });
    const back = await at(r.page);
    ui.flowCheck(
      "U7",
      `${v}: Back leads to the page before, never an invalid page or the gone screen`,
      !back.invalid && !back.goneShown && back.url.startsWith(`/projects/${FLOW.slug}/`),
      back,
    );
  } else {
    // The diagram at its new path: Edit offers the work made on the old one.
    await r.ui.openDiagram(FLOW.slug, "diagrams/flow-renamed.mmd");
    // Finding the old path's work, the page asks the service to open that path: gone, it is refused (errors.mjs).
    await r.ui.enterEdit({ expects: [{ kind: "http", status: 404, url: "/api/authoring/open" }] });
    const bring = r.page.locator(".authoring-statusline").getByRole("button", { name: "Bring them here", exact: true });
    const offeredHere = await within(r.page, async () => (await bring.count()) > 0, { timeout: 10_000 }).then(
      () => true,
      () => false,
    );
    ui.flowCheck("G1", "file renamed: the diagram at its new path offers the work made on the old one", offeredHere, {
      status: (await r.ui.editorState())?.status ?? null,
    });
    if (offeredHere) {
      await bring.click();
      await within(r.page, async () => ((await r.ui.editorSource().catch(() => "")) ?? "").includes(label), {
        timeout: 5_000,
      }).catch(() => {});
      await clickSave(r.page);
      await within(r.page, async () => ui.fileState(FLOW.slug, RENAMED).text?.includes(label), {
        timeout: 15_000,
      }).catch(() => {});
    }
    const now = ui.fileState(FLOW.slug, RENAMED);
    ui.flowCheck(
      "G2",
      "file renamed: saved at its new path, the old path not recreated, nothing else overwritten",
      now.text === mine.text && !ui.fileState(FLOW.slug, FLOW.file).exists,
      { renamedHolds: now.text === mine.text, oldRecreated: ui.fileState(FLOW.slug, FLOW.file).exists },
    );
  }
  await r.page.close({ runBeforeUnload: false });
  await ui.resetProject(FLOW.slug);
}

/** Every document.apply the context's pages try to send (a request event: one the offline browser fails counts too). */
function applyAttempts(context) {
  const list = [],
    of = new WeakMap();
  context.on("request", (r) => {
    if (r.method() !== "POST" || !/\/api\/authoring$/.test(new URL(r.url()).pathname)) return;
    let body = null;
    try {
      body = JSON.parse(r.postData() ?? "null");
    } catch {
      /* not JSON */
    }
    if (body?.op !== "document.apply") return;
    const entry = {
      operationId: body.operationId ?? null,
      expectedSourceRevision: body.expectedSourceRevision ?? null,
      source: body.source ?? null,
      status: null,
      outcome: null,
      failed: null,
    };
    list.push(entry);
    of.set(r, entry);
  });
  context.on("requestfinished", async (r) => {
    const e = of.get(r);
    if (!e) return;
    const res = await r.response().catch(() => null);
    e.outcome = (await res?.json().catch(() => null))?.outcome ?? null;
    e.status = res?.status() ?? null;
  });
  context.on("requestfailed", (r) => {
    const e = of.get(r);
    if (e) e.failed = r.failure()?.errorText ?? "failed";
  });
  return list;
}
const savesOf = (r) =>
  (r?.cumulativeReviews?.reviews ?? [])
    .filter((x) => x.subject?.path === FLOW.file)
    .reduce((n, x) => n + (x.saveCount ?? 0), 0);
const hhmm = (d) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });

export default async ({ ui, step, expect, context, run }) => {
  const flow = flowRecorder({ step, run }, meta.flow);
  const B = Object.fromEntries(meta.flow.baseline.map((b) => [b.action, b]));
  const act = (action, fn) => flow.act(action, B[action].class, fn);
  const tried = applyAttempts(context);
  await ui.resetProject(FLOW.slug);
  const before = ui.fileState(FLOW.slug, FLOW.file);
  const reviewBefore = await ui.archerCall(FLOW.slug, "list_changes", {});
  const a = await ui.openContext();
  await a.ui.openDiagram(FLOW.slug, FLOW.path);
  await act("click Edit", () => a.ui.enterEdit());
  await flow.actions([B["double-click node a"], B["type the new label"], B["press Enter"]], () =>
    a.ui.rename(FLOW.node, ONE),
  );
  await ui.setOffline(true);
  await act("click Save (offline)", async () => {
    await clickSave(a.page);
    await expect(a.page.locator(".authoring-statusline")).toContainText(HELD, { timeout: 10_000 });
  });
  const draftId = new URL(a.page.url()).searchParams.get("draftId");
  const first = await a.ui.storedDraft(draftId);
  const shown = await a.ui.editorState();
  const pageText = await a.page
    .locator("body")
    .innerText()
    .catch(() => "");
  ui.flowCheck(
    "G4",
    "offline Save: the page says the change is kept in this browser, not saved",
    (shown?.status ?? "").includes(HELD) &&
      first?.held === true &&
      !/Failed to fetch/i.test(pageText) &&
      shown?.editing === true,
    {
      status: shown?.status ?? null,
      held: first?.held ?? null,
      rawFetchError: /Failed to fetch/i.test(pageText),
      feedback: shown?.feedback?.text ?? null,
    },
  );
  ui.flowCheck(
    "G1",
    "offline Save: kept from the revision the person edited",
    first?.pending?.expectedSourceRevision === before.revision &&
      first?.pending?.source === first?.source &&
      (first?.source ?? "").includes(ONE),
    {
      sentBase: first?.pending?.expectedSourceRevision ?? null,
      base: before.revision,
      pendingIsEditor: first?.pending?.source === first?.source,
    },
  );

  // A second edit and Save while still offline: one held save, the latest text, the same identity. Offline, the canvas's
  // structured edits need the service; the Mermaid source is the person's way to keep editing.
  await act("click Mermaid source", () => a.ui.toggleEditorSource());
  const typed = (await a.ui.editorSource()).replace(ONE, TWO);
  await act("type the second label in the source", () => a.ui.setEditorSource(typed));
  await act("click Save again (offline)", () => clickSave(a.page));
  const captured = await a.ui.captureEditor(FLOW.slug, a.ui);
  const second = await a.ui.storedDraft(draftId);
  const heldId = first?.pending?.operationId ?? null;
  ui.flowCheck(
    "G5",
    "several edits while offline: one held save holding the latest text",
    second?.held === true &&
      second?.pending?.operationId === heldId &&
      second?.pending?.source === captured.text &&
      captured.text.includes(TWO),
    {
      heldId,
      nowId: second?.pending?.operationId ?? null,
      held: second?.held ?? null,
      latest: second?.pending?.source === captured.text,
      hasTwo: captured.text.includes(TWO),
    },
  );
  ui.flowCheck(
    "G5",
    "while offline: nothing is sent and the file is unchanged",
    tried.every((t) => t.failed !== null || t.status === null) &&
      tried.filter((t) => t.status !== null).length === 0 &&
      ui.fileState(FLOW.slug, FLOW.file).revision === before.revision,
    { attempts: tried.length, answered: tried.filter((t) => t.status !== null).length },
  );

  // Reload while offline: the browser cannot load the page. What it keeps is read from another tab of the profile.
  const session = await sessionOf(a.page);
  const address = a.page.url();
  const reload = await act("reload (F5, offline)", () =>
    a.page.reload().then(
      () => "loaded",
      (e) => String(e?.message ?? e).split("\n")[0],
    ),
  );
  const kept = await ui.storedDraft(draftId);
  ui.flowCheck(
    "G1",
    "reload while offline: the browser keeps the text, target and base, and the held save",
    kept?.source === captured.text &&
      kept?.opened?.sourceRevision === captured.baseRevision &&
      kept?.held === true &&
      kept?.pending?.operationId === heldId &&
      kept?.pending?.source === captured.text,
    {
      reload,
      keptText: kept?.source === captured.text,
      keptBase: kept?.opened?.sourceRevision ?? null,
      held: kept?.held ?? null,
    },
  );
  await act("close the tab (Ctrl+W)", () => a.page.close({ runBeforeUnload: false }));
  await ui.setOffline(false);
  const b = await reopenTab(ui, session);
  const at = new Date();
  await act("reopen the closed tab (back online)", async () => {
    await b.page.goto(address);
    await within(b.page, async () => tried.some((t) => t.status !== null), { timeout: 15_000 });
    // Bounded wait, not an assertion: what the page ends up saying is judged by the checks below.
    await within(
      b.page,
      async () =>
        /saved/i.test(
          (await b.page
            .locator(".archer-presence")
            .first()
            .textContent({ timeout: 500 })
            .catch(() => "")) ?? "",
        ),
      { timeout: 15_000 },
    );
  });
  await within(b.page, async () => tried.every((t) => t.failed !== null || t.status !== null), { timeout: 5_000 });
  const sent = tried.filter((t) => t.failed === null && t.status !== null);
  const reviewAfter = await ui.archerCall(FLOW.slug, "list_changes", {});
  const recorded = savesOf(reviewAfter) - savesOf(reviewBefore);
  const disk = ui.fileState(FLOW.slug, FLOW.file);
  // The service's record of the identity the browser kept (the page's own request event shows what it tried to send).
  const known = heldId
    ? ((await ui.serviceGet(`/p/${FLOW.slug}/api/authoring/operations/${heldId}`).catch(() => null))?.operation ?? null)
    : null;
  ui.flowCheck(
    "G5",
    "back online: the held save is sent once, under its kept identity",
    sent.length === 1 &&
      sent[0].operationId === heldId &&
      sent[0].expectedSourceRevision === before.revision &&
      known?.state === "terminal" &&
      known?.outcome === "applied" &&
      recorded === 1,
    {
      sent: sent.map(({ source, ...x }) => x),
      heldId,
      service: known ? { state: known.state, outcome: known.outcome } : null,
      recorded,
      base: before.revision,
    },
  );
  ui.flowCheck("G1", "back online: the file holds the person's text", disk.text === captured.text, {
    diskRevision: disk.revision,
    length: captured.text.length,
  });
  const presence = b.page.locator(".archer-presence").first();
  const claim = ((await presence.textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
  const fresh = [hhmm(at), hhmm(new Date(at.getTime() - 60_000)), hhmm(new Date())].some((t) => claim.includes(t));
  ui.flowCheck(
    "G4",
    "back online: the page says Saved · time",
    /\bsaved\b/i.test(claim) && fresh && (await b.ui.editorState())?.editing !== true,
    { claim },
  );
  run.flowState.j9d = { reload, held: HELD, claim, attempts: tried.map(({ source, ...x }) => x) };
  await b.page.close({ runBeforeUnload: false });

  // Conflict variant: an outside write while the save is held.
  await ui.resetProject(FLOW.slug);
  tried.length = 0;
  const base2 = ui.fileState(FLOW.slug, FLOW.file);
  const c = await ui.openContext();
  await c.ui.openDiagram(FLOW.slug, FLOW.path);
  await c.ui.enterEdit();
  await c.ui.rename(FLOW.node, MINE);
  const person = await c.ui.captureEditor(FLOW.slug, c.ui);
  await ui.setOffline(true);
  await step("click Save (offline, conflict variant)", async () => {
    await clickSave(c.page);
    await expect(c.page.locator(".authoring-statusline")).toContainText(HELD, { timeout: 10_000 });
  });
  const other = base2.text.replace("b[API]", "b[API by agent]");
  await ui.agentWrite(FLOW.slug, FLOW.file, other);
  const diskBeforeSave = ui.fileState(FLOW.slug, FLOW.file).text;
  // The held save, sent on reconnecting, meets the agent's write: the refusal this variant seeds (errors.mjs). It can
  // land after the reconnect step has ended, so the reconnect runs inside the step that waits for the answer, and
  // that one step declares it (seen in r6b: the alert fell into the next step once in 3 runs).
  await step(
    "back online: the held save is answered",
    async () => {
      await ui.setOffline(false);
      await within(c.page, async () => tried.some((t) => t.status !== null), { timeout: 15_000 });
      await within(c.page, async () => (await c.page.locator(".authoring-conflict").count()) > 0, { timeout: 10_000 });
    },
    { expects: [{ kind: "alert", text: "Save is blocked" }] },
  );
  const answered = tried.filter((t) => t.status !== null);
  const editorSource = await c.ui.editorSource().catch(() => null);
  const verdict = g2Verdict({
    answer: answered.at(-1) ? { outcome: answered.at(-1).outcome } : null,
    sent: answered.length > 0,
    diskBeforeSave,
    diskAfterSave: ui.fileState(FLOW.slug, FLOW.file).text,
    otherWriter: other,
    personSource: person.text,
    editorSource,
  });
  const state = await c.ui.editorState();
  ui.flowCheck(
    "G2",
    "offline save, outside write meanwhile: refused, nothing overwritten, text kept",
    verdict.ok && answered.length === 1 && state?.conflict != null,
    {
      ...verdict,
      answers: answered.map(({ source, ...x }) => x),
      conflict: state?.conflict?.text ?? null,
      sentBase: answered[0]?.expectedSourceRevision ?? null,
      base: base2.revision,
    },
  );
  await c.page.close({ runBeforeUnload: false });

  // Lost-answer variant: connected, but the Save never reaches Archer.
  await ui.resetProject(FLOW.slug);
  tried.length = 0;
  const base3 = ui.fileState(FLOW.slug, FLOW.file);
  const reviewBefore3 = await ui.archerCall(FLOW.slug, "list_changes", {});
  const e = await e2eContext(ui);
  await e.ui.openDiagram(FLOW.slug, FLOW.path);
  await e.ui.enterEdit();
  await e.ui.rename(FLOW.node, LOST);
  const lostText = await e.ui.captureEditor(FLOW.slug, e.ui);
  let cut = 0;
  await e.page.route("**/api/authoring", (route) => {
    const r = route.request();
    if (cut === 0 && r.method() === "POST" && /"op":"document\.apply"/.test(r.postData() ?? "")) {
      cut++;
      return route.abort("connectionreset");
    }
    return route.fallback();
  });
  await step(
    "click Save (it never reaches Archer)",
    async () => {
      await clickSave(e.page);
      await within(e.page, async () => /Not saved|Not known/.test((await e.ui.editorState())?.status ?? ""), {
        timeout: 15_000,
      });
    },
    { leavesEditor: true },
  );
  const lostState = await e.ui.editorState();
  const lostPage = await e.page
    .locator("body")
    .innerText()
    .catch(() => "");
  const again = e.page.locator(".authoring-toolbar").getByRole("button", { name: "Save again", exact: true });
  ui.flowCheck(
    "G4",
    "save never received: the page says plainly that it is not known yet, never Not saved, and offers Save again",
    /Not known yet whether your change reached Archer/.test(lostState?.status ?? "") &&
      !/\bNot saved\b/.test(lostState?.status ?? "") &&
      (await again.isEnabled().catch(() => false)) &&
      !/durable operation|Retry explicitly|Check status|Failed to fetch/i.test(lostPage) &&
      ui.fileState(FLOW.slug, FLOW.file).revision === base3.revision,
    {
      status: lostState?.status ?? null,
      recovery: lostState?.recovery ?? null,
      jargon: (lostPage.match(/durable operation|Retry explicitly|Check status|Failed to fetch/i) ?? [null])[0],
    },
  );
  await step(
    "click Save again",
    async () => {
      await again.click();
      await within(e.page, async () => tried.filter((t) => t.status !== null).length > 0, { timeout: 15_000 });
      await within(e.page, async () => (await e.ui.editorState())?.editing === false, { timeout: 10_000 });
    },
    { leavesEditor: true },
  );
  const firstId = tried[0]?.operationId ?? null;
  const answered3 = tried.filter((t) => t.status !== null);
  const known3 = firstId
    ? ((await ui.serviceGet(`/p/${FLOW.slug}/api/authoring/operations/${firstId}`).catch(() => null))?.operation ??
      null)
    : null;
  const recorded3 = savesOf(await ui.archerCall(FLOW.slug, "list_changes", {})) - savesOf(reviewBefore3);
  ui.flowCheck(
    "G5",
    "save never received: Save again sends the same operation, saved once",
    tried.length === 2 &&
      tried[1].operationId === firstId &&
      answered3.length === 1 &&
      known3?.state === "terminal" &&
      known3?.outcome === "applied" &&
      recorded3 === 1 &&
      ui.fileState(FLOW.slug, FLOW.file).text === lostText.text,
    {
      attempts: tried.map(({ source, ...x }) => x),
      service: known3 ? { state: known3.state, outcome: known3.outcome } : null,
      recorded: recorded3,
    },
  );
  await e.page.close({ runBeforeUnload: false });

  // The kept-file variants first: a seeded fault that hides kept saves (hide-pending-copies) also stops the renamed
  // variant's "Bring them here", which would end the run before them.
  for (const variant of ["held", "held, file changed", "lost answer"])
    await keptNewTab({ ui, step, expect, tried, variant });
  for (const variant of ["reopened", "resumed offline"]) await offeredElsewhere({ ui, step, expect, tried, variant });
  for (const variant of ["deleted", "deleted, unsaved", "renamed"]) await gone({ ui, step, expect, tried, variant });
  await goneNewTab({ ui, step, expect, tried });
  await assertFlowChecks({ step, run, flow });
};
