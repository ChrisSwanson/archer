// The G3 effect matrix behind tools/devkit/security/authority-matrix.mjs (security rubric §1 authority
// model and matrix, G3, G6; probes P1 and P10). The route inventory (inventory-model.mjs) proves who is
// ADMITTED to each HTTP row; this matrix proves what each admitted or refused request DID. Every write
// surface — the HTTP writers and the management plane's three doors (`archer call`, `archer mcp`, the
// raw socket) — is crossed with each credential column, `edit` on/off, the account write rule
// allow/deny and a path class, and every cell is judged on its effect: an admitted cell must have
// changed its target (a positive control: the file's hash changed, or the grant works), a refused cell
// must have changed nothing (a negative control), and no cell may touch the canary outside the project.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { AGENT_FORGET_MS } from "../../../ts/src/agents/listeners.ts";
import { AGENT_WRITE_WINDOW_MS } from "../../../ts/src/service/protocol.ts";

export const WRITE_RULES = ["diagrams", "notes", "comments", "emphasis", "register", "manifest"];
export const HTTP_COLUMNS = [
  "none",
  "grant-cookie",
  "grant-bearer",
  "owner-path",
  "owner-cookie",
  "owner-bearer",
  "revoked-cookie",
  "revoked-bearer",
];
export const TRANSPORTS = ["cli", "mcp"];

/**
 * The policy settings; each switch is a file edit with no restart, so every phase also shows the policy is read fresh.
 * The first four flip every rule together. The `deny:<rule>` phases deny ONE rule and allow the rest, so each
 * AND-ed rule pair (ADR 0028: `register` ∧ `manifest` for register_diagram; `comments`/`emphasis` ∧ `notes` when
 * a comment or highlight pins an embedded diagram's name) is seen with each side denied alone. They run only
 * the rows that check the denied rule (`scope`), since every other row is unchanged from edit-on+allow.
 */
export const PHASES = [
  { id: "edit-on+allow", edit: true, rules: "allow" },
  { id: "edit-on+deny", edit: true, rules: "deny" },
  { id: "edit-off+allow", edit: false, rules: "allow" },
  { id: "edit-off+deny", edit: false, rules: "deny" },
  ...["register", "manifest", "notes", "comments", "emphasis", "diagrams"].map((rule) => ({
    id: `edit-on+deny:${rule}`,
    edit: true,
    rules: [rule],
    scope: [rule],
  })),
];

/** The rules a phase denies (all six under "deny"; one under `deny:<rule>`). */
export function deniedRules(phase) {
  return phase.rules === "deny" ? [...WRITE_RULES] : phase.rules === "allow" ? [] : [...phase.rules];
}

/**
 * Whether a phase's rules refuse a row that checks `rules`: any one of them denied. `register` is also
 * denied whenever `manifest` is (ADR 0013: "`register` also needs `manifest`").
 */
export function ruleDenies(rules, phase) {
  const denied = new Set(deniedRules(phase));
  if (denied.has("manifest")) denied.add("register");
  return rules.some((rule) => denied.has(rule));
}

/**
 * Whether a phase runs a row: the four full phases run every row; a `deny:<rule>` phase only rows that check that
 * rule, or whose bookkeeping falls under it (`row.touches`: a delivery's read mark is a `comments` write).
 */
export function phaseRuns(phase, row) {
  return (
    phase.scope === undefined ||
    [...(row.rules ?? []), ...(row.touches ?? [])].some(
      (rule) => phase.scope.includes(rule) || (phase.scope.includes("manifest") && rule === "register"),
    )
  );
}

// ------------------------------------------------------------------ the fixture

