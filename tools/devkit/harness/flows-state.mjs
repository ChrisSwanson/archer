// State-and-recovery primitives for the user-flows rubric (docs/quality/rubrics/user-flows.md §3 G1, G2, G4, G5,
// U5; §8 Tools). index.mjs adds them to every `ui` a journey gets (the first page and each ui.openContext()):
//
//   ui.setOffline(bool)                     the browser context goes offline / online (Playwright setOffline)
//   ui.restartService()                     sandbox.mjs restart: same port, state, links; waits for readiness
//   ui.stopService() / ui.startService()    its two halves (act while the service is down); ui.killService(): SIGKILL
//   ui.dropResponseAfterCommit(pattern, o)  the request reaches the service (route.fetch), its answer is thrown
//                                           away (route.abort): the effect is committed, the page never hears it
//   ui.resendInPage(drop)                   the exact request a drop recorded (URL and body, so the same operation
//                                           identity), sent again by the page itself (its cookie, origin and routes)
//   ui.serviceGet(path) / ui.threads(slug, target) / ui.fileState(slug, relPath)
//                                           read back from the service (this context's cookie) and from disk
//   ui.captureEditor(slug) / ui.captureComment()
//                                           the G1 state (draft source or comment text, target id, base revision);
//                                           a comment's target and revision are read from the draft the page keeps
//   ui.storedComments()                     the comment drafts kept in this browser profile (archer.comment-draft.v1:*),
//                                           a reply's with its threadId
//   ui.captureReply()                       the G1 state of the reply being written: its text (the "Your reply" box) and,
//                                           from the reply draft the page keeps for that text, its target and thread
//   ui.flowCheck(gate, boundary, ok, details)
//                                           record one collector verdict in summary.flowState.checks (never throws)
//
// Collector verdicts are data, not step failures, so a seeded fault shows up as the gate it breaks and the
// journey keeps going to the next boundary; a journey ends with `assertFlowChecks`, which fails a step when any
// check did not hold. Seeded faults (§8: "a stub route that drops the draft, skips the revision check, or repeats
// the effect") are switched on with ARCHER_FLOWS_FAULT=<name>[,<name>] and installed by `installFaults`:
//
//   drop-draft            every document start deletes the editor's browser drafts (archer.authoring.v1:*)
//   drop-comment-draft    going offline or restarting the service empties the open comment box, and every document
//                         start deletes the comment and reply drafts kept in the browser (archer.comment-draft.v1:*)
//   drift-comment-revision  every document start rewrites the kept comment drafts' base revision (same text, same
//                         target and anchor): only a collector that reads the revision back can see it (codex-03)
//   skip-revision-check   a Save (document.apply) is sent with the file's current revision as its base
//   repeat-effect         POST /api/comments and POST /api/comments/submit are sent twice, the second as a new
//                         operation (fresh id); the page gets the second answer
//   drop-submit-answer    the first Send (POST /api/comments/submit) of each browser context commits and its answer
//                         is dropped (route.fetch, then route.abort), as J8d does to its lost comment's Send: a
//                         condition, not a collector fault; run a queued journey (J5) with it to see the page's claim
//                         (a journey without DISCONNECT_INVARIANTS then fails console-errors and failed-requests on
//                         the dropped request itself: that is the injected drop, not the page)
//   hide-connection-indicator  the page's [data-connection] notice is hidden and unmarked as soon as it appears
//   hang-stalled-write    while the network is stalled (ui.stallNetwork), a comment write is held unanswered instead
//                         of failing: the page gets no network evidence from it (J8a v1.1, the notice by a failed write)
//   fresh-save-identity   every Save (document.apply) goes out under a new operation id: a held offline Save (J9d)
//                         is then not the request the browser kept, which only a collector reading the id back can see
//   claim-any-save        the presence line calls every change not made by the agent "Saved" in the person's
//                         voice, as before claude-206 (the lead and voice are rewritten as they appear): J6's
//                         "before Save" checks then fail
//   stale-open            POST /api/authoring/open for a target whose file is gone is answered with that target's last
//                         successful answer in this browser context, so the page believes the file is still there:
//                         J9d's held save is then sent to the missing file and its G5 "not sent" check fails
//   hide-missing-source   compile failures with no source revision (a registered file that was deleted) are removed
//                         from GET api/compile and from the `compile` stream event before the page reads them, as the
//                         page's parser did before claude-204: J11's removed-file G4 check then fails
//   drop-reveal-scroll    the action collector (flow-metrics.mjs) records no "scroll to:" entry for a target that was
//                         off screen before its action, as before claude-07/codex-05: J1's trace then lacks the scroll
//                         to Pageturner and its comparison with the pinned trace reports it missing
//   follow-presented-link  present_diagram's result, as the journey's agent sees it, gives the `?follow` address as
//                         its URL (ui.url = ui.followUrl), as before claude-08: J11's link then opens whatever the agent
//                         presented last, and its U7 stable-link check fails (installed by `agentFaults`)
//   drop-pairing-return   the pairing form's POST /-/pair is sent without its `return` field, as before claude-09:
//                         J1's pairing from a refused address then lands on /projects/ and its U6 check fails
//   fresh-operation-identity  every comment create, reply and submit the page sends as an operation goes out under a
//                         new id, as the chat did before codex-202: a Send repeated after a lost answer is then a second
//                         comment (J8e). Requests a journey drops itself (dropResponseAfterCommit) are not rewritten.
//   forget-operation-hold every document start deletes the operation identities the page keeps in this browser
//                         (archer.comment-operation.v1:*, and a chat draft's `sending`), as before claude-202: after a lost answer and a reload the
//                         restored comment is sent as a new one (J8d "lost, then reload")
//   ignore-open-tabs      the lock manager reports no other tab's lock (navigator.locks.query), so a tab sees no
//                         other tab as open, as before claude-201: a second tab is offered the first one's live draft
//                         instead of being told it is written there (J9c, J9e)
//   shared-owner-id       the tab-ownership claim keeps whatever id sessionStorage holds (every lock is granted at
//                         once), as before claude-301: a duplicated tab shares its opener's id and restores its drafts
//   auto-restore-other    reading this tab's draft (a key ending ~<owner>) falls back to any other owner's draft under
//                         the same key, as a page that restores another tab's draft by itself (claude-301, O117)
//   threshold-takeover    a tab counts as open only if it answers a ping within 150 ms (the old rule): a tab busy for
//                         longer looks closed and its draft is offered elsewhere (claude-302)
//   hide-saved-claim      the presence line (.archer-presence) is hidden: the editor closing after a lost save then
//                         says nothing, which J8d's save status check must not take for "Saved" (PC-03)
//   false-chat-status     the open chat shows a note reading "Not sent", whatever happened: the
//                         lie the chat told after a lost submit before codex-202, which J8e's status check must catch
//   late-stall-notice     the [data-connection] notice is held back for 2 s each time it first appears: J8a-stall's
//                         ≤45 s bound, measured from the stall, then fails (PC-08)
//   drop-edit-draft       every document start deletes the kept edits of existing comments (archer.comment-draft.v1:…
//                         \0edit:…), as before the Edit box kept its text: J9c's edit boundaries then read nothing back
//   hide-edit-changed     the editor's "This comment changed since you started editing it" note is hidden and its
//                         "Save over it" reads "Save" again, as an editor that writes over another change silently:
//                         J9c's "edit: changed meanwhile" check must catch it
//   drop-edit-revision    every comment edit (PATCH api/comments/<thread>/<comment>) goes out without its
//                         expectedRevision, as the page sent it before O124: a Save that meets a change the page has
//                         not seen then writes over it (J9c "edit: a change the page had not seen")
//   stale-recovery-read   every editor recovery record (archer.authoring.v1:*) reads as this document first read it,
//                         as takeRecovery did before codex-401 (no fresh read under the lock): a stale Resume offer
//                         then takes a copy another tab resumed meanwhile (J9 "resume, two tabs")
//   hide-closed-work      the gone screen (.authoring-missing) says "You have no unsaved changes to it in this browser"
//                         and has no Resume them, as before claude-403 in a new tab: J9d "file deleted, new tab" fails
//   offer-first-listed    every editor recovery record reads without its save time (savedAt), as before O137: with
//                         several closed tabs' copies the page offers the first the browser lists (J9 "three closed
//                         copies")
//   inert-resume          the editor's "Resume them" does nothing, as from a full draft address before codex-403 (J9
//                         "resume, full draft address")
//   content-keyed-identity every comment create and reply the page sends as an operation goes out under an id made
//                         from what it writes (its address, target, anchor and text), as the page's identity was before
//                         codex-301: two tabs that each type the same words then send one operation, and the service
//                         answers the second from the first one's receipt (J8d "two tabs, the same words")
//   hide-pending-copies   on an in-place edit address (?edit) with no draft id, a recovery record holding a save (pending) reads as absent,
//                         as the plain-address scan was before claude-501: a closed tab's held or unconfirmed save is not
//                         offered in a new tab on a file that is still there (J9d "kept file, new tab")
//   drop-copy-withdrawal  the page acts on no storage event (a capturing listener stops them first), as the copies list was
//                         before codex-502 for every row but the offered one: a row another tab resumed stays listed
//                         (J9 "copy rows")
//   definite-late-refusal a late delete/resolve/dismiss's final words are rewritten as before codex-501 ("Archer did not
//                         answer, and the thread is still there, so it did not resolve the thread. Try again."), and
//                         kept on screen after the effect arrives: late-write.mjs's G4 checks then fail
//   self-reload           a project page reloads itself (location.reload) 400 ms after its first load in each tab, as a
//                         page that reloads on its own: the navigation census (navigations.mjs) must count it as a load
//                         the journey did not issue (prove-collectors.mjs "navigations")
//
// tools/devkit/harness/flows-prove.mjs runs each collector's journey clean and with its fault and
// checks that the clean run passes and the faulted run fails exactly that gate.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { CAUSES } from "./errors.mjs";

