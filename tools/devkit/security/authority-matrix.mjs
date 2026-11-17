#!/usr/bin/env node
// The G3 effect matrix (security rubric §1 matrix, G3, G6; probes P1 and P10): every write surface ×
// credential × `edit` on/off × account write rule allow/deny × path class, judged on what each cell did.
//
//   node --import tsx tools/devkit/security/authority-matrix.mjs --name eg3-<n> [--out <dir>] [--keep]
//        [--seed <seed>] [--only <regex>] [--phases <id,…>] [--transports cli,mcp] [--other-account] [--lifecycle]
//        [--network-netns] [--allow-known-defects] [--quiet-ms <ms>] [--after-quiet-ms <ms>] [--consume-cap-ms <ms>]
//
// --name: a sandbox this tool owns. If it is not running, it is brought up (`sandbox.mjs up --tls`)
// with the fixture project (authority-matrix-model.mjs FIXTURE_FILES) and brought down at the end
// unless --keep. An already running sandbox must hold the fixture project.
//
// Surfaces:
// - http: the browser writers (authoring apply/publish/layout, drafts and proposals, comments and their thread
//   mutations, note highlights, archive/show, settings, listener pin and Launch, selection, walkthrough
//   position) with each §1 column (none, grant cookie/Bearer, service token cookie/Bearer, revoked,
//   and the retired service token path, which must admit nothing);
// - cli / mcp: every state-changing management operation through `archer call` and `archer mcp`
//   (the relay into the service): content writes, registration, comments, highlights, walkthroughs, the
//   docs index, presentation state, grants, attach/detach and network access;
// - socket: the raw socket's grant, emphasis, attach, recordWrite, change/review, selection, present and
//   listener/agent methods; with --other-account, another OS account's connection (other-account-socket.mjs, Docker);
// - with --lifecycle, stop_service and handover, each on a service of its own.
// Phases: edit on/off × all rules allow/deny, plus each rule denied alone (composite rules isolated).
// A refusal must change nothing in the project, the account config or the service state; the only state a
// refusal may change is content-checked (continuityAgedOnly, listenersHousekeepingOnly) and counted in the
// report. Rows that cannot run are reported as NOT EVALUATED with their reason (NOT_EVALUATED).
// Every mismatch that involves a state path carries `stateDiff` (credential-free; stateDiff below).
// - http→management: every management-only operation and socket method asked of HTTP.
// Each in four phases (edit on/off × rules allow/deny, switched by file edits with no restart) and per
// path class: inside the Archer folder, outside it, a symlink, a hard link, a linked directory, a
// symlinked sidecar or note. Each cell snapshots the project, the canary outside it, the account config
// and the state directory before and after (settled), and runs the row's own effect check: an admitted
// cell must show its effect (the file hash changed, the grant works), a refused one none.
//
// Seeds (a known fail, to prove the tool reports one): rule-not-applied:<rule> (the deny phase leaves that
// rule on, as if the product ignored it), edit-not-applied (edit-off phases leave edit on),
// phantom-write:<row> (after each refused cell of that row a byte is written, as if a refusal still wrote),
// lost-write:<row> (each admitted cell's write is undone, as if an answer lied about its effect),
// refused-with-state-change (after each refused cell the service's private lifecycle record, once it exists, gains a
// byte: a refusal that changed only service state, which the judge once missed), and the X-20 housekeeping seeds
// (codex-rescore5), each a refusal's state change dressed as housekeeping: housekeeping:drop-fresh-announcement (an
// announcement made just before the cell is removed after it), housekeeping:continuity-version (version 1 → 2, the
// writes kept), housekeeping:drop-fresh-agent (an agent registered just before is removed), housekeeping:backdate-agent
// (its lastActive set to 2001).
//
// Barriers: every before-snapshot waits until nothing has changed for --quiet-ms (600) and every after-snapshot for
// --after-quiet-ms (400), sampling every 100 ms. Silence alone is not a finished reload (X-21, codex-rescore6): before
// that, every Markdown or Mermaid file the tool changed since the last cell's barrier (a prepare's note or removed index)
// must be in the service's persisted continuity baseline at the disk's revision, or gone from it (consumedBarrier). A
// cell whose change is not consumed within --consume-cap-ms (15000) is NOT EVALUATED with its reason, and fails the run.
//
// --lifecycle: also runs stop_service (CLI, on a second throwaway sandbox) and the socket's handover (ending this one).
// --network-netns: also runs setup_network_access with the person's yes in a private network namespace
// (network-access-netns.mjs); without it, or where no namespace can be made, that row is NOT EVALUATED with the reason.
// Results go to --out (results.json, results.md); every secret is redacted. Exit 1 on any mismatch; with
// --allow-known-defects, mismatches that are all listed product defects (KNOWN_PRODUCT_DEFECTS) exit 0, still reported.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  CANARY_FILES,
  changedPaths,
  consumedBarrier,
  recoveryDiff,
  ruleDenies,
  CONTINUITY,
  continuityAgedOnly,
  deniedRules,
  LISTENERS,
  listenersHousekeepingOnly,
  expectedHttp,
  expectedHttpCode,
  expectedManagement,
  FIXTURE_FILES,
  FIXTURE_NAME,
  HTTP_COLUMNS,
  judge,
  LINKS,
  markdown,
  PHASES,
  phaseRuns,
  snapshot,
  summarise,
  TRANSPORTS,
} from "./authority-matrix-model.mjs";
import { credentialsFor, loadRegistries, request } from "./inventory.mjs";
import { cliCall, mcpSession, socketSession } from "./lib/agent-clients.mjs";
import { cookiePair, redact, sandboxRecord, send } from "./lib/client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const ZERO = `sha256:${"0".repeat(64)}`;
const id16 = () => randomBytes(16).toString("hex");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const SAMPLE_MS = 100,
  QUIET_CAP_MS = 8_000,
  CONSUME_CAP_MS = 15_000;

// ------------------------------------------------------------------ rows

const FLOW_COMMENTS = "project:.archer/diagrams/flow.comments.json";
const AUTHORING_INDEX = "state:runtime/authoring/index.json";
const CHANGE_REVIEW = "state:runtime/change-review/index.json";

/** HTTP writers. `send(ctx, column, prepared)` returns the response; `effect` names what an admitted cell must change. */
const authoringApply = (viewTarget, source) => ({
  prepare: async (ctx) => ({ opened: await ctx.open(viewTarget), generation: await ctx.generation(), n: ctx.uniq() }),
  send: (ctx, column, s) =>
    ctx.api(column, "POST", "authoring", {
      journalGeneration: s.generation,
      op: "document.apply",
      operationId: id16(),
      target: s.opened?.target ?? viewTarget,
      expectedTargetRevision: s.opened?.targetRevision ?? ZERO,
      expectedSourceRevision: s.opened?.sourceRevision ?? ZERO,
      source: source(s.n),
    }),
});
const publish = (file) => ({
  prepare: async (ctx) => {
    const n = ctx.uniq();
    return { generation: await ctx.generation(), file: file(n), n };
  },
  send: (ctx, column, s) =>
    ctx.api(column, "POST", "authoring", {
      journalGeneration: s.generation,
      op: "document.publish",
      operationId: id16(),
      path: s.file,
      source: `flowchart LR\n  a[New ${s.n}] e1@--> b[B]\n`,
    }),
});
const httpComment = (target) => ({
  send: (ctx, column) =>
    ctx.api(column, "POST", "comments", { target, anchor: { kind: "view" }, body: `matrix comment ${ctx.uniq()}` }),
});
// The page's operation form (ADR 0016): the same authority as the legacy create, with a fresh identity per cell.
const httpCommentOnce = (target) => ({
  send: (ctx, column) =>
    ctx.api(column, "POST", "comments", {
      operation: { id: id16(), issuedAt: Date.now(), name: "comment.create", target },
      payload: { target, anchor: { kind: "view" }, body: `matrix comment ${ctx.uniq()}` },
    }),
});
const passage = { kind: "passage", quote: "tokens", prefix: "A passage about ", suffix: "." };
const highlight = (notePath, ctxRevision) => ({
  prepare: async (ctx) => ({ revision: ctxRevision ? await ctx.noteEmphasisRevision(notePath) : 0, n: ctx.uniq() }),
  send: (ctx, column, s) =>
    ctx.api(column, "POST", `note-emphases?path=${encodeURIComponent(notePath)}`, {
      notePath,
      id: "matrix-person",
      title: `H${s.n}`,
      groups: [{ id: "g", label: "G", description: "D", passages: [passage] }],
      expectedRevision: s.revision,
    }),
});