export const FIXTURE_NAME = "E-G3 matrix";
const FLOW = "flowchart LR\n  a[Client] e1@--> b[API]\n";
/** The corpus project (copied by `sandbox.mjs up --corpus`; corpus copies carry no links, so links are made after). */
export const FIXTURE_FILES = {
  "archer.toml": `version = 1\nname = "${FIXTURE_NAME}"\nfolder = ".archer"\n\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "Flow"\nsource = ".archer/diagrams/flow.mmd"\n`,
  ".archer/diagrams/flow.mmd": FLOW,
  ".archer/diagrams/loose.mmd": "flowchart LR\n  c[Loose] e1@--> d[Thing]\n",
  ".archer/notes/note.md":
    "# Note\n\nA passage about tokens.\n\n```mermaid\n%% archer-id: pinned\nflowchart LR\n  a[A] e1@--> b[B]\n```\n",
  "README.md": "# Readme\n\nOutside the Archer folder.\n",
  "docs/outside.mmd": "flowchart LR\n  x[Outside] e1@--> y[Folder]\n",
};
/** Outside the project (the sandbox root's canary/): no cell may change a byte here (G6). */
export const CANARY_FILES = {
  "sym.mmd": "flowchart LR\n  k[Canary] e1@--> z[Symlinked]\n",
  "hard.mmd": "flowchart LR\n  k[Canary] e1@--> z[Hardlinked]\n",
  "note.md": "# Canary note\n\nA passage about tokens.\n",
  "comments.json": '{"canary":true}\n',
};
/** Links made in the project after `up`: [kind, path in the project, canary file or dir]. */
export const LINKS = [
  ["symlink", ".archer/diagrams/linked.mmd", "sym.mmd"],
  ["hardlink", ".archer/diagrams/hard.mmd", "hard.mmd"],
  ["symlink", ".archer/diagrams/linkdir", "."],
  ["symlink", ".archer/diagrams/loose.comments.json", "comments.json"],
  ["symlink", ".archer/notes/linked.md", "note.md"],
];

// ------------------------------------------------------------------ snapshots

const VOLATILE_STATE = /^(cache\/|archer\.sock$|archer\.lock$|service\.json$)/;

/**
 * Every file under each `[prefix, dir]`, as `prefix:relative path` → content hash (a link hashes its
 * target text, never what it points at). `.git` is skipped; volatile state files (caches, the socket,
 * the lock) are skipped under `state`.
 */
export function snapshot(dirs) {
  const out = {};
  for (const [prefix, dir, only] of dirs) {
    const walk = (path) => {
      let entries;
      try {
        entries = readdirSync(path, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(path, entry.name),
          rel = relative(dir, full);
        if (entry.name === ".git" || (prefix === "state" && VOLATILE_STATE.test(rel))) continue;
        if (only !== undefined && !only.includes(rel)) continue;
        let stat;
        try {
          stat = lstatSync(full);
        } catch {
          continue;
        }
        if (stat.isSymbolicLink()) out[`${prefix}:${rel}`] = `link:${readlinkSync(full)}`;
        else if (stat.isDirectory()) walk(full);
        else if (stat.isFile()) {
          try {
            out[`${prefix}:${rel}`] = `${stat.nlink}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`;
          } catch {
            /* raced */
          }
        }
      }
    };
    walk(dir);
  }
  return out;
}

/** The paths whose hash differs between two snapshots (added, removed or changed). */
export function changedPaths(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => before[key] !== after[key]).sort();
}

// ------------------------------------------------------------------ expectations

/**
 * The §1 matrix for an HTTP write cell. `row.capability`:
 *   comment    comment or note highlight: every admitted credential ("Comment: per the account rule"); edit-independent
 *   edit       content edit (apply, publish, layout): a cookie grant or the owner's cookie, while `edit` is on
 *   lifecycle  archive/show (decision D1: follows the edit switch). As built (http.ts): any Bearer
 *              gets a bare 404 before anything else; a cookie archives while `edit` is on. No write rule applies (it is service state, not a project file).
 *   settings   account or project configuration: refused for every browser credential (ADR 0028 `settings_read_only`)
 *   person     a person's state change with no write rule (selection, walkthrough position): every admitted credential
 *   owner      the person on this computer only (listener pin and Launch, http.ts `person_only`): the owner's cookie
 * A column the matrix gives no form on the data plane (the service token as Bearer) is a refusal, and so is the
 * service token in the path (`owner-path`): retired in 0.15.0, it is no credential, kept as a regression probe.
 * Returns "admit" or "refuse"; there is no "observed" cell: every cell carries an expectation.
 */
export function expectedHttp(row, column, phase) {
  if (["none", "revoked-cookie", "revoked-bearer", "owner-bearer", "owner-path"].includes(column)) return "refuse";
  const cookie = column === "grant-cookie" || column === "owner-cookie";
  if (row.capability === "edit") {
    if (!cookie || !phase.edit) return "refuse";
  } else if (row.capability === "lifecycle") {
    if (column === "grant-bearer" || !phase.edit) return "refuse";
  } else if (row.capability === "settings") return "refuse";
  else if (row.capability === "owner") {
    if (column !== "owner-cookie") return "refuse";
  } else if (row.capability !== "comment" && row.capability !== "person")
    throw new Error(`no §1 expectation for capability ${row.capability}`);
  if (ruleDenies(row.rules, phase)) return "refuse";
  return row.path;
}

