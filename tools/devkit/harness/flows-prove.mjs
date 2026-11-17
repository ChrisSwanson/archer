#!/usr/bin/env node
// User-flows rubric §8: "Before a collector is used to score, it is shown working on a known passing case and on a
// known failing one. The known failing case is a seeded fault." This runs each state-and-recovery collector's
// journey twice against a sandbox, clean and with its seeded fault (ARCHER_FLOWS_FAULT, see
// tools/devkit/harness/flows-state.mjs), and checks that the clean run's check holds and the faulted run's same
// check does not. It judges the collector, not the product: a journey that fails elsewhere on a product defect
// still proves its collector when the named check behaves as stated.
//
//   node tools/devkit/harness/flows-prove.mjs --sandbox <name> [--queued-sandbox <name>] [--only G2] [--json]
//
// A case marked `submission: "queued"` runs on the queued sandbox (comment_submission = "queued"); without
// --queued-sandbox it is reported NOT RUN and does not count as proven.
//
// Exit 1 when any collector did not behave as stated.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { list } from "../sandbox.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const J = (f) => join(REPO, "tools/devkit/journeys/flows", f);

/** collector, journey, fault, the check (gate + boundary prefix) that must hold clean and fail with the fault. */
export const CASES = [
  {
    collector: "G1 editor draft",
    journey: J("j09-interrupted-edit.mjs"),
    fault: "drop-draft",
    gate: "G1",
    boundary: "reload",
  },
  {
    collector: "G1 comment draft",
    journey: J("j08b-service-restart.mjs"),
    fault: "drop-comment-draft",
    gate: "G1",
    boundary: "service down (restart): before Add comment",
  },
  {
    collector: "G1 kept comment draft (reload)",
    journey: J("j09c-interrupted-comment.mjs"),
    fault: "drop-comment-draft",
    gate: "G1",
    boundary: "reload",
  },
  {
    collector: "G1 kept reply draft (reload)",
    journey: J("j09c-interrupted-comment.mjs"),
    fault: "drop-comment-draft",
    gate: "G1",
    boundary: "reply: reload",
  },
  {
    collector: "G1 kept comment revision (reload)",
    journey: J("j09c-interrupted-comment.mjs"),
    fault: "drift-comment-revision",
    gate: "G1",
    boundary: "reload",
  },
  {
    collector: "G4 status before Save is not Saved (J6, PC-09)",
    journey: J("j06-edit-save.mjs"),
    fault: "claim-any-save",
    gate: "G4",
    boundary: "before Save: the reading page does not say Saved",
  },
  {
    collector: "G2 external write",
    journey: J("j07a-external-write.mjs"),
    fault: "skip-revision-check",
    gate: "G2",
    boundary: "stale save after an external write",
  },
  {
    collector: "G2 coordinated saves",
    journey: J("j07b-coordinated-saves.mjs"),
    fault: "skip-revision-check",
    gate: "G2",
    boundary: "sequential: the second save from the same base",
  },
  {
    collector: "G4/U5 disconnection indicator",
    journey: J("j08b-service-restart.mjs"),
    fault: "hide-connection-indicator",
    gate: "G4",
    boundary: "service down (restart): disconnection indicator present",
  },
  {
    collector: "G5 effect count",
    journey: J("j08d-lost-response.mjs"),
    fault: "repeat-effect",
    gate: "G5",
    boundary: "control: one comment, one effect",
  },
  {
    collector: "G5 same-operation replay (create)",
    journey: J("j08d-lost-response.mjs"),
    fault: "repeat-effect",
    gate: "G5",
    boundary: "answer lost, the same operation resent before restart: answered from its receipt, one effect",
  },
  {
    collector: "G5 same-operation replay (send, queued)",
    journey: J("j08d-lost-response.mjs"),
    fault: "repeat-effect",
    gate: "G5",
    boundary: "send answer lost, the same send resent before restart: answered from its receipt, sent once",
    submission: "queued",
  },
  {
    collector: "G5 held offline save keeps its identity (J9d)",
    journey: J("j09d-offline-save.mjs"),
    fault: "fresh-save-identity",
    gate: "G5",
    boundary: "back online: the held save is sent once, under its kept identity",
  },
  {
    collector: "G5 a save that never reached Archer is sent again under its identity (J9d, claude-11)",
    journey: J("j09d-offline-save.mjs"),
    fault: "fresh-save-identity",
    gate: "G5",
    boundary: "save never received: Save again sends the same operation, saved once",
  },
  {
    collector: "G1 work on a deleted file stays reachable (J9d, claude-203)",
    journey: J("j09d-offline-save.mjs"),
    fault: "drop-draft",
    gate: "G1",
    boundary: "file deleted before reopen: the person's text is shown, with Copy",
  },
  {
    collector: "G5 a held save is not sent to a deleted file (J9d, claude-203)",
    journey: J("j09d-offline-save.mjs"),
    fault: "stale-open",
    gate: "G5",
    boundary: "file deleted before reopen: the held save is not sent to the missing file",
  },
  {
    collector: "G2 held offline save after an outside write (J9d)",
    journey: J("j09d-offline-save.mjs"),
    fault: "skip-revision-check",
    gate: "G2",
    boundary: "offline save, outside write meanwhile: refused, nothing overwritten, text kept",
  },
  {
    collector: "G4 notice by a failed write (J8a v1.1)",
    journey: J("j08a2-network-stall.mjs"),
    fault: "hang-stalled-write",
    gate: "G4",
    boundary: "network stalled, first failed write: disconnection indicator present",
  },
  {
    collector: "U7 stable presented link (claude-08)",
    journey: J("j11-agent-shows.mjs"),
    fault: "follow-presented-link",
    gate: "U7",
    boundary: "stable link: a fresh context opens the presented view and emphasis after another present",
  },
  {
    collector: "G4 a deleted registered diagram's link says it is gone (J11, claude-204)",
    journey: J("j11-agent-shows.mjs"),
    fault: "hide-missing-source",
    gate: "G4",
    boundary: "removed file: the link says the file is gone, dates no change and offers no Edit",
  },
  {
    collector: "U6 pairing return (claude-09)",
    journey: J("j01-first-entry.mjs"),
    fault: "drop-pairing-return",
    gate: "U6",
    boundary: "pairing from a refused address: lands on that address",
  },
  {
    collector: "G1 kept chat draft (reload, codex-201)",
    journey: J("j09e-chat-drafts.mjs"),
    fault: "drop-comment-draft",
    gate: "G1",
    boundary: "chat: reload",
  },
  {
    collector: "G1 chat draft, second open tab (claude-201)",
    journey: J("j09e-chat-drafts.mjs"),
    fault: "ignore-open-tabs",
    gate: "G1",
    boundary: "chat: a second open tab is not given the first tab's text, and is told where it is",
  },
  {
    collector: "G1 kept edit of a comment (reload, O111)",
    journey: J("j09c-interrupted-comment.mjs"),
    fault: "drop-edit-draft",
    gate: "G1",
    boundary: "edit: reload",
  },
  {
    collector: "G4 edit of a comment changed meanwhile is said (O111)",
    journey: J("j09c-interrupted-comment.mjs"),
    fault: "hide-edit-changed",
    gate: "G4",
    boundary:
      "edit: changed meanwhile, then reload: said, with what the comment reads now, and Save says it replaces it",
  },
  {
    collector: "G1 Resume in two tabs: a stale offer never takes a live copy (codex-401, claude-401)",
    journey: J("j09-interrupted-edit.mjs"),
    fault: "stale-recovery-read",
    gate: "G1",
    boundary: "resume, two tabs: the first keeps the closed tab's work and its own; the second never takes it",
  },
  {
    collector: "G1 Resume from a full draft address shows the work at once (codex-403, claude-402)",
    journey: J("j09-interrupted-edit.mjs"),
    fault: "inert-resume",
    gate: "G1",
    boundary:
      "resume, full draft address: Resume shows the closed tab's work at once, under the draft the address names, not Saved",
  },
  {
    collector: "G1 several closed copies: the newest is offered, the others kept (O137)",
    journey: J("j09-interrupted-edit.mjs"),
    fault: "offer-first-listed",
    gate: "G1",
    boundary: "three closed copies: the newest is offered, the 2 others named and listed, and Resume keeps them",
  },
  {
    collector: "G1 file deleted, opened in a new tab: the closed tab's work is offered (claude-403)",
    journey: J("j09d-offline-save.mjs"),
    fault: "hide-closed-work",
    gate: "G1",
    boundary:
      "file deleted, new tab: the gone screen offers the closed tab's work, and Resume them shows it with Save as a new diagram here",
  },
  {
    collector: "G1 a closed tab's held save is offered in a new tab on a kept file (J9d, claude-501)",
    journey: J("j09d-offline-save.mjs"),
    fault: "hide-pending-copies",
    gate: "G1",
    boundary:
      "kept file, new tab (held): the closed tab's save is offered on the plain edit address, named as a save, nothing sent before Resume",
  },
  {
    collector: "G1 a closed tab's unconfirmed save is offered in a new tab on a kept file (J9d, claude-501)",
    journey: J("j09d-offline-save.mjs"),
    fault: "hide-pending-copies",
    gate: "G1",
    boundary:
      "kept file, new tab (lost answer): the closed tab's save is offered on the plain edit address, named as a save, nothing sent before Resume",
  },
  {
    collector: "G1 a non-primary copy resumed elsewhere leaves the list (J9, codex-502)",
    journey: J("j09-interrupted-edit.mjs"),
    fault: "drop-copy-withdrawal",
    gate: "G1",
    boundary:
      "copy rows: a non-primary copy resumed in another tab leaves this tab's list at once, the count follows, and that tab is named",
  },
  {
    collector: "G4 a late resolve after the last check stays not known, then settles (codex-501)",
    journey: J("late-write.mjs"),
    fault: "definite-late-refusal",
    gate: "G4",
    boundary: "late resolve, after the last check: not known, what was last seen and when, never a definite did not",
  },
  {
    collector: "G4 a late resolve delivered after the last check is settled by the next listing (codex-501)",
    journey: J("late-write.mjs"),
    fault: "definite-late-refusal",
    gate: "G4",
    boundary:
      "late resolve, delivered after the last check: the next listing settles it, the message goes, and the thread is resolved",
  },
  {
    collector: "G2 comment edit over a change the page had not seen (O124)",
    journey: J("j09c-interrupted-comment.mjs"),
    fault: "drop-edit-revision",
    gate: "G2",
    boundary:
      "edit: a change the page had not seen: refused, not written over, and Save over it offered with what it reads",
  },
  {
    collector: "G1 comment draft, second open tab (claude-201)",
    journey: J("j09c-interrupted-comment.mjs"),
    fault: "ignore-open-tabs",
    gate: "G1",
    boundary: "two tabs: the second tab is not given the first tab's live text, and is told where it is",
  },
  {
    collector: "G5 chat lost create, Send again (codex-202)",
    journey: J("j08e-chat-lost-response.mjs"),
    fault: "fresh-operation-identity",
    gate: "G5",
    boundary: "chat create answer lost, Send again: the same operation, one effect",
  },
  {
    collector: "G5 chat lost reply, Send again (codex-202)",
    journey: J("j08e-chat-lost-response.mjs"),
    fault: "fresh-operation-identity",
    gate: "G5",
    boundary: "chat reply answer lost, Send again: the same operation, one effect",
  },
  {
    collector: "G4 chat lost submit status (codex-202, queued)",
    journey: J("j08e-chat-lost-response.mjs"),
    fault: "false-chat-status",
    gate: "G4",
    boundary: "chat submit answer lost: the final status is true (sent, read back), not Not sent",
    submission: "queued",
  },
  {
    collector: "G5 chat lost, then reload (claude-202)",
    journey: J("j08e-chat-lost-response.mjs"),
    fault: "forget-operation-hold",
    gate: "G5",
    boundary: "chat lost, then reload: Send is the same message, one effect",
  },
  {
    collector: "G5 comment lost, then reload (claude-202)",
    journey: J("j08d-lost-response.mjs"),
    fault: "forget-operation-hold",
    gate: "G5",
    boundary: "lost, then reload: the page's own resend is the same comment, one effect",
  },
  {
    collector: "G5 two tabs, the same words: two comments (codex-301)",
    journey: J("j08d-lost-response.mjs"),
    fault: "content-keyed-identity",
    gate: "G5",
    boundary: "two tabs, the same words, A's answers lost: two comments, each once",
  },
  {
    collector: "G5 two tabs, the same words: two comments (codex-301, queued)",
    journey: J("j08d-lost-response.mjs"),
    fault: "content-keyed-identity",
    gate: "G5",
    boundary: "two tabs, the same words, A's answers lost: two comments, each once",
    submission: "queued",
  },
  {
    collector: "G1 duplicated tab, comment (claude-301)",
    journey: J("j09c-interrupted-comment.mjs"),
    fault: "shared-owner-id",
    gate: "G1",
    boundary: "duplicated tab: not given the first tab's live text, and told it is written in another tab",
  },
  {
    collector: "G1 busy owner tab (claude-302)",
    journey: J("j09c-interrupted-comment.mjs"),
    fault: "threshold-takeover",
    gate: "G1",
    boundary: "busy tab: a tab busy for seconds is still open: a new tab is told, not offered or given its text",
  },
  {
    collector: "G1 another tab's draft is not restored by itself (O117)",
    journey: J("j09c-interrupted-comment.mjs"),
    fault: "auto-restore-other",
    gate: "G1",
    boundary: "two tabs: the second tab is not given the first tab's live text, and is told where it is",
  },
  {
    collector: "G1 duplicated tab, chat (claude-301)",
    journey: J("j09e-chat-drafts.mjs"),
    fault: "shared-owner-id",
    gate: "G1",
    boundary: "chat: a duplicated tab is not given the first tab's text, and is told where it is",
  },
  {
    collector: "G1 duplicated editor tab (claude-303)",
    journey: J("j09-interrupted-edit.mjs"),
    fault: "shared-owner-id",
    gate: "G1",
    boundary: "duplicated editor tab: not given the first tab's unsaved change, and told it is open in another tab",
  },
  {
    collector: "G1 editor draft of an open tab not offered (claude-303)",
    journey: J("j09-interrupted-edit.mjs"),
    fault: "ignore-open-tabs",
    gate: "G1",
    boundary: "plain edit address, the draft's tab open: not offered, said to be open in another tab",
  },
  {
    collector: "G4 lost save says Saved (PC-03)",
    journey: J("j08d-lost-response.mjs"),
    fault: "hide-saved-claim",
    gate: "G4",
    boundary: "save answer lost: the final status is true (saved, or uncertain)",
  },
  {
    collector: "G4 stall notice within 45 s (PC-08)",
    journey: J("j08a2-network-stall.mjs"),
    fault: "late-stall-notice",
    gate: "G4",
    boundary: "network stalled: disconnection indicator present",
  },
];