export const HTTP_ROWS = [
  {
    id: "apply-standalone",
    capability: "edit",
    rules: ["diagrams"],
    path: "admit",
    pathClass: "inside",
    files: ["project:.archer/diagrams/flow.mmd"],
    ...authoringApply({ kind: "view", viewId: "flow" }, (n) => `flowchart LR\n  a[Client ${n}] e1@--> b[API]\n`),
  },
  {
    id: "apply-embedded",
    capability: "edit",
    rules: ["notes"],
    path: "admit",
    pathClass: "inside",
    files: ["project:.archer/notes/note.md"],
    ...authoringApply(
      { kind: "embedded", address: "notes/note.md#pinned" },
      (n) => `flowchart LR\n  a[A ${n}] e1@--> b[B]\n`,
    ),
  },
  {
    id: "apply-hardlinked-view",
    capability: "edit",
    rules: ["diagrams"],
    path: "refuse",
    pathClass: "linked-hardlink",
    files: [],
    ...authoringApply({ kind: "view", viewId: "hard" }, (n) => `flowchart LR\n  a[Hard ${n}] e1@--> b[B]\n`),
  },
  {
    id: "publish-inside",
    capability: "edit",
    rules: ["diagrams"],
    path: "admit",
    pathClass: "inside",
    files: (s) => [`project:.archer/${s.file}`],
    ...publish((n) => `diagrams/new-${n}.mmd`),
  },
  {
    id: "publish-folder-root",
    capability: "edit",
    rules: ["diagrams"],
    path: "refuse",
    pathClass: "inside-not-creatable",
    files: [],
    ...publish((n) => `other-${n}.mmd`),
  },
  {
    id: "publish-outside",
    capability: "edit",
    rules: ["diagrams"],
    path: "refuse",
    pathClass: "outside",
    files: [],
    ...publish((n) => `../escape-${n}.mmd`),
  },
  {
    id: "publish-linked-dir",
    capability: "edit",
    rules: ["diagrams"],
    path: "refuse",
    pathClass: "linked-dir",
    files: [],
    ...publish((n) => `diagrams/linkdir/new-${n}.mmd`),
  },
  {
    id: "publish-onto-symlink",
    capability: "edit",
    rules: ["diagrams"],
    path: "refuse",
    pathClass: "linked-symlink",
    files: [],
    ...publish(() => "diagrams/linked.mmd"),
  },
  {
    id: "layout-save",
    capability: "edit",
    rules: ["diagrams"],
    path: "admit",
    pathClass: "inside",
    files: [],
    prepare: async (ctx) => {
      const opened = await ctx.open({ kind: "view", viewId: "flow" });
      return { opened, before: await ctx.presentationRevision(opened), n: ctx.uniq() };
    },
    send: (ctx, column, s) =>
      ctx.api(column, "POST", "authoring/presentation", {
        op: "save",
        target: s.opened.target,
        expectedTargetRevision: s.opened.targetRevision,
        sourceRevision: s.opened.sourceRevision,
        expectedRevision: s.before,
        positions: { a: { x: 10 + s.n, y: 20 }, b: { x: 300, y: 40 + s.n } },
      }),
    verify: async (ctx, s) => (await ctx.presentationRevision(s.opened)) !== s.before,
  },
  {
    id: "comment-view",
    capability: "comment",
    rules: ["comments"],
    path: "admit",
    pathClass: "inside",
    files: ["project:.archer/diagrams/flow.comments.json"],
    ...httpComment("view:flow"),
  },
  {
    id: "comment-view-operation",
    capability: "comment",
    rules: ["comments"],
    path: "admit",
    pathClass: "inside",
    files: ["project:.archer/diagrams/flow.comments.json"],
    ...httpCommentOnce("view:flow"),
  },
  {
    id: "comment-note",
    capability: "comment",
    rules: ["comments"],
    path: "admit",
    pathClass: "inside",
    files: ["project:.archer/notes/note.comments.json"],
    ...httpComment("note:notes/note.md"),
  },
  // The view's source is a hard link, but its comment sidecar is its own new file in the folder: a comment lands there (G6 holds; the canary is hashed).
  {
    id: "comment-hardlinked-view",
    capability: "comment",
    rules: ["comments"],
    path: "admit",
    pathClass: "linked-hardlink",
    files: ["project:.archer/diagrams/hard.comments.json"],
    ...httpComment("view:hard"),
  },
  {
    id: "comment-symlinked-sidecar",
    capability: "comment",
    rules: ["comments"],
    path: "refuse",
    pathClass: "linked-symlink",
    files: [],
    ...httpComment("view:loose"),
  },
  {
    id: "comment-outside",
    capability: "comment",
    rules: ["comments"],
    path: "refuse",
    pathClass: "outside",
    files: [],
    ...httpComment("note:../README.md"),
  },
  {
    id: "highlight-note",
    capability: "comment",
    rules: ["emphasis"],
    path: "admit",
    pathClass: "inside",
    files: ["project:.archer/notes/note.md.emphases.json"],
    ...highlight("notes/note.md", true),
  },
  {
    id: "highlight-outside",
    capability: "comment",
    rules: ["emphasis"],
    path: "refuse",
    pathClass: "outside",
    files: [],
    ...highlight("../README.md", false),
  },
  {
    id: "highlight-symlinked-note",
    capability: "comment",
    rules: ["emphasis"],
    path: "refuse",
    pathClass: "linked-symlink",
    files: [],
    ...highlight("notes/linked.md", false),
  },
  {
    id: "archive-project",
    capability: "lifecycle",
    rules: [],
    path: "admit",
    pathClass: "state",
    files: ["state:runtime/project-lifecycle.json"],
    send: (ctx, column) => ctx.api(column, "POST", "project-lifecycle", { slug: ctx.slug, action: "archive" }),
    after: async (ctx, admitted) => {
      if (admitted) await ctx.api("grant-cookie", "POST", "project-lifecycle", { slug: ctx.slug, action: "show" });
    },
  },
  // comments/submit (http.ts commentsAndNotes, comments/store.ts submit): a draft becomes sent. Drafts exist only under the
  // account's `comment_submission = "queued"` (config/index.ts), so this row runs with it (`queued`), and each prepare makes
  // its own draft with the policy open. The effect: the draft's file changes and the thread reads sent; a refusal leaves it a draft.
  {
    id: "comment-submit",
    capability: "comment",
    rules: ["comments"],
    path: "admit",
    pathClass: "inside",
    files: [FLOW_COMMENTS],
    queued: true,
    prepare: (ctx) => ctx.draftThread(),
    send: (ctx, column, s) => ctx.api(column, "POST", "comments/submit", { threadId: s.id }),
    verify: (ctx, s) => ctx.threadStatus(s.id) === "sent",
  },
  // Comment-thread mutations (http.ts commentsAndNotes): every admitted credential, the `comments` rule, never the edit switch.
  // Each prepare makes its own thread with the policy open, so the cell's own request is the only thing judged.
  {
    id: "comment-reply",
    capability: "comment",
    rules: ["comments"],
    path: "admit",
    pathClass: "inside",
    files: [FLOW_COMMENTS],
    // Its own thread: person replies on the agents' reply thread would be delivered to the next MCP door and bump its revision.
    send: (ctx, column) =>
      ctx.api(column, "POST", `comments/${ctx.replyThread}/replies`, { body: `matrix reply ${ctx.uniq()}` }),
  },
  {
    id: "comment-patch",
    capability: "comment",
    rules: ["comments"],
    path: "admit",
    pathClass: "inside",
    files: [FLOW_COMMENTS],
    prepare: (ctx) => ctx.newThread(),
    send: (ctx, column, s) =>
      ctx.api(column, "PATCH", `comments/${s.id}/${s.commentId}`, { body: `edited ${ctx.uniq()}` }),
  },
  {
    id: "comment-delete",
    capability: "comment",
    rules: ["comments"],
    path: "admit",
    pathClass: "inside",
    files: [FLOW_COMMENTS],
    prepare: (ctx) => ctx.newThread(),
    send: (ctx, column, s) => ctx.api(column, "DELETE", `comments/${s.id}/${s.commentId}`),
  },
  {
    id: "comment-resolve",
    capability: "comment",
    rules: ["comments"],
    path: "admit",
    pathClass: "inside",
    files: [FLOW_COMMENTS],
    prepare: (ctx) => ctx.newThread(),
    send: (ctx, column, s) => ctx.api(column, "POST", `comments/${s.id}/resolve`),
  },
  {
    id: "comment-dismiss",
    capability: "comment",
    rules: ["comments"],
    path: "admit",
    pathClass: "inside",
    files: [FLOW_COMMENTS],
    prepare: (ctx) => ctx.agentResolvedThread(),
    send: (ctx, column, s) => ctx.api(column, "POST", `comments/${s.id}/dismiss`),
  },
  // A comment on an embedded diagram whose name is not yet in its note pins it: `comments` ∧ `notes` (ADR 0028).
  {
    id: "comment-unpinned-embedded",
    capability: "comment",
    rules: ["comments", "notes"],
    path: "admit",
    pathClass: "inside-pin",
    files: (s) => s.files,
    prepare: (ctx) => ctx.freshEmbedded(),
    send: (ctx, column, s) =>
      ctx.api(column, "POST", "comments", { target: `view:${s.viewId}`, anchor: { kind: "view" }, body: `pin ${s.n}` }),
  },
  // Note highlights have no DELETE: clearing a set is a POST with no groups. The DELETE method itself must be refused.
  {
    id: "highlight-clear",
    capability: "comment",
    rules: ["emphasis"],
    path: "admit",
    pathClass: "inside",
    files: ["project:.archer/notes/note.md.emphases.json"],
    prepare: (ctx) => ctx.highlightSet("matrix-clear"),
    send: (ctx, column, s) =>
      ctx.api(column, "POST", `note-emphases?path=${encodeURIComponent("notes/note.md")}`, {
        notePath: "notes/note.md",
        id: "matrix-clear",
        groups: [],
        expectedRevision: s.revision,
      }),
  },
  {
    id: "highlight-delete-method",
    capability: "comment",
    rules: ["emphasis"],
    path: "refuse",
    pathClass: "inside",
    files: [],
    refusalCode: () => "bare_404",
    send: (ctx, column) => ctx.api(column, "DELETE", `note-emphases?path=${encodeURIComponent("notes/note.md")}`),
  },
  // Authoring drafts and proposals (authoring-http.ts): a cookie and the edit switch; no write rule; service state only.
  // A project holds at most 64 open drafts, so every draft a cell opens is discarded after it, and a cell that must
  // be refused reuses one shared draft (a refusal must not change it; if one did, that cell is already a mismatch).
  {
    id: "draft-save",
    capability: "edit",
    rules: [],
    path: "admit",
    pathClass: "state",
    files: [AUTHORING_INDEX],
    prepare: async (ctx, column) => ({
      generation: await ctx.generation(),
      n: ctx.uniq(),
      draftId: `drf_${id16()}`,
      draftRevision: 1,
      cookie: column,
    }),
    send: (ctx, column, s) =>
      ctx.api(column, "POST", "authoring", {
        journalGeneration: s.generation,
        op: "draft.save",
        operationId: id16(),
        draftId: s.draftId,
        expectedDraftRevision: null,
        source: `flowchart LR\n  a[Draft ${s.n}] e1@--> b[B]\n`,
        origin: { kind: "new" },
      }),
    after: (ctx, admitted, s) => (admitted ? ctx.discard(s) : undefined),
  },
  {
    id: "draft-discard",
    capability: "edit",
    rules: [],
    path: "admit",
    pathClass: "state",
    files: [AUTHORING_INDEX],
    prepare: (ctx, column, expected) => ctx.draft(column, expected),
    send: (ctx, column, s) =>
      ctx.api(column, "POST", "authoring", {
        journalGeneration: s.generation,
        op: "draft.discard",
        operationId: id16(),
        draftId: s.draftId,
        draftRevision: s.draftRevision,
      }),
  },
  {
    id: "draft-send",
    capability: "edit",
    rules: [],
    path: "admit",
    pathClass: "state",
    files: [AUTHORING_INDEX],
    prepare: (ctx, column, expected) => ctx.draft(column, expected),
    after: (ctx, admitted, s) => ctx.discard(s),
    send: (ctx, column, s) =>
      ctx.api(column, "POST", "authoring", {
        journalGeneration: s.generation,
        op: "draft.send",
        operationId: id16(),
        draftId: s.draftId,
        draftRevision: s.draftRevision,
      }),
  },
  {
    id: "change-withdraw",
    capability: "edit",
    rules: [],
    path: "admit",
    pathClass: "state",
    files: [CHANGE_REVIEW],
    prepare: (ctx, column, expected) => ctx.draft(column, expected),
    after: (ctx, admitted, s) => ctx.discard(s),
    send: (ctx, column, s) =>
      ctx.api(column, "POST", "authoring", {
        journalGeneration: s.generation,
        op: "change.withdraw",
        operationId: id16(),
        changeId: s.changeId,
        reviewRevision: s.reviewRevision,
      }),
  },
  // Configuration: refused for every browser credential (ADR 0028 `settings_read_only`); the account and project archer.toml are hashed.
  {
    id: "settings-put-account",
    capability: "settings",
    rules: [],
    path: "refuse",
    pathClass: "account-config",
    files: [],
    send: (ctx, column) => ctx.raw(column, "PUT", "/api/settings", { host: "0.0.0.0" }),
  },
  {
    id: "settings-put-project",
    capability: "settings",
    rules: [],
    path: "refuse",
    pathClass: "account-config",
    files: [],
    send: (ctx, column) => ctx.api(column, "PUT", "settings", { host: "0.0.0.0" }),
  },
  {
    id: "project-settings-patch",
    capability: "settings",
    rules: [],
    path: "refuse",
    pathClass: "project-config",
    files: [],
    send: (ctx, column) => ctx.api(column, "PATCH", "project-settings", { name: "renamed", edit: true }),
  },
  // Listener pin (person on this computer only). Launch runs once per project per 30 s, so it is its own block before the phases.
  {
    id: "listener-pin",
    capability: "owner",
    rules: [],
    path: "admit",
    pathClass: "state",
    files: ["state:listeners.json"],
    prepare: async (ctx) => ({ agentId: await ctx.registerAgent() }),
    send: (ctx, column, s) => ctx.api(column, "POST", "listeners/pin", { agentId: s.agentId }),
    verify: async (ctx, s) =>
      (await ctx.listeners()).current?.listener?.agentId === s.agentId &&
      (await ctx.listeners()).current?.pinnedByPerson === true,
  },
  // The person's own view state: every admitted credential, no rule, no edit switch.
  {
    id: "selection",
    capability: "person",
    rules: [],
    path: "admit",
    pathClass: "state",
    files: [],
    prepare: (ctx) => ctx.selectionFlip(),
    send: (ctx, column, s) => ctx.api(column, "POST", "selection", s.selection),
    verify: async (ctx, s) => (await ctx.selectedNode()) === s.node,
  },
  {
    id: "walkthrough-position",
    capability: "person",
    rules: [],
    path: "admit",
    pathClass: "state",
    files: [],
    prepare: (ctx) => ctx.readingFlip(),
    send: (ctx, column, s) => ctx.api(column, "POST", "walkthrough-position", s.position),
    verify: async (ctx, s) => JSON.stringify(await ctx.reading()) !== s.before,
  },
];

/** Launch (http.ts listeners/launch): the person on this computer only; spawns the account's `[agents] launcher` (here a harmless marker script). */
export const LAUNCH_ROW = {
  id: "listener-launch",
  capability: "owner",
  rules: [],
  path: "admit",
  pathClass: "process",
  files: ["state:listeners.json"],
  prepare: (ctx) => ctx.launchable(),
  send: (ctx, column, s) => ctx.api(column, "POST", "listeners/launch", { threadId: s.threadId }),
  verify: async (ctx, s) => ctx.launched(s.markers),
};

/** Management writers, the same arguments through `archer call` and `archer mcp`. `args(ctx, prepared)` builds the call. */
const comment = (target) => ({
  op: "create_comment",
  args: (ctx) => ({ target, anchor: { kind: "view" }, body: `agent comment ${ctx.uniq()}` }),
});
const register = (sourcePath) => ({ op: "register_diagram", args: () => ({ sourcePath }) });
const setHighlight = (notePath, fresh) => ({
  op: "set_note_emphasis",
  prepare: async (ctx) => ({ revision: fresh ? await ctx.noteEmphasisRevision(notePath) : 0, n: ctx.uniq() }),
  args: (ctx, s) => ({
    notePath,
    id: "matrix-agent",
    title: `A${s.n}`,
    groups: [{ id: "g", label: "G", description: "D", passages: [passage] }],
    expectedRevision: s.revision,
  }),
});
const emphasisGroups = [{ id: "g", style: "highlight", label: "Path", description: "d", nodes: ["a"] }];