/** The refusal code a cell must answer, where the built behaviour fixes one (a Bearer on archive/show: a bare 404). */
export function expectedHttpCode(row, column, expected) {
  if (expected !== "refuse") return undefined;
  if (["none", "revoked-cookie", "revoked-bearer", "owner-bearer", "owner-path"].includes(column)) return "bare_404"; // refused at admission (browser-access.ts)
  if (row.capability === "lifecycle" && column === "grant-bearer") return "bare_404";
  if (row.capability === "settings") return "settings_read_only";
  if (row.capability === "owner" && column.startsWith("grant-")) return "person_only";
  return row.refusalCode?.(column);
}

/**
 * The §1 "Socket (same OS account)" row for a management cell: everything, "subject to the write rules"
 * and confinement (G6), and never the person's edit switch (ADR 0028: agents keep writing with edit off).
 * Grant and state operations follow no write rule. A capability that needs the person's own yes
 * (`row.capability === "person"`) is refused without it.
 */
export function expectedManagement(row, phase) {
  if (row.capability === "person") return "refuse";
  if (ruleDenies(row.rules, phase)) return "refuse";
  return row.path;
}

// ------------------------------------------------------------------ verdicts

/**
 * A cell's verdict from its expectation and what it did. `observed` = {admitted, changed (paths, every
 * prefix: project, canary, config AND state), positive (the row's own effect check held), negative (the
 * row's own no-effect check held), code}; `allowed` = project path prefixes an admitted row may change;
 * `options.refusalState` = state path prefixes a refusal of this row may still change (an explicit,
 * per-row allow-list; empty by default); `options.code` = the refusal code the cell must answer. Mismatch kinds:
 *   over-admit           refusal expected, the request was admitted
 *   refused-with-effect  answered as refused but something changed (any project, config or service-state
 *                        path not on the row's refusal allow-list), or the effect check saw a change
 *   wrong-refusal        refused, but not with the code the built behaviour fixes
 *   under-admit          admission expected, the request was refused
 *   no-effect            admitted but the positive control failed (nothing the row should change changed);
 *                        required of EVERY admission: no cell passes a positive on its status alone
 *   stray-effect         a project path outside the row's allowed set changed
 *   canary-changed       a byte outside the project changed (G6)
 */
export function judge(expected, observed, allowed, options = {}) {
  const { refusalState = [], code } = options;
  const mismatches = [];
  const projectChanges = observed.changed.filter((path) => path.startsWith("project:") || path.startsWith("config:"));
  const refusalChanges = observed.changed.filter(
    (path) => !(path.startsWith("state:") && refusalState.some((prefix) => path.startsWith(`state:${prefix}`))),
  );
  if (observed.changed.some((path) => path.startsWith("canary:"))) mismatches.push("canary-changed");
  if (projectChanges.some((path) => !allowed.some((prefix) => path.startsWith(prefix))))
    mismatches.push("stray-effect");
  const noEffect = refusalChanges.length === 0 && observed.negative !== false;
  if (expected === "admit") {
    if (!observed.admitted) mismatches.push("under-admit");
    else if (!observed.positive) mismatches.push("no-effect");
  } else if (expected === "refuse") {
    if (observed.admitted) mismatches.push("over-admit");
    else {
      if (!noEffect) mismatches.push("refused-with-effect");
      if (code !== undefined && observed.code !== code) mismatches.push("wrong-refusal");
    }
  } else throw new Error(`a cell needs an expectation (admit or refuse), not ${JSON.stringify(expected)}`);
  const verdict = mismatches.length > 0 ? "mismatch" : "pass";
  const control = !observed.admitted ? (noEffect ? "negative" : "none") : observed.positive ? "positive" : "none";
  return { verdict, mismatches, control };
}

/** A project's restart-continuity file in the state directory (ts/src/state/continuity.ts). */
export const CONTINUITY = /^state:runtime\/[^/]+\.continuity\.json$/;
export const LISTENERS = "state:listeners.json";

