// The route inventory behind tools/devkit/security/inventory.mjs (security rubric G2, G3, §5).
//
// Archer's API routes are a declared table (shared/api-routes.mts) and its prelude matches a few paths ad hoc
// (`rest[0] === "p"` …), so the inventory is a declared catalogue CROSS-CHECKED against the source: every path
// segment the table routes on and every route literal the code compares a path segment
// against must be claimed by a catalogue row (else it is reported `unclassified`), and every row's
// anchors must still be in the code (else `stale`). The management side comes from the code's own
// tables: the socket's METHODS set, AGENT_METHODS, OPERATIONS (MCP tools and CLI operations) and the
// debug routes' `debugAccess`. Per row the code-derived facts are: origin check and body cap, read
// from the handler's own text, so removing a `sameOrigin` or a `readBody` cap shows up here.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// ------------------------------------------------------------------ the catalogue

/**
 * `access` is the §1 authority class a row needs:
 *   public            answers without a credential (the frozen allowlist)
 *   public-loopback   debug health/metrics: a loopback peer, no credential
 *   read              any grant (cookie or Bearer) or the service token
 *   comment           as read, for comment writes (Bearer included, §1 "as cookie")
 *   authoring         a cookie grant (editor reads; independent of `edit`)
 *   edit              a cookie grant while the resolved `edit` switch allows
 *   owner-local       the owner's cookie from this computer (Launch, pin)
 *   config            never: every credential is refused (settings_read_only)
 *   debug-page        any grant or the service token (posting page telemetry)
 *   debug-owner       the service token only (cookie or Bearer)
 *   debug-profiling   the service token from loopback with ARCHER_DEBUG_PROFILING=1
 *   unspecified       the §1 matrix does not name it: observed only, listed for adjudication
 * `cap` names the body-cap constant the handler must apply (null: the body is never read; `drain`).
 */
const R = (id, method, path, access, extra = {}) => ({
  id,
  method,
  path,
  access,
  surface: "http",
  file: "ts/src/service/http.ts",
  state: false,
  cap: null,
  anchors: [],
  ...extra,
});