export const MANAGEMENT_ROWS = [
  // A refused write is refused before it is announced, so it leaves no announcement (a refused write that did is a mismatch).
  {
    id: "write-standalone",
    rules: ["diagrams"],
    path: "admit",
    pathClass: "inside",
    files: ["project:.archer/diagrams/flow.mmd"],
    op: "write_diagram",
    prepare: async (ctx) => ({ revision: (await ctx.read("flow")).sourceRevision, n: ctx.uniq() }),
    args: (ctx, s) => ({
      viewId: "flow",
      source: `flowchart LR\n  a[Agent ${s.n}] e1@--> b[API]\n`,
      expectedRevision: s.revision,
    }),
  },
  {
    id: "write-embedded",
    rules: ["notes"],
    path: "admit",
    pathClass: "inside",
    files: ["project:.archer/notes/note.md"],
    op: "write_diagram",
    prepare: async (ctx) => ({ revision: (await ctx.read("notes/note.md#pinned")).sourceRevision, n: ctx.uniq() }),
    args: (ctx, s) => ({
      viewId: "notes/note.md#pinned",
      source: `flowchart LR\n  a[Agent ${s.n}] e1@--> b[B]\n`,
      expectedRevision: s.revision,
    }),
  },
  {
    id: "write-hardlinked-view",
    rules: ["diagrams"],
    path: "refuse",
    pathClass: "linked-hardlink",
    files: [],
    op: "write_diagram",
    args: () => ({ viewId: "hard", source: FIXTURE_FILES[".archer/diagrams/flow.mmd"], expectedRevision: ZERO }),
  },
  {
    id: "write-outside",
    rules: ["diagrams"],
    path: "refuse",
    pathClass: "outside",
    files: [],
    op: "write_diagram",
    args: () => ({
      viewId: "../README.md#x",
      source: FIXTURE_FILES[".archer/diagrams/flow.mmd"],
      expectedRevision: ZERO,
    }),
  },
  {
    id: "register-inside",
    rules: ["register", "manifest"],
    path: "admit",
    pathClass: "inside",
    files: ["project:archer.toml"],
    allowed: ["project:.archer/", "project:archer.toml"],
    op: "register_diagram",
    prepare: async (ctx) => {
      const n = ctx.uniq();
      writeFileSync(
        join(ctx.projectRoot, `.archer/diagrams/reg-${n}.mmd`),
        `flowchart LR\n  r[Reg ${n}] e1@--> s[S]\n`,
      );
      return { n };
    },
    args: (ctx, s) => ({ sourcePath: `diagrams/reg-${s.n}.mmd` }),
  },
  {
    id: "register-outside",
    rules: ["register", "manifest"],
    path: "refuse",
    pathClass: "outside",
    files: [],
    allowed: ["project:.archer/", "project:archer.toml"],
    ...register("../docs/outside.mmd"),
  },
  {
    id: "register-linked-dir",
    rules: ["register", "manifest"],
    path: "refuse",
    pathClass: "linked-dir",
    files: [],
    allowed: ["project:.archer/", "project:archer.toml"],
    ...register("diagrams/linkdir/sym.mmd"),
  },
  {
    id: "register-hardlink",
    rules: ["register", "manifest"],
    path: "refuse",
    pathClass: "linked-hardlink",
    files: [],
    allowed: ["project:.archer/", "project:archer.toml"],
    ...register("diagrams/hard.mmd"),
  },
  {
    id: "register-symlink",
    rules: ["register", "manifest"],
    path: "refuse",
    pathClass: "linked-symlink",
    files: [],
    allowed: ["project:.archer/", "project:archer.toml"],
    ...register("diagrams/linked.mmd"),
  },
  {
    id: "comment-view",
    rules: ["comments"],
    path: "admit",
    pathClass: "inside",
    files: ["project:.archer/diagrams/flow.comments.json"],
    ...comment("view:flow"),
  },
  {
    id: "comment-note",
    rules: ["comments"],
    path: "admit",
    pathClass: "inside",
    files: ["project:.archer/notes/note.comments.json"],
    ...comment("note:notes/note.md"),
  },
  {
    id: "comment-hardlinked-view",
    rules: ["comments"],
    path: "admit",
    pathClass: "linked-hardlink",
    files: ["project:.archer/diagrams/hard.comments.json"],
    ...comment("view:hard"),
  },
  {
    id: "comment-symlinked-sidecar",
    rules: ["comments"],
    path: "refuse",
    pathClass: "linked-symlink",
    files: [],
    ...comment("view:loose"),
  },
  {
    id: "comment-outside",
    rules: ["comments"],
    path: "refuse",
    pathClass: "outside",
    files: [],
    ...comment("note:../README.md"),
  },
  {
    id: "reply",
    rules: ["comments"],
    path: "admit",
    pathClass: "inside",
    files: ["project:.archer/diagrams/flow.comments.json"],
    op: "reply_comment",
    prepare: async (ctx) => ({ revision: await ctx.threadRevision(ctx.personThread) }),
    args: (ctx, s) => ({ threadId: ctx.personThread, body: `agent reply ${ctx.uniq()}`, expectedRevision: s.revision }),
  },
  {
    id: "highlight-note",
    rules: ["emphasis"],
    path: "admit",
    pathClass: "inside",
    files: ["project:.archer/notes/note.md.emphases.json"],
    ...setHighlight("notes/note.md", true),
  },
  {
    id: "highlight-outside",
    rules: ["emphasis"],
    path: "refuse",
    pathClass: "outside",
    files: [],
    ...setHighlight("../README.md", false),
  },
  {
    id: "highlight-symlinked-note",
    rules: ["emphasis"],
    path: "refuse",
    pathClass: "linked-symlink",
    files: [],
    ...setHighlight("notes/linked.md", false),
  },
  {
    id: "docs-index",
    rules: ["notes"],
    path: "admit",
    pathClass: "inside",
    files: ["project:.archer/index.md"],
    op: "docs_index",
    // docs_index writes only when the router would change (written: false otherwise), so each cell starts without one.
    prepare: async (ctx) => {
      rmSync(join(ctx.projectRoot, ".archer/index.md"), { force: true });
      return {};
    },
    args: () => ({ write: true }),
  },
  {
    id: "walkthrough",
    rules: ["emphasis"],
    path: "admit",
    pathClass: "inside",
    files: ["project:.archer/diagrams/flow.walkthroughs.json"],
    op: "write_walkthrough",
    prepare: async (ctx) => ({ model: (await ctx.read("flow")).modelRevision, n: ctx.uniq() }),
    args: (ctx, s) => ({
      viewId: "flow",
      modelRevision: s.model,
      walkthrough: {
        id: `w${s.n}`,
        title: "W",
        steps: [{ id: "s1", title: "S", kind: "does", what: "t", nodes: [{ kind: "node", id: "a" }] }],
      },
    }),
  },
  {
    id: "view-emphasis",
    rules: [],
    path: "admit",
    pathClass: "state",
    files: [],
    op: "set_emphasis",
    prepare: async (ctx) => ({ n: ctx.uniq() }),
    args: (ctx, s) => ({ id: `e${s.n}`, viewId: "flow", groups: emphasisGroups }),
    verify: async (ctx, s) => (await ctx.emphasisIds()).includes(`e${s.n}`),
  },
  {
    id: "present",
    rules: [],
    path: "admit",
    pathClass: "state",
    files: [],
    op: "present_diagram",
    prepare: async (ctx) => ({ before: await ctx.presentationId() }),
    args: () => ({ viewId: "flow" }),
    verify: async (ctx, s) => (await ctx.presentationId()) !== s.before,
  },
  {
    id: "issue-link",
    rules: [],
    path: "admit",
    pathClass: "grant",
    files: [],
    op: "issue_access_link",
    args: (ctx) => ({ label: `matrix ${ctx.uniq()}` }),
    verify: async (ctx, s, answer) => ctx.exchanges(answer?.url),
  },
  {
    id: "issue-authoring-link",
    rules: [],
    path: "admit",
    pathClass: "grant",
    files: [],
    op: "issue_authoring_access",
    args: (ctx) => ({ label: `matrix ${ctx.uniq()}`, projectRoots: [ctx.projectRoot] }),
    verify: async (ctx, s, answer) => ctx.exchanges(answer?.url),
  },
  {
    id: "revoke-link",
    rules: [],
    path: "admit",
    pathClass: "grant",
    files: [],
    op: "revoke_access_link",
    prepare: async (ctx) => ctx.freshLink(),
    args: (ctx, s) => ({ grantId: s.id }),
    verify: async (ctx, s) => !(await ctx.exchanges(s.url)),
  },
  {
    id: "pairing-code",
    rules: [],
    path: "admit",
    pathClass: "grant",
    files: [],
    op: "issue_pairing_code",
    args: () => ({}),
    verify: async (ctx, s, answer) => ctx.pairs(answer?.code),
  },
  {
    id: "network-access",
    capability: "person",
    rules: [],
    path: "refuse",
    pathClass: "account-config",
    files: [],
    op: "setup_network_access",
    args: () => ({ personConfirmed: true }),
  },
  {
    id: "attach",
    rules: [],
    path: "admit",
    pathClass: "project-root",
    files: [],
    op: "attach_project",
    args: (ctx) => ({ root: ctx.extraRoot }),
    verify: async (ctx) => (await ctx.projectRoots()).includes(ctx.extraRoot),
    after: async (ctx) => {
      await ctx.socket.call("detach", { root: ctx.extraRoot });
    },
  },
  {
    id: "detach",
    rules: [],
    path: "admit",
    pathClass: "project-root",
    files: [],
    op: "detach_project",
    prepare: async (ctx) => {
      await ctx.socket.call("attach", { root: ctx.extraRoot });
      return {};
    },
    args: (ctx) => ({ root: ctx.extraRoot }),
    verify: async (ctx) => !(await ctx.projectRoots()).includes(ctx.extraRoot),
  },
  {
    id: "attach-missing",
    rules: [],
    path: "refuse",
    pathClass: "outside",
    files: [],
    op: "attach_project",
    args: (ctx) => ({ root: join(ctx.record.root, "missing") }),
    verify: async (ctx) => (await ctx.projectRoots()).includes(join(ctx.record.root, "missing")),
  },
  {
    id: "resolve-comment",
    rules: ["comments"],
    path: "admit",
    pathClass: "inside",
    files: [FLOW_COMMENTS],
    op: "resolve_comment",
    prepare: (ctx) => ctx.agentThread(),
    args: (ctx, s) => ({ threadId: s.id, expectedRevision: s.revision }),
  },
  {
    id: "comment-unpinned-embedded",
    rules: ["comments", "notes"],
    path: "admit",
    pathClass: "inside-pin",
    files: (s) => s.files,
    op: "create_comment",
    prepare: (ctx) => ctx.freshEmbedded(),
    args: (ctx, s) => ({ target: `view:${s.viewId}`, anchor: { kind: "view" }, body: `agent pin ${s.n}` }),
  },
  {
    id: "emphasis-unpinned-embedded",
    rules: ["emphasis", "notes"],
    path: "admit",
    pathClass: "inside-pin",
    files: (s) => [s.files[0]],
    op: "set_emphasis",
    prepare: (ctx) => ctx.freshEmbedded(),
    args: (ctx, s) => ({ id: `p${s.n}`, viewId: s.viewId, groups: emphasisGroups }),
    verify: async (ctx, s) => (await ctx.emphasisIds(s.viewId)).includes(`p${s.n}`),
  },
  {
    id: "resolve-change",
    rules: [],
    path: "admit",
    pathClass: "state",
    files: [CHANGE_REVIEW],
    op: "resolve_change",
    prepare: (ctx, column, expected) => ctx.draft("owner-cookie", expected),
    after: (ctx, admitted, s) => ctx.discard(s),
    args: (ctx, s) => ({ changeId: s.changeId, expectedReviewRevision: s.reviewRevision, disposition: "handled" }),
  },
  {
    id: "set-selection",
    rules: [],
    path: "admit",
    pathClass: "state",
    files: [],
    op: "set_selection",
    prepare: (ctx) => ctx.selectionFlip(),
    args: (ctx, s) => s.selection,
    verify: async (ctx, s) => (await ctx.selectedNode()) === s.node,
  },
  // Export: MCP answers the bytes and writes nothing; the CLI's --output writes the file the caller names (its own OS account).
  {
    id: "export",
    rules: [],
    path: "admit",
    pathClass: "answer",
    files: [],
    op: "export_diagram",
    transports: ["mcp"],
    args: () => ({ viewId: "flow", format: "svg" }),
    verify: async (ctx, s, answer) => typeof answer?.data === "string" && answer.data.length > 0,
  },
  {
    id: "export-to-file",
    rules: [],
    path: "admit",
    pathClass: "caller-path",
    files: [],
    op: "export_diagram",
    transports: ["cli"],
    prepare: async (ctx) => ({ output: join(ctx.exportsDir, `flow-${ctx.uniq()}.svg`) }),
    flags: (s) => ["--output", s.output],
    args: () => ({ viewId: "flow", format: "svg" }),
    verify: async (ctx, s) => existsSync(s.output) && readFileSync(s.output, "utf8").includes("<svg"),
  },
];