function run(sandbox, journey, fault) {
  const env = { ...process.env };
  if (fault) env.ARCHER_FLOWS_FAULT = fault;
  else delete env.ARCHER_FLOWS_FAULT;
  const r = spawnSync(
    process.execPath,
    [
      join(REPO, "tools/devkit/harness/smoke.mjs"),
      "--sandbox",
      sandbox,
      "--keep-going",
      "--json",
      "--journey",
      journey,
    ],
    { cwd: REPO, env, encoding: "utf8", timeout: 10 * 60_000 },
  );
  const line = r.stdout
    .trim()
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .pop();
  if (!line)
    throw new Error(`smoke.mjs printed no summary for ${journey} (${fault ?? "clean"}): ${r.stderr.slice(-500)}`);
  const { summary: path, ok } = JSON.parse(line);
  const summary = JSON.parse(readFileSync(path, "utf8"));
  return { ok, path, faults: summary.flowState?.faults ?? [], checks: summary.flowState?.checks ?? [] };
}

/** Whether the sandbox's service is running. An isolated service stops itself after 30 min idle (service.ts), so a
 * queued sandbox left unused while the immediate cases run could be gone by its next case (O123). A sandbox started
 * since O126 has no idle stop; this still says NOT RUN for one that stopped otherwise (a crash, `stop`). */