export const HTTP_ROUTES = [
  // Before admission: the allowlist.
  R("pair", "POST", "/-/pair", "public", {
    state: true,
    cap: "MAX_PAIR_BODY_BYTES",
    handler: "pairBrowser",
    anchors: ["/-/pair"],
    columns: ["none", "grant-cookie", "grant-bearer"],
    body: "{}",
  }),
  R("root", "GET", "/", "public", {
    handler: "handleRequest",
    anchors: ["", "/"],
    columns: ["none", "grant-cookie", "grant-bearer"],
    note: "no credential: the pairing form; a credential: 303 /projects/",
  }),
  // Pages and the shell.
  R("home", "GET", "/", "owner-local", {
    handler: "handleRequest",
    columns: ["owner-path"],
    note: "retired in 0.15.0: /<service token>/ is neither a credential nor a page; probed so it stays the bare 404",
  }),
  R("page-asset", "GET", "/-/page-assets/{asset}", "read", { handler: "handleRequest" }),
  R("page-projects", "GET", "/projects/", "read", {
    handler: "handleRequest",
    note: "readBrowserRoute (shared/browser-routes.mts)",
  }),
  R("page-project", "GET", "/projects/{slug}/", "read", { handler: "handleRequest" }),
  R("api-projects", "GET", "/api/projects", "read", { handler: "handleRequest", anchors: ["projects"] }),
  R("api-browser-projects", "GET", "/api/browser-projects", "read", {
    handler: "handleRequest",
    anchors: ["browser-projects"],
  }),
  R("api-connection", "GET", "/api/connection", "read", { handler: "handleRequest", anchors: ["connection"] }),
  R("api-lifecycle", "POST", "/api/project-lifecycle", "unspecified", {
    state: true,
    cap: "MAX_PROJECT_LIFECYCLE_BODY_BYTES",
    handler: "projectLifecycle",
    anchors: ["project-lifecycle"],
    body: "{}",
    note: "hides/shows a project in every reader's catalog: §1 names no column",
  }),
  R("api-settings", "GET", "/api/settings", "read", { handler: "settings", anchors: ["settings"] }),
  R("api-settings-put", "PUT", "/api/settings", "config", {
    state: true,
    cap: "drain",
    handler: "settings",
    body: "{}",
  }),
  // Per project.
  R("p-settings", "GET", "/p/{slug}/api/settings", "read", { handler: "settings" }),
  R("p-settings-put", "PUT", "/p/{slug}/api/settings", "config", {
    state: true,
    cap: "drain",
    handler: "settings",
    body: "{}",
  }),
  R("p-lifecycle", "POST", "/p/{slug}/api/project-lifecycle", "unspecified", {
    state: true,
    cap: "MAX_PROJECT_LIFECYCLE_BODY_BYTES",
    handler: "projectLifecycle",
    body: "{}",
  }),
  R("p-project-settings", "GET", "/p/{slug}/api/project-settings", "read", {
    handler: "projectSettings",
    anchors: ["project-settings"],
  }),
  R("p-project-settings-patch", "PATCH", "/p/{slug}/api/project-settings", "config", {
    state: true,
    cap: "drain",
    handler: "projectSettings",
    body: "{}",
  }),
  R("p-note-emphases", "GET", "/p/{slug}/api/note-emphases?path={note}", "read", {
    handler: "noteEmphases",
    anchors: ["note-emphases"],
  }),
  R("p-note-emphases-post", "POST", "/p/{slug}/api/note-emphases", "unspecified", {
    state: true,
    cap: "MAX_NOTE_EMPHASIS_FILE_BYTES",
    handler: "noteEmphases",
    body: "{}",
    note: "writes a sidecar in the Archer folder: comment-like or edit-like is not decided by §1",
  }),
  R("p-comment-activity", "GET", "/p/{slug}/api/comment-activity", "read", {
    handler: "commentRead",
    anchors: ["comment-activity"],
  }),
  R("p-notes", "GET", "/p/{slug}/api/notes?viewId={view}", "read", { handler: "commentRead", anchors: ["notes"] }),
  R("p-expand-menu", "GET", "/p/{slug}/api/expand-menu?viewId={view}&element=x", "read", {
    handler: "expandMenuRoute",
    anchors: ["expand-menu"],
    note: "ADR 0036 A8: a view id and an element looked up in the project model; no file is read",
  }),
  R("p-exploration", "GET", "/p/{slug}/api/exploration?viewId={view}&expand=", "read", {
    handler: "explorationRoute",
    anchors: ["exploration"],
    note: "ADR 0036 A8, A9: a link's (element, source) list replayed on the project model; sources only from this inventory; no file is read",
  }),
  R("p-notes-content", "GET", "/p/{slug}/api/notes/content?path={note}", "read", {
    handler: "commentRead",
    anchors: ["content"],
  }),
  R("p-notes-diagram", "GET", "/p/{slug}/api/notes/diagram?address=x%23y", "read", {
    handler: "commentRead",
    anchors: ["diagram"],
  }),
  R("p-notes-all", "GET", "/p/{slug}/api/notes/all", "read", { handler: "commentRead", anchors: ["all"] }),
  R("p-comments", "GET", "/p/{slug}/api/comments", "read", { handler: "commentRead", anchors: ["comments"] }),
  R("p-comments-pending", "GET", "/p/{slug}/api/comments/pending", "read", {
    handler: "commentRead",
    anchors: ["pending"],
  }),
  R("p-comments-create", "POST", "/p/{slug}/api/comments", "comment", {
    state: true,
    cap: "MAX_COMMENTS_BODY_BYTES",
    handler: "commentWrite",
    body: "{}",
  }),
  R("p-comments-submit", "POST", "/p/{slug}/api/comments/submit", "comment", {
    state: true,
    cap: "MAX_COMMENTS_BODY_BYTES",
    handler: "commentWrite",
    anchors: ["submit"],
    body: '{"threadIds":[]}',
  }),
  R("p-comments-reply", "POST", "/p/{slug}/api/comments/t-none/replies", "comment", {
    state: true,
    cap: "MAX_COMMENTS_BODY_BYTES",
    handler: "commentWrite",
    anchors: ["replies"],
    body: "{}",
  }),
  R("p-comments-resolve", "POST", "/p/{slug}/api/comments/t-none/resolve", "comment", {
    state: true,
    cap: "MAX_COMMENTS_BODY_BYTES",
    handler: "commentWrite",
    anchors: ["resolve"],
    body: "{}",
  }),
  R("p-comments-dismiss", "POST", "/p/{slug}/api/comments/t-none/dismiss", "comment", {
    state: true,
    cap: "MAX_COMMENTS_BODY_BYTES",
    handler: "commentWrite",
    anchors: ["dismiss"],
    body: "{}",
  }),
  R("p-comments-edit", "PATCH", "/p/{slug}/api/comments/t-none/c-none", "comment", {
    state: true,
    cap: "MAX_COMMENTS_BODY_BYTES",
    handler: "commentWrite",
    body: "{}",
  }),
  R("p-comments-delete", "DELETE", "/p/{slug}/api/comments/t-none/c-none", "comment", {
    state: true,
    cap: "MAX_COMMENTS_BODY_BYTES",
    handler: "commentWrite",
    body: "{}",
  }),
  R("p-listeners", "GET", "/p/{slug}/api/listeners", "read", {
    handler: "listeners",
    anchors: ["listeners", "LISTENER_ROUTES.list"],
  }),
  R("p-listeners-pin", "POST", "/p/{slug}/api/listeners/pin", "owner-local", {
    state: true,
    cap: "MAX_LISTENER_BODY_BYTES",
    handler: "listeners",
    anchors: ["LISTENER_ROUTES.pin", "pin"],
    body: "{}",
  }),
  R("p-listeners-launch", "POST", "/p/{slug}/api/listeners/launch", "owner-local", {
    state: true,
    cap: "MAX_LISTENER_BODY_BYTES",
    handler: "listeners",
    anchors: ["LISTENER_ROUTES.launch", "launch"],
    body: "{}",
    note: "spawns the recorded launcher; the probe body is invalid so nothing runs",
  }),
  R("p-operations", "POST", "/p/{slug}/api/operations", "read", {
    cap: "MAX_SELECTION_BODY_BYTES",
    handler: "browserOperation",
    anchors: ["operations"],
    body: "{}",
    note: "read-only operations (BROWSER_OPERATIONS) over POST",
  }),
  R("p-selection", "POST", "/p/{slug}/api/selection", "read", {
    state: true,
    cap: "MAX_SELECTION_BODY_BYTES",
    handler: "handleSelection",
    anchors: ["selection"],
    body: "{}",
    note: "the reader's selection, which the agent reads",
  }),
  R("p-walkthrough-position", "POST", "/p/{slug}/api/walkthrough-position", "read", {
    state: true,
    cap: "1024",
    handler: "handleReading",
    anchors: ["walkthrough-position"],
    body: "{}",
  }),
  R("p-reader-exploration", "POST", "/p/{slug}/api/reader-exploration", "read", {
    state: true,
    cap: "MAX_READER_EXPLORATION_BYTES",
    handler: "handleReaderExploration",
    anchors: ["reader-exploration"],
    body: "{}",
    note: "ADR 0036 O1: transient reader state, like a selection; changes no other page",
  }),
  R("p-documents", "GET", "/p/{slug}/api/documents", "read", { handler: "handleRequest", anchors: ["documents"] }),
  R("p-projects", "GET", "/p/{slug}/api/projects", "read", { handler: "handleRequest" }),
  R("p-browser-projects", "GET", "/p/{slug}/api/browser-projects", "read", { handler: "handleRequest" }),
  R("p-diagrams", "GET", "/p/{slug}/api/diagrams", "read", { handler: "handleRequest", anchors: ["diagrams"] }),
  R("p-compile", "GET", "/p/{slug}/api/compile", "read", { handler: "handleRequest", anchors: ["compile"] }),
  R("p-walkthroughs", "GET", "/p/{slug}/api/walkthroughs?viewId={view}", "read", {
    handler: "handleRequest",
    anchors: ["walkthroughs"],
  }),
  R("p-bootstrap", "GET", "/p/{slug}/api/bootstrap", "read", { handler: "handleRequest", anchors: ["bootstrap"] }),
  R("p-connection", "GET", "/p/{slug}/api/connection", "read", { handler: "handleRequest" }),
  R("p-events", "GET", "/p/{slug}/api/events", "read", { handler: "events", anchors: ["events"], stream: true }),
  R("p-search", "GET", "/p/{slug}/api/search?q=a", "read", { handler: "handleRequest", anchors: ["search"] }),
  R("p-browser-search", "GET", "/p/{slug}/api/browser-search?q=a", "read", {
    handler: "handleRequest",
    anchors: ["browser-search"],
  }),
  R("p-walkthroughs-old", "GET", "/p/{slug}/api/walkthroughs/old?viewId={view}&id=x", "read", {
    handler: "handleRequest",
    anchors: ["old"],
  }),
  R("p-documents-content", "GET", "/p/{slug}/api/documents/content?path={document}", "read", {
    handler: "handleRequest",
  }),
  R("p-diagram", "GET", "/p/{slug}/api/diagrams/{view}", "read", { handler: "handleRequest" }),
  R("p-diagram-source", "GET", "/p/{slug}/api/diagram-source/{view}", "read", {
    handler: "handleRequest",
    anchors: ["diagram-source"],
  }),
  R("p-emphasis", "GET", "/p/{slug}/api/emphasis/{view}", "read", { handler: "handleRequest", anchors: ["emphasis"] }),
  R("p-thumbnail", "GET", "/p/{slug}/api/thumbnails/{view}?rev=x&theme=light", "read", {
    handler: "thumbnail",
    anchors: ["thumbnails"],
  }),
  // Browser authoring (http.ts dispatch, authoring-http.ts admission).
  R("p-authoring-status", "GET", "/p/{slug}/api/authoring", "authoring", {
    file: "ts/src/service/authoring-http.ts",
    handler: "handleAuthoringHttp",
    anchors: ["authoring"],
    note: "refusal is 200 {authorized:false}",
  }),
  R("p-authoring-mutate", "POST", "/p/{slug}/api/authoring", "edit", {
    state: true,
    cap: "MAX_AUTHORING_HTTP_BYTES",
    file: "ts/src/service/authoring-http.ts",
    handler: "handleAuthoringHttp",
    body: "{}",
  }),
  ...["open", "snapshot", "preview", "edit"].map((action) =>
    R(`p-authoring-${action}`, "POST", `/p/{slug}/api/authoring/${action}`, "authoring", {
      cap: "MAX_AUTHORING_HTTP_BYTES",
      file: "ts/src/service/authoring-http.ts",
      handler: "handleAuthoringHttp",
      anchors: [action],
      body: "{}",
    }),
  ),
  R("p-authoring-presentation", "POST", "/p/{slug}/api/authoring/presentation", "edit", {
    state: true,
    cap: "MAX_AUTHORING_HTTP_BYTES",
    file: "ts/src/service/authoring-http.ts",
    handler: "handleAuthoringHttp",
    anchors: ["presentation"],
    body: "{}",
    note: "op read is authoring-level; a layout save is edit-level",
  }),
  R(
    "p-authoring-operation",
    "GET",
    "/p/{slug}/api/authoring/operations/00000000000000000000000000000000",
    "authoring",
    { file: "ts/src/service/authoring-http.ts", handler: "handleAuthoringHttp" },
  ),
];