/** The raw socket's state-changing methods that are not behind an operation of their own. */
export const SOCKET_ROWS = [
  {
    id: "issueAccess",
    rules: [],
    path: "admit",
    pathClass: "grant",
    files: [],
    method: "issueAccess",
    params: (ctx) => ({ label: `matrix ${ctx.uniq()}` }),
    verify: async (ctx, s, result) => ctx.exchanges(result?.url),
  },
  {
    id: "issueAuthoringAccess",
    rules: [],
    path: "admit",
    pathClass: "grant",
    files: [],
    method: "issueAuthoringAccess",
    params: (ctx) => ({ label: `matrix ${ctx.uniq()}`, projectRoots: [ctx.projectRoot] }),
    verify: async (ctx, s, result) => ctx.exchanges(result?.url),
  },
  {
    id: "revokeAccess",
    rules: [],
    path: "admit",
    pathClass: "grant",
    files: [],
    method: "revokeAccess",
    prepare: async (ctx) => ctx.freshLink(),
    params: (ctx, s) => ({ grantId: s.id }),
    verify: async (ctx, s) => !(await ctx.exchanges(s.url)),
  },
  {
    id: "issuePairingCode",
    rules: [],
    path: "admit",
    pathClass: "grant",
    files: [],
    method: "issuePairingCode",
    params: () => ({}),
    verify: async (ctx, s, result) => ctx.pairs(result?.code),
  },
  {
    id: "setEmphasis",
    rules: [],
    path: "admit",
    pathClass: "state",
    files: [],
    method: "setEmphasis",
    prepare: async (ctx) => ({ n: ctx.uniq() }),
    params: (ctx, s) => ({
      root: ctx.projectRoot,
      viewId: "flow",
      emphases: [{ id: `s${s.n}`, groups: emphasisGroups }],
    }),
    verify: async (ctx, s) => (await ctx.emphasisIds()).includes(`s${s.n}`),
  },
  {
    id: "attach",
    rules: [],
    path: "admit",
    pathClass: "project-root",
    files: [],
    method: "attach",
    params: (ctx) => ({ root: ctx.extraRoot }),
    verify: async (ctx) => (await ctx.projectRoots()).includes(ctx.extraRoot),
    after: async (ctx) => {
      await ctx.socket.call("detach", { root: ctx.extraRoot });
    },
  },
  {
    id: "detach",
    rules: [],
    path: "admit",
    pathClass: "project-root",
    files: [],
    method: "detach",
    prepare: async (ctx) => {
      await ctx.socket.call("attach", { root: ctx.extraRoot });
      return {};
    },
    params: (ctx) => ({ root: ctx.extraRoot }),
    verify: async (ctx) => !(await ctx.projectRoots()).includes(ctx.extraRoot),
  },
  {
    id: "setEmphasis-unpinned-embedded",
    rules: ["emphasis", "notes"],
    path: "admit",
    pathClass: "inside-pin",
    files: (s) => [s.files[0]],
    method: "setEmphasis",
    prepare: (ctx) => ctx.freshEmbedded(),
    params: (ctx, s) => ({
      root: ctx.projectRoot,
      viewId: s.viewId,
      emphases: [{ id: `q${s.n}`, groups: emphasisGroups }],
    }),
    verify: async (ctx, s) => (await ctx.emphasisIds(s.viewId)).includes(`q${s.n}`),
  },
  {
    id: "recordWrite",
    rules: [],
    path: "admit",
    pathClass: "state",
    files: [],
    method: "recordWrite",
    prepare: async (ctx) => ({ n: ctx.uniq() }),
    params: (ctx, s) => ({ root: ctx.projectRoot, viewId: "flow", summary: `matrix write ${s.n}` }),
    verify: async (ctx, s) => Object.values(ctx.continuityTexts()).some((text) => text.includes(`matrix write ${s.n}`)),
  },
  {
    id: "resolveChange",
    rules: [],
    path: "admit",
    pathClass: "state",
    files: [CHANGE_REVIEW],
    method: "resolveChange",
    prepare: (ctx, column, expected) => ctx.draft("owner-cookie", expected),
    after: (ctx, admitted, s) => ctx.discard(s),
    params: (ctx, s) => ({
      root: ctx.projectRoot,
      changeId: s.changeId,
      expectedReviewRevision: s.reviewRevision,
      disposition: "declined",
    }),
  },
  {
    id: "clearReview",
    rules: [],
    path: "admit",
    pathClass: "state",
    files: [AUTHORING_INDEX],
    method: "clearReview",
    prepare: (ctx) => ctx.pendingReview(),
    params: (ctx, s) => ({
      root: ctx.projectRoot,
      reviewId: s.reviewId,
      expectedReviewRevision: s.reviewRevision,
      summary: "matrix cleared",
    }),
  },
  {
    id: "setSelection",
    rules: [],
    path: "admit",
    pathClass: "state",
    files: [],
    method: "setSelection",
    prepare: (ctx) => ctx.selectionFlip(),
    params: (ctx, s) => ({ root: ctx.projectRoot, selection: s.selection }),
    verify: async (ctx, s) => (await ctx.selectedNode()) === s.node,
  },
  {
    id: "present",
    rules: [],
    path: "admit",
    pathClass: "state",
    files: [],
    method: "present",
    prepare: async (ctx) => ({ before: await ctx.presentationId() }),
    params: (ctx) => ({ root: ctx.projectRoot, viewId: "flow", openBrowser: false }),
    verify: async (ctx, s) => (await ctx.presentationId()) !== s.before,
  },
  {
    id: "registerAgent",
    rules: [],
    path: "admit",
    pathClass: "state",
    files: ["state:listeners.json"],
    method: "registerAgent",
    prepare: async (ctx) => ({ n: ctx.uniq() }),
    params: (ctx, s) => ({ root: ctx.projectRoot, cwd: ctx.projectRoot, host: "other", label: `matrix agent ${s.n}` }),
    verify: async (ctx, s, result) =>
      typeof result?.agentId === "string" &&
      (await ctx.listeners()).current?.agents?.some((a) => a.agentId === result.agentId),
  },
  {
    id: "claimListener",
    rules: [],
    path: "admit",
    pathClass: "state",
    files: ["state:listeners.json"],
    method: "claimListener",
    // A person's pin outranks an agent's claim, so the cell starts unpinned (the pin cells leave one behind).
    prepare: async (ctx) => {
      await ctx.api("owner-cookie", "POST", "listeners/pin", { agentId: null });
      return { agentId: await ctx.registerAgent() };
    },
    params: (ctx, s) => ({ root: ctx.projectRoot, agentId: s.agentId }),
    verify: async (ctx, s) => (await ctx.listeners()).current?.listener?.agentId === s.agentId,
  },
  {
    id: "heartbeat",
    rules: [],
    path: "admit",
    pathClass: "state",
    files: [],
    method: "heartbeat",
    prepare: async (ctx) => {
      const agentId = await ctx.registerAgent();
      await sleep(20);
      return { agentId, before: await ctx.lastActive(agentId) };
    },
    params: (ctx, s) => ({ agentId: s.agentId, via: "cli" }),
    verify: async (ctx, s) => {
      const now = await ctx.lastActive(s.agentId);
      return now !== undefined && now !== s.before;
    },
  },
  // Delivery (service/listeners.ts inbox, waitMessage, reportActivity). No write rule refuses them; their project effect
  // is the delivery's bookkeeping, a delivered thread's sent → read mark in its comments file (comments/store.ts markRead),
  // a write under the `comments` rule (`touches`). Under a comments deny that mark is refused inside the product and only
  // logged (listeners.ts #markRead), so the answer must still be delivered and no project file may change (`forbid`).
  // Each prepare makes a fresh agent the checkout's listener and leaves it a fresh person thread (sent) on flow.
  {
    id: "waitMessage",
    rules: [],
    touches: ["comments"],
    path: "admit",
    pathClass: "delivery",
    method: "waitMessage",
    prepare: (ctx) => ctx.deliverable(),
    params: (ctx, s) => ({ root: ctx.projectRoot, agentId: s.agentId, timeoutMs: 5000 }),
    ...readMark(true),
  },
  {
    id: "inbox-agent",
    rules: [],
    touches: ["comments"],
    path: "admit",
    pathClass: "delivery",
    method: "inbox",
    prepare: (ctx) => ctx.deliverable(),
    params: (ctx, s) => ({ root: ctx.projectRoot, agentId: s.agentId }),
    ...readMark(true),
  },
  // Without an agent id the inbox lists what waits and takes nothing: no read mark in any phase.
  {
    id: "inbox-all",
    rules: [],
    touches: ["comments"],
    path: "admit",
    pathClass: "delivery",
    method: "inbox",
    prepare: (ctx) => ctx.deliverable(),
    params: (ctx) => ({ root: ctx.projectRoot }),
    ...readMark(false),
  },
  // A pull's report: the recipient's fetch of the thread at its revision records it read (and `answered` keeps the conversation).
  // Unlike a wait, it marks read in the call itself, so under a comments deny the call is refused (write_rule_denied), as
  // built (listeners.ts reportActivity → markThreadRead). Its negative control: nothing changed on disk AND the thread still
  // waits for delivery (inbox without an agent id lists it), i.e. the refused report did not record the comments as received.
  {
    id: "reportActivity",
    rules: [],
    touches: ["comments"],
    path: "admit",
    pathClass: "delivery",
    method: "reportActivity",
    prepare: (ctx) => ctx.deliverable(),
    expect: (phase) => (ruleDenies(["comments"], phase) ? "refuse" : "admit"),
    refusalCode: () => "write_rule_denied",
    params: (ctx, s) => ({
      root: ctx.projectRoot,
      agentId: s.agentId,
      fetched: [{ threadId: s.threadId, revision: s.revision }],
      answered: [s.threadId],
    }),
    unchanged: async (ctx, s) => ctx.stillWaiting(s.threadId),
    ...readMark(true, (result, s) => Array.isArray(result?.read) && result.read.includes(s.threadId)),
  },
];

/**
 * A delivery row's effect: the answer carries the prepared thread (`answered`, by default its messages), and, where the
 * row marks read and the phase allows comments, flow's comments file changes and the thread reads `read`; otherwise no
 * project file changes and it still reads `sent`.
 */
function readMark(
  marks,
  answered = (result, s) => Array.isArray(result?.messages) && result.messages.some((m) => m.threadId === s.threadId),
) {
  const marking = (phase) => marks && !ruleDenies(["comments"], phase);
  return {
    files: (s, phase) => (marking(phase) ? [FLOW_COMMENTS] : []),
    forbid: (phase) => (marking(phase) ? [] : ["project:"]),
    verify: (ctx, s, result, { phase }) =>
      answered(result, s) && ctx.threadStatus(s.threadId) === (marking(phase) ? "read" : "sent"),
  };
}

/** Rows the matrix does not run, each with its reason (reported as NOT EVALUATED, never silently left out). */
export const NOT_EVALUATED = [
  {
    surface: "cli, mcp",
    row: "setup_network_access (positive, with the person's yes)",
    reason:
      "not run: pass --network-netns. It rebinds the service off loopback, so it runs only in a private network namespace (network-access-netns.mjs), never in the loopback sandbox (R3/P8). Its refusals in the sandbox run as cells: the CLI without a terminal and MCP with the question declined.",
  },
  {
    surface: "socket",
    row: "mcpRelay",
    reason:
      "covered as transport: not a content writer of its own, it is the transport of the `archer mcp` door, whose every operation is a cell (fresh MCP positive and negative effects traverse the real relay). No separate content mutation is claimed for it.",
  },
];

/**
 * Product defects this matrix reproduces and that are not fixed yet. A matching cell stays a mismatch and is marked
 * `knownDefect`; the exit code ignores them only with --allow-known-defects. Each entry is { id, what, match(cell) }.
 * Empty: PD-1 (a refused reportActivity recorded the delivery), PD-2 (setup_network_access over the MCP relay ended
 * on the network with the settings rolled back) and PD-3 (its restart lost its own service connection and rolled
 * back) are fixed (sec/pd-fixes), so a recurrence fails the run.
 */
export const KNOWN_PRODUCT_DEFECTS = [];

// ------------------------------------------------------------------ the sandbox