export const FAULTS = [
  "drop-draft",
  "drop-comment-draft",
  "drift-comment-revision",
  "skip-revision-check",
  "repeat-effect",
  "hide-connection-indicator",
  "hang-stalled-write",
  "drop-submit-answer",
  "drop-reveal-scroll",
  "follow-presented-link",
  "drop-pairing-return",
  "fresh-save-identity",
  "claim-any-save",
  "stale-open",
  "hide-missing-source",
  "fresh-operation-identity",
  "forget-operation-hold",
  "ignore-open-tabs",
  "hide-saved-claim",
  "late-stall-notice",
  "false-chat-status",
  "drop-edit-draft",
  "hide-edit-changed",
  "content-keyed-identity",
  "shared-owner-id",
  "auto-restore-other",
  "threshold-takeover",
  "drop-edit-revision",
  "stale-recovery-read",
  "inert-resume",
  "hide-closed-work",
  "offer-first-listed",
  "self-reload",
  "hide-pending-copies",
  "drop-copy-withdrawal",
  "definite-late-refusal",
];

/** The seeded faults named in ARCHER_FLOWS_FAULT (comma separated); an unknown name is refused, not ignored. */
export function activeFaults(env = process.env) {
  const named = (env.ARCHER_FLOWS_FAULT ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const f of named)
    if (!FAULTS.includes(f)) throw new Error(`ARCHER_FLOWS_FAULT names ${f}; known faults: ${FAULTS.join(", ")}`);
  return new Set(named);
}

export const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** Field-by-field comparison of a captured G1 state with its read-back. Returns the fields that differ. */
export function compareState(captured, readBack, fields = ["text", "target", "baseRevision"]) {
  const diffs = [];
  for (const f of fields) {
    const a = JSON.stringify(captured?.[f] ?? null),
      b = JSON.stringify(readBack?.[f] ?? null);
    if (a !== b) diffs.push({ field: f, captured: captured?.[f] ?? null, readBack: readBack?.[f] ?? null });
  }
  return diffs;
}

/**
 * G2's predicate over the evidence of one stale save: the refusal (the save's answer), the file bytes before and
 * after it, the other writer's bytes and where the person's version ended up. `answer` is the parsed JSON of the
 * stale POST /api/authoring (or null when the page refused before sending, which also counts as refused before
 * it takes effect).
 */
export function g2Verdict({
  answer,
  sent,
  diskBeforeSave,
  diskAfterSave,
  otherWriter,
  personSource,
  editorSource,
  copies = [],
}) {
  const problems = [];
  const refused = !sent || answer?.outcome === "conflict" || typeof answer?.error?.code === "string";
  if (!refused)
    problems.push(
      `the stale save was not refused (outcome ${JSON.stringify(answer?.outcome ?? answer?.error ?? null)})`,
    );
  if (diskAfterSave !== diskBeforeSave) problems.push("the file bytes changed across the stale save");
  if (diskAfterSave !== otherWriter) problems.push("the other writer's version is not on disk");
  const kept = editorSource === personSource || copies.includes(personSource);
  if (!kept) problems.push("the person's version is neither in the editor nor saved as a copy");
  return {
    ok: problems.length === 0,
    refused,
    refusal:
      answer?.outcome === "conflict"
        ? { outcome: "conflict", kind: answer.conflict?.kind ?? null }
        : (answer?.error ?? (sent ? null : "refused by the page before sending")),
    kept: editorSource === personSource ? "editor" : kept ? "copy" : null,
    problems,
  };
}

/** G5's predicate: how many durable effects carry this content, against how many operations the person meant. */
export function g5Verdict({ effects, expected, label }) {
  return {
    ok: effects === expected,
    effects,
    expected,
    ...(effects === expected
      ? {}
      : { problem: `${label}: ${effects} durable effect(s), expected exactly ${expected}` }),
  };
}

/**
 * The flows primitives for one page. `run` is the journey's summary (verdicts go to run.flowState), `onRestart`
 * lets the harness reset its service-log cursor (a restarted service starts its log again).
 */