/** Canonical JSON (keys sorted at every level), so two records compare by content, not key order. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const parsed = (text) => {
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};
const validWindow = (w) => w !== undefined && Number.isFinite(w.start) && Number.isFinite(w.end) && w.start <= w.end;

/**
 * Whether a continuity file's change is one a refusal may make: announcements that really expired dropping
 * out. The product keeps an agent-write announcement for AGENT_WRITE_WINDOW_MS (5 s; service/protocol.ts,
 * project-state.ts #persistContinuity) and drops it at the next rewrite once it is older. `window` = {start,
 * end}: the cell's own clock, captured just before its before-snapshot and just after its after-read; a rewrite
 * in between happened at some t in [start, end]. So, with every other field (version, root, files and any
 * other key) identical:
 *   - no announcement is added or changed (after ⊆ before, each byte-identical);
 *   - each one removed had expired by the window's end: at + windowMs < end;
 *   - each one kept was still fresh at the window's start: at + windowMs ≥ start (a rewrite in the window
 *     would have dropped an older one).
 * Without a window nothing can be shown to have expired: false. False when nothing changed.
 */
export function continuityAgedOnly(beforeText, afterText, window, windowMs = AGENT_WRITE_WINDOW_MS) {
  if (beforeText === afterText || !validWindow(window)) return false;
  const before = parsed(beforeText),
    after = parsed(afterText);
  if (before === null || after === null || !Array.isArray(before.writes) || !Array.isArray(after.writes)) return false;
  const { writes: _b, ...restBefore } = before,
    { writes: _a, ...restAfter } = after;
  if (canonical(restBefore) !== canonical(restAfter)) return false;
  const had = new Map(before.writes.map((w) => [canonical(w), w]));
  if (after.writes.some((w) => !had.has(canonical(w)))) return false;
  const kept = new Set(after.writes.map(canonical));
  for (const [key, w] of had) {
    if (!Number.isSafeInteger(w?.at)) return false;
    if (kept.has(key) ? w.at + windowMs < window.start : !(w.at + windowMs < window.end)) return false;
  }
  return true;
}

/**
 * Whether the listener registry (`state:listeners.json`) changed only by agent housekeeping a refusal may
 * overlap (agents/listeners.ts). `window` = {start, end} as for continuityAgedOnly. Every key but `agents`
 * (pins, claims, thread owners, delivery records, launch markers) must be identical, and:
 *   - no agent is added, and a kept agent differs at most in `lastActive`, which may only move forward and
 *     never past the window's end (a heartbeat or a save of the live clock; never backdated or future-dated);
 *   - an agent is removed only as the product forgets one (#forget): holding no claim, and silent for more
 *     than AGENT_FORGET_MS (1 h) by the window's end.
 * Without a window: false. False when nothing changed.
 */
export function listenersHousekeepingOnly(beforeText, afterText, window, forgetMs = AGENT_FORGET_MS) {
  if (beforeText === afterText || !validWindow(window)) return false;
  const before = parsed(beforeText),
    after = parsed(afterText);
  if (before === null || after === null) return false;
  const { agents: agentsBefore = [], ...restBefore } = before,
    { agents: agentsAfter = [], ...restAfter } = after;
  if (!Array.isArray(agentsBefore) || !Array.isArray(agentsAfter) || canonical(restBefore) !== canonical(restAfter))
    return false;
  const time = (iso) => (typeof iso === "string" ? Date.parse(iso) : NaN);
  const known = new Map(agentsBefore.map((a) => [a?.agentId, a]));
  if (known.size !== agentsBefore.length) return false;
  const held = new Set(Object.values(before.claims ?? {}).map((c) => (typeof c === "string" ? c : c?.agentId)));
  const seen = new Set();
  for (const a of agentsAfter) {
    const was = known.get(a?.agentId);
    if (was === undefined || seen.has(a.agentId)) return false;
    seen.add(a.agentId);
    if (canonical({ ...was, lastActive: 0 }) !== canonical({ ...a, lastActive: 0 })) return false;
    if (a.lastActive !== was.lastActive) {
      const from = time(was.lastActive),
        to = time(a.lastActive);
      if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from) || to > window.end) return false;
    }
  }
  for (const [id, was] of known) {
    if (seen.has(id)) continue;
    const last = time(was.lastActive);
    if (held.has(id) || !Number.isFinite(last) || !(window.end - last > forgetMs)) return false;
  }
  return true;
}

/** The class a cell is counted under: surface/door, column, edit, rule, path class, capability. */
export function cellClass(cell) {
  return [cell.surface, cell.column, cell.phase, cell.pathClass, cell.capability].join(" | ");
}