/** Writes the fixture corpus into a new temporary directory; returns it (the sandbox copies it). */
export function writeFixtureCorpus() {
  const corpus = mkdtempSync(join(tmpdir(), "archer-eg3-corpus-"));
  for (const [file, text] of Object.entries(FIXTURE_FILES)) {
    mkdirSync(dirname(join(corpus, "eg3", file)), { recursive: true });
    writeFileSync(join(corpus, "eg3", file), text);
  }
  return corpus;
}

/** The canary outside the project, the links into it, and a second project for attach/detach. */
function placeLinks(record, projectRoot) {
  const canary = join(record.root, "canary");
  mkdirSync(canary, { recursive: true });
  for (const [file, text] of Object.entries(CANARY_FILES))
    if (!existsSync(join(canary, file))) writeFileSync(join(canary, file), text);
  for (const [kind, at, to] of LINKS) {
    const path = join(projectRoot, at);
    if (lstatExists(path)) continue;
    if (kind === "symlink") symlinkSync(to === "." ? canary : join(canary, to), path);
    else linkSync(join(canary, to), path);
  }
  const extra = join(record.root, "extra", "eg3-extra");
  if (!existsSync(join(extra, "archer.toml"))) {
    mkdirSync(join(extra, ".archer", "diagrams"), { recursive: true });
    writeFileSync(join(extra, "archer.toml"), 'version = 1\nname = "E-G3 extra"\nfolder = ".archer"\n');
    writeFileSync(join(extra, ".archer", "diagrams", "x.mmd"), "flowchart LR\n  x[X] e1@--> y[Y]\n");
  }
  return { canary, extra };
}
function lstatExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Sets the project's top-level `edit` switch (a file edit the service reads fresh). */
function setEdit(projectRoot, on) {
  const file = join(projectRoot, "archer.toml");
  const text = readFileSync(file, "utf8").replace(/^edit = (true|false)\n/m, "");
  writeFileSync(file, on ? text : text.replace(/^version = 1\n/m, "version = 1\nedit = false\n"));
}

/**
 * The account archer.toml for a phase: the denied rules false (one left on under a rule-not-applied seed),
 * and `[agents] launcher` = a harmless script that only drops a marker file in `launches` (Launch's positive
 * control; it never names a real agent). `queued`: the `[service]` table sets `comment_submission = "queued"`, so a
 * person's comment is a draft until submitted (the comments/submit row).
 */
function setRules(configPath, projectRoot, phase, seed, launches, queued = false) {
  const kept = seed?.startsWith("rule-not-applied:") ? seed.split(":")[1] : null;
  const denied = deniedRules(phase).filter((rule) => rule !== kept);
  // launch = "ask": the Launch button only. Left to its default ("auto" once a launcher is set), an owner's comment sent
  // in one cell (comments/submit) is launched for minutes later, after next_turn and the listener's expiry, and that
  // launch's listeners.json save lands in some unrelated cell.
  const launcher =
    launches === undefined
      ? ""
      : `\n[agents]\nlaunch = "ask"\nlauncher = ${JSON.stringify([process.execPath, "-e", "require('fs').writeFileSync(require('path').join(process.argv[1], Date.now() + '-' + process.pid), '')", launches])}\n`;
  const rules =
    denied.length === 0
      ? ""
      : `\n[[projects]]\npath = ${JSON.stringify(projectRoot)}\n${denied.map((rule) => `${rule} = false`).join("\n")}\n`;
  const service = queued ? '\n[service]\ncomment_submission = "queued"\n' : "";
  writeFileSync(configPath, `version = 1\n${service}${launcher}${rules}`);
}

/**
 * A credential-free account of how state files changed, for a mismatch that involves state: for a continuity file,
 * which top-level fields changed, which baseline paths came or went or changed revision, and the announcements
 * (view id and time) before and after; for the listener registry, which fields changed and each agent whose entry
 * changed, with its lastActive before and after. Other state paths are named only. No summary, label or token text.
 */
export function stateDiff(paths, before, after, window, snapshots = {}) {
  const json = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  const changedKeys = (a, b) =>
    [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])]
      .filter((k) => JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k]))
      .sort();
  return paths.map((path) => {
    const a = json(before[path]),
      b = json(after[path]);
    if (CONTINUITY.test(path)) {
      const entries = (v) => new Map((v?.files?.entries ?? []).map((e) => [e.path, `${e.kind}:${e.revision ?? "-"}`]));
      const ea = entries(a),
        eb = entries(b);
      return {
        path,
        kind: "continuity",
        existedBefore: a !== null,
        existsAfter: b !== null,
        fieldsChanged: changedKeys(a, b),
        filesPolicyChanged: a?.files?.policy !== b?.files?.policy,
        filesAdded: [...eb.keys()].filter((k) => !ea.has(k)),
        filesRemoved: [...ea.keys()].filter((k) => !eb.has(k)),
        filesRevised: [...eb.keys()].filter((k) => ea.has(k) && ea.get(k) !== eb.get(k)),
        writesBefore: (a?.writes ?? []).map((w) => ({ viewId: w.viewId, at: w.at })),
        writesAfter: (b?.writes ?? []).map((w) => ({ viewId: w.viewId, at: w.at })),
        window,
      };
    }
    if (path === LISTENERS) {
      const agents = (v) => new Map((v?.agents ?? []).map((x) => [x.agentId, x]));
      const aa = agents(a),
        ab = agents(b);
      return {
        path,
        kind: "listeners",
        fieldsChanged: changedKeys(a, b),
        agents: [...new Set([...aa.keys(), ...ab.keys()])]
          .filter((id) => JSON.stringify(aa.get(id)) !== JSON.stringify(ab.get(id)))
          .map((id) => ({
            agentId: id,
            lastActiveBefore: aa.get(id)?.lastActive ?? null,
            lastActiveAfter: ab.get(id)?.lastActive ?? null,
            otherFieldsChanged: changedKeys({ ...aa.get(id), lastActive: 0 }, { ...ab.get(id), lastActive: 0 }),
          })),
        window,
      };
    }
    // The recovery record (state/account.ts `runtime/<key>.json`) and its last-good source blobs (`<key>.sources/<digest>`).
    if (RECOVERY.test(path)) return { path, kind: "recovery", ...recoveryDiff(before[path], after[path]) };
    if (RECOVERY_SOURCE.test(path))
      return {
        path,
        kind: "recovery-source",
        existedBefore: snapshots.before?.[path] !== undefined,
        existsAfter: snapshots.after?.[path] !== undefined,
      };
    return { path, kind: "other" };
  });
}
const RECOVERY = /^state:runtime\/[0-9a-f]{16,}\.json$/,
  RECOVERY_SOURCE = /^state:runtime\/[0-9a-f]{16,}\.sources\/[^/]+$/;

// ------------------------------------------------------------------ the run