/** Debug routes (debug-http.ts `#route`); access comes from the code's own `debugAccess`. */
export const DEBUG_ROUTES = [
  ["GET", "health"],
  ["GET", "metrics"],
  ["GET", "log"],
  ["GET", "events"],
  ["POST", "events"],
  ["POST", "reset"],
  ["POST", "profile/cpu"],
  ["POST", "heap-snapshot"],
].map(([method, name]) => ({
  id: `debug-${method.toLowerCase()}-${name.replace("/", "-")}`,
  surface: "debug",
  file: "ts/src/service/debug-http.ts",
  handler: "#route",
  method,
  path: `/-/debug/${name}`,
  name,
  anchors: [name],
  state: method === "POST",
  cap: name === "events" && method === "POST" ? "MAX_CLIENT_BATCH_BYTES" : method === "POST" ? "drain" : null,
  body: method === "POST" ? "{}" : undefined,
  columns: ["none", "grant-cookie", "grant-bearer", "owner-cookie", "owner-bearer", "revoked-cookie", "revoked-bearer"],
}));

/** Structural segment literals (`p`, `api`, `-`) and comparisons that select no route. */
const STRUCTURAL = new Set(["p", "api", "-", ""]);

/**
 * Socket methods: whether each changes state and whether HTTP has any route to it. A method in the
 * code's METHODS set with no entry here is reported `unclassified`.
 */