export function flowsActions({
  page,
  context,
  sandbox,
  step,
  expect,
  run,
  onRestart,
  errors = null,
  faults = activeFaults(),
}) {
  // The conditions these helpers seed (offline, a stalled network, the service down) make requests fail, the page say
  // so and the browser log it: expected while the condition lasts and a grace after, as narrowly as errors.mjs CAUSES
  // says, never unseeded.
  const conditions = new Map();
  const condition = (name, on) => {
    if (!errors) return;
    if (on) {
      if (!conditions.has(name)) conditions.set(name, errors.condition(name, CAUSES[name]));
    } else {
      conditions.get(name)?.();
      conditions.delete(name);
    }
  };
  const origin = sandbox.origin.replace(/\/$/, "");
  const state = run
    ? (run.flowState ??= { faults: [...faults], checks: [], drops: [], restarts: [] })
    : { checks: [], drops: [], restarts: [] };
  const cookieHeader = async () => (await context.cookies(origin)).map((c) => `${c.name}=${c.value}`).join("; ");
  const inProject = (slug, relPath) => {
    const p = sandbox.projects.find((x) => x.slug === slug);
    if (!p) throw new Error(`no project ${slug} in sandbox ${sandbox.name}`);
    const root = resolve(p.root),
      file = resolve(root, relPath);
    if (!file.startsWith(root + sep) || !root.startsWith(sandbox.root + sep))
      throw new Error(`${relPath} is outside project ${slug}`);
    return file;
  };
  const started = (r) => {
    Object.assign(sandbox, { pid: r.pid, process: r.process, ownerToken: r.ownerToken });
    state.restarts.push({ at: new Date().toISOString(), ms: r.lastRestartMs, pid: r.pid });
    onRestart?.();
    return { pid: r.pid, ms: r.lastRestartMs };
  };
  const commentBox = () => page.getByRole("textbox", { name: "Comment", exact: true });

  const f = {
    faults,
    flowState: state,
    /** Record one collector verdict; returns `ok`. */
    flowCheck(gate, boundary, ok, details = {}) {
      // The verdict is written after the details (O150): a details object that carries its own `ok` (a spread g2Verdict
      // or g5Verdict) used to replace the check's verdict, so the check's other conditions were never judged.
      state.checks.push({ ...details, gate, boundary, ok: Boolean(ok), at: new Date().toISOString() });
      return Boolean(ok);
    },
    /**
     * Browser offline (true) or online (false) for this context (Playwright setOffline: navigator.onLine and the
     * offline/online events follow, every new request fails with ERR_INTERNET_DISCONNECTED). Chromium's emulation
     * does not cut a connection already open: the page's event stream keeps delivering while "offline" (seen
     * 2026-11-02: a change event arrived and the read it caused failed). A real network loss stalls that stream too.
     */
    setOffline: (offline, { expects } = {}) =>
      step(
        offline ? "browser goes offline" : "browser comes back online",
        async () => {
          if (offline && faults.has("drop-comment-draft"))
            await commentBox()
              .fill("")
              .catch(() => {});
          if (offline) condition("browser offline", true);
          await context.setOffline(Boolean(offline));
          if (!offline) condition("browser offline", false);
        },
        { selectionMayChange: true, ...(expects ? { expects } : {}) },
      ), // expects: what coming back deliberately causes (errors.mjs)
    /**
     * A real network loss, as Chromium's offline mode does not give one (user-flows v1.1, J8a): with `true` the
     * page's open event stream stays open but delivers nothing (no events, heartbeats, errors), every new request
     * to the service fails (net::ERR_ADDRESS_UNREACHABLE: no `offline` event, navigator.onLine stays true), and
     * new streams fail the same way; `false` lets everything through again (the stream held open resumes).
     * Needs `prepareStall()` before the page loads: the hold is an EventSource wrapper installed by init script.
     */
    async prepareStall() {
      await context.addInitScript(() => {
        const Native = window.EventSource;
        if (Native === undefined || Native.__archerStallable) return;
        const held = () => window.__archerStalled === true;
        const gate = (fn) =>
          typeof fn !== "function"
            ? fn
            : function (event) {
                if (!held()) return fn.call(this, event);
              };
        class Stallable extends Native {
          addEventListener(type, fn, options) {
            return super.addEventListener(type, gate(fn), options);
          }
        }
        for (const name of ["onopen", "onerror", "onmessage"]) {
          const native = Object.getOwnPropertyDescriptor(Native.prototype, name);
          Object.defineProperty(Stallable.prototype, name, {
            configurable: true,
            get() {
              return native.get.call(this);
            },
            set(fn) {
              native.set.call(this, gate(fn));
            },
          });
        }
        Stallable.__archerStallable = true;
        window.EventSource = Stallable;
      });
      // Seeded fault hang-stalled-write: a comment write is held (never answered, never failed) instead.
      const hang = (req) =>
        faults.has("hang-stalled-write") &&
        req.method() === "POST" &&
        /\/api\/comments(\/|$)/.test(new URL(req.url()).pathname);
      f.stallHandler ??= (route) => (hang(route.request()) ? new Promise(() => {}) : route.abort("addressunreachable"));
      f.stallMatch ??= (url) => url.origin === origin;
    },
    stallNetwork: (stalled) =>
      step(
        stalled ? "the network stalls (stream held open, requests unanswered)" : "the network comes back",
        async () => {
          if (!f.stallHandler) throw new Error("stallNetwork needs ui.prepareStall() before the page loads");
          if (stalled && faults.has("drop-comment-draft"))
            await commentBox()
              .fill("")
              .catch(() => {});
          if (stalled) {
            condition("network stalled", true);
            await context.route(f.stallMatch, f.stallHandler);
          } else {
            await context.unroute(f.stallMatch, f.stallHandler).catch(() => {});
            condition("network stalled", false);
          }
          await page.evaluate((on) => {
            window.__archerStalled = on;
          }, Boolean(stalled));
        },
        { selectionMayChange: true },
      ),
    /**
     * Restart the sandbox's service (sandbox.mjs restart): same port, state directory, links and projects, and the
     * call returns once every project answers again. The sandbox record this page uses is updated in place.
     */
    restartService: () =>
      step(
        "service restarts",
        async () => {
          if (faults.has("drop-comment-draft"))
            await commentBox()
              .fill("")
              .catch(() => {});
          const { restart } = await import("../sandbox.mjs");
          condition("service restarting", true);
          try {
            return started(await restart({ name: sandbox.name }));
          } finally {
            condition("service restarting", false);
          }
        },
        { selectionMayChange: true },
      ),
    /** The first half of restartService: the service is down until ui.startService() (act while it is). */
    stopService: () =>
      step(
        "service stops",
        async () => {
          if (faults.has("drop-comment-draft"))
            await commentBox()
              .fill("")
              .catch(() => {});
          const { stopService } = await import("../sandbox.mjs");
          state.restarts.push({ stoppedAt: new Date().toISOString() });
          condition("service down", true);
          return stopService({ name: sandbox.name });
        },
        { selectionMayChange: true },
      ),
    /** §6 promise "service killed after an acknowledged save": SIGKILL (no shutdown of its own), then start it again. */
    killService: () =>
      step(
        "service is killed and started again",
        async () => {
          const { stopService, startService } = await import("../sandbox.mjs");
          condition("service killed", true);
          try {
            await stopService({ name: sandbox.name, kill: true });
            return started(await startService({ name: sandbox.name }));
          } finally {
            condition("service killed", false);
          }
        },
        { selectionMayChange: true },
      ),
    /** The second half: start the stopped service again (same port, state, links) and wait until it is ready. */
    startService: () =>
      step(
        "service starts again",
        async () => {
          const { startService } = await import("../sandbox.mjs");
          try {
            return started(await startService({ name: sandbox.name }));
          } finally {
            condition("service down", false);
          }
        },
        { selectionMayChange: true },
      ),
    /**
     * The request a drop recorded, sent again from the page with its exact URL and body: a real browser request
     * (the page's cookie, Origin and the context's routes), so a write sent as an operation repeats its identity.
     * Returns {status, json, operationId}.
     */
    async resendInPage(drop) {
      if (!drop) throw new Error("resendInPage needs a recorded drop");
      const answer = await page.evaluate(
        async ({ url, body }) => {
          const r = await fetch(url, {
            method: "POST",
            cache: "no-store",
            headers: { "content-type": "application/json" },
            body,
          });
          return { status: r.status, text: await r.text() };
        },
        { url: drop.url, body: drop.request },
      );
      let json = null;
      try {
        json = JSON.parse(answer.text);
      } catch {
        json = null;
      }
      let operationId = null;
      try {
        operationId = JSON.parse(drop.request)?.operation?.id ?? null;
      } catch {
        operationId = null;
      }
      return { status: answer.status, json, operationId };
    },
    /**
     * Every matching request (method, default POST; `times`, default 1) is sent to the service with route.fetch()
     * and its answer is then dropped with route.abort(): the write is committed, the page sees a network failure.
     * Returns a handle: {drops: [{url, status, body}], off()}. Later matching requests go through untouched.
     */
    async dropResponseAfterCommit(urlPattern, { method = "POST", times = 1, when = () => true } = {}) {
      const handle = {
        drops: [],
        off: async () => {
          await page.unroute(urlPattern, handler).catch(() => {});
        },
      };
      const handler = async (route) => {
        const req = route.request();
        if (req.method() !== method || handle.drops.length >= times || !when(req)) return route.fallback();
        const answer = await route.fetch();
        const body = await answer.text().catch(() => "");
        const drop = {
          url: req.url().replace(origin, ""),
          method,
          status: answer.status(),
          body: body.slice(0, 2000),
          request: (req.postData() ?? "").slice(0, 2000),
          at: new Date().toISOString(),
        };
        handle.drops.push(drop);
        state.drops.push(drop);
        errors?.dropped(req);
        await route.abort("connectionreset");
      };
      await page.route(urlPattern, handler);
      return handle;
    },
    /** GET a service path as this context (its access cookie), JSON. */
    async serviceGet(path) {
      const res = await fetch(origin + path, {
        headers: { cookie: await cookieHeader() },
        signal: AbortSignal.timeout(5000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`GET ${path} answered ${res.status}: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    },
    /** The service's threads on a target ("view:checkout"), as the agent's get_comments would see them. */
    async threads(slug, target) {
      return (await f.serviceGet(`/p/${slug}/api/comments?target=${encodeURIComponent(target)}`)).threads ?? [];
    },
    /** Threads holding a comment with exactly `body`. */
    async threadsWith(slug, target, body) {
      return (await f.threads(slug, target)).filter((t) => (t.comments ?? []).some((c) => c.body === body));
    },
    /** A project file on disk: its text and revision (the service's sourceRevision is sha256 of the bytes). */
    fileState(slug, relPath) {
      const file = inProject(slug, relPath);
      if (!existsSync(file)) return { exists: false, text: null, revision: null };
      const bytes = readFileSync(file);
      return { exists: true, text: bytes.toString("utf8"), revision: sha256(bytes) };
    },
    /** The editor's browser draft for `draftId` (localStorage archer.authoring.v1:*), parsed, or null. */
    async storedDraft(draftId) {
      return page
        .evaluate((id) => {
          try {
            for (const k of Object.keys(localStorage))
              if (k.startsWith("archer.authoring.v1:") && k.endsWith(`:${id}`))
                return JSON.parse(localStorage.getItem(k));
          } catch {
            /* blocked storage */
          }
          return null;
        }, draftId)
        .catch(() => null);
    },
    /** Every editor draft in this browser profile (archer.authoring.v1:*): {key, draftId, source, dirty}. */
    async storedDrafts() {
      return page
        .evaluate(() => {
          try {
            return Object.keys(localStorage)
              .filter((k) => k.startsWith("archer.authoring.v1:"))
              .map((key) => {
                let d = null;
                try {
                  d = JSON.parse(localStorage.getItem(key));
                } catch {
                  /* not JSON */
                }
                return {
                  key: key.replace(/^.*:(drf_[0-9a-f]+)$/, "$1"),
                  draftId: d?.draftId ?? null,
                  source: d?.source ?? null,
                  dirty: d ? d.source !== d.opened?.source : null,
                };
              });
          } catch {
            return [];
          }
        })
        .catch(() => []);
    },
    /**
     * G1 state of the open editor: the Mermaid in it, its target (project, document path from the address, draft id)
     * and its base revision (the revision the draft was opened from, as the editor keeps it with the draft).
     */
    async captureEditor(slug, ui) {
      const u = new URL(page.url());
      const text = await ui.editorSource();
      const draftId = u.searchParams.get("draftId");
      const stored = draftId ? await f.storedDraft(draftId) : null;
      return {
        kind: "editor",
        text,
        target: { project: slug, path: decodeURIComponent(u.pathname.replace(`/projects/${slug}/`, "")), draftId },
        baseRevision: stored?.opened?.sourceRevision ?? null,
      };
    },
    /** Every comment draft this profile keeps (archer.comment-draft.v1:*), as stored: {target, anchorId, body, baseRevision}. */
    async storedComments() {
      return page
        .evaluate(() => {
          try {
            return Object.keys(localStorage)
              .filter((k) => k.startsWith("archer.comment-draft.v1:"))
              .map((key) => {
                let d = null;
                try {
                  d = JSON.parse(localStorage.getItem(key));
                } catch {
                  /* not JSON */
                }
                // The kind is the key's (a chat draft ends in chat:<anchor key>, a reply in reply:<thread>), and so is the
                // tab that keeps it (~<owner>, claude-201).
                const kind = /\0chat:/.test(key)
                  ? "chat"
                  : /\0reply:/.test(key)
                    ? "reply"
                    : /\0edit:/.test(key)
                      ? "edit"
                      : "comment";
                const owner = /~([0-9a-f]{16})$/.exec(key)?.[1] ?? null;
                return {
                  kind,
                  owner,
                  target: d?.target ?? null,
                  anchorId: d?.anchor?.id ?? d?.anchor?.kind ?? null,
                  threadId: d?.threadId ?? null,
                  commentId: d?.commentId ?? null,
                  base: d?.base ?? null,
                  body: d?.body ?? null,
                  baseRevision: d?.baseRevision ?? null,
                  sending: d?.sending?.operation?.id ?? null,
                };
              });
          } catch {
            return [];
          }
        })
        .catch(() => []);
    },
    /**
     * G1 state of the comment being composed, observed, never supplied: its text (the box), its anchor as shown (the
     * discussion's "Node: X" heading) and, from the draft the page keeps for that text, its target, anchor id and
     * base revision. No kept draft (or more than one with the text): those are null. (`baseRevision` is ignored: it
     * was the caller's value, which no boundary could change; codex-03.)
     */
    async captureComment() {
      const box = commentBox();
      const text = (await box.count()) ? await box.inputValue().catch(() => null) : null;
      const region = page.getByRole("region", { name: "Contextual discussion", exact: true });
      const heading = await region
        .locator(".primary-floating-context")
        .first()
        .textContent({ timeout: 1000 })
        .catch(() => null);
      const anchor = heading?.replace(/\s+/g, " ").trim() ?? null;
      const kept = text ? (await f.storedComments()).filter((d) => d.kind === "comment" && d.body === text) : [];
      const one = kept.length === 1 ? kept[0] : null;
      return {
        kind: "comment",
        text,
        target: { anchor, target: one?.target ?? null, anchorId: one?.anchorId ?? null },
        baseRevision: one?.baseRevision ?? null,
      };
    },
    /**
     * G1 state of the reply being written, observed: the text in the first visible "Your reply" box and, from the
     * reply draft the page keeps for that text (exactly one), its target and thread. Null fields when none is kept.
     */
    async captureReply() {
      const box = page.getByRole("textbox", { name: "Your reply", exact: true }).first();
      const text = (await box.count()) ? await box.inputValue().catch(() => null) : null;
      const kept = text ? (await f.storedComments()).filter((d) => d.kind === "reply" && d.body === text) : [];
      const one = kept.length === 1 ? kept[0] : null;
      return { kind: "reply", text, target: { target: one?.target ?? null, threadId: one?.threadId ?? null } };
    },
    /**
     * G1 state of an edit of an existing comment being written, observed: the text in the first visible "Edit your
     * comment" box and, from the edit draft the page keeps for that text (exactly one), its target, thread and comment,
     * and `base`, the comment's text the edit began from. Null fields when none is kept.
     */
    async captureEdit() {
      const box = page.getByRole("textbox", { name: "Edit your comment", exact: true }).first();
      const text = (await box.count()) ? await box.inputValue().catch(() => null) : null;
      const kept = text ? (await f.storedComments()).filter((d) => d.kind === "edit" && d.body === text) : [];
      const one = kept.length === 1 ? kept[0] : null;
      return {
        kind: "edit",
        text,
        target: { target: one?.target ?? null, threadId: one?.threadId ?? null, commentId: one?.commentId ?? null },
        base: one?.base ?? null,
      };
    },
    /**
     * G1 state of the chat message being written (codex-201), observed: the text in "Message to the agent" and, from
     * the chat draft the page keeps for that text (exactly one), its target, conversation anchor and the thread it
     * answers (null for a new conversation). Null fields when none is kept.
     */
    async captureChat() {
      const box = page.getByRole("textbox", { name: "Message to the agent", exact: true });
      const text = (await box.count()) ? await box.inputValue().catch(() => null) : null;
      const kept = text ? (await f.storedComments()).filter((d) => d.kind === "chat" && d.body === text) : [];
      const one = kept.length === 1 ? kept[0] : null;
      return {
        kind: "chat",
        text,
        target: { target: one?.target ?? null, anchorId: one?.anchorId ?? null, threadId: one?.threadId ?? null },
        owner: one?.owner ?? null,
        sending: one?.sending ?? null,
      };
    },
    /**
     * Run the bundled `archer call <op>` with the sandbox's environment in a project (the agent's view: get_comments,
     * list_changes, …) and return its JSON result. (flows-tools-b's ui.agent(...) is the general form.)
     */
    async archerCall(slug, op, args = {}) {
      const { sandboxEnv, REPO } = await import("../sandbox.mjs");
      const { spawnSync } = await import("node:child_process");
      const p = sandbox.projects.find((x) => x.slug === slug);
      if (!p) throw new Error(`no project ${slug} in sandbox ${sandbox.name}`);
      const out = spawnSync(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          resolve(REPO, "ts/src/bin/archer.ts"),
          "call",
          op,
          "--json",
          "--stdin",
        ],
        { cwd: p.root, env: sandboxEnv(sandbox), input: JSON.stringify(args), encoding: "utf8", timeout: 30_000 },
      );
      if (out.status !== 0)
        throw new Error(`archer call ${op} exited ${out.status}: ${(out.stderr || out.stdout).slice(0, 400)}`);
      return JSON.parse(out.stdout);
    },
    /** The connection indicator: the page's [data-connection] state, or null when none is shown. */
    connection: () =>
      page
        .locator("[data-connection]")
        .first()
        .getAttribute("data-connection", { timeout: 500 })
        .catch(() => null),
  };
  return f;
}

/** Seeded faults in what the journey's agent is told (`ui.agent`, agent.mjs); index.mjs wraps the agent once. */
export function agentFaults(agent, faults = activeFaults()) {
  if (!faults.has("follow-presented-link")) return agent;
  const faulted = async (op, args, options) => {
    const result = await agent(op, args, options);
    // The link before claude-08: the address that follows the agent, not the presented diagram's own.
    if (op === "present_diagram" && result?.ui?.followUrl)
      return { ...result, ui: { ...result.ui, url: result.ui.followUrl } };
    return result;
  };
  return Object.assign(faulted, { calls: agent.calls });
}

/** Seeded faults that live in the page or its routes; installed once per context by index.mjs. */
export async function installFaults({ context, sandbox, faults = activeFaults() }) {
  if (faults.has("hide-pending-copies")) {
    await context.addInitScript(() => {
      const get = Storage.prototype.getItem;
      Storage.prototype.getItem = function getItem(key) {
        const v = get.call(this, key);
        if (
          v === null ||
          typeof key !== "string" ||
          !key.startsWith("archer.authoring.v1:") ||
          !new URLSearchParams(location.search).has("edit") ||
          new URLSearchParams(location.search).has("draftId")
        )
          return v;
        try {
          return JSON.parse(v)?.pending ? null : v;
        } catch {
          return v;
        }
      };
    });
  }
  if (faults.has("drop-copy-withdrawal")) {
    await context.addInitScript(() => {
      addEventListener(
        "storage",
        (e) => {
          if ((e.key ?? "").startsWith("archer.authoring.v1:")) e.stopImmediatePropagation();
        },
        true,
      );
    });
  }
  if (faults.has("definite-late-refusal")) {
    await context.addInitScript(() => {
      const FINAL =
        /Archer did not answer, so it is not known whether it did (.+?): when last (?:checked|read), at [^,]+, (the (?:thread|comment) is still there)(?:, and the latest check could not reach Archer)?\. If it is still there, try again; it is never done twice\./;
      let said = null;
      const rewrite = () => {
        const walk = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          const m = FINAL.exec(n.nodeValue ?? "");
          if (m) {
            said = `Archer did not answer, and ${m[2]}, so it did not ${m[1]}. Try again.`;
            n.nodeValue = (n.nodeValue ?? "").replace(FINAL, said);
          }
        }
        // Kept after the page cleared it, as the old page never settled it.
        if (said && !document.body.innerText.includes(said)) {
          const p = document.createElement("p");
          p.setAttribute("role", "alert");
          p.textContent = said;
          document.body.append(p);
        }
      };
      new MutationObserver(rewrite).observe(document, { subtree: true, childList: true, characterData: true });
    });
  }
  if (faults.has("self-reload")) {
    await context.addInitScript(() => {
      if (window !== window.top || !location.pathname.startsWith("/projects/")) return;
      try {
        if (sessionStorage.getItem("archer.seeded-self-reload")) return;
        sessionStorage.setItem("archer.seeded-self-reload", "1");
      } catch {
        return;
      }
      addEventListener("load", () => setTimeout(() => location.reload(), 400), { once: true });
    });
  }
  if (faults.has("drop-pairing-return")) {
    // The pairing form as before claude-09: the code alone, so the pairing lands on /projects/.
    await context.route("**/-/pair", (route) => {
      const req = route.request();
      if (
        req.method() !== "POST" ||
        !(req.headers()["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")
      )
        return route.fallback();
      const fields = new URLSearchParams(req.postData() ?? "");
      fields.delete("return");
      return route.fallback({ postData: fields.toString() });
    });
  }
  if (faults.has("drop-draft")) {
    await context.addInitScript(() => {
      try {
        for (const k of Object.keys(localStorage)) if (k.startsWith("archer.authoring.v1:")) localStorage.removeItem(k);
      } catch {
        /* blocked */
      }
    });
  }
  if (faults.has("fresh-operation-identity")) {
    const fresh = async (route) => {
      const req = route.request();
      let body = null;
      try {
        body = JSON.parse(req.postData() ?? "");
      } catch {
        body = null;
      }
      if (req.method() !== "POST" || typeof body?.operation?.id !== "string") return route.fallback();
      const id = createHash("sha256")
        .update(`fresh-operation-identity:${body.operation.id}:${Math.random()}`)
        .digest("hex")
        .slice(0, 32);
      return route.fallback({ postData: JSON.stringify({ ...body, operation: { ...body.operation, id } }) });
    };
    await context.route("**/api/comments", fresh);
    await context.route("**/api/comments/*/replies", fresh);
    await context.route("**/api/comments/submit", fresh);
  }
  if (faults.has("content-keyed-identity")) {
    await context.addInitScript(() => {
      const real = window.fetch.bind(window);
      const fnv = (text, seed) => {
        let h = seed >>> 0;
        for (let i = 0; i < text.length; i++) {
          h ^= text.charCodeAt(i);
          h = Math.imul(h, 0x01000193) >>> 0;
        }
        return h.toString(16).padStart(8, "0");
      };
      window.fetch = (input, init) => {
        try {
          const url = new URL(
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
            location.href,
          );
          if (
            (init?.method ?? "GET").toUpperCase() === "POST" &&
            /\/api\/comments(\/[^/]+\/replies)?$/.test(url.pathname) &&
            typeof init?.body === "string"
          ) {
            const body = JSON.parse(init.body);
            if (typeof body?.operation?.id === "string" && body.operation.name !== "comment.submit") {
              const what = `${url.pathname}\0${JSON.stringify(body.payload ?? null)}`;
              const id = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b].map((seed) => fnv(what, seed)).join("");
              // The whole identity, as the page reused it: the first issue time this browser gave that id.
              const at = `archer.flows-fault.content-id:${id}`;
              const issuedAt = Number(localStorage.getItem(at) ?? body.operation.issuedAt);
              localStorage.setItem(at, String(issuedAt));
              return real(input, {
                ...init,
                body: JSON.stringify({ ...body, operation: { ...body.operation, id, issuedAt } }),
              });
            }
          }
        } catch {
          /* not a comment operation */
        }
        return real(input, init);
      };
    });
  }
  if (faults.has("forget-operation-hold")) {
    await context.addInitScript(() => {
      try {
        for (const k of Object.keys(localStorage)) {
          if (k.startsWith("archer.comment-operation.v1:")) localStorage.removeItem(k);
          // The chat keeps its uncertain Send's identity in its draft (`sending`): dropped the same way.
          else if (k.startsWith("archer.comment-draft.v1:") && /\0chat:/.test(k)) {
            const d = JSON.parse(localStorage.getItem(k));
            if (d?.sending) localStorage.setItem(k, JSON.stringify({ ...d, sending: null }));
          }
        }
      } catch {
        /* blocked */
      }
    });
  }
  if (faults.has("ignore-open-tabs")) {
    await context.addInitScript(() => {
      // Every other tab looks closed: their tab locks are not reported.
      const locks = navigator.locks,
        query = locks.query.bind(locks);
      locks.query = async () => {
        const q = await query();
        return { ...q, held: (q.held ?? []).filter((l) => !l.name?.startsWith("archer.tab.v1:")) };
      };
    });
  }
  if (faults.has("shared-owner-id")) {
    await context.addInitScript(() => {
      // Every lock is granted at once and none is reported: a duplicated tab keeps its opener's id.
      const locks = navigator.locks,
        query = locks.query.bind(locks);
      locks.request = (name, a, b) => {
        const cb = typeof a === "function" ? a : b;
        return Promise.resolve(cb({ name, mode: "exclusive" }));
      };
      locks.query = async () => {
        const q = await query();
        return { ...q, held: (q.held ?? []).filter((l) => !l.name?.startsWith("archer.tab.v1:")) };
      };
    });
  }
  if (faults.has("auto-restore-other")) {
    await context.addInitScript(() => {
      const get = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key) {
        const own = get.call(this, key);
        if (
          own !== null ||
          typeof key !== "string" ||
          !/~[0-9a-f]{16}$/.test(key) ||
          !key.startsWith("archer.comment-draft.v1:")
        )
          return own;
        const base = key.slice(0, key.lastIndexOf("~") + 1);
        for (let i = 0; i < this.length; i++) {
          const k = this.key(i);
          if (k !== null && k !== key && k.startsWith(base)) return get.call(this, k);
        }
        return own;
      };
    });
  }
  if (faults.has("threshold-takeover")) {
    await context.addInitScript(() => {
      // The old rule: a tab is open only if it answers within 150 ms. Each page answers for its own id.
      const ping = new BroadcastChannel("archer.flows-fault.ping");
      ping.onmessage = (e) => {
        const mine = sessionStorage.getItem("archer.tab-id.v1");
        if (e.data?.type === "ping" && e.data.id === mine)
          ping.postMessage({ type: "pong", id: mine, nonce: e.data.nonce });
      };
      const locks = navigator.locks,
        query = locks.query.bind(locks);
      locks.query = async () => {
        const q = await query();
        const tabsHeld = (q.held ?? []).filter((l) => l.name?.startsWith("archer.tab.v1:"));
        const nonce = Math.random().toString(36),
          answered = new Set();
        const ask = new BroadcastChannel("archer.flows-fault.ping");
        ask.onmessage = (e) => {
          if (e.data?.type === "pong" && e.data.nonce === nonce) answered.add(e.data.id);
        };
        for (const l of tabsHeld) ask.postMessage({ type: "ping", id: l.name.slice("archer.tab.v1:".length), nonce });
        await new Promise((r) => setTimeout(r, 150));
        ask.close();
        return {
          ...q,
          held: (q.held ?? []).filter(
            (l) => !l.name?.startsWith("archer.tab.v1:") || answered.has(l.name.slice("archer.tab.v1:".length)),
          ),
        };
      };
    });
  }
  if (faults.has("hide-saved-claim")) {
    await context.addInitScript(() => {
      const hide = () => {
        for (const el of document.querySelectorAll(".archer-presence")) el.style.display = "none";
      };
      new MutationObserver(hide).observe(document, { subtree: true, childList: true });
    });
  }
  if (faults.has("false-chat-status")) {
    await context.addInitScript(() => {
      // A note of its own in the chat, beside what React draws: rewriting React's nodes breaks the panel itself.
      const lie = () => {
        for (const chat of document.querySelectorAll(".archer-chat")) {
          if (chat.querySelector("[data-seeded-fault]") !== null) continue;
          const note = document.createElement("p");
          note.className = "archer-chat-note";
          note.setAttribute("data-seeded-fault", "false-chat-status");
          note.textContent = "Not sent";
          chat.appendChild(note);
        }
      };
      new MutationObserver(lie).observe(document, { subtree: true, childList: true, characterData: true });
    });
  }
  if (faults.has("late-stall-notice")) {
    await context.addInitScript(() => {
      // Each notice is held back for 2 s after it first appears, then shown as the page drew it.
      const held = new WeakMap();
      const hold = () => {
        for (const el of document.querySelectorAll("[data-connection]")) {
          if (!held.has(el)) {
            held.set(el, el.getAttribute("data-connection"));
            el.removeAttribute("data-connection");
            el.style.visibility = "hidden";
            setTimeout(() => {
              el.setAttribute("data-connection", held.get(el));
              el.style.visibility = "";
            }, 2000);
          }
        }
      };
      new MutationObserver(hold).observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["data-connection"],
      });
    });
  }
  if (faults.has("drop-comment-draft")) {
    await context.addInitScript(() => {
      try {
        for (const k of Object.keys(localStorage))
          if (k.startsWith("archer.comment-draft.v1:")) localStorage.removeItem(k);
      } catch {
        /* blocked */
      }
    });
  }
  if (faults.has("drop-edit-draft")) {
    await context.addInitScript(() => {
      try {
        for (const k of Object.keys(localStorage))
          if (k.startsWith("archer.comment-draft.v1:") && k.includes("\0edit:")) localStorage.removeItem(k);
      } catch {
        /* blocked */
      }
    });
  }
  if (faults.has("hide-edit-changed")) {
    await context.addInitScript(() => {
      const hide = () => {
        for (const el of document.querySelectorAll(".archer-composer-kept"))
          if (/changed since you started editing/.test(el.textContent ?? "") && el.style.display !== "none")
            el.style.display = "none";
        for (const b of document.querySelectorAll("button"))
          if (b.textContent === "Save over it") b.textContent = "Save";
      };
      new MutationObserver(hide).observe(document, { subtree: true, childList: true, characterData: true });
    });
  }
  if (faults.has("stale-recovery-read")) {
    await context.addInitScript(() => {
      const first = new Map(),
        get = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key) {
        const value = get.call(this, key);
        if (this !== window.localStorage || typeof key !== "string" || !key.startsWith("archer.authoring.v1:"))
          return value;
        if (!first.has(key) && value !== null) first.set(key, value);
        return first.has(key) ? first.get(key) : value;
      };
      // The withdrawal in other tabs reads the record fresh too; as before, nothing withdraws a stale offer.
      const add = window.addEventListener;
      window.addEventListener = function (type, listener, options) {
        if (type === "storage") return undefined;
        return add.call(this, type, listener, options);
      };
    });
  }
  if (faults.has("hide-closed-work")) {
    await context.addInitScript(() => {
      const hide = () => {
        for (const panel of document.querySelectorAll(".authoring-missing")) {
          for (const b of panel.querySelectorAll("button"))
            if (b.textContent === "Resume them") b.closest("p")?.remove();
          for (const p of panel.querySelectorAll("p[role=status]"))
            if (p.textContent?.includes("from another tab, now closed"))
              p.textContent = p.textContent.replace(
                /Your unsaved changes to it from another tab, now closed, are kept in this browser\./,
                "You have no unsaved changes to it in this browser.",
              );
        }
      };
      new MutationObserver(hide).observe(document, { subtree: true, childList: true, characterData: true });
    });
  }
  if (faults.has("offer-first-listed")) {
    await context.addInitScript(() => {
      const get = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key) {
        const value = get.call(this, key);
        if (
          this !== window.localStorage ||
          typeof key !== "string" ||
          !key.startsWith("archer.authoring.v1:") ||
          value === null
        )
          return value;
        // The journey's own reads (page.evaluate) see the same: they only look at the source.
        try {
          const r = JSON.parse(value);
          delete r.savedAt;
          return JSON.stringify(r);
        } catch {
          return value;
        }
      };
    });
  }
  if (faults.has("inert-resume")) {
    await context.addInitScript(() => {
      document.addEventListener(
        "click",
        (event) => {
          const b = event.target instanceof Element ? event.target.closest("button") : null;
          if (b && b.textContent === "Resume them" && b.closest(".authoring-statusline")) {
            event.stopImmediatePropagation();
            event.preventDefault();
          }
        },
        true,
      );
    });
  }
  if (faults.has("drop-edit-revision")) {
    await context.route("**/api/comments/*/*", async (route) => {
      const req = route.request();
      let body;
      try {
        body = JSON.parse(req.postData() ?? "null");
      } catch {
        body = null;
      }
      if (req.method() !== "PATCH" || body === null || typeof body !== "object" || !("expectedRevision" in body))
        return route.fallback();
      const { expectedRevision: _dropped, ...rest } = body;
      return route.fallback({ postData: JSON.stringify(rest) });
    });
  }
  if (faults.has("drift-comment-revision")) {
    await context.addInitScript(() => {
      try {
        for (const k of Object.keys(localStorage)) {
          if (!k.startsWith("archer.comment-draft.v1:")) continue;
          const d = JSON.parse(localStorage.getItem(k));
          localStorage.setItem(k, JSON.stringify({ ...d, baseRevision: `sha256:${"0".repeat(64)}` }));
        }
      } catch {
        /* blocked */
      }
    });
  }
  if (faults.has("hide-connection-indicator")) {
    await context.addInitScript(() => {
      // Hidden and unmarked, not removed: removing a node React owns would break the page in other ways.
      const strip = () => {
        for (const el of document.querySelectorAll("[data-connection]")) {
          el.removeAttribute("data-connection");
          el.style.display = "none";
        }
      };
      new MutationObserver(strip).observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["data-connection"],
      });
    });
  }
  if (faults.has("claim-any-save")) {
    await context.addInitScript(() => {
      const claim = () => {
        for (const el of document.querySelectorAll('.archer-presence[data-voice="other"]')) {
          el.setAttribute("data-voice", "you");
          const lead = el.querySelector(".archer-presence-lead");
          if (lead && lead.textContent !== "Saved") lead.textContent = "Saved";
        }
      };
      new MutationObserver(claim).observe(document, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["data-voice"],
      });
    });
  }
  if (faults.has("stale-open")) {
    const seen = new Map();
    await context.route("**/api/authoring/open", async (route) => {
      const req = route.request(),
        key = req.postData() ?? "";
      const res = await route.fetch();
      if (res.ok()) {
        const body = await res.text();
        seen.set(key, body);
        return route.fulfill({ response: res, body });
      }
      if (seen.has(key)) return route.fulfill({ status: 200, contentType: "application/json", body: seen.get(key) });
      return route.fulfill({ response: res });
    });
  }
  if (faults.has("hide-missing-source")) {
    const strip = (text) => {
      try {
        const v = JSON.parse(text);
        if (Array.isArray(v?.failures)) v.failures = v.failures.filter((f) => f?.sourceRevision !== null);
        return JSON.stringify(v);
      } catch {
        return text;
      }
    };
    await context.route("**/api/compile", async (route) => {
      const res = await route.fetch();
      return route.fulfill({ response: res, body: strip(await res.text()) });
    });
    await context.addInitScript(`(() => {
      const strip = ${strip.toString()};
      const add = EventSource.prototype.addEventListener;
      EventSource.prototype.addEventListener = function (type, listener, options) {
        if (type !== "compile" || typeof listener !== "function") return add.call(this, type, listener, options);
        return add.call(this, type, (event) => listener.call(this, new MessageEvent("compile", { data: strip(event.data), lastEventId: event.lastEventId, origin: event.origin })), options);
      };
    })();`);
  }
  if (faults.has("skip-revision-check")) {
    // The stub Save: it claims the file's current revision as its base, so the service's revision check passes.
    await context.route("**/api/authoring", async (route) => {
      const req = route.request();
      let body;
      try {
        body = JSON.parse(req.postData() ?? "null");
      } catch {
        body = null;
      }
      if (req.method() !== "POST" || body?.op !== "document.apply") return route.fallback();
      const slug = /\/p\/([^/]+)\/api\/authoring$/.exec(new URL(req.url()).pathname)?.[1];
      const opened = await fetch(new URL(`/p/${slug}/api/authoring/open`, req.url()), {
        method: "POST",
        headers: { ...(await req.allHeaders()), "content-type": "application/json" },
        body: JSON.stringify({ target: body.target }),
      })
        .then((r) => r.json())
        .catch(() => null);
      const current = opened?.sourceRevision ?? body.expectedSourceRevision;
      return route.fallback({
        postData: JSON.stringify({
          ...body,
          expectedSourceRevision: current,
          ...(opened?.targetRevision ? { expectedTargetRevision: opened.targetRevision } : {}),
        }),
      });
    });
  }
  if (faults.has("fresh-save-identity")) {
    // The defect a receipt cannot catch for a Save: the page mints a new identity instead of sending the one it kept.
    await context.route("**/api/authoring", async (route) => {
      const req = route.request();
      let body;
      try {
        body = JSON.parse(req.postData() ?? "null");
      } catch {
        body = null;
      }
      if (req.method() !== "POST" || body?.op !== "document.apply" || typeof body.operationId !== "string")
        return route.fallback();
      return route.fallback({
        postData: JSON.stringify({
          ...body,
          operationId: createHash("sha256")
            .update(`fresh-save-identity:${body.operationId}`)
            .digest("hex")
            .slice(0, 32),
        }),
      });
    });
  }
  if (faults.has("drop-submit-answer")) {
    let dropped = false;
    await context.route("**/api/comments/submit", async (route) => {
      if (dropped || route.request().method() !== "POST") return route.fallback();
      dropped = true;
      await route.fetch();
      await route.abort("connectionreset");
    });
  }
  if (faults.has("repeat-effect")) {
    const repeat = async (route) => {
      const req = route.request();
      if (req.method() !== "POST") return route.fallback();
      await route.fetch();
      // A real double effect: the second send is a NEW operation (ADR 0016). Sent with the same operation id,
      // the service would answer it from its receipt and the fault would be invisible; this models the
      // defect a receipt cannot catch, a page minting a fresh identity for one person action.
      let body = null;
      try {
        body = JSON.parse(req.postData() ?? "");
      } catch {
        body = null;
      }
      const fresh =
        body?.operation?.id === undefined
          ? undefined
          : JSON.stringify({
              ...body,
              operation: {
                ...body.operation,
                id: createHash("sha256").update(`repeat-effect:${body.operation.id}`).digest("hex").slice(0, 32),
              },
            });
      const second = await route.fetch(fresh === undefined ? {} : { postData: fresh });
      return route.fulfill({ response: second });
    };
    await context.route("**/api/comments", repeat);
    await context.route("**/api/comments/submit", repeat);
  }
}

/** The journey's last step: every recorded collector check held. Lists the ones that did not. */
export async function assertFlowChecks({ step, run, flow }) {
  // With the journey's trace recorder this is its goal: the mandatory outcome is that every collector check held.
  const as = flow ? (title, fn) => flow.goal(title, fn) : step;
  return as("flow collectors: every check held", async () => {
    const bad = (run.flowState?.checks ?? []).filter((c) => !c.ok);
    if (bad.length)
      throw new Error(
        `collector checks failed: ${bad.map((c) => `${c.gate}@${c.boundary}${c.problem ? ` (${c.problem})` : c.problems ? ` (${c.problems.join("; ")})` : c.diffs ? ` (${c.diffs.map((d) => d.field).join(", ")} differ)` : ""}`).join("; ")}`,
      );
    return run.flowState?.checks?.length ?? 0;
  });
}