export async function run({
  name,
  out,
  keep = false,
  seed,
  only,
  phases,
  transports = TRANSPORTS,
  otherAccount = false,
  lifecycle = false,
  quietMs = 600,
  afterQuietMs = 400,
  consumeCapMs = CONSUME_CAP_MS,
  columns = HTTP_COLUMNS,
  networkNetns = false,
} = {}) {
  if (!/^eg3-[a-z0-9-]+$/.test(name ?? ""))
    throw new Error("--name must be eg3-<n>: this tool brings up and down only its own sandboxes");
  // The commit and tree the run measures, read before it starts: a commit made while it runs is not the one measured.
  const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" }).stdout.trim();
  const dirty =
    spawnSync("git", ["status", "--porcelain", "--", "ts", "shared", "ui/src"], {
      cwd: REPO,
      encoding: "utf8",
    }).stdout.trim() !== "";
  const sandbox = await import("../sandbox.mjs");
  let created = false;
  const existing = sandbox.readRecord(name);
  if (existing === null || !existing.pid) {
    const corpus = writeFixtureCorpus();
    try {
      await sandbox.up({ name, corpus, tls: true });
      created = true;
    } finally {
      rmSync(corpus, { recursive: true, force: true });
    }
  }
  const sessions = [];
  try {
    const record = await sandboxRecord(name);
    const project = record.projects?.[0];
    if (
      project === undefined ||
      !existsSync(join(project.root, "archer.toml")) ||
      !readFileSync(join(project.root, "archer.toml"), "utf8").includes(FIXTURE_NAME)
    )
      throw new Error(
        `sandbox ${name} does not hold the "${FIXTURE_NAME}" fixture project; down it or pick another name`,
      );
    const projectRoot = project.root;
    const { canary, extra } = placeLinks(record, projectRoot);
    const launches = join(record.root, "launches"),
      exportsDir = join(record.root, "exports");
    mkdirSync(launches, { recursive: true });
    mkdirSync(exportsDir, { recursive: true });
    const env = sandbox.sandboxEnv(record);
    const minted = await credentialsFor(record);
    const secrets = minted.secrets;
    const target = {
      origin: record.origin,
      ca: record.ca,
      ownerToken: record.ownerToken,
      credentials: minted.credentials,
    };
    const socket = await socketSession(env.ARCHER_SOCKET);
    sessions.push(socket);
    const helper = await mcpSession({ cwd: projectRoot, env });
    sessions.push(helper);
    const remember = (value, kind) => {
      if (typeof value === "string" && value.length >= 8) secrets.set(value, kind);
    };
    let counter = 0;
    const apiBase = `/p/${project.slug}/api/`;
    let current = PHASES[0],
      queued = false;
    const applyPhase = (phase) => {
      current = phase;
      setEdit(projectRoot, seed === "edit-not-applied" ? true : phase.edit);
      setRules(record.configPath, projectRoot, phase, seed, launches, queued);
    };
    const parse = (r) => {
      try {
        return JSON.parse(r.body);
      } catch {
        return null;
      }
    };
    const ctx = {
      record,
      projectRoot,
      extraRoot: extra,
      exportsDir,
      slug: project.slug,
      socket,
      uniq: () => ++counter,
      api: (column, method, path, body) =>
        request(
          target,
          { method },
          column,
          `${apiBase}${path}`,
          {},
          { body: body === undefined ? "" : JSON.stringify(body) },
        ),
      raw: (column, method, path, body) =>
        request(target, { method }, column, path, {}, { body: body === undefined ? "" : JSON.stringify(body) }),
      /** Runs a prepare's setup with edit on and every rule allowed, then puts the cell's phase back (both are file edits read fresh). */
      async openPolicy(fn) {
        setEdit(projectRoot, true);
        setRules(record.configPath, projectRoot, PHASES[0], undefined, launches, queued);
        try {
          return await fn();
        } finally {
          applyPhase(current);
        }
      },
      /** A person's draft on flow (the account's comment_submission is "queued" for this row), made by the owner's cookie. */
      async draftThread() {
        if (!queued) throw new Error("a draft needs the queued comment submission");
        return ctx.openPolicy(async () => {
          const thread = parse(
            await ctx.api("owner-cookie", "POST", "comments", {
              target: "view:flow",
              anchor: { kind: "view" },
              body: `draft ${ctx.uniq()}`,
            }),
          );
          if (thread?.status !== "draft")
            throw new Error(
              `a queued comment was not a draft (${thread?.status ?? thread?.error?.code ?? "no answer"})`,
            );
          return { id: thread.id };
        });
      },
      /** Whether a thread's person comments still wait for delivery: `inbox` without an agent id lists what waits and takes nothing. */
      async stillWaiting(threadId) {
        const r = await socket.call("inbox", { root: projectRoot });
        return r.admitted && (r.result?.messages ?? []).some((m) => m.threadId === threadId);
      },
      /** A thread's status in flow's comments file, read from disk (null when it is not there). */
      threadStatus(threadId) {
        try {
          return (
            JSON.parse(readFileSync(join(projectRoot, ".archer/diagrams/flow.comments.json"), "utf8")).threads.find(
              (t) => t.id === threadId,
            )?.status ?? null
          );
        } catch {
          return null;
        }
      },
      /** A fresh agent made the checkout's listener (any pin cleared first), and a fresh person thread on flow (sent) waiting for it. */
      async deliverable() {
        return ctx.openPolicy(async () => {
          await ctx.api("owner-cookie", "POST", "listeners/pin", { agentId: null });
          const agentId = await ctx.registerAgent();
          const claimed = await socket.call("claimListener", { root: projectRoot, agentId });
          if (!claimed.admitted) throw new Error(`claimListener refused (${claimed.code})`);
          const thread = parse(
            await ctx.api("grant-cookie", "POST", "comments", {
              target: "view:flow",
              anchor: { kind: "view" },
              body: `for delivery ${ctx.uniq()}`,
            }),
          );
          if (thread?.status !== "sent")
            throw new Error(
              `a person thread for delivery was not sent (${thread?.status ?? thread?.error?.code ?? "no answer"})`,
            );
          // The control for reportActivity's negative: before the call the thread waits for delivery.
          if (!(await ctx.stillWaiting(thread.id))) throw new Error("a fresh person thread does not wait for delivery");
          return { agentId, threadId: thread.id, revision: thread.revision };
        });
      },
      continuityTexts: () => continuityTexts(),
      async newThread() {
        return ctx.openPolicy(async () => {
          const thread = parse(
            await ctx.api("grant-cookie", "POST", "comments", {
              target: "view:flow",
              anchor: { kind: "view" },
              body: `thread ${ctx.uniq()}`,
            }),
          );
          if (!thread?.id) throw new Error("could not create a person thread for a comment cell");
          return { id: thread.id, commentId: thread.comments[0].id };
        });
      },
      async agentThread() {
        return ctx.openPolicy(async () => {
          const made = await helper.call("create_comment", {
            target: "view:flow",
            anchor: { kind: "view" },
            body: `agent thread ${ctx.uniq()}`,
          });
          const thread = made.result?.thread ?? made.result;
          if (!thread?.id) throw new Error(`could not create an agent thread (${made.code})`);
          return { id: thread.id, revision: thread.revision ?? 1 };
        });
      },
      async agentResolvedThread() {
        const thread = await ctx.agentThread();
        const resolved = await ctx.openPolicy(() =>
          helper.call("resolve_comment", { threadId: thread.id, expectedRevision: thread.revision }),
        );
        if (!resolved.admitted) throw new Error(`could not agent-resolve a thread (${resolved.code})`);
        return thread;
      },
      /** A new note holding one top-level, unnamed Mermaid block (address `<note>#diagram-1`): a comment or highlight on it pins its name. */
      freshEmbedded() {
        const n = ctx.uniq(),
          note = `notes/cell-${n}.md`;
        writeFileSync(
          join(projectRoot, ".archer", note),
          "Cell note.\n\n```mermaid\nflowchart LR\n  a[A] e1@--> b[B]\n```\n",
        );
        return {
          n,
          viewId: `${note}#diagram-1`,
          files: [`project:.archer/${note}`, `project:.archer/notes/cell-${n}.diagram-1.comments.json`],
        };
      },
      async highlightSet(id) {
        return ctx.openPolicy(async () => {
          const set = await ctx.api(
            "grant-cookie",
            "POST",
            `note-emphases?path=${encodeURIComponent("notes/note.md")}`,
            {
              notePath: "notes/note.md",
              id,
              title: "To clear",
              groups: [{ id: "g", label: "G", description: "D", passages: [passage] }],
              expectedRevision: await ctx.noteEmphasisRevision("notes/note.md"),
            },
          );
          if (set.status !== 200) throw new Error(`could not set a highlight to clear (${set.status})`);
          return { revision: await ctx.noteEmphasisRevision("notes/note.md") };
        });
      },
      /** A saved draft (and the change it put up for review), made by the cell's own cookie, or the owner's for the columns that cannot author. */
      async draft(column, expected) {
        if (expected === "refuse")
          return (ctx.sharedDraft ??= { ...(await ctx.draft("owner-cookie", "admit")), shared: true });
        const cookie = column === "grant-cookie" || column === "owner-cookie" ? column : "owner-cookie";
        return ctx.openPolicy(async () => {
          const generation = await ctx.generation();
          const saved = parse(
            await ctx.api(cookie, "POST", "authoring", {
              journalGeneration: generation,
              op: "draft.save",
              operationId: id16(),
              draftId: `drf_${id16()}`,
              expectedDraftRevision: null,
              source: `flowchart LR\n  a[Draft ${ctx.uniq()}] e1@--> b[B]\n`,
              origin: { kind: "new" },
            }),
          );
          if (saved?.outcome !== "saved" || typeof saved.review?.changeId !== "string")
            throw new Error(
              `could not save a draft for a cell (${saved?.outcome ?? saved?.error?.code ?? "no answer"})`,
            );
          return {
            generation,
            cookie,
            draftId: saved.draft.draftId,
            draftRevision: saved.draft.draftRevision,
            changeId: saved.review.changeId,
            reviewRevision: 1,
          };
        });
      },
      /** Discards a cell's own draft (never the shared one), with the cookie that made it. */
      async discard(d) {
        if (d?.draftId === undefined || d.shared) return;
        await ctx.openPolicy(async () => {
          const status = parse(await request(target, { method: "GET" }, d.cookie, `${apiBase}authoring`));
          const draft = status?.drafts?.find((x) => x.draftId === d.draftId);
          if (draft?.state === "open")
            await ctx.api(d.cookie, "POST", "authoring", {
              journalGeneration: status.generation,
              op: "draft.discard",
              operationId: id16(),
              draftId: d.draftId,
              draftRevision: draft.draftRevision,
            });
        });
      },
      /** A pending cumulative review: the owner applies an edit to flow (which opens or folds one), then list_changes names it. */
      async pendingReview() {
        return ctx.openPolicy(async () => {
          const opened = await ctx.open({ kind: "view", viewId: "flow" });
          const applied = parse(
            await ctx.api("owner-cookie", "POST", "authoring", {
              journalGeneration: await ctx.generation(),
              op: "document.apply",
              operationId: id16(),
              target: opened.target,
              expectedTargetRevision: opened.targetRevision,
              expectedSourceRevision: opened.sourceRevision,
              source: `flowchart LR\n  a[Review ${ctx.uniq()}] e1@--> b[API]\n`,
            }),
          );
          const reviews = (await helper.call("list_changes", {})).result?.cumulativeReviews?.reviews ?? [];
          const review = reviews.find((r) => r.state === "pending") ?? reviews.find((r) => r.clearedAt === undefined);
          if (review === undefined)
            throw new Error(
              `no pending cumulative review after an apply (${applied?.outcome ?? applied?.error?.code})`,
            );
          return { reviewId: review.reviewId, reviewRevision: review.reviewRevision };
        });
      },
      async context() {
        return (await helper.call("get_presentation_context", {})).result ?? {};
      },
      async selectedNode() {
        const c = await ctx.context();
        return c.selection?.nodes?.[0]?.id ?? c.selection?.selection?.nodes?.[0]?.id ?? null;
      },
      async selectionFlip() {
        const c = await ctx.context();
        const node = (await ctx.selectedNode()) === "a" ? "b" : "a";
        const presentationId =
          c.presentation?.viewId === "flow" && c.presentation?.presentationId
            ? c.presentation.presentationId
            : "reader:flow";
        return {
          node,
          selection: {
            schemaVersion: 1,
            viewId: "flow",
            revision: (await ctx.read("flow")).modelRevision,
            presentationId,
            nodes: [{ id: node }],
            edges: [],
          },
        };
      },
      async reading() {
        return (await ctx.context()).walkthrough ?? null;
      },
      async readingFlip() {
        if (ctx.walkthroughId === undefined) {
          const id = `pos${ctx.uniq()}`;
          const written = await ctx.openPolicy(async () =>
            helper.call("write_walkthrough", {
              viewId: "flow",
              modelRevision: (await ctx.read("flow")).modelRevision,
              walkthrough: {
                id,
                title: "Position",
                steps: [
                  { id: "s1", title: "S", kind: "does", what: "t", nodes: [{ kind: "node", id: "a" }] },
                  { id: "s2", title: "T", kind: "does", what: "u", nodes: [{ kind: "node", id: "b" }] },
                ],
              },
            }),
          );
          if (!written.admitted)
            throw new Error(`could not write the walkthrough for the position cells (${written.code})`);
          ctx.walkthroughId = id;
        }
        const now = await ctx.reading();
        const step = now?.step === 1 ? 2 : 1;
        return { before: JSON.stringify(now), position: { viewId: "flow", id: ctx.walkthroughId, step } };
      },
      async registerAgent() {
        const r = await socket.call("registerAgent", {
          root: projectRoot,
          cwd: projectRoot,
          host: "other",
          label: `matrix ${ctx.uniq()}`,
        });
        if (!r.admitted) throw new Error(`registerAgent refused (${r.code})`);
        return r.result.agentId;
      },
      async listeners() {
        return (await socket.call("listListeners", { root: projectRoot })).result ?? {};
      },
      async lastActive(agentId) {
        return (await ctx.listeners()).current?.agents?.find((a) => a.agentId === agentId)?.lastActive;
      },
      markers: () => readdirSync(launches).length,
      async launchable() {
        // One launch per project per LAUNCH_REPEAT_MS (30 s): wait out the previous admitted one.
        if (ctx.launchedAt !== undefined) await sleep(Math.max(0, ctx.launchedAt + 31_000 - Date.now()));
        const thread = await ctx.newThread();
        return { threadId: thread.id, markers: ctx.markers() };
      },
      async launched(before) {
        for (let waited = 0; waited < 5000; waited += 100) {
          if (ctx.markers() > before) {
            ctx.launchedAt = Date.now();
            return true;
          }
          await sleep(100);
        }
        return false;
      },
      async open(viewTarget) {
        const r = await ctx.api("grant-cookie", "POST", "authoring/open", { target: viewTarget });
        return r.status === 200 ? JSON.parse(r.body) : null;
      },
      async generation() {
        const r = await request(target, { method: "GET" }, "grant-cookie", `${apiBase}authoring`);
        return JSON.parse(r.body).generation;
      },
      async presentationRevision(opened) {
        if (opened === null) return null;
        const r = await ctx.api("grant-cookie", "POST", "authoring/presentation", {
          op: "read",
          target: opened.target,
          expectedTargetRevision: opened.targetRevision,
          sourceRevision: opened.sourceRevision,
        });
        return r.status === 200 ? (JSON.parse(r.body).presentation?.revision ?? null) : `status ${r.status}`;
      },
      async read(viewId) {
        return (await helper.call("read_diagram", { viewId })).result ?? {};
      },
      async noteEmphasisRevision(notePath) {
        return (await helper.call("list_note_emphases", { notePath })).result?.snapshot?.revision ?? 0;
      },
      async threadRevision(threadId) {
        return (await helper.call("get_comments", {})).result?.threads?.find((t) => t.id === threadId)?.revision ?? 1;
      },
      async emphasisIds(viewId = "flow") {
        return ((await helper.call("list_emphases", { viewId })).result?.views ?? []).flatMap((v) =>
          v.emphases.map((e) => e.id),
        );
      },
      async presentationId() {
        return (await helper.call("get_presentation_context", {})).result?.presentation?.presentationId ?? null;
      },
      async projectRoots() {
        return ((await socket.call("listProjects", {})).result?.projects ?? []).map((p) => p.root);
      },
      async exchanges(url) {
        if (typeof url !== "string") return false;
        remember(new URL(url).searchParams.get("token"), "grant");
        const answer = await send(url, { ca: record.ca });
        return answer.status === 303 && cookiePair(answer) !== null;
      },
      async pairs(code) {
        if (typeof code !== "string") return false;
        remember(code, "pairing-code");
        const answer = await send(`${record.origin}/-/pair`, {
          method: "POST",
          headers: { origin: record.origin, "content-type": "application/json" },
          body: JSON.stringify({ code }),
          ca: record.ca,
        });
        return cookiePair(answer) !== null;
      },
      async freshLink() {
        const issued = await socket.call("issueAccess", { label: `matrix revoke ${ctx.uniq()}` });
        remember(issued.result?.token, "grant");
        remember(new URL(issued.result.url).searchParams.get("token"), "grant");
        if (!(await ctx.exchanges(issued.result.url)))
          throw new Error("a fresh link did not exchange before revoking it");
        return { id: issued.result.id, url: issued.result.url };
      },
    };
    // A person's thread for the agents' replies.
    const thread = await ctx.api("grant-cookie", "POST", "comments", {
      target: "view:flow",
      anchor: { kind: "view" },
      body: "the person's question",
    });
    ctx.personThread = JSON.parse(thread.body).id;
    ctx.replyThread = JSON.parse(
      (
        await ctx.api("grant-cookie", "POST", "comments", {
          target: "view:flow",
          anchor: { kind: "view" },
          body: "the person's thread for browser replies",
        })
      ).body,
    ).id;

    const dirs = [
      ["project", projectRoot],
      ["canary", canary],
      ["config", record.root, ["archer.toml"]],
      ["state", record.stateDir],
    ];
    const continuityTexts = () => {
      const out = {};
      let names = [];
      try {
        names = readdirSync(join(record.stateDir, "runtime"));
      } catch {
        /* none yet */
      }
      for (const file of names)
        if (file.endsWith(".continuity.json")) {
          try {
            out[`state:runtime/${file}`] = readFileSync(join(record.stateDir, "runtime", file), "utf8");
          } catch {
            /* raced */
          }
        }
      try {
        out["state:listeners.json"] = readFileSync(join(record.stateDir, "listeners.json"), "utf8");
      } catch {
        /* none yet */
      }
      // The recovery records, for a mismatch's credential-free diff (recoveryDiff); never judged by content.
      for (const file of names)
        if (RECOVERY.test(`state:runtime/${file}`)) {
          try {
            out[`state:runtime/${file}`] = readFileSync(join(record.stateDir, "runtime", file), "utf8");
          } catch {
            /* raced */
          }
        }
      return out;
    };
    /** This project's continuity file (the one naming its root), or null. */
    const projectContinuity = () =>
      Object.entries(continuityTexts()).find(
        ([p, text]) =>
          CONTINUITY.test(p) &&
          (() => {
            try {
              return JSON.parse(text).root === projectRoot;
            } catch {
              return false;
            }
          })(),
      )?.[1] ?? null;
    const projectDirs = [["project", projectRoot]];
    // X-21: the project as last seen consumed by the service (its continuity baseline agreed with it); every document
    // changed since (by a prepare, or the cell before) must be consumed before the next before-snapshot.
    let consumedProject = snapshot(projectDirs);
    const consume = { checked: 0, pendingAtStart: 0, maxWaitMs: 0, timeouts: 0 };
    /**
     * An idle barrier: snapshots every SAMPLE_MS until nothing (project, canary, account config, service state) has
     * changed for `ms`; at most QUIET_CAP_MS (a state that never settles is counted in meta.quietCapped).
     */
    let quietCapped = 0;
    const quiet = async (ms = quietMs) => {
      let last = snapshot(dirs),
        stableSince = Date.now();
      const deadline = Date.now() + QUIET_CAP_MS;
      while (Date.now() - stableSince < ms) {
        if (Date.now() > deadline) {
          quietCapped++;
          break;
        }
        await sleep(SAMPLE_MS);
        const next = snapshot(dirs);
        if (changedPaths(last, next).length > 0) {
          last = next;
          stableSince = Date.now();
        }
      }
      return last;
    };
    const settled = () => quiet();
    // X-20 seeds (housekeeping:<kind>): a refusal's state change dressed as housekeeping, which the allowance must not pass.
    const housekeepingSetup = async (kind) => {
      if (kind === "drop-fresh-announcement") {
        const r = await socket.call("recordWrite", {
          root: projectRoot,
          viewId: "flow",
          summary: `seed ${ctx.uniq()}`,
        });
        if (!r.admitted) throw new Error(`seed recordWrite refused (${r.code})`);
        return {};
      }
      if (kind === "drop-fresh-agent" || kind === "backdate-agent") return { agentId: await ctx.registerAgent() };
      if (kind === "continuity-version") return {};
      throw new Error(`unknown housekeeping seed ${kind}`);
    };
    const housekeepingSeed = (kind, seeded) => {
      const rewrite = (file, change) => {
        const value = JSON.parse(readFileSync(file, "utf8"));
        change(value);
        writeFileSync(file, JSON.stringify(value));
      };
      const runtime = join(record.stateDir, "runtime");
      const continuityFiles = (existsSync(runtime) ? readdirSync(runtime) : [])
        .filter((f) => f.endsWith(".continuity.json"))
        .map((f) => join(runtime, f))
        .filter((f) => {
          try {
            return JSON.parse(readFileSync(f, "utf8")).root === projectRoot;
          } catch {
            return false;
          }
        });
      if (kind === "drop-fresh-announcement")
        for (const f of continuityFiles)
          rewrite(f, (v) => {
            v.writes = v.writes.filter((w) => Date.now() - w.at > 5_000);
          });
      if (kind === "continuity-version")
        for (const f of continuityFiles)
          rewrite(f, (v) => {
            v.version = (Number(v.version) || 1) + 1;
          });
      const listenersFile = join(record.stateDir, "listeners.json");
      if (kind === "drop-fresh-agent")
        rewrite(listenersFile, (v) => {
          v.agents = v.agents.filter((a) => a.agentId !== seeded.agentId);
        });
      if (kind === "backdate-agent")
        rewrite(listenersFile, (v) => {
          for (const a of v.agents) if (a.agentId === seeded.agentId) a.lastActive = "2001-01-01T00:00:00.000Z";
        });
    };
    const selected = (surface, row) => only === undefined || new RegExp(only).test(`${surface} ${row.id}`);
    const seedRow = seed?.includes("-write:") ? seed.split(":")[1] : null;
    const cells = [];

    /** One cell: prepare, snapshot, act, settle, check the effect, judge. */
    const cell = async (spec) => {
      // A queued row runs with the account's comment_submission = "queued", put back after the cell.
      if (spec.row.queued) {
        queued = true;
        applyPhase(current);
      }
      try {
        await oneCell(spec);
      } finally {
        if (spec.row.queued) {
          queued = false;
          applyPhase(current);
        }
      }
    };
    const oneCell = async ({ surface, row, column, phase, expected, code, act }) => {
      let prepared = {};
      try {
        if (row.prepare) prepared = await row.prepare(ctx, column, expected);
      } catch (error) {
        // A setup the tool could not make is reported as a failed cell (never skipped), and the run goes on.
        cells.push({
          surface,
          row: row.id,
          column,
          phase: phase.id,
          pathClass: row.pathClass,
          capability: row.capability ?? "setup",
          rules: row.rules,
          expected,
          admitted: false,
          changed: [],
          positive: false,
          verdict: "mismatch",
          mismatches: ["prepare-failed"],
          control: "none",
          error: String(error?.message ?? error).slice(0, 300),
        });
        return;
      }
      const seeded =
        seed?.startsWith("housekeeping:") && expected === "refuse" ? await housekeepingSetup(seed.split(":")[1]) : {};
      // The before-snapshot is an idle barrier: the service's own state (and the project, config and canary) must
      // stop changing for `quietMs`, so what a prepare set off (a file it wrote or removed, which the watcher then
      // reloads and the continuity baseline follows) has landed before this cell's request is sent.
      // X-21: and before that, every document the tool changed since the last consumed point (a prepare's, or the cell
      // before's) is in the service's persisted continuity baseline at the disk's revision (or gone from it): the reload
      // the watcher scheduled has finished its last phase. Not consumed in time: the cell is NOT EVALUATED, never a pass.
      const touched = changedPaths(consumedProject, snapshot(projectDirs));
      const barrier = await consumedBarrier(touched, {
        read: () => ({ disk: snapshot(projectDirs), continuity: projectContinuity(), root: projectRoot }),
        quiet: () => quiet(),
        sleep,
        capMs: consumeCapMs,
        sampleMs: SAMPLE_MS,
      });
      // consume: barriers with a document to check, those that found one not consumed yet (the X-21 race, now waited out), the longest.
      if (touched.some((p) => /\.(md|mmd)$/.test(p))) {
        consume.checked++;
        consume.maxWaitMs = Math.max(consume.maxWaitMs, barrier.waitedMs);
      }
      if (barrier.pendingAtStart > 0) consume.pendingAtStart++;
      if (!barrier.consumed) {
        consume.timeouts++;
        cells.push({
          surface,
          row: row.id,
          column,
          phase: phase.id,
          pathClass: row.pathClass,
          capability: row.capability ?? (row.rules.length ? `rule:${row.rules.join("+")}` : "no-rule"),
          rules: row.rules,
          expected,
          admitted: false,
          changed: [],
          positive: false,
          verdict: "not-evaluated",
          mismatches: [],
          control: "none",
          reason: `the service did not consume the prepared change within ${consumeCapMs} ms: ${barrier.pending.map((p) => `${p.path} (${p.reason})`).join(", ")}`,
        });
        if (row.after) await row.after(ctx, false, prepared);
        return;
      }
      const before = barrier.before;
      consumedProject = Object.fromEntries(Object.entries(before).filter(([p]) => p.startsWith("project:")));
      const continuityBefore = continuityTexts();
      const startedAt = Date.now();
      const files = typeof row.files === "function" ? row.files(prepared, phase) : row.files;
      const saved = Object.fromEntries(
        files
          .filter((f) => f.startsWith("project:"))
          .map((f) => {
            const p = join(projectRoot, f.slice(8));
            return [p, existsSync(p) ? readFileSync(p) : null];
          }),
      );
      const answer = await act(prepared);
      // Seeds: a refusal that still writes, or an admission whose write is undone.
      if (seedRow === row.id && seed.startsWith("phantom-write:") && !answer.admitted)
        writeFileSync(
          join(projectRoot, ".archer/diagrams/flow.mmd"),
          `${readFileSync(join(projectRoot, ".archer/diagrams/flow.mmd"), "utf8")}%% phantom\n`,
        );
      if (seed === "refused-with-state-change" && !answer.admitted) {
        // As if a refusal still touched private service state: the lifecycle record gains a byte (same JSON, new hash).
        const lifecycleFile = join(record.stateDir, "runtime", "project-lifecycle.json");
        if (existsSync(lifecycleFile)) writeFileSync(lifecycleFile, `${readFileSync(lifecycleFile, "utf8")}\n`);
      }
      if (seed?.startsWith("housekeeping:") && !answer.admitted) housekeepingSeed(seed.split(":")[1], seeded);
      if (seedRow === row.id && seed.startsWith("lost-write:") && answer.admitted)
        for (const [p, bytes] of Object.entries(saved)) {
          if (bytes === null) rmSync(p, { force: true });
          else writeFileSync(p, bytes);
        }
      const after = await quiet(afterQuietMs);
      const changed = changedPaths(before, after);
      const effectSeen = files.every((f) => changed.includes(f)) && (files.length > 0 || row.verify !== undefined);
      const forbidden = changed.filter((f) => (row.forbid?.(phase) ?? []).some((prefix) => f.startsWith(prefix)));
      const verified = row.verify ? await row.verify(ctx, prepared, answer.result, { phase, changed }) : true;
      const positive = effectSeen && verified && forbidden.length === 0;
      // A refused row may name a check of its own that nothing happened beyond the files (`unchanged`).
      const unchanged = !answer.admitted && row.unchanged ? await row.unchanged(ctx, prepared, { phase }) : true;
      const allowed = row.allowed ?? ["project:.archer/"];
      // The only state a refusal may change, verified by content against this cell's own clock: announcements that
      // really expired (continuityAgedOnly) and agent housekeeping by the product's rules (listenersHousekeepingOnly).
      const continuityAfter = continuityTexts();
      const window = { start: startedAt, end: Date.now() };
      const aged = changed.filter(
        (p) =>
          continuityBefore[p] !== undefined &&
          continuityAfter[p] !== undefined &&
          (CONTINUITY.test(p)
            ? continuityAgedOnly(continuityBefore[p], continuityAfter[p], window)
            : p === LISTENERS && listenersHousekeepingOnly(continuityBefore[p], continuityAfter[p], window)),
      );
      const refusalState = [...(row.refusalState ?? []), ...aged.map((p) => p.slice("state:".length))];
      const judged = judge(
        expected,
        {
          admitted: answer.admitted,
          changed,
          positive,
          negative: !positive && unchanged,
          code: answer.code ?? undefined,
        },
        allowed,
        { refusalState, code },
      );
      // Any mismatch that involves a state path keeps a credential-free account of the continuity and listener
      // files before and after (stateDiff), so a future one can be attributed without the sandbox.
      const stateChanged = changed.filter((p) => p.startsWith("state:") && !aged.includes(p));
      const stateDiffs =
        judged.verdict === "mismatch" && stateChanged.length > 0
          ? stateDiff(stateChanged, continuityBefore, continuityAfter, window, { before, after })
          : undefined;
      if (row.after) await row.after(ctx, answer.admitted, prepared);
      cells.push({
        ...(stateDiffs === undefined ? {} : { stateDiff: stateDiffs }),
        surface,
        row: row.id,
        column,
        phase: phase.id,
        pathClass: row.pathClass,
        capability: row.capability ?? (row.rules.length ? `rule:${row.rules.join("+")}` : "no-rule"),
        rules: row.rules,
        expected,
        admitted: answer.admitted,
        status: answer.status,
        code: answer.code ?? undefined,
        expectedCode: code,
        changed,
        refusalStateAllowed: answer.admitted ? [] : aged,
        positive,
        ...judged,
      });
    };
    const httpAnswer = (response) => {
      let code;
      try {
        code = JSON.parse(response.body)?.error?.code;
      } catch {
        /* not JSON */
      }
      return {
        admitted: response.status >= 200 && response.status < 400,
        status: response.status,
        code: code ?? (response.status === 404 && response.body === "" ? "bare_404" : undefined),
        result: null,
      };
    };

    // Launch first, before any agent registers as a listener in the checkout (a live listener gets the message instead).
    // Neither the edit switch nor a write rule applies to it, so one phase; every column is crossed.
    if (selected("http", LAUNCH_ROW) && (phases === undefined || phases.includes(PHASES[0].id))) {
      applyPhase(PHASES[0]);
      await settled();
      for (const column of [...columns].sort((x, y) => (x === "owner-cookie" ? -1 : y === "owner-cookie" ? 1 : 0))) {
        const expected = expectedHttp(LAUNCH_ROW, column, PHASES[0]);
        await cell({
          surface: "http",
          row: LAUNCH_ROW,
          column,
          phase: PHASES[0],
          expected,
          code: expectedHttpCode(LAUNCH_ROW, column, expected),
          act: async (s) => httpAnswer(await LAUNCH_ROW.send(ctx, column, s)),
        });
      }
    }
    for (const phase of PHASES.filter((p) => phases === undefined || phases.includes(p.id))) {
      applyPhase(phase);
      await settled();
      for (const row of HTTP_ROWS.filter((r) => selected("http", r) && phaseRuns(phase, r)))
        for (const column of columns) {
          const expected = expectedHttp(row, column, phase);
          await cell({
            surface: "http",
            row,
            column,
            phase,
            expected,
            code: expectedHttpCode(row, column, expected),
            act: async (s) => httpAnswer(await row.send(ctx, column, s)),
          });
        }
      for (const transport of transports) {
        const door = transport === "mcp" ? await mcpSession({ cwd: projectRoot, env }) : null;
        if (door) sessions.push(door);
        for (const row of MANAGEMENT_ROWS.filter(
          (r) =>
            selected(transport, r) &&
            phaseRuns(phase, r) &&
            (r.transports === undefined || r.transports.includes(transport)),
        ))
          await cell({
            surface: transport,
            row,
            column: "same-account",
            phase,
            expected: expectedManagement(row, phase),
            act: async (s) =>
              transport === "mcp"
                ? door.call(row.op, row.args(ctx, s))
                : cliCall(row.op, row.args(ctx, s), { cwd: projectRoot, env, flags: row.flags?.(s) ?? [] }),
          });
        door?.close();
      }
      for (const row of SOCKET_ROWS.filter((r) => selected("socket", r) && phaseRuns(phase, r)))
        await cell({
          surface: "socket",
          row,
          column: "same-account",
          phase,
          expected: row.expect?.(phase) ?? expectedManagement(row, phase),
          code: (row.expect?.(phase) ?? expectedManagement(row, phase)) === "refuse" ? row.refusalCode?.() : undefined,
          act: async (s) => socket.call(row.method, row.params(ctx, s)),
        });
    }

    // HTTP never reaches a management-only operation or socket method (R4, P10), whatever the credential.
    const registries = loadRegistries();
    const { OPERATION_CLASSES, SOCKET_METHODS } = await import("./inventory-model.mjs");
    const firstPhase = PHASES[0];
    applyPhase(firstPhase);
    const httpOnlyColumns = ["grant-cookie", "grant-bearer", "owner-path", "owner-cookie"];
    const managementOps = registries.operations
      .map((o) => o.name)
      .filter((n) => OPERATION_CLASSES[n]?.state && !registries.browserOperations.includes(n));
    const httpMgmtRows = [
      ...managementOps.map((op) => ({
        id: `operations:${op}`,
        rules: [],
        path: "refuse",
        pathClass: "management-only",
        capability: "management",
        files: [],
        send: (column) => ctx.api(column, "POST", "operations", { name: op, arguments: {} }),
      })),
      ...Object.entries(SOCKET_METHODS)
        .filter(([, c]) => c.state)
        .map(([method]) => ({
          id: `path:${method}`,
          rules: [],
          path: "refuse",
          pathClass: "management-only",
          capability: "management",
          files: [],
          send: (column) => ctx.api(column, "POST", method, {}),
        })),
    ];
    for (const row of httpMgmtRows.filter((r) => selected("http-management", r)))
      for (const column of httpOnlyColumns)
        await cell({
          surface: "http-management",
          row,
          column,
          phase: firstPhase,
          expected: "refuse",
          act: async () => {
            const answer = httpAnswer(await row.send(column));
            // The operations route answers a refusal of an unlisted name as 422 invalid_request.
            return answer.code === "invalid_request" ? { ...answer, admitted: false } : answer;
          },
        });

    const notEvaluated = [...NOT_EVALUATED];
    const notCovered = [
      "Pairing as a credential column on writes: a paired device holds a grant cookie (the same column as grant-cookie).",
      "Management writes from another OS account: the kernel refuses the connection (--other-account cell), so no operation is reachable to cross with rules or paths.",
    ];
    if (otherAccount) {
      const probe = spawnSync(
        process.execPath,
        [join(HERE, "other-account-socket.mjs"), "--socket", env.ARCHER_SOCKET, "--json"],
        { cwd: REPO, encoding: "utf8", timeout: 240_000 },
      );
      let parsed = null;
      try {
        parsed = JSON.parse(probe.stdout.trim().split("\n").pop());
      } catch {
        /* none */
      }
      if (probe.status === 2 || parsed === null)
        notCovered.push(`another OS account (--other-account): Docker could not run the probe (exit ${probe.status})`);
      else {
        const otherAdmitted = parsed.other?.connected === true;
        cells.push({
          surface: "socket",
          row: "connect",
          column: "another-account",
          phase: "any",
          pathClass: "socket",
          capability: "connect",
          rules: [],
          expected: "refuse",
          admitted: otherAdmitted,
          code: parsed.other?.code,
          changed: [],
          positive: false,
          verdict: otherAdmitted ? "mismatch" : "pass",
          mismatches: otherAdmitted ? ["over-admit"] : [],
          control: otherAdmitted ? "none" : "negative",
        });
        const ownerOk = parsed.owner?.connected === true && parsed.owner?.answered === true;
        cells.push({
          surface: "socket",
          row: "connect",
          column: "same-account",
          phase: "any",
          pathClass: "socket",
          capability: "connect",
          rules: [],
          expected: "admit",
          admitted: ownerOk,
          changed: [],
          positive: ownerOk,
          verdict: ownerOk ? "pass" : "mismatch",
          mismatches: ownerOk ? [] : ["under-admit"],
          control: ownerOk ? "positive" : "none",
        });
      }
    } else notCovered.push("another OS account: not run (pass --other-account; needs Docker)");

    // setup_network_access with the person's yes, in a private network namespace of its own (nothing on a host interface).
    let network = null;
    if (networkNetns) {
      const { runInNamespace } = await import("./network-access-netns.mjs");
      network = runInNamespace();
      const at = notEvaluated.findIndex((n) => n.row.startsWith("setup_network_access"));
      if (network.unavailable !== undefined)
        notEvaluated[at] = {
          ...notEvaluated[at],
          reason: `no safe place to run it: ${network.unavailable}. It rebinds the service off loopback, and this tool never binds a host interface.`,
        };
      else {
        notEvaluated.splice(at, 1);
        cells.push(...network.cells);
      }
    }

    applyPhase(firstPhase);
    // Stop and handover end a service, so each gets a service of its own, last: `archer call stop_service` on a second
    // throwaway sandbox, then the socket's `handover` on this one. Their deny controls are the http-management cells
    // (path:stop, path:handover, operations:stop_service: refused for every browser credential, nothing changed).
    if (lifecycle && selected("socket", { id: "handover" })) {
      const alive = (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const exits = async (pid) => {
        for (let waited = 0; waited < 15_000; waited += 200) {
          if (!alive(pid)) return true;
          await sleep(200);
        }
        return false;
      };
      const lifecycleCell = (surface, row, answer, stopped) =>
        cells.push({
          surface,
          row,
          column: "same-account",
          phase: "lifecycle",
          pathClass: "service",
          capability: "no-rule",
          rules: [],
          expected: "admit",
          admitted: answer.admitted,
          code: answer.code ?? undefined,
          changed: [],
          positive: stopped,
          ...judge("admit", { admitted: answer.admitted, changed: [], positive: stopped }, ["project:.archer/"]),
        });
      const stopName = `${name}-stop`;
      const corpus = writeFixtureCorpus();
      try {
        const second = await sandbox.up({ name: stopName, corpus, tls: true });
        const answer = await cliCall(
          "stop_service",
          {},
          { cwd: second.projects[0].root, env: sandbox.sandboxEnv(second) },
        );
        lifecycleCell("cli", "stop_service", answer, answer.admitted && (await exits(second.pid)));
      } finally {
        rmSync(corpus, { recursive: true, force: true });
        if (sandbox.readRecord(stopName) !== null) await sandbox.down({ name: stopName });
      }
      const answer = await socket.call("handover", {});
      lifecycleCell("socket", "handover", answer, answer.admitted && (await exits(record.pid)));
    } else
      notEvaluated.push({
        surface: "cli, socket",
        row: "stop_service, stop, handover",
        reason:
          "not run: pass --lifecycle (each ends a service; the tool then uses its own second sandbox for stop and ends this one with handover)",
      });
    const meta = {
      at: new Date().toISOString(),
      commit,
      productTreeDirty: dirty,
      rubric: "docs/quality/rubrics/security.md v1 (§1 matrix, G3, G6, P1, P10)",
      sandbox: name,
      transport: record.tls ? "https (--tls)" : "http",
      seed: seed ?? null,
      phases: PHASES.filter((p) => phases === undefined || phases.includes(p.id)).map((p) => p.id),
      transports,
      columns,
      only: only ?? null,
      mcpQuestionsDeclined: helper.asked.length,
      quietMs,
      afterQuietMs,
      quietCapped,
      consumeCapMs,
      consume,
    };
    for (const c of cells) {
      const d = c.verdict === "mismatch" ? KNOWN_PRODUCT_DEFECTS.find((k) => k.match(c)) : undefined;
      if (d) c.knownDefect = d.id;
    }
    const knownProductDefects = KNOWN_PRODUCT_DEFECTS.filter((d) => cells.some((c) => c.knownDefect === d.id)).map(
      ({ id, what }) => ({ id, what }),
    );
    const report = {
      meta,
      summary: summarise(cells, notEvaluated),
      cells,
      notEvaluated,
      notCovered,
      knownProductDefects,
      ...(network === null || network.unavailable !== undefined
        ? {}
        : {
            networkNamespace: {
              address: network.address,
              interfaces: network.interfaces,
              relayLater: network.relayLater,
              reset: network.reset,
            },
          }),
    };
    const dir = out ?? mkdtempSync(join(tmpdir(), "archer-authority-matrix-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "results.json"), `${redact(JSON.stringify(report, null, 2), secrets)}\n`);
    writeFileSync(join(dir, "results.md"), redact(markdown(report), secrets));
    return { dir, report };
  } finally {
    for (const s of sessions) {
      try {
        s.close();
      } catch {
        /* closed */
      }
    }
    if (created && !keep) await sandbox.down({ name });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      name: { type: "string" },
      out: { type: "string" },
      keep: { type: "boolean" },
      seed: { type: "string" },
      only: { type: "string" },
      phases: { type: "string" },
      transports: { type: "string" },
      "other-account": { type: "boolean" },
      lifecycle: { type: "boolean" },
      "quiet-ms": { type: "string" },
      "after-quiet-ms": { type: "string" },
      "consume-cap-ms": { type: "string" },
      "network-netns": { type: "boolean" },
      "allow-known-defects": { type: "boolean" },
    },
  });
  run({
    name: values.name,
    out: values.out,
    keep: values.keep === true,
    seed: values.seed,
    only: values.only,
    phases: values.phases?.split(","),
    transports: values.transports?.split(",") ?? TRANSPORTS,
    otherAccount: values["other-account"] === true,
    lifecycle: values.lifecycle === true,
    networkNetns: values["network-netns"] === true,
    ...(values["quiet-ms"] ? { quietMs: Number(values["quiet-ms"]) } : {}),
    ...(values["after-quiet-ms"] ? { afterQuietMs: Number(values["after-quiet-ms"]) } : {}),
    ...(values["consume-cap-ms"] ? { consumeCapMs: Number(values["consume-cap-ms"]) } : {}),
  })
    .then(({ dir, report }) => {
      const { totals } = report.summary;
      process.stdout.write(
        `${JSON.stringify({ out: dir, totals, mismatches: report.summary.mismatches.length, notEvaluatedCells: totals.notEvaluatedCells, knownProductDefects: totals.knownProductDefects, unexpectedMismatches: totals.unexpectedMismatches })}\n`,
      );
      // Any mismatch fails, except known product defects under --allow-known-defects (they stay mismatches in the report).
      // A cell NOT EVALUATED (its prepare not consumed in time, X-21) is no evidence either way: it fails the run too.
      if (
        totals.unexpectedMismatches > 0 ||
        totals.notEvaluatedCells > 0 ||
        (totals.knownProductDefects > 0 && values["allow-known-defects"] !== true)
      )
        process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`authority-matrix: ${error.stack ?? error}\n`);
      process.exitCode = 2;
    });
}