// ------------------------------------------------------------------ X-21: a prepare the service has consumed

/** A file the document catalog may list (project/discovery.ts: Markdown and Mermaid), so the continuity baseline follows it. */
const DOCUMENT = /\.(md|mmd)$/;

/**
 * X-21 (codex-rescore6): filesystem silence is not a finished reload. A document the tool wrote or removed (a prepare,
 * or the cell before) is consumed once the project's persisted continuity baseline (`files.entries`, written by the
 * reload's last phase, project-state.ts #announceDocuments → #persistContinuity, after its views and recovery record
 * are committed) agrees with the disk: a removed document is gone from it, a written one is there at the disk's
 * revision. `touched`: `project:` paths changed since the last consumed point; `disk`: a project snapshot now;
 * `continuityText`: the project's continuity file (null when there is none); `root`: the project root it must name.
 * Returns what is still pending, each { path, reason } (project paths only, no content).
 */
export function unconsumed(touched, disk, continuityText, root) {
  const docs = touched.filter(
    (p) => p.startsWith("project:") && DOCUMENT.test(p) && !String(disk[p] ?? "").startsWith("link:"),
  );
  if (docs.length === 0) return [];
  const record = continuityText == null ? null : parsed(continuityText);
  if (record === null || record.root !== root || !Array.isArray(record.files?.entries))
    return docs.map((path) => ({ path, reason: "no continuity baseline for the project yet" }));
  const entries = new Map(record.files.entries.map((e) => [`project:${e.path}`, e.revision]));
  const pending = [];
  for (const path of docs) {
    const now = disk[path];
    if (now === undefined) {
      if (entries.has(path)) pending.push({ path, reason: "removed, still in the baseline" });
      continue;
    }
    const revision = `sha256:${now.slice(now.indexOf(":") + 1)}`;
    if (!entries.has(path)) pending.push({ path, reason: "written, not in the baseline yet" });
    else if (entries.get(path) !== revision) pending.push({ path, reason: "the baseline holds another revision" });
  }
  return pending;
}

/**
 * The before-barrier (X-21): waits until every document change in `touched` is consumed (`unconsumed`), then until
 * nothing changes for the quiet period (`quiet`), and checks the consumption again on what the quiet barrier returned,
 * all within `capMs`. `read()` → { disk, continuity, root }. Returns { consumed: true, before, pendingAtStart, waitedMs } or, when the
 * service did not consume in time, { consumed: false, pending, waitedMs }: the caller scores that cell NOT EVALUATED,
 * never pass. `before` is the snapshot `quiet` returned.
 */
export async function consumedBarrier(touched, { read, quiet, sleep, capMs = 15_000, sampleMs = 100, now = Date.now }) {
  const started = now();
  const check = (disk) => {
    const r = read();
    return unconsumed(touched, disk ?? r.disk, r.continuity, r.root);
  };
  let pendingAtStart;
  for (;;) {
    let pending = check();
    pendingAtStart ??= pending.length;
    while (pending.length > 0) {
      if (now() - started >= capMs) return { consumed: false, pending, pendingAtStart, waitedMs: now() - started };
      await sleep(sampleMs);
      pending = check();
    }
    const before = await quiet();
    pending = check(before);
    if (pending.length === 0) return { consumed: true, before, pendingAtStart, waitedMs: now() - started };
    if (now() - started >= capMs) return { consumed: false, pending, pendingAtStart, waitedMs: now() - started };
  }
}

/**
 * A credential-free account of a recovery record's change (state/account.ts RecoveryRecord, `runtime/<key>.json`):
 * which top-level fields changed; the views added, removed or at another revision (ids only); caption and last-change
 * ids added, removed or changed (with who changed it); the presented and selected view ids; how many emphases. No
 * caption, summary, title or digest text.
 */