export const SOCKET_METHODS = {
  hello: { state: false },
  attach: { state: true },
  detach: { state: true },
  listProjects: { state: false },
  restartConfiguration: { state: false, secretBearing: true },
  issueAccess: { state: true, grants: true },
  issueAuthoringAccess: { state: true, grants: true },
  listAccess: { state: false, grants: true },
  revokeAccess: { state: true, grants: true },
  issuePairingCode: { state: true, grants: true },
  present: { state: true },
  setEmphasis: { state: true },
  listEmphases: { state: false },
  setSelection: { state: true },
  getContext: { state: false },
  getModel: { state: false },
  getProjectModel: { state: false },
  recordWrite: { state: true },
  stop: { state: true },
  handover: { state: true },
  pendingChanges: { state: false },
  listChanges: { state: false },
  readChange: { state: false },
  resolveChange: { state: true },
  readReview: { state: false },
  clearReview: { state: true },
  registerAgent: { state: true },
  claimListener: { state: true },
  heartbeat: { state: true },
  waitMessage: { state: true },
  inbox: { state: true },
  listListeners: { state: false },
  reportActivity: { state: true },
  mcpRelay: { state: true },
};

/** MCP tools and CLI operations (application OPERATIONS): state, and whether one grants a capability. */
export const OPERATION_CLASSES = {
  list_changes: { state: false },
  read_change: { state: false },
  resolve_change: { state: true },
  issue_authoring_access: { state: true, capability: true },
  read_note: { state: false },
  list_diagrams: { state: false },
  find_elements: { state: false },
  docs_index: { state: false, note: "write: true regenerates index.md" },
  list_stale_diagrams: { state: false },
  read_diagram_at_commit: { state: false },
  compare_diagrams: { state: false },
  export_diagram: { state: true, note: "writes an export file" },
  read_diagram: { state: false },
  measure_diagram: { state: false, note: "read-only fresh source geometry; no source, presentation or inbox mutation" },
  validate_diagram: { state: false },
  write_diagram: { state: true },
  register_diagram: { state: true },
  present_diagram: { state: true },
  list_walkthroughs: { state: false },
  write_walkthrough: { state: true },
  list_emphases: { state: false },
  set_emphasis: { state: true },
  list_note_emphases: { state: false },
  set_note_emphasis: { state: true },
  set_selection: { state: true },
  get_presentation_context: { state: false },
  get_ui_url: { state: false },
  create_comment: { state: true },
  get_comments: { state: false },
  reply_comment: { state: true },
  resolve_comment: { state: true },
  issue_access_link: { state: true, capability: true },
  list_access_links: { state: false },
  revoke_access_link: { state: true, capability: true },
  issue_pairing_code: { state: true, capability: true },
  setup_network_access: { state: true, capability: true },
  start_service: { state: true },
  stop_service: { state: true },
  list_projects: { state: false },
  attach_project: { state: true },
  detach_project: { state: true },
};

