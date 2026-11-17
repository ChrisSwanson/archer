// Shared pieces of the state-and-recovery journeys (J6–J9 of docs/quality/rubrics/user-flows.md §6). Each journey
// records its collector verdicts with ui.flowCheck (summary.flowState.checks) and ends with assertFlowChecks.
import { compareState, sha256 } from "../../harness/flows-state.mjs";

/** Owned by the performance rubric (request counts, duplicate attempts), not judged here (§1 ownership table). */
export const FLOW_INVARIANTS = {
  "duplicate-requests": {
    severity: "warn",
    reason: "performance-owned (performance.md S3/S4); known: api/comments read 3x per load",
  },
  "requests-per-view": { severity: "warn", reason: "performance-owned (performance.md S3)" },
};
/** A journey that disconnects on purpose: the browser's own failed requests and refused connections are the point. */
export const DISCONNECT_INVARIANTS = {
  ...FLOW_INVARIANTS,
  "console-errors": {
    severity: "warn",
    reason: "deliberate disconnection: ERR_INTERNET_DISCONNECTED / ERR_CONNECTION_REFUSED lines",
  },
  "failed-requests": { severity: "warn", reason: "deliberate disconnection or a dropped response" },
  "http-errors": { severity: "warn", reason: "a restarting service answers 503 project_loading for a moment" },
  warnings: {
    severity: "warn",
    reason: "a restart or disconnection logs svc./ui. warnings by design; G1/G4/G5 judge the outcome",
  },
};

/** J6–J9 edit target: `journeys/diagrams/flow.mmd` (`a[Client] --> b[API]`). */
export const FLOW = {
  slug: "journeys",
  path: "diagrams/flow.mmd",
  file: ".archer/diagrams/flow.mmd",
  node: "a",
  from: "Client",
};
/** J8 target: `checkout`, the Customer participant. */
export const CHECKOUT = {
  slug: "pageturner",
  path: "diagrams/checkout.mmd",
  file: ".archer/diagrams/checkout.mmd",
  target: "view:checkout",
  anchorId: "customer",
};

/** The lines that differ between two texts (same line count assumed; otherwise every line from the first change). */
export function changedLines(before, after) {
  const a = before.split("\n"),
    b = after.split("\n"),
    out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if (a[i] !== b[i]) out.push({ line: i + 1, before: a[i] ?? null, after: b[i] ?? null });
  return out;
}

/** J6's outcome: exactly one line changed, and it is the renamed node's label (quoting allowed). */
export function onlyLabelChanged(before, after, { node, from, to }) {
  const lines = changedLines(before, after);
  const one = lines.length === 1 ? lines[0] : null;
  const ok =
    one?.before.includes(`${node}[${from}]`) &&
    one.before.replace(`${node}[${from}]`, `${node}[${to}]`) ===
      one.after.replace(`${node}["${to}"]`, `${node}[${to}]`);
  return { ok, lines };
}

/**
 * G1 at one promise boundary for the editor: compare what was captured before it with what the restored editor
 * holds after it, and check the file on disk was not changed by crossing it. Records the verdict; returns it.
 */
export async function g1Editor(ui, boundary, captured, { slug = FLOW.slug, file = FLOW.file, diskBefore } = {}) {
  const readBack = await ui.captureEditor(slug, ui);
  const diffs = compareState(captured, {
    ...readBack,
    target: { ...readBack.target, draftId: captured.target.draftId === null ? null : readBack.target.draftId },
  });
  const disk = ui.fileState(slug, file);
  const problems = diffs.map((d) => `${d.field} differs`);
  if (diskBefore !== undefined && disk.revision !== diskBefore)
    problems.push("the file on disk changed across the boundary");
  ui.flowCheck("G1", boundary, problems.length === 0, {
    captured: summarise(captured),
    readBack: summarise(readBack),
    diffs,
    problems,
  });
  return { readBack, problems };
}

/**
 * G1 for a comment being composed: text, anchor, target and base revision read back after the boundary, from the
 * page and the draft it keeps (ui.captureComment observes all of them; none is supplied).
 */
export async function g1Comment(ui, boundary, captured) {
  const readBack = await ui.captureComment();
  const diffs = compareState(captured, readBack);
  ui.flowCheck("G1", boundary, diffs.length === 0, {
    captured,
    readBack,
    diffs,
    problems: diffs.map((d) => `${d.field} differs`),
  });
  return readBack;
}

const summarise = (s) =>
  s && {
    ...s,
    text:
      s.text === null
        ? null
        : { sha: sha256(s.text ?? ""), length: (s.text ?? "").length, head: (s.text ?? "").slice(0, 120) },
  };