export function recoveryDiff(beforeText, afterText) {
  const a = beforeText == null ? null : parsed(beforeText),
    b = afterText == null ? null : parsed(afterText);
  const keys = [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])]
    .filter((k) => canonical(a?.[k]) !== canonical(b?.[k]))
    .sort();
  const byId = (list, value) =>
    new Map(
      (Array.isArray(list) ? list : []).map((item) =>
        Array.isArray(item) ? [item[0], canonical(value(item[1]))] : [item?.id, canonical(value(item))],
      ),
    );
  const delta = (x, y) => ({
    added: [...y.keys()].filter((k) => !x.has(k)),
    removed: [...x.keys()].filter((k) => !y.has(k)),
    changed: [...y.keys()].filter((k) => x.has(k) && x.get(k) !== y.get(k)),
  });
  const views = delta(
    byId(a?.views, (v) => [v?.path, v?.kind, v?.revision]),
    byId(b?.views, (v) => [v?.path, v?.kind, v?.revision]),
  );
  const changes = (r) => byId(r?.lastChange, (c) => [c?.at, c?.by, c?.summary]);
  return {
    existedBefore: a !== null,
    existsAfter: b !== null,
    fieldsChanged: keys,
    viewsAdded: views.added,
    viewsRemoved: views.removed,
    viewsRevised: views.changed,
    captions: delta(
      byId(a?.captions, (c) => [c?.at, c?.caption]),
      byId(b?.captions, (c) => [c?.at, c?.caption]),
    ),
    lastChange: {
      ...delta(changes(a), changes(b)),
      byAfter: Object.fromEntries(
        (Array.isArray(b?.lastChange) ? b.lastChange : []).map(([id, c]) => [id, c?.by ?? null]),
      ),
    },
    presentedBefore: a?.presentation?.viewId ?? null,
    presentedAfter: b?.presentation?.viewId ?? null,
    selectedBefore: a?.selection?.viewId ?? null,
    selectedAfter: b?.selection?.viewId ?? null,
    emphasesBefore: Array.isArray(a?.emphases) ? a.emphases.length : null,
    emphasesAfter: Array.isArray(b?.emphases) ? b.emphases.length : null,
  };
}

/** Counts per cell class and per dimension, and every mismatch. `notEvaluated` = rows that did not run, each with its reason. */
export function summarise(cells, notEvaluated = []) {
  const count = (key) => {
    const table = {};
    for (const cell of cells) {
      const k = key(cell);
      table[k] ??= {
        cells: 0,
        pass: 0,
        mismatch: 0,
        notEvaluated: 0,
        admitted: 0,
        refused: 0,
        positive: 0,
        negative: 0,
      };
      const t = table[k];
      t.cells++;
      t[cell.verdict === "not-evaluated" ? "notEvaluated" : cell.verdict]++;
      t[cell.admitted ? "admitted" : "refused"]++;
      if (cell.control === "positive") t.positive++;
      if (cell.control === "negative") t.negative++;
    }
    return table;
  };
  const totals = count(() => "all").all ?? {
    cells: 0,
    pass: 0,
    mismatch: 0,
    notEvaluated: 0,
    admitted: 0,
    refused: 0,
    positive: 0,
    negative: 0,
  };
  return {
    // notEvaluatedCells: cells whose prepare the service did not consume in time (X-21), never a pass; notEvaluated: rows that did not run.
    totals: {
      ...totals,
      notEvaluatedCells: totals.notEvaluated,
      notEvaluated: notEvaluated.length,
      refusalsWithAllowedStateChange: cells.filter((cell) => !cell.admitted && cell.refusalStateAllowed?.length > 0)
        .length,
      knownProductDefects: cells.filter((cell) => cell.verdict === "mismatch" && cell.knownDefect).length,
      unexpectedMismatches: cells.filter((cell) => cell.verdict === "mismatch" && !cell.knownDefect).length,
    },
    allowedRefusalStateChanges: count((cell) =>
      !cell.admitted && cell.refusalStateAllowed?.length > 0
        ? `${cell.surface} ${cell.row}: ${cell.refusalStateAllowed.map((p) => p.replace(/[0-9a-f]{16,}/g, "<key>")).join(" ")}`
        : "none",
    ),
    bySurface: count((cell) => cell.surface),
    byColumn: count((cell) => `${cell.surface.startsWith("http") ? "http" : "management"} ${cell.column}`),
    byPhase: count((cell) => cell.phase),
    byPathClass: count((cell) => cell.pathClass),
    byExpected: count((cell) => cell.expected),
    byRow: count((cell) => `${cell.surface} ${cell.row}`),
    byClass: count(cellClass),
    mismatches: cells.filter((cell) => cell.verdict === "mismatch"),
    notEvaluatedCells: cells.filter((cell) => cell.verdict === "not-evaluated"),
    knownProductDefects: count((cell) => (cell.verdict === "mismatch" && cell.knownDefect ? cell.knownDefect : "none")),
  };
}