// ------------------------------------------------------------------ static extraction

/** The text of a top-level function (`function name(` … the next line that is `}`), or of a class member `#name(`. */
export function functionText(source, name) {
  const pattern = name.startsWith("#")
    ? new RegExp(`\\n(\\s+)(?:async )?${name.replace("#", "#")}\\(`)
    : new RegExp(`\\n(?:export )?(?:async )?function ${name}\\(`);
  const match = pattern.exec(source);
  if (match === null) return null;
  const indent = name.startsWith("#") ? match[1] : "";
  const end = source.indexOf(`\n${indent}}`, match.index + 1);
  return source.slice(match.index, end < 0 ? undefined : end + indent.length + 2);
}

/**
 * Every route literal a routing function compares a path segment against, with its line. The left
 * operand must be a segment variable (`rest[0]`, `second`, `area`, `name`, …), so method and option
 * comparisons are not mistaken for routes. Also `[...].includes(third)` lists and LISTENER_ROUTES members.
 */
export function routeLiterals(source) {
  const found = [];
  const lineOf = (index) => source.slice(0, index).split("\n").length;
  const compare =
    /\b(rest\[\d\]|route\[\d\]|segments\[\d\]|first|second|third|area|a|b|name|path)\s*[!=]==\s*"([^"]*)"/g;
  for (const m of source.matchAll(compare)) found.push({ literal: m[2], line: lineOf(m.index) });
  for (const m of source.matchAll(/\[((?:\s*"[^"]*"\s*,?)+)\]\.includes\((?:third|second|first|name)/g))
    for (const lit of m[1].matchAll(/"([^"]*)"/g)) found.push({ literal: lit[1], line: lineOf(m.index) });
  for (const m of source.matchAll(/LISTENER_ROUTES\.(\w+)/g))
    found.push({ literal: `LISTENER_ROUTES.${m[1]}`, line: lineOf(m.index) });
  return found;
}

/**
 * Every path segment the declarative route table (shared/api-routes.mts) routes on, with its line: the literal
 * segments of each `["api", …]` path (parameters `:name` excepted) and the members of a list mapped into paths
 * (`([…] as const).map(`).
 */
export function tableLiterals(source) {
  const found = [];
  const lineOf = (index) => source.slice(0, index).split("\n").length;
  for (const m of source.matchAll(/\[\s*"api"((?:\s*,\s*[^\],]+)*)\s*\]/g))
    for (const lit of m[1].matchAll(/"([^"]*)"/g))
      if (!lit[1].startsWith(":")) found.push({ literal: lit[1], line: lineOf(m.index) });
  for (const m of source.matchAll(/\[((?:\s*"[^"]*"\s*,?)+)\]\s*as const\)\.map\(/g))
    for (const lit of m[1].matchAll(/"([^"]*)"/g)) found.push({ literal: lit[1], line: lineOf(m.index) });
  return found;
}

/** The socket's METHODS set as the source spells it (it is not exported), plus `...AGENT_METHODS`. */
export function socketMethods(socketSource, agentMethods) {
  const m = /const METHODS[^=]*=\s*new Set<string>\(\[([^\]]*)\]/.exec(socketSource);
  if (m === null) return null;
  const names = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  return m[1].includes("...AGENT_METHODS") ? [...names, ...agentMethods] : names;
}

/** What a handler's own text shows: its origin check and the cap it reads its body under. */
export function handlerFacts(text, cap) {
  if (text === null) return { originCheck: "handler-missing", capInCode: false };
  const exact = /typeof req\.headers\.origin !== "string"|req\.headers\.origin !== `/.test(text);
  const same = /sameOrigin\(/.test(text);
  const originCheck = exact ? "required-exact" : same ? "sameOrigin (a missing Origin passes)" : "none in handler";
  let capInCode = false;
  if (cap === "drain") capInCode = /req\.resume\(\)|settingsReadOnly\(req/.test(text);
  else if (cap !== null && cap !== undefined)
    capInCode = text.includes(cap) || (cap === "1024" && /readBody\(req, res, 1024\)/.test(text));
  return { originCheck, capInCode };
}

/**
 * The static inventory over the repository at `repo`: rows with their code facts, plus `unclassified`
 * (route literals no row claims, socket methods or operations no class covers) and `stale` (row anchors
 * the code no longer has). `registries` carries the tables imported from the code (see registries.mts).
 */
export function staticInventory(repo, registries, sources = {}) {
  const read = (file) => sources[file] ?? readFileSync(join(repo, file), "utf8");
  const http = read("ts/src/service/http.ts"),
    debug = read("ts/src/service/debug-http.ts"),
    authoring = read("ts/src/service/authoring-http.ts");
  const socket = read("ts/src/service/socket.ts"),
    access = read("ts/src/service/browser-access.ts");
  const cookieWritesExact =
    access.includes("cookie_write_origin") && /headers\.origin !== `\$\{authority\.secure/.test(access);
  const fileText = {
    "ts/src/service/http.ts": http,
    "ts/src/service/authoring-http.ts": authoring,
    "ts/src/service/debug-http.ts": debug,
  };
  const rows = [];
  for (const row of HTTP_ROUTES) {
    const source = fileText[row.file];
    const text =
      row.handler === "handleAuthoringHttp"
        ? functionText(authoring, "handleAuthoringHttp")
        : functionText(source, row.handler);
    const facts = handlerFacts(text, row.cap);
    // Authoring admits only a cookie grant, whose non-GET writes browserAccess holds to the exact Origin and JSON.
    if (
      row.handler === "handleAuthoringHttp" &&
      facts.originCheck === "none in handler" &&
      /access\.credential\s*!==\s*["']cookie["']/.test(text ?? "")
    )
      facts.originCheck = "cookie only (browser-access exact Origin)";
    rows.push({
      ...row,
      admission: row.access === "public" ? "none (allowlist)" : "browserAccess before dispatch",
      cookieWrites: cookieWritesExact ? "exact Origin + JSON (browser-access.ts)" : "NOT FOUND",
      ...facts,
    });
  }
  const routeText = functionText(debug, "#route"),
    admitted = functionText(debug, "#admitted"),
    clientEvents = functionText(debug, "#clientEvents");
  for (const row of DEBUG_ROUTES) {
    const access = registries.debugAccess?.[`${row.method} ${row.name}`] ?? "unknown";
    const facts = handlerFacts(
      `${admitted ?? ""}\n${row.cap === "MAX_CLIENT_BATCH_BYTES" ? (clientEvents ?? "") : (routeText ?? "")}`,
      row.cap,
    );
    rows.push({
      ...row,
      access: `debug-${access}`,
      admission: "DebugHttp #admitted (ARCHER_DEBUG=1 only)",
      cookieWrites:
        "cookie: exact Origin + JSON; any write: Sec-Fetch-Site same-origin or none; Bearer: a foreign Origin refused",
      ...facts,
    });
  }
  // Cross-check: every route literal is claimed; every anchor is present.
  const claimed = new Set(rows.flatMap((row) => row.anchors));
  const unclassified = [];
  const literalsByFile = {
    "shared/api-routes.mts": tableLiterals(read("shared/api-routes.mts")),
    "ts/src/service/http.ts": routeLiterals(http),
    "ts/src/service/debug-http.ts": routeLiterals(routeText ?? "").map((x) => ({
      ...x,
      line: x.line + debug.slice(0, debug.indexOf(routeText ?? "")).split("\n").length - 1,
    })),
  };
  for (const [file, literals] of Object.entries(literalsByFile))
    for (const { literal, line } of literals)
      if (!STRUCTURAL.has(literal) && !claimed.has(literal) && !NON_ROUTE_LITERALS.has(literal))
        unclassified.push({
          surface: "http",
          file,
          line,
          literal,
          why: "a path segment the code routes on that no inventory row claims",
        });
  const allLiterals = new Set(
    Object.values(literalsByFile)
      .flat()
      .map((x) => x.literal),
  );
  const stale = rows.flatMap((row) =>
    row.anchors
      .filter((anchor) => !allLiterals.has(anchor))
      .map((anchor) => ({ id: row.id, anchor, why: "the row's anchor is no longer in the code" })),
  );
  // Management: the code's tables.
  const methods = socketMethods(socket, registries.agentMethods ?? []) ?? [];
  if (methods.length === 0)
    unclassified.push({
      surface: "socket",
      file: "ts/src/service/socket.ts",
      literal: "METHODS",
      why: "the METHODS set could not be parsed",
    });
  const management = [];
  for (const method of methods) {
    const cls = SOCKET_METHODS[method];
    if (cls === undefined) {
      unclassified.push({
        surface: "socket",
        file: "ts/src/service/socket.ts",
        literal: method,
        why: "a socket method with no class in SOCKET_METHODS",
      });
      continue;
    }
    management.push({
      id: `socket-${method}`,
      surface: "socket",
      method,
      access: "socket (same OS account; directory 0700)",
      ...cls,
    });
  }
  for (const name of Object.keys(SOCKET_METHODS))
    if (!methods.includes(name))
      stale.push({ id: `socket-${name}`, anchor: name, why: "classified but no longer in METHODS" });
  for (const operation of registries.operations ?? []) {
    const cls = OPERATION_CLASSES[operation.name];
    if (cls === undefined) {
      unclassified.push({
        surface: "operation",
        file: "ts/src/application/tools.ts",
        literal: operation.name,
        why: "an MCP tool / CLI operation with no class in OPERATION_CLASSES",
      });
      continue;
    }
    management.push({
      id: `op-${operation.name}`,
      surface: "mcp+cli",
      method: operation.name,
      access: "MCP stdio / CLI (same OS account, via the socket)",
      ...cls,
      ...(operation.annotations ? { annotations: operation.annotations } : {}),
    });
  }
  for (const name of Object.keys(OPERATION_CLASSES))
    if (!(registries.operations ?? []).some((op) => op.name === name))
      stale.push({ id: `op-${name}`, anchor: name, why: "classified but no longer in OPERATIONS" });
  management.push({
    id: "mcp-resources",
    surface: "mcp",
    method: "resources/read",
    access: "MCP stdio",
    state: false,
    note: "archer://docs/* and the app resource (ADR 0003)",
  });
  return { rows, management, unclassified, stale };
}

/** Literals compared against segment variables that route nothing (values, not paths). */
const NON_ROUTE_LITERALS = new Set([]);

// ------------------------------------------------------------------ expectations and verdicts

export const COLUMNS = [
  "none",
  "grant-cookie",
  "grant-bearer",
  "owner-path",
  "owner-cookie",
  "owner-bearer",
  "revoked-cookie",
  "revoked-bearer",
];

/**
 * The §1 matrix's expectation for a cell: "admit", "refuse", "n/a" (the credential has no form on
 * that surface) or "?" (the matrix does not say; observed only).
 */
export function expected(row, column, { edit = true, profiling = false } = {}) {
  const grant = column === "grant-cookie" || column === "grant-bearer";
  const owner = column === "owner-cookie";
  // The service token in the path is no credential (retired in 0.15.0): every such request is the bare 404.
  if (column === "owner-path") return "refuse";
  if (column.startsWith("revoked") || column === "none") {
    if (row.access === "public" || row.access === "debug-public") return "admit";
    return "refuse";
  }
  switch (row.access) {
    case "public":
    case "debug-public":
      return "admit";
    case "read":
    case "comment":
      return column === "owner-bearer" ? "n/a" : "admit";
    // The service token's Edit cell is "as cookie": its link signs a browser in (the `?token=` exchange sets an
    // owner cookie) and that cookie authors. A Bearer is explicit, non-browser authority and never authors
    // (authoring-http.ts; security round 1, B2-1).
    case "authoring":
      return column === "grant-cookie" || column === "owner-cookie"
        ? "admit"
        : column === "owner-bearer"
          ? "n/a"
          : "refuse";
    case "edit":
      return column === "grant-cookie" || column === "owner-cookie"
        ? edit
          ? "admit"
          : "refuse"
        : column === "owner-bearer"
          ? "n/a"
          : "refuse";
    case "owner-local":
      return owner ? "admit" : column === "owner-bearer" ? "n/a" : "refuse";
    case "config":
      return "refuse";
    case "debug-page":
      return grant || column === "owner-cookie" || column === "owner-bearer" ? "admit" : "n/a";
    case "debug-owner":
      return column === "owner-cookie" || column === "owner-bearer" ? "admit" : grant ? "refuse" : "n/a";
    case "debug-profiling":
      return (column === "owner-cookie" || column === "owner-bearer") && profiling
        ? "admit"
        : grant || column.startsWith("owner-")
          ? "refuse"
          : "n/a";
    case "unspecified":
      return "?";
    default:
      return "?";
  }
}

/** Codes that are a refusal of authority (not a validation answer from an admitted handler). */
const REFUSAL_CODES = new Set([
  "authoring_forbidden",
  "person_only",
  "settings_read_only",
  "editing_disabled",
  "write_rule_denied",
  "create_not_allowed",
]);

/**
 * Whether a response shows the request was admitted to its handler. A bare 404 (empty body), the
 * refused-link page, an empty 403 (an origin refusal) and the authority refusal codes are refusals;
 * anything else (a 2xx, a validation 4xx with a code, a 413) came from an admitted handler.
 */
export function classify(response) {
  if (response.status === 0) return { class: "error", detail: response.error };
  const type = String(response.headers["content-type"] ?? "");
  let code;
  if (type.includes("json")) {
    try {
      const body = JSON.parse(response.body);
      code = body?.error?.code;
      if (body?.authorized === false) code = "authorized_false";
    } catch {
      /* not JSON */
    }
  }
  if (response.status === 404 && response.body === "") return { class: "refused", code: "bare_404" };
  if (response.status === 404 && type.startsWith("text/html") && !response.body.includes("Nothing at this address"))
    return { class: "refused", code: "refused_page" };
  if (response.status === 403 && response.body === "") return { class: "refused", code: "origin_403" };
  if (code === "authorized_false" || REFUSAL_CODES.has(code)) return { class: "refused", code };
  return { class: "admitted", code: code ?? String(response.status) };
}

/** A cell's verdict: pass, over-admit (a security failure), under-admit (a contract mismatch), observed (no expectation). */
export function verdict(expectation, observed) {
  if (observed === "error") return "error";
  if (expectation === "?" || expectation === "n/a") return "observed";
  if (expectation === observed.replace("admitted", "admit").replace("refused", "refuse")) return "pass";
  return expectation === "refuse" ? "over-admit" : "under-admit";
}

// ------------------------------------------------------------------ probes

/** The five G2 variants for a cookie-borne write (rubric G2): each must be refused with no effect. */
export function crossSiteVariants(origin) {
  return [
    { name: "foreign Origin", headers: { origin: "https://evil.example", "content-type": "application/json" } },
    { name: "Origin: null", headers: { origin: "null", "content-type": "application/json" } },
    { name: "cookie without Origin", headers: { "content-type": "application/json" } },
    { name: "simple content type", headers: { origin, "content-type": "text/plain" } },
    {
      name: "Sec-Fetch-Site: cross-site",
      headers: {
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "no-cors",
        "content-type": "application/x-www-form-urlencoded",
      },
    },
  ];
}

/** A hash of every file under `dirs` (skipping .git and caches), for "the state hash is unchanged". */
export function stateHash(dirs, skip = /(^|\/)(\.git|cache|node_modules)(\/|$)/) {
  const hash = createHash("sha256");
  const walk = (root, dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name),
        rel = relative(root, path);
      if (skip.test(rel)) continue;
      if (entry.isDirectory()) walk(root, path);
      else if (entry.isFile()) {
        hash.update(rel);
        hash.update(String(statSync(path).size));
        try {
          hash.update(readFileSync(path));
        } catch {
          /* raced */
        }
      }
    }
  };
  for (const dir of dirs) walk(dir, dir);
  return hash.digest("hex");
}

/** §5 metrics from a probed (or static) inventory. */
export function metrics(inventory) {
  const http = inventory.rows;
  const nonPublic = http.filter((row) => !["public", "debug-public"].includes(row.access));
  const stateful = http.filter((row) => row.state);
  const bodyRows = http.filter(
    (row) =>
      (row.cap !== null && row.cap !== undefined && row.cap !== "drain") ||
      (row.body !== undefined && row.method !== "GET"),
  );
  const missingAdmission = nonPublic.filter(
    (row) =>
      row.cells !== undefined &&
      ["none", "revoked-cookie", "revoked-bearer"].some(
        (column) => row.cells.edit_on?.[column]?.verdict === "over-admit",
      ),
  );
  // Probed: any G2 variant admitted or changing state. Static: the handler (or browser-access for cookies) shows no check;
  // `config` rows refuse every credential before reading, so they need none.
  const staticMissing = (row) =>
    row.access !== "config" &&
    (row.originCheck === "none in handler" ||
      row.originCheck === "handler-missing" ||
      row.cookieWrites === "NOT FOUND");
  const missingOrigin = stateful.filter(
    (row) => row.crossSite?.some((v) => v.class === "admitted" || v.stateChanged) || staticMissing(row),
  );
  const missingCap = bodyRows.filter(
    (row) =>
      row.cap === null ||
      row.cap === undefined ||
      (row.cap !== "drain" && !row.capInCode) ||
      row.bodyCap?.some((probe) => probe.refused === false),
  );
  return {
    inventoryRows: { http: http.length, management: inventory.management.length },
    unclassified: inventory.unclassified.length,
    stale: inventory.stale.length,
    rowsMissingAdmission: {
      count: missingAdmission.length,
      of: nonPublic.length,
      ids: missingAdmission.map((r) => r.id),
    },
    rowsMissingOriginCheck: { count: missingOrigin.length, of: stateful.length, ids: missingOrigin.map((r) => r.id) },
    rowsMissingBodyCap: { count: missingCap.length, of: bodyRows.length, ids: missingCap.map((r) => r.id) },
  };
}