/** Select mode → click the participant → `c` → type: the comment composer open on it with `text`. */
export async function composeComment({ page, step, expect }, text, { anchorId = CHECKOUT.anchorId, typeExpects } = {}) {
  const box = page.getByRole("textbox", { name: "Comment", exact: true });
  await step("click Select mode", () => page.getByRole("button", { name: "Select mode", exact: true }).click(), {
    selectionMayChange: true,
  });
  await step(
    `click participant ${anchorId}`,
    () => page.locator(`g.archer-seq-participant[data-seq-id="${anchorId}"]`).first().click(),
    { selectionMayChange: true },
  );
  await step("press c", async () => {
    await page.keyboard.press("c");
    await expect(box).toBeVisible();
  });
  await step("type the comment", () => box.fill(text), typeExpects ? { expects: typeExpects } : {}); // typeExpects: what a seeded fault makes typing say (errors.mjs)
  return box;
}

/**
 * The page's saved claim after the editor closes (J6's reading): the presence line "Saved · HH:MM" in the person's
 * voice, at this minute or the one before, visible. `{ saidSaved, claim, voice }`; claim null when no presence line shows.
 */
export async function savedClaim(page, { wait = 10_000 } = {}) {
  const presence = page.locator(".archer-presence").first();
  await presence.waitFor({ state: "visible", timeout: wait }).catch(() => {});
  // Shown, not merely in the document: a hidden line says nothing to the person (the seeded fault hide-saved-claim).
  if ((await presence.count()) === 0 || !(await presence.isVisible()))
    return { saidSaved: false, claim: null, voice: null };
  const claim = ((await presence.textContent()) ?? "").replace(/\s+/g, " ").trim();
  const voice = await presence.getAttribute("data-voice");
  const now = new Date(),
    hhmm = (d) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  const fresh = [hhmm(now), hhmm(new Date(now.getTime() - 60_000))].some((t) => claim.includes(t));
  return { saidSaved: /\bsaved\b/i.test(claim) && voice === "you" && fresh, claim, voice };
}

/** Add comment (and in `queued` mode Send queued); returns once the click has been made. */
export const addComment = ({ page, step }, title = "click Add comment") =>
  step(title, () => page.getByRole("button", { name: "Add comment", exact: true }).click());

/** The mode the sandbox was started with (sandbox.mjs up --comment-submission). */
export const submissionMode = (sandbox) => sandbox.commentSubmission ?? "immediate";

/**
 * Wait (bounded by the harness assertion timeout, 10 s per U5: a tool limit, not a target) for a condition; returns
 * the last value. Used for "the indicator is present", never as a sleep.
 */
export async function within(page, fn, { timeout = 10_000, interval = 200 } = {}) {
  const until = Date.now() + timeout;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > until) return last;
    await page.waitForTimeout(interval);
  }
}

/** Count the main frame's navigations from now on (unrequested reloads, §5). */
export function navigationCounter(page) {
  let n = 0;
  const on = (f) => {
    if (f === page.mainFrame()) n++;
  };
  page.on("framenavigated", on);
  return {
    get count() {
      return n;
    },
    reset() {
      n = 0;
    },
    stop() {
      page.off("framenavigated", on);
    },
  };
}

/** Every POST /api/authoring answer this page gets: {op, request, status, body}. `applies()` keeps the Saves. */
export function trackAuthoring(page) {
  const list = [];
  page.on("response", async (r) => {
    if (r.request().method() !== "POST" || !/\/api\/authoring$/.test(r.url())) return;
    let request = null;
    try {
      request = JSON.parse(r.request().postData() ?? "null");
    } catch {
      /* not JSON */
    }
    list.push({ op: request?.op ?? null, request, status: r.status(), body: await r.json().catch(() => null) });
  });
  return {
    list,
    applies: () => list.filter((x) => x.op === "document.apply"),
    clear: () => {
      list.length = 0;
    },
  };
}

/** The editor's Save button, clicked as a person does (not ui.save, which expects the editor to close). */
export const clickSave = (page) =>
  page.locator(".authoring-toolbar").getByRole("button", { name: "Save", exact: true }).click();

/** Wait until `n` Save answers have arrived on `tracker` (bounded). */
export async function savesAnswered(page, tracker, n = 1, timeout = 15_000) {
  return within(page, () => tracker.applies().length >= n, { timeout });
}

/**
 * A tab's sessionStorage, read before it is closed: Ctrl+Shift+T gives a reopened tab its session back, and with it
 * the tab's owner id (draft-tabs.ts, O117), so the reopened tab restores its own drafts. Playwright cannot reopen a
 * closed tab; `reopenTab` opens a new one with that session, as the browser does.
 */
export const sessionOf = (page) =>
  page.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(sessionStorage)))).catch(() => "{}");
export async function reopenTab(ui, session) {
  const r = await ui.openContext();
  await r.page.addInitScript((s) => {
    try {
      if (sessionStorage.getItem("archer.flows.reopened") === null) {
        for (const [k, v] of Object.entries(JSON.parse(s))) sessionStorage.setItem(k, v);
        sessionStorage.setItem("archer.flows.reopened", "1");
      }
    } catch {
      /* blocked */
    }
  }, session);
  return r;
}