/** The readable report. */
export function markdown(report) {
  const { meta, summary } = report;
  const table = (title, rows) => {
    const lines = [
      `## ${title}`,
      "",
      "| class | cells | pass | mismatch | not evaluated | admitted | refused | positive controls | negative controls |",
      "|---|---|---|---|---|---|---|---|---|",
    ];
    for (const [key, t] of Object.entries(rows).sort(([a], [b]) => a.localeCompare(b)))
      lines.push(
        `| ${key} | ${t.cells} | ${t.pass} | ${t.mismatch} | ${t.notEvaluated ?? 0} | ${t.admitted} | ${t.refused} | ${t.positive} | ${t.negative} |`,
      );
    return [...lines, ""];
  };
  const t = summary.totals;
  const lines = [
    `# G3 authority matrix — ${meta.commit}`,
    "",
    `Generated ${meta.at} against sandbox \`${meta.sandbox}\` (${meta.transport}). Rubric: ${meta.rubric}.${meta.seed ? ` **Seeded: ${meta.seed}.**` : ""}`,
    "",
    `**${t.cells} cells: ${t.pass} pass, ${t.mismatch} mismatches (${t.knownProductDefects ?? 0} of them known product defects, below; ${t.unexpectedMismatches ?? t.mismatch} unexpected); ${t.notEvaluatedCells ?? 0} cells and ${t.notEvaluated} rows NOT EVALUATED (below, each with its reason).** ${t.positive} positive effect controls (admitted, target changed or grant works), ${t.negative} negative controls (refused, nothing changed in the project, the account config or the service state).`,
    "",
    "Dimensions: HTTP writers × 8 credential columns; management writers × {`archer call`, `archer mcp`} and the raw socket; every cell × `edit` {on, off} × account write rule {allow, deny, each rule denied alone} × path class. The canary outside the project is hashed in every cell.",
    "",
    "## Mismatches",
    "",
  ];
  if (summary.mismatches.length === 0) lines.push("None.", "");
  else {
    lines.push(
      "| surface | row | column | phase | path class | expected | answer | mismatch | known product defect | changed |",
      "|---|---|---|---|---|---|---|---|---|---|",
    );
    for (const m of summary.mismatches)
      lines.push(
        `| ${m.surface} | ${m.row} | ${m.column} | ${m.phase} | ${m.pathClass} | ${m.expected} | ${m.admitted ? "admitted" : "refused"} ${m.status ?? ""} ${m.code ?? ""} | ${m.mismatches.join(", ")} | ${m.knownDefect ?? "—"} | ${m.changed.join(" ") || "—"} |`,
      );
    lines.push("");
  }
  lines.push(
    ...table("By surface (door)", summary.bySurface),
    ...table("By credential column", summary.byColumn),
    ...table("By phase (edit × write rule)", summary.byPhase),
    ...table("By path class", summary.byPathClass),
    ...table("By expectation", summary.byExpected),
    ...table("By row", summary.byRow),
    ...table(
      "Refusals whose only state change is on the allow-list (content-checked: announcement aging, a refused write's own pre-write announcement, agent housekeeping)",
      summary.allowedRefusalStateChanges ?? {},
    ),
    ...table("By cell class (surface | column | phase | path class | capability)", summary.byClass),
  );
  if (report.knownProductDefects?.length)
    lines.push(
      "## Known product defects (reproduced here; reported, not fixed, and never counted as pass)",
      "",
      ...report.knownProductDefects.map((d) => `- **${d.id}**: ${d.what}`),
      "",
    );
  if (summary.notEvaluatedCells?.length)
    lines.push(
      "## Cells NOT EVALUATED (the service did not consume the cell's prepare in time; X-21)",
      "",
      "| surface | row | column | phase | reason |",
      "|---|---|---|---|---|",
      ...summary.notEvaluatedCells.map((c) => `| ${c.surface} | ${c.row} | ${c.column} | ${c.phase} | ${c.reason} |`),
      "",
    );
  if (report.notEvaluated?.length)
    lines.push(
      "## NOT EVALUATED",
      "",
      "| surface | row | reason |",
      "|---|---|---|",
      ...report.notEvaluated.map((n) => `| ${n.surface} | ${n.row} | ${n.reason} |`),
      "",
    );
  if (report.notCovered?.length) lines.push("## Not covered", "", ...report.notCovered.map((n) => `- ${n}`), "");
  return `${lines.join("\n")}\n`;
}