const running = (name) => list().some((r) => r.name === name && r.running);

const find = (checks, c) => checks.filter((x) => x.gate === c.gate && x.boundary === c.boundary);

async function main() {
  const { values } = parseArgs({
    options: {
      sandbox: { type: "string" },
      "queued-sandbox": { type: "string" },
      only: { type: "string" },
      json: { type: "boolean" },
    },
  });
  if (!values.sandbox) {
    process.stderr.write("usage: flows-prove.mjs --sandbox <name> [--queued-sandbox <name>] [--only G2] [--json]\n");
    process.exit(2);
  }
  const results = [];
  for (const c of CASES.filter((x) => !values.only || x.collector.startsWith(values.only))) {
    const sandbox = c.submission === "queued" ? values["queued-sandbox"] : values.sandbox;
    if (sandbox === undefined) {
      results.push({
        collector: c.collector,
        journey: c.journey.slice(REPO.length + 1),
        fault: c.fault,
        check: `${c.gate}@${c.boundary}`,
        proven: false,
        notRun: "needs --queued-sandbox",
      });
      if (!values.json) process.stdout.write(`NOT RUN    ${c.collector}: needs --queued-sandbox\n`);
      continue;
    }
    if (!running(sandbox)) {
      results.push({
        collector: c.collector,
        journey: c.journey.slice(REPO.length + 1),
        fault: c.fault,
        check: `${c.gate}@${c.boundary}`,
        proven: false,
        notRun: `sandbox ${sandbox} is not running (an isolated service stops after 30 min idle)`,
      });
      if (!values.json) process.stdout.write(`NOT RUN    ${c.collector}: sandbox ${sandbox} is not running\n`);
      continue;
    }
    const clean = run(sandbox, c.journey, null),
      seeded = run(sandbox, c.journey, c.fault);
    const a = find(clean.checks, c),
      b = find(seeded.checks, c);
    const passHolds = a.length > 0 && a.every((x) => x.ok),
      faultCaught = b.length > 0 && b.some((x) => !x.ok) && seeded.faults.includes(c.fault);
    const proven = passHolds && faultCaught;
    results.push({
      collector: c.collector,
      journey: c.journey.slice(REPO.length + 1),
      fault: c.fault,
      check: `${c.gate}@${c.boundary}`,
      proven,
      knownPass: { holds: passHolds, summary: clean.path },
      seededFault: {
        caught: faultCaught,
        summary: seeded.path,
        problems: b.map((x) => x.problems ?? x.problem ?? x.diffs ?? null),
      },
    });
    if (!values.json)
      process.stdout.write(
        `${proven ? "PROVEN " : "NOT PROVEN"} ${c.collector}: clean ${passHolds ? "holds" : "DOES NOT HOLD"}, ${c.fault} ${faultCaught ? "caught" : "NOT CAUGHT"}  (${c.gate}@${c.boundary})\n  clean:  ${clean.path}\n  seeded: ${seeded.path}\n`,
      );
  }
  if (values.json) process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  process.exitCode = results.every((r) => r.proven || r.notRun === "needs --queued-sandbox") ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
