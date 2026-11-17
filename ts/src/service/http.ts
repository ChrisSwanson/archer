// The data plane: Archer's own page and the routes it reads, per project, all
// under the one service token (ticket 07), with the headers, limits and
// checks of Rust's crates/archer-present/src/browser.rs.
//
//   GET  /                              a signed-in browser: to /projects/; without a credential: the pairing form
//   GET  /projects/<name>/…             the web page (`defaultPagePath`); `?token=` signs the browser in first
//   GET  /-/page-assets/<name>          the page's own files (its ELK layout worker), by content-hashed name
//   .../p/<name>/api/…                  a project's routes, by cookie (a browser session) or Bearer grant;
//                                       declared in shared/api-routes.mts, answered by API_HANDLERS (routes.ts)
//   GET  .../api/diagrams               inventory          {schemaVersion 1, views}
//   GET  .../api/diagrams/<id>          envelope           {schemaVersion 2, view, revision, model}
//   GET  .../api/compile                failing sources    {schemaVersion 1, failures}
//   GET  .../api/bootstrap              what is presented (with its exploration stamp), or null
//   GET  .../api/connection             browser compatibility and service epoch
//   GET  .../api/emphasis/<id>          {schemaVersion 1, viewId, emphases}
//   GET  .../api/thumbnails/<id>?rev=&theme=&v=&format=  thumbnail at that model revision (immutable):
//                                       format=svg (default; br/gzip by accept-encoding) or png
//   GET/POST .../api/note-emphases      durable named passage emphasis for one note
//   GET  .../api/expand-menu?viewId=<id>&element=<id>&expand=<list>  one element's Expand entries and pieces
//                                       (ADR 0036 §11–§13; schema/explorations.v1.schema.json)
//   GET  .../api/exploration?viewId=<id>&expand=<list> | &presentationId=<id>  every frame of an exploration
//   POST .../api/reader-exploration     the reader's own additions and frame selection (O1)
//   GET  .../api/walkthroughs?viewId=<id> a view's walkthroughs and their resolution (ts/src/walkthroughs/contract.ts)
//   GET  .../api/walkthroughs/old?viewId=<id>&id=<walkthrough id> the model it was written on, from Git
//   GET  .../api/search?q=<words>       the contents page's filter  {query, results}
//   GET  .../api/events                 SSE: presentation, inventory, compile, emphasis, note-emphasis, comments, notes, change, walkthroughs, listeners
//   POST .../api/selection              what the reader selected
//   POST .../api/walkthrough-position   the walkthrough and step the reader is on
//   GET/PATCH .../api/project-settings  settings snapshot; PATCH edits archer.toml's name/description
//   GET  .../api/comment-activity       per-view/note thread counts and latest post time
//   GET  .../api/listeners              who listens in this checkout and its worktrees (ListenerListing)
//   POST .../api/listeners/pin          the person's pick {agentId|null}; .../launch {threadId}: run their launcher
//   .../api/comments, .../api/notes     comments and notes (ts/src/comments/contract.ts), including
//                                       api/notes/all (every note, those about no diagram too),
//                                       api/comments/pending, api/comments/submit and .../<id>/dismiss
//
// A request without the token gets a bare 404, whatever its path or method,
// so a caller holding no credential cannot tell a wrong token from a route
// that does not exist. One exception, for people: a GET of a page-shaped
// address without a valid browser credential gets a short 404 page asking for
// a new link, the same bytes for every such address (refusedPage). A browser that does hold a valid
// credential and asks for a page of no project gets a not-found page with a link to Projects, also the
// same bytes for every address (NOT_FOUND_PAGE).
import { markRefusedConnection } from "./web-server.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { networkInterfaces } from "node:os";
import { pageText } from "./project-facts.ts";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import { promisify } from "node:util";
import { handleAuthoringHttp, type AuthoringAction, type AuthoringHttpBackend } from "./authoring-http.ts";
import { PersistenceError } from "../state/account.ts";
import { NoteNotFound } from "../comments/notes.ts";
import { CommentsError } from "../comments/store.ts";
import { NoteEmphasisError } from "../notes/emphasis.ts";
import { MAX_NOTE_EMPHASIS_FILE_BYTES } from "../../../shared/note-emphasis.mts";
import { SearchRefusal } from "./front-door.ts";
import { StateRefusal, type ProjectState } from "./project-state.ts";
import { WalkthroughsError } from "../walkthroughs/store.ts";
import type { StreamCap } from "./streams.ts";
import { MAX_EVENT_STREAMS, MAX_EVENT_STREAMS_PER_GRANT } from "./streams.ts";
import { contentSecurityPolicy, inlineScriptHashes, pageCsp, SCRIPTLESS_CSP } from "./page-csp.ts";
import type { BrowserConnection } from "./browser-protocol.ts";
import { decodeExpansions, type Expansion } from "../../../shared/explorations.mts";
import { browserAccess, sessionCookie, type AccessRefusal, type BrowserAuthority } from "./browser-access.ts";
import type { PairingCodes } from "./pairing-codes.ts";
import { safeReturnPath } from "./return-path.ts";
import {
  ACCESS_PAGE_STYLE,
  MAX_PAIR_BODY_BYTES,
  PAIRING_PAGE,
  pairingPage,
  type PairingMessage,
} from "./pairing-page.ts";
import { browserRoutePath, readBrowserRoute, type BrowserRoute } from "../../../shared/browser-routes.mts";
import { parseDiagramAddress } from "../../../shared/note-diagrams.mts";
import type { DiscoverySettings } from "../project/discovery.ts";
import { projectSummary } from "./project-summary.ts";
import { ThumbnailRefusal, type ThumbnailFormat, type ThumbnailStore } from "./thumbnails.ts";
import { PAGE_ASSETS_DIR } from "../../../shared/page-assets.mts";
import { activeTelemetry, currentRequest, phaseEnd, phaseStart, requestClient } from "../telemetry/index.ts";
import { dispatchApi, routeHandlers, type RequestAccess, type RouteContext, type RouteHandler } from "./routes.ts";

/** A selection is a handful of ids; anything larger is a bug or an attack. */
import { parseBrowserOperation, BrowserOperationRefusal } from "./browser-operations.ts";
import { OperationError, type OperationResult } from "../application/index.ts";
import { InstanceSettingsError, type InstanceSettingsStore } from "../config/instance-settings.ts";
import { browserEditing, WriteRuleDenied } from "../config/write-policy.ts";
import { ProjectError } from "../project/errors.ts";
import { findProject } from "../project/index.ts";
import { EDITING_DISABLED } from "../project/source-writer.ts";
import {
  ProjectSettingsError,
  projectSettingsSnapshot,
  readProjectManifest,
  type ProjectSettingsSnapshot,
} from "../config/project-settings.ts";
import type { ResolvedFeedbackConfiguration } from "../config/feedback-resolution.ts";
import { configurationSourceRevision } from "../config/source-revision.ts";
import { resolveDiscoverySettings } from "../project/discovery.ts";
import type { OperationAck, Thread } from "../comments/contract.ts";
import { LISTENER_EVENT, LISTENER_ROUTES, type ListenerListing, type ListenerStatus } from "../agents/contract.ts";
import type { ProjectLifecycleMetadata, ProjectVisibility } from "../state/project-lifecycle.ts";
import {
  MAX_PROJECT_LIFECYCLE_BODY_BYTES,
  parseProjectLifecycleMutation,
  ProjectLifecycleRequestError,
  visibilityFor,
} from "./project-lifecycle.ts";

export const MAX_SELECTION_BODY_BYTES = 64 * 1024;
/** A comment of MAX_COMMENT_CHARS, in any script, with its anchor, fits with room to spare. */
export const MAX_COMMENTS_BODY_BYTES = 64 * 1024;
/** A heartbeat on every open stream this often, retaining the legacy comment. */
export const KEEP_ALIVE_MS = 15_000;
/** How soon a native EventSource reconnects to a project still being opened after a start. */
const RESTORE_RETRY_MS = 1_000;

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  // No script runs: an HTML answer with inline scripts carries its own hashes instead (`htmlHeaders`, page-csp.ts).
  "content-security-policy": SCRIPTLESS_CSP,
};

/** SECURITY_HEADERS for an HTML body, whose CSP allows exactly the inline scripts it carries (by hash). */
function htmlHeaders(body: Buffer | string): Readonly<Record<string, string>> {
  const policy = typeof body === "string" ? contentSecurityPolicy(inlineScriptHashes(body)) : pageCsp(body);
  return { ...SECURITY_HEADERS, "content-security-policy": policy };
}

export interface DataPlane {
  readonly authoring?: AuthoringHttpBackend;
  readonly discoverySettings?: (project: ProjectState) => DiscoverySettings;
  readonly authority: BrowserAuthority;
  readonly grantStreams?: Map<ServerResponse, string>;
  readonly connection: BrowserConnection;
  readonly isStopping: () => boolean;
  /** Whether saved projects are still being opened after a start: an unknown project may be one of them. */
  readonly isRestoring?: () => boolean;
  readonly operation?: (root: string, name: string, args: Record<string, unknown>) => Promise<OperationResult>;
  readonly page: () => Buffer;
  /** The page's own files by name (`page-assets.ts`), or null; without it `/-/page-assets/` does not exist. */
  readonly pageAsset?: (name: string) => Buffer | null;
  readonly project: (slug: string) => ProjectState | undefined;
  readonly projects: () => readonly ProjectState[];
  readonly projectLifecycle: (project: ProjectState) => ProjectLifecycleMetadata;
  readonly setProjectLifecycle: (slug: string, visibility: ProjectVisibility) => ProjectLifecycleMetadata | null;
  readonly cap: StreamCap;
  readonly log: (line: string) => void;
  /** Every open event stream, so detaching or stopping can end them. */
  readonly streams: Map<ServerResponse, ProjectState>;
  readonly settings: InstanceSettingsStore;
  /** The project's resolved feedback preferences (ADR 0023), for its settings snapshot. */
  readonly projectFeedback?: (project: ProjectState) => ResolvedFeedbackConfiguration;
  /** Gallery thumbnails; without it the route does not exist. */
  readonly thumbnails?: ThumbnailStore;
  /** Pairing codes typed on the base page; without them `/` and `/-/pair` do not exist. */
  readonly pairing?: PairingCodes;
  /** Who listens for the bubble's messages (ADR 0035 §7–8); without it the listener routes do not exist. */
  readonly listeners?: ListenerBackend;
}

/** The page's side of delivery: the listing, the person's pin and Launch. Refusals carry a `code` (ListenerRefusal). */
export interface ListenerBackend {
  /** `personal`: the owner's own sign-in from this computer asked (decision 23); only then `personal` and `launcher`. */
  listing(project: ProjectState, view?: { readonly personal?: boolean }): ListenerListing;
  pin(project: ProjectState, agentId: string | null): ListenerStatus;
  launch(project: ProjectState, threadId: string): Promise<{ readonly launched: true; readonly pid?: number }>;
  /** The person sent these threads' messages from the page; `owner` as for Launch (ADR 0035, amended 2026-10-31). */
  arrived?(project: ProjectState, threadIds: readonly string[], sender: { readonly owner: boolean }): void;
}

/**
 * Whether a peer is this computer: its loopback, or one of its own interface addresses (the owner's
 * browser dialling the LAN address the service binds when network access is on).
 */
export function onThisComputer(address: string | undefined): boolean {
  if (isLoopback(address)) return true;
  if (address === undefined) return false;
  const bare = address.startsWith("::ffff:") ? address.slice(7) : address;
  return Object.values(networkInterfaces()).some((list) => (list ?? []).some((entry) => entry.address === bare));
}

/** Whether a peer address is this machine's loopback. */
export function isLoopback(address: string | undefined): boolean {
  if (address === undefined) return false;
  const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  return v4 === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/**
 * CSRF defence in depth for the one state-changing route: `Origin` must name
 * the authority the browser dialled (`Host`). A missing Origin is allowed:
 * non-browser clients holding the token send none.
 */
export function sameOrigin(headers: IncomingMessage["headers"]): boolean {
  const origin = headers.origin;
  if (origin === undefined) return true;
  const host = headers.host;
  if (host === undefined) return false;
  const authority = origin.startsWith("http://")
    ? origin.slice(7)
    : origin.startsWith("https://")
      ? origin.slice(8)
      : null;
  return authority === host;
}

/** Development telemetry only: why a request got the bare 404. A missing cookie is routine (debug level). */
function accessRefused(reason: string): void {
  const telemetry = activeTelemetry();
  if (telemetry === null) return;
  const request = currentRequest();
  telemetry.log(reason === "cookie_missing" ? "debug" : "info", "svc.access-refused", `access refused: ${reason}`, {
    ...(request === undefined ? {} : { requestId: request.id }),
    data: { reason },
  });
}

export function handleRequest(plane: DataPlane, req: IncomingMessage, res: ServerResponse): void {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://archer.invalid");
  } catch {
    return bare404(res);
  }
  const path = url.pathname;
  const authority = plane.authority;
  if (plane.pairing !== undefined && path === "/-/pair")
    return void pairBrowser(plane, authority, plane.pairing, req, res, url);
  // Before authentication only the route's shape and a project-name lookup are checked; resolving
  // files (catalog, inventory, notes) happens after a credential is admitted.
  const started = phaseStart();
  let refusal: AccessRefusal | undefined;
  const access = browserAccess(
    authority,
    req.method ?? "GET",
    url,
    req.headers,
    (candidate, search) => isPageAddress(plane, candidate, search),
    (reason) => {
      refusal = reason;
      accessRefused(reason);
    },
  );
  phaseEnd("auth", started);
  if (access === null) {
    // The base address without a credential: the form a pairing code is typed into.
    if (
      plane.pairing !== undefined &&
      path === "/" &&
      url.search === "" &&
      (req.method ?? "GET") === "GET" &&
      refusal !== undefined &&
      LINK_REFUSALS.has(refusal)
    )
      return sendPairingPage(res, 200, PAIRING_PAGE);
    return refusedPage(req.method ?? "GET", url, refusal) ? sendRefusedPage(res) : bare404(res);
  }
  requestClient(access.grantId);
  if (access.redirect !== undefined) {
    // One hop: the exchange lands on the canonical address, not on a form that redirects again.
    const exchanged = new URL(access.redirect, "http://archer.invalid");
    const target = pageTarget(plane, exchanged.pathname, exchanged.search);
    const location = target?.kind === "redirect" ? target.location : access.redirect;
    res.writeHead(303, { ...SECURITY_HEADERS, location, "set-cookie": access.cookie! }).end();
    return;
  }
  if (
    access.grantId !== undefined &&
    plane.grantStreams !== undefined &&
    (req.method ?? "GET") === "GET" &&
    /^\/p\/[^/]+\/api\/events$/.test(access.path)
  ) {
    plane.grantStreams.set(res, access.grantId);
    res.once("close", () => plane.grantStreams?.delete(res));
    res.once("finish", () => plane.grantStreams?.delete(res));
  }
  const rest = access.path.slice(1).split("/");
  const method = req.method ?? "GET";
  if (plane.isStopping()) {
    req.resume();
    if (method === "GET" && rest.length === 4 && rest[0] === "p" && rest[2] === "api" && rest[3] === "events") {
      if (plane.project(decode(rest[1] ?? "") ?? "") === undefined) return bare404(res);
      // Native EventSource treats a non-200 status as terminal. A valid empty
      // stream ending normally instead preserves older pages' native retry
      // throughout a drain that lasts longer than their reconnect interval.
      res
        .writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/event-stream", connection: "close" })
        .end(": restarting\n\n");
      return;
    }
    res.writeHead(503, { ...SECURITY_HEADERS, "retry-after": "1", "content-length": "0", connection: "close" }).end();
    return;
  }
  if (method === "GET" && rest.length === 3 && rest[0] === "-" && rest[1] === PAGE_ASSETS_DIR) {
    const bytes = timed("read", () => plane.pageAsset?.(decode(rest[2] ?? "") ?? "") ?? null);
    if (bytes === null) return bare404(res);
    return void sendCompressible(req, res, bytes, "text/javascript; charset=utf-8", PAGE_ASSET_HEADERS).catch(() => {
      if (!res.headersSent) bare404(res);
    });
  }
  if (rest.length === 1 && rest[0] === "" && method === "GET") {
    res.writeHead(303, { ...SECURITY_HEADERS, location: "/projects/" }).end();
    return;
  }
  {
    const pagePath = `/${rest.join("/")}`;
    // Server-Timing (S9): a page's `route` is reading its address and finding what it shows.
    const routing = phaseStart();
    if (method === "GET" && readBrowserRoute(pagePath, url.search) !== null) {
      const target = pageTarget(plane, pagePath, url.search);
      phaseEnd("route", routing);
      // A credential holder who follows an address to no project gets the not-found page with a way back.
      if (target === null) return plane.isRestoring?.() === true ? sendLoadingPage(res) : sendNotFoundPage(res);
      if (target.kind === "redirect") {
        res.writeHead(303, { ...SECURITY_HEADERS, location: target.location, "content-length": "0" }).end();
        return;
      }
      const failed = (failure: unknown): void => {
        plane.log(`[archer] ui: page=failed reason=${failure instanceof Error ? failure.message : String(failure)}`);
        if (!res.headersSent) error(res, 500, "page_unavailable", "Archer could not serve the page.");
      };
      // An unbuilt or unreadable page is this 500, not a throw out of the request listener.
      let bytes: Buffer;
      try {
        bytes = timed("read", () => plane.page());
      } catch (failure) {
        return failed(failure);
      }
      return void sendPage(req, res, bytes).catch(failed);
    }
  }
  // The service's own routes (`/api/…`), then a project's (`/p/<name>/api/…`).
  const answer = (project: ProjectState | null, segments: readonly string[]): void => {
    const ctx = { plane, req, res, url, access: requestAccess(access, req), project };
    if (!dispatchApi(API_HANDLERS, ctx, project === null ? "service" : "project", segments)) bare404(res);
  };
  if (rest[0] === "api") return answer(null, rest);
  if (rest[0] !== "p" || rest.length < 2) return bare404(res);
  const project = plane.project(decode(rest[1] ?? "") ?? "");
  if (project === undefined) {
    if (plane.isRestoring?.() !== true) return bare404(res);
    if (method === "GET" && rest.length === 4 && rest[2] === "api" && rest[3] === "events") {
      // Native EventSource treats a non-200 answer as terminal, so a page following a project that is
      // still opening gets an empty stream with a retry hint, ends normally, and reconnects; once the
      // project is open the stream carries its standing state.
      res
        .writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/event-stream", connection: "close" })
        .end(`retry: ${RESTORE_RETRY_MS}\n: opening\n\n`);
      return;
    }
    res.setHeader("retry-after", "1");
    return error(
      res,
      503,
      "project_loading",
      "Archer is still opening its projects after starting; try again in a moment.",
    );
  }
  // `/p/<name>/` is the API base, never a page: only `api/…` lives under it.
  if (rest.length === 2) return bare404(res);
  answer(project, rest.slice(2));
}

/** What a route may ask of the credential browserAccess admitted. */
function requestAccess(
  access: { readonly grantId?: string | undefined; readonly credential?: string | undefined },
  req: IncomingMessage,
): RequestAccess {
  let local: boolean | undefined;
  return {
    owner: access.grantId === undefined,
    bearer: access.credential === "bearer",
    realm: access.grantId === undefined ? "service" : `grant:${access.grantId}`,
    get local() {
      local ??= onThisComputer(req.socket.remoteAddress);
      return local;
    },
    ...(access.grantId === undefined ? {} : { grantId: access.grantId }),
  };
}

// ---------------------------------------------------------------- API routes
// One handler per shared/api-routes.mts entry; `dispatchApi` (routes.ts) picks it.

/** The project of a project-scope route: the router resolved it before dispatch. */
const projectOf = (ctx: RouteContext): ProjectState => ctx.project!;

/** The view id of `api/<name>/<view id>`, decoded by the router. */
const viewOf = (ctx: RouteContext): string => ctx.params["viewId"]!;

/** The project's reads, its page writes and the catalog, connection and lifecycle (either scope). */
const STATE_ROUTES: readonly RouteHandler[] = [
  {
    id: "documents",
    handle: (ctx) =>
      json(
        ctx.res,
        200,
        timed("read", () => projectOf(ctx).documentCatalog(ctx.plane.discoverySettings?.(projectOf(ctx)))),
      ),
  },
  // All attached projects share this service credential. Expose only the
  // same public metadata their own project routes already serve, never IPC
  // status (which includes canonical roots and credential-bearing URLs).
  { id: "projects", handle: ({ plane, req, res }) => sendProjectCatalog(plane, req, res) },
  { id: "browser-projects", handle: ({ plane, req, res }) => sendProjectCatalog(plane, req, res, true) },
  {
    id: "diagrams",
    // The thumbnail version rides with the inventory, so the page spells each preview's address whole.
    handle: (ctx) => {
      const { plane } = ctx,
        project = projectOf(ctx);
      json(
        ctx.res,
        200,
        timed("read", () =>
          plane.thumbnails === undefined
            ? project.inventory()
            : {
                ...project.inventory(),
                thumbnailVersion: plane.thumbnails.version,
                thumbnailFormat: plane.thumbnails.format,
              },
        ),
      );
    },
  },
  {
    id: "compile",
    handle: (ctx) =>
      json(
        ctx.res,
        200,
        timed("read", () => projectOf(ctx).compileStatus()),
      ),
  },
  { id: "walkthroughs", handle: (ctx) => walkthroughs(projectOf(ctx), ctx.url.searchParams, ctx.res) },
  { id: "expand-menu", handle: (ctx) => expandMenuRoute(projectOf(ctx), ctx.url.searchParams, ctx.req, ctx.res) },
  { id: "exploration", handle: (ctx) => explorationRoute(projectOf(ctx), ctx.url.searchParams, ctx.req, ctx.res) },
  {
    id: "bootstrap",
    handle: (ctx) =>
      json(
        ctx.res,
        200,
        timed("read", () => cleanPresentation(projectOf(ctx), projectOf(ctx).bootstrap())),
      ),
  },
  { id: "connection", handle: ({ plane, res }) => json(res, 200, plane.connection) },
  {
    id: "project-lifecycle",
    handle: ({ plane, req, res, access }) => projectLifecycle(plane, req, res, access.bearer),
  },
  {
    id: "operations",
    enabled: (plane) => plane.operation !== undefined,
    handle: (ctx) => browserOperation(ctx.plane, projectOf(ctx), ctx.req, ctx.res),
  },
  { id: "selection", handle: (ctx) => handleSelection(projectOf(ctx), ctx.req, ctx.res) },
  { id: "walkthrough-position", handle: (ctx) => handleReading(projectOf(ctx), ctx.req, ctx.res) },
  { id: "reader-exploration", handle: (ctx) => handleReaderExploration(projectOf(ctx), ctx.req, ctx.res) },
  {
    id: "events",
    handle: (ctx) => events(ctx.plane, projectOf(ctx), ctx.req, ctx.res, ctx.access.owner && ctx.access.local),
  },
  { id: "search", handle: (ctx) => search(ctx.plane, projectOf(ctx), ctx.url.searchParams, ctx.res) },
  {
    id: "browser-search",
    handle: (ctx) => {
      try {
        json(
          ctx.res,
          200,
          timed("read", () => projectOf(ctx).browserSearch(ctx.url.searchParams.get("q"))),
        );
      } catch (failure) {
        if (failure instanceof SearchRefusal) return error(ctx.res, 422, failure.code, failure.message);
        error(ctx.res, 500, "internal", "document search could not be completed");
      }
    },
  },
  { id: "walkthroughs-old", handle: (ctx) => oldVersion(projectOf(ctx), ctx.url.searchParams, ctx.res) },
  {
    id: "documents-content",
    handle: (ctx) => {
      const { res } = ctx,
        project = projectOf(ctx);
      void project
        .readDocument(ctx.url.searchParams.get("path") ?? "", ctx.plane.discoverySettings?.(project))
        .then((document) => {
          if (document === null) return bare404(res);
          return json(res, 200, document);
        })
        .catch(() => {
          if (!res.headersSent) error(res, 500, "internal", "document could not be read");
        });
    },
  },
  {
    id: "diagram",
    handle: (ctx) => {
      const viewId = viewOf(ctx),
        envelope = projectOf(ctx).envelope(viewId);
      return envelope === null
        ? error(ctx.res, 404, "diagram_not_found", `no diagram view is registered as '${viewId}'`)
        : sendEnvelope(ctx.req, ctx.res, envelope);
    },
  },
  {
    id: "diagram-source",
    handle: (ctx) => {
      const { res } = ctx,
        viewId = viewOf(ctx);
      void projectOf(ctx)
        .diagramSource(viewId)
        .then((source) =>
          source === null
            ? error(res, 404, "diagram_not_found", `no diagram view is registered as '${viewId}'`)
            : json(res, 200, source),
        )
        .catch(() => {
          if (!res.headersSent) error(res, 500, "internal", "the source could not be read");
        });
    },
  },
  {
    id: "emphasis",
    handle: (ctx) =>
      json(
        ctx.res,
        200,
        timed("read", () => projectOf(ctx).emphasisPayload(viewOf(ctx))),
      ),
  },
  {
    id: "thumbnail",
    enabled: (plane) => plane.thumbnails !== undefined,
    handle: (ctx) =>
      thumbnail(ctx.plane.thumbnails!, projectOf(ctx), viewOf(ctx), ctx.url.searchParams, ctx.req, ctx.res),
  },
];

// ---------------------------------------------------------------- pages
// Every page is the one application; the address only says where it opens.
// Canonical addresses are served. `/projects/<name>` without its slash and an
// Archer-folder file named by its project path redirect to the canonical address,
// keeping the query (shared/browser-routes.mts).

type PageTarget = { readonly kind: "serve" } | { readonly kind: "redirect"; readonly location: string };
const SERVE: PageTarget = { kind: "serve" };

/** Syntactic page check, cheap enough to run before authentication: a page route of an attached project. */
function isPageAddress(plane: DataPlane, pathname: string, search: string): boolean {
  const route = readBrowserRoute(pathname, search);
  // While saved projects are opened, an unknown name may be one of them: it gets the loading page, not a 404.
  return (
    route !== null &&
    (route.kind === "projects" || plane.project(route.projectSlug) !== undefined || plane.isRestoring?.() === true)
  );
}

/** What a GET of `pathname` answers: the page, a redirect, or null (not a page, or no such project).
 * It reads the project's files: call it only for an authenticated request. */
function pageTarget(plane: DataPlane, pathname: string, search: string): PageTarget | null {
  const route = readBrowserRoute(pathname, search);
  if (route === null) return null;
  if (route.kind === "projects")
    return pathname === "/projects/" ? SERVE : { kind: "redirect", location: `/projects/${search}` };
  const project = plane.project(route.projectSlug);
  if (project === undefined) return null;
  // An Archer-folder file named by its project path (`/projects/<name>/.archer/diagrams/x.mmd`) answers with
  // its canonical address in one hop, not a page that loads and then navigates again (perf #3).
  const alias = route.kind === "file" ? folderPathAlias(plane, project, route.path) : null;
  if (alias === null && route.projectSlug === project.slug && pathname !== `/projects/${route.projectSlug}`)
    return SERVE;
  const href = browserRoutePath(alias ?? { ...route, projectSlug: project.slug });
  if (href === null) return null;
  const hash = href.indexOf("#");
  const [target, fragment] = hash < 0 ? [href, ""] : [href.slice(0, hash), href.slice(hash)];
  if (target === pathname) return SERVE;
  // `?follow` leads; every other parameter follows in its own order and spelling.
  const kept = route.kind === "follow" ? withoutParameter(search, "follow") : search;
  const query = target.endsWith("?follow") ? (kept === "" ? "" : `&${kept.slice(1)}`) : kept;
  return { kind: "redirect", location: `${target}${query}${fragment}` };
}

/** The canonical route of an Archer-folder note or diagram named by its project path; null for any other path
 * (an Archer-folder file by its own path, a project document, nothing). Reads the catalog only for a path that
 * is not an Archer-folder file already. A diagram whose file is unknown has no clean address: null. */
function folderPathAlias(plane: DataPlane, project: ProjectState, path: string): BrowserRoute | null {
  if (archerFiles(project).has(path)) return null;
  const entry = project
    .documentCatalog(plane.discoverySettings?.(project))
    .documents.find((document) => document.source.path === path);
  if (entry?.legacy?.notePath !== undefined)
    return { kind: "note", projectSlug: project.slug, path: entry.legacy.notePath };
  if (entry?.legacy?.viewId === undefined) return null;
  const route = viewRoute(project, entry.legacy.viewId);
  return route.kind === "view" && route.sourcePath === undefined ? null : route;
}

function viewRoute(project: ProjectState, viewId: string): BrowserRoute {
  const projectSlug = project.slug;
  const embedded = parseDiagramAddress(viewId);
  if (embedded !== null) return { kind: "file", projectSlug, path: embedded.notePath, fragment: embedded.name };
  const view = project
    .inventory()
    .views.find((candidate) => candidate.id === viewId && candidate.registration !== "embedded");
  const sourcePath = view?.sourcePath?.replace(/^\.\//, "");
  return sourcePath === undefined
    ? { kind: "view", projectSlug, viewId }
    : { kind: "view", projectSlug, viewId, sourcePath };
}

/** The Archer-folder paths that answer `/projects/<name>/<path>` first: notes and standalone diagrams. */
function archerFiles(project: ProjectState): ReadonlySet<string> {
  const paths = new Set(project.allNotes().notes.map((note) => note.path));
  for (const view of project.inventory().views)
    if (view.registration !== "embedded" && view.sourcePath !== undefined)
      paths.add(view.sourcePath.replace(/^\.\//, ""));
  return paths;
}

function withoutParameter(search: string, name: string): string {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const kept = raw.split("&").filter((part) => part !== "" && part.split("=", 1)[0] !== name);
  return kept.length === 0 ? "" : `?${kept.join("&")}`;
}

const THUMBNAIL_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  // Opened directly, the SVG still runs nothing and loads nothing.
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  // `private`, not `public`: on clean addresses a cookie is the credential,
  // and a shared cache must not hand a project's drawing to anyone else.
  "cache-control": "private, max-age=31536000, immutable",
};

/**
 * GET api/thumbnails/<view id>?rev=<model revision>&theme=light|dark&v=<thumbnail version>&format=svg|png
 *
 * At the view's current model revision and this painter's version (the
 * inventory's `thumbnailVersion`): the drawing, cacheable for a year (the URL
 * names one drawing exactly). `format` (the inventory's `thumbnailFormat`) is
 * `svg` when absent: the SVG, sent br or gzip as `accept-encoding` allows from
 * copies made when it was drawn, with one weak ETag across its encodings
 * (`vary: accept-encoding`), as the page shell; or `png`: the same drawing as
 * a PNG at twice a card's size, with a strong ETag of its own. At any other
 * well-formed revision, or without this painter's version: an uncached 302 to
 * the current address, so a page with a slightly older inventory still shows
 * the current drawing, and an upgrade's previews are not answered from last
 * version's cache.
 */
async function thumbnail(
  store: ThumbnailStore,
  project: ProjectState,
  viewId: string,
  query: URLSearchParams,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const rev = query.get("rev"),
    theme = query.get("theme"),
    asked = query.get("format");
  if (
    rev === null ||
    !/^sha256:[0-9a-f]{64}$/.test(rev) ||
    (theme !== "light" && theme !== "dark") ||
    (asked !== null && asked !== "svg" && asked !== "png")
  )
    return error(
      res,
      422,
      "invalid_thumbnail_request",
      "name the drawing: api/thumbnails/<view id>?rev=<modelRevision>&theme=light|dark[&format=svg|png]",
    );
  const format: ThumbnailFormat = asked ?? "svg";
  const envelope = project.envelope(viewId);
  if (envelope === null) return error(res, 404, "diagram_not_found", "no compiled diagram view has that id");
  if (envelope.revision !== rev || query.get("v") !== store.version) {
    // Every parameter is a checked token (`sha256:<hex>`, light|dark, hex, svg|png): spelled as the page spells them.
    const location = `${encodeURIComponent(viewId)}?rev=${envelope.revision}&theme=${theme}&v=${store.version}${asked === null ? "" : `&format=${asked}`}`;
    res.writeHead(302, { ...SECURITY_HEADERS, location, "content-length": "0" }).end();
    return;
  }
  const request = { viewId, revision: rev, theme } as const,
    etag = store.etag(request, format);
  // The SVG's answer depends on accept-encoding; its validator does not (weak comparison, RFC 9110 13.1.2).
  const varies: Record<string, string> = format === "svg" ? { vary: "accept-encoding" } : {};
  const bare = (tag: string): string => tag.trim().replace(/^W\//, "");
  const match = req.headers["if-none-match"];
  if (typeof match === "string" && match.split(",").some((tag) => bare(tag) === bare(etag))) {
    res.writeHead(304, { ...THUMBNAIL_HEADERS, ...varies, etag }).end();
    return;
  }
  try {
    const drawn = await store.get(request, envelope, {
      format,
      codings: acceptedCodings(req.headers["accept-encoding"]),
    });
    res
      .writeHead(200, {
        ...THUMBNAIL_HEADERS,
        ...varies,
        etag: drawn.etag,
        "content-type": drawn.contentType,
        "content-length": drawn.bytes.length,
        ...(drawn.encoding === undefined ? {} : { "content-encoding": drawn.encoding }),
      })
      .end(drawn.bytes);
  } catch (failure) {
    if (res.headersSent) return;
    if (failure instanceof ThumbnailRefusal) {
      activeTelemetry()?.thumbnailRefused(failure.code);
      if (failure.code === "thumbnail_busy" || failure.code === "thumbnail_timeout") {
        res
          .writeHead(503, { ...SECURITY_HEADERS, "retry-after": "1", "content-type": "application/json" })
          .end(JSON.stringify({ schemaVersion: 1, error: { code: failure.code, message: failure.message } }));
        return;
      }
      return error(res, 422, failure.code, failure.message);
    }
    error(res, 500, "internal", "the thumbnail could not be drawn");
  }
}

/** Lets requests that arrived meanwhile run between two projects' reads (each may walk its files on a miss). */
const yieldToOthers = (): Promise<void> => new Promise((done) => setImmediate(done));

async function projectCatalog(plane: DataPlane, includeDocuments = false): Promise<unknown> {
  const projects: unknown[] = [];
  for (const [index, attached] of plane.projects().entries()) {
    // Server-Timing (S9): the turns given to other requests between projects are `wait`, the summaries `catalog`.
    if (index > 0) {
      const waited = phaseStart();
      await yieldToOthers();
      phaseEnd("wait", waited);
    }
    const started = phaseStart();
    projects.push(
      projectSummary(attached, plane.projectLifecycle(attached), includeDocuments, plane.discoverySettings?.(attached)),
    );
    phaseEnd("catalog", started);
  }
  return {
    schemaVersion: 1,
    ...(plane.thumbnails === undefined
      ? {}
      : { thumbnailVersion: plane.thumbnails.version, thumbnailFormat: plane.thumbnails.format }),
    projects,
  };
}

async function sendProjectCatalog(
  plane: DataPlane,
  req: IncomingMessage,
  res: ServerResponse,
  includeDocuments = false,
): Promise<void> {
  try {
    await sendRevalidatedJson(req, res, await projectCatalog(plane, includeDocuments));
  } catch (failure) {
    plane.log(
      `[archer] ui: project catalog failed: ${failure instanceof Error ? (failure.stack ?? failure.message) : String(failure)}`,
    );
    if (!res.headersSent)
      error(res, 500, "internal", "the project catalog could not be read; the service log has the detail");
  }
}

async function projectLifecycle(
  plane: DataPlane,
  req: IncomingMessage,
  res: ServerResponse,
  bearer: boolean,
): Promise<void> {
  // Archive and show change the project's place on the page, an Edit-cell change: a grant's Bearer never makes
  // one (security rubric §1). A cookie may, under the exact Origin and JSON below.
  if (bearer) {
    req.resume();
    return bare404(res);
  }
  if (typeof req.headers.origin !== "string" || !sameOrigin(req.headers)) {
    req.resume();
    return status(res, 403);
  }
  if (req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    req.resume();
    return error(res, 415, "invalid_project_lifecycle", "project lifecycle changes must be sent as application/json");
  }
  try {
    const text = await readBody(req, res, MAX_PROJECT_LIFECYCLE_BODY_BYTES);
    if (text === null) return;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ProjectLifecycleRequestError("the project lifecycle request body is not JSON");
    }
    const request = parseProjectLifecycleMutation(value);
    const target = plane.project(request.slug);
    if (target === undefined)
      return error(res, 404, "project_not_found", "the named attached project is not available");
    // Archiving or showing a project follows its edit switch, as Edit and New do (decision D1,
    // 2026-10-31): read fresh from archer.toml, and an unreadable configuration refuses (fail closed).
    let editing = false;
    try {
      editing = browserEditing(findProject(target.root)).enabled;
    } catch {
      editing = false;
    }
    if (!editing) return error(res, 403, "editing_disabled", EDITING_DISABLED);
    const lifecycle = plane.setProjectLifecycle(request.slug, visibilityFor(request.action));
    if (lifecycle === null) return error(res, 404, "project_not_found", "the named attached project is not available");
    return json(res, 200, { lifecycle });
  } catch (failure) {
    if (failure instanceof ProjectLifecycleRequestError)
      return error(res, 422, "invalid_project_lifecycle", failure.message);
    if (failure instanceof PersistenceError)
      return error(
        res,
        500,
        failure.code,
        "the project lifecycle change could not be confirmed; reload the catalog before retrying",
      );
    plane.log(
      `[archer] ui: project lifecycle route failed: ${failure instanceof Error ? (failure.stack ?? failure.message) : String(failure)}`,
    );
    if (!res.headersSent)
      error(res, 500, "internal", "the project lifecycle change could not be saved; the service log has the detail");
  }
}

/** Browser credentials never write configuration (ADR 0028); the refusal reads no body and no file. */
function settingsReadOnly(req: IncomingMessage, res: ServerResponse, message: string): void {
  req.resume();
  error(res, 403, "settings_read_only", message);
}

async function settings(plane: DataPlane, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  try {
    if (method === "PUT")
      return settingsReadOnly(
        req,
        res,
        "Archer settings are read-only in the page; change them in the global archer.toml (~/.config/archer/archer.toml) and restart the service.",
      );
    if (method !== "GET") return bare404(res);
    return json(res, 200, plane.settings.read());
  } catch (failure) {
    if (failure instanceof InstanceSettingsError) return error(res, failure.status, failure.code, failure.message);
    plane.log(
      `[archer] ui: settings route failed: ${failure instanceof Error ? (failure.stack ?? failure.message) : String(failure)}`,
    );
    if (!res.headersSent)
      error(res, 500, "internal", "settings could not be read or written; the service log has the detail");
  }
}

// ------------------------------------------------------ project settings

function projectSettingsView(plane: DataPlane, project: ProjectState): ProjectSettingsSnapshot {
  const loaded = project.project;
  return projectSettingsSnapshot({
    slug: project.slug,
    name: project.name,
    project: loaded,
    loadedRevision: configurationSourceRevision(loaded),
    manifest: readProjectManifest(loaded),
    discovery: resolveDiscoverySettings(
      loaded,
      plane.discoverySettings === undefined ? {} : { project: plane.discoverySettings(project) },
    ),
    feedback: plane.projectFeedback?.(project) ?? null,
    lifecycle: plane.projectLifecycle(project),
  });
}

/** GET: the settings modal's read-only snapshot. The page never writes archer.toml (ADR 0028). */
async function projectSettings(
  plane: DataPlane,
  project: ProjectState,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? "GET";
  try {
    if (method === "PATCH")
      return settingsReadOnly(
        req,
        res,
        "Project settings are read-only in the page; set name and description in the project's archer.toml.",
      );
    if (method !== "GET") return bare404(res);
    return json(res, 200, projectSettingsView(plane, project));
  } catch (failure) {
    if (failure instanceof ProjectSettingsError)
      return error(res, failure.status, failure.code, failure.message, failure.details);
    plane.log(
      `[archer] ui: project settings route failed: ${failure instanceof Error ? (failure.stack ?? failure.message) : String(failure)}`,
    );
    if (!res.headersSent)
      error(res, 500, "internal", "project settings could not be read; the service log has the detail");
  }
}

// -------------------------------------------------------- note emphasis

async function noteEmphases(
  plane: DataPlane,
  project: ProjectState,
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
): Promise<void> {
  const method = req.method ?? "GET";
  try {
    if (method === "GET")
      return json(
        res,
        200,
        timed("read", () => project.noteEmphases(query.get("path") ?? "")),
      );
    if (method !== "POST") return bare404(res);
    if (!sameOrigin(req.headers)) {
      req.resume();
      return status(res, 403);
    }
    const text = await readBody(req, res, MAX_NOTE_EMPHASIS_FILE_BYTES);
    if (text === null) return;
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new NoteEmphasisError("invalid_note_emphasis", "the note emphasis request body is not JSON");
    }
    json(res, 200, project.setNoteEmphasis(body, "person"));
  } catch (failure) {
    if (failure instanceof NoteEmphasisError)
      return error(res, failure.status, failure.code, failure.message, failure.details);
    if (failure instanceof WriteRuleDenied) return ruleDenied(plane, res, failure);
    plane.log("[archer] ui: note emphasis route failed; inspect the service log");
    if (!res.headersSent)
      error(res, 500, "internal", "the note emphasis could not be read or written; the service log has the detail");
  }
}

/** A rules refusal: fixed text and the rule for the page; any configuration detail to the log only. */
function ruleDenied(plane: DataPlane, res: ServerResponse, failure: WriteRuleDenied): void {
  if (failure.detail !== undefined)
    plane.log(`[archer] write refused: the global archer.toml could not be read: ${failure.detail}`);
  error(res, 403, failure.code, failure.message, { rule: failure.rule });
}

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Refusals a person following a browser link meets: no cookie yet, or an old or mistyped link or cookie. */
const LINK_REFUSALS: ReadonlySet<AccessRefusal> = new Set([
  "session_unavailable",
  "cookie_missing",
  "cookie_unknown",
  "cookie_ambiguous",
  "token_unknown",
  "token_query_invalid",
  "token_not_page",
]);

/**
 * Whether a refused request gets the "ask for a new link" page instead of the bare 404: a GET of
 * a page-shaped address, refused for a browser credential. Only the address's shape is read, never
 * whether its project exists, so every such address answers the same bytes (no project oracle).
 * API routes, unknown routes, Bearer callers and foreign Hosts keep the bare 404.
 */
function refusedPage(method: string, url: URL, refusal: AccessRefusal | undefined): boolean {
  return (
    method === "GET" && refusal !== undefined && LINK_REFUSALS.has(refusal) && readBrowserRoute(url.pathname) !== null
  );
}

/**
 * The refused page. Its bytes are the same for every address (no project oracle) and it runs no script. Its
 * "Enter it here" link sends the address it was refused at to the pairing form as a same-origin referrer
 * (`Referrer-Policy: same-origin`, as the form's own pages), so a pairing lands back there (decided 2026-11-02;
 * claude-09). The form's script reads it; `/-/pair` checks it again where it is used (`return-path.ts`).
 */
const REFUSED_PAGE = Buffer.from(
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<title>Archer</title>
<style>${ACCESS_PAGE_STYLE}</style></head>
<body><main><h1>Open the link Archer gave you</h1>
<p>This page opens from the link Archer gave you, or one someone shared with you. If that link has expired or isn't valid, ask the agent or that person for a new one, and open it in this browser.</p>
<p>Have a pairing code? <a href="/">Enter it here</a>.</p></main></body></html>
`,
  "utf8",
);

/** Pairing answers are this small; anything larger is not a code (defined with the form, which sizes its return to it). */
export { MAX_PAIR_BODY_BYTES };
const PAIR_REFUSALS = {
  invalid: [400, "code_invalid", "not a pairing code: 8 letters and digits, like 7KQ4-M2XD"],
  wrong: [400, "code_wrong", "that is not a live pairing code"],
  expired: [400, "code_expired", "that pairing code expired; ask for a new one"],
  used: [400, "code_used", "that pairing code was already used"],
  throttled: [429, "too_many_tries_wait", "too many wrong codes; wait a minute"],
  too_many_tries: [429, "too_many_tries", "too many wrong codes; every live code is void, ask for a new one"],
} as const;

/**
 * `POST /-/pair`: the pairing form's `code` (`application/x-www-form-urlencoded`, what the page sends) or
 * `{"code": "…"}` as JSON. A correct live code is spent and exchanged for a new, individually revocable
 * access grant; the browser gets a session of it and one 303 to `/projects/` (security round 1, owner
 * decision D5), like a link's exchange. Browser rules as for every cookie write: an allowed Host and the
 * exact Origin (a form from another site, or none, is refused before the body is read), no CORS, and no
 * query, so a code is never in a URL or a Location. A refusal answers the form again with its reason (or,
 * to JSON, the error). The body is never logged.
 */
async function pairBrowser(
  plane: DataPlane,
  authority: BrowserAuthority,
  pairing: PairingCodes,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const host = req.headers.host;
  if (
    req.method !== "POST" ||
    url.search !== "" ||
    host === undefined ||
    !authority.allowedHosts.has(host.toLowerCase())
  ) {
    req.resume();
    return bare404(res);
  }
  const type = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  const form = type === "application/x-www-form-urlencoded";
  if (
    req.headers.origin !== `${authority.secure ? "https" : "http"}://${host}` ||
    (!form && type !== "application/json")
  ) {
    req.resume();
    return status(res, 403);
  }
  if (plane.isStopping()) {
    req.resume();
    return status(res, 503);
  }
  const text = await readBody(req, res, MAX_PAIR_BODY_BYTES);
  if (text === null) return;
  const refuse = (code: number, name: PairingMessage, message: string): void =>
    form ? sendPairingPage(res, code, pairingPage(name)) : error(res, code, name, message);
  // `code`, and at most one `return` (the page the browser was refused at); nothing else.
  let code: unknown, back: unknown;
  const only = (keys: readonly string[]): boolean =>
    keys.includes("code") &&
    keys.every((key) => key === "code" || key === "return") &&
    new Set(keys).size === keys.length;
  if (form) {
    const fields = [...new URLSearchParams(text)];
    if (only(fields.map(([key]) => key)))
      for (const [key, value] of fields)
        if (key === "code") code = value;
        else back = value;
  } else {
    try {
      const body: unknown = JSON.parse(text);
      if (body !== null && typeof body === "object" && !Array.isArray(body) && only(Object.keys(body)))
        ({ code, return: back } = body as Record<string, unknown>);
    } catch {
      /* not JSON: not a code */
    }
  }
  let outcome;
  try {
    outcome = pairing.redeem(code, () =>
      authority.grants.issue(`Paired ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`),
    );
  } catch (failure) {
    plane.log(
      `[archer] ui: pairing could not issue a grant: ${failure instanceof Error ? failure.message : String(failure)}`,
    );
    return refuse(500, "internal", "the pairing could not be saved; ask for a new code");
  }
  if (!outcome.ok) {
    const [code, name, message] = PAIR_REFUSALS[outcome.reason];
    if (outcome.reason === "throttled") res.setHeader("retry-after", String(outcome.retryAfterSeconds));
    return refuse(code, name, message);
  }
  requestClient(outcome.value.id);
  // The paired browser gets a session of the new grant; the grant's own secret is never sent anywhere.
  let cookie: string;
  try {
    cookie = sessionCookie(authority, outcome.value.id);
  } catch (failure) {
    plane.log(
      `[archer] ui: pairing could not sign the browser in: ${failure instanceof Error ? failure.message : String(failure)}`,
    );
    return refuse(500, "internal", "the pairing could not be saved; ask for a new code");
  }
  // The page the browser was refused at, when it is a clean page path of an attached project; else the projects page.
  res
    .writeHead(303, {
      ...SECURITY_HEADERS,
      location: pairedLocation(plane, back),
      "set-cookie": cookie,
      "content-length": "0",
    })
    .end();
}

/** Where a pairing lands: a safe return (`return-path.ts`) in a project this service has attached, else `/projects/`. */
function pairedLocation(plane: DataPlane, back: unknown): string {
  const path = safeReturnPath(back);
  if (path === null) return "/projects/";
  const route = readBrowserRoute(path.split("?", 1)[0]!, path.includes("?") ? path.slice(path.indexOf("?")) : "");
  return route !== null && (route.kind === "projects" || plane.project(route.projectSlug) !== undefined)
    ? path
    : "/projects/";
}

/**
 * The pairing form (at `/`, and as the answer to a refused code). Its address never holds a secret, so it
 * sends its origin as referrer to itself (`same-origin`; nowhere else): under `no-referrer` a browser's form
 * POST carries `Origin: null`, which the exact Origin check of `/-/pair` refuses.
 */
function sendPairingPage(res: ServerResponse, code: number, body: Buffer): void {
  res
    .writeHead(code, {
      ...htmlHeaders(body),
      "referrer-policy": "same-origin",
      "content-type": "text/html; charset=utf-8",
      "content-length": body.length,
    })
    .end(body);
}

function sendRefusedPage(res: ServerResponse): void {
  res
    .writeHead(404, {
      ...SECURITY_HEADERS,
      "referrer-policy": "same-origin",
      "content-type": "text/html; charset=utf-8",
      "content-length": REFUSED_PAGE.length,
    })
    .end(REFUSED_PAGE);
}

/**
 * A page address that names no project, asked by a browser holding a valid credential (round 1, D17). The
 * same bytes for every such address, the address never echoed, so it is no oracle for which projects exist,
 * now or once a credential is scoped to some of them. Without a valid credential the request never gets here.
 */
const NOT_FOUND_PAGE = Buffer.from(
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<title>Not found · Archer</title>
<style>${ACCESS_PAGE_STYLE}</style></head>
<body><main><h1>Nothing at this address</h1>
<p>Archer has no project or page here. It may have been renamed, moved or detached, or the address may be mistyped.</p>
<p><a href="/projects/">Go to Projects</a></p></main></body></html>
`,
  "utf8",
);

function sendNotFoundPage(res: ServerResponse): void {
  res
    .writeHead(404, {
      ...SECURITY_HEADERS,
      "content-type": "text/html; charset=utf-8",
      "content-length": NOT_FOUND_PAGE.length,
    })
    .end(NOT_FOUND_PAGE);
}

/** A project page asked for while saved projects are still opened: it reloads itself in a second. */
function sendLoadingPage(res: ServerResponse): void {
  const body =
    '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="1"><title>Archer</title><p>Archer is opening this project…</p>';
  res
    .writeHead(503, {
      ...SECURITY_HEADERS,
      "content-type": "text/html; charset=utf-8",
      "retry-after": "1",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(body),
    })
    .end(body);
}

/** The same three headers for every bare 404, whatever was asked (R2); nothing else that could tell routes apart. */
function bare404(res: ServerResponse): void {
  res
    .writeHead(404, {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-length": "0",
    })
    .end();
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res
    .writeHead(status, {
      ...(type.startsWith("text/html") ? htmlHeaders(body) : SECURITY_HEADERS),
      "content-type": type,
      "content-length": Buffer.byteLength(body),
    })
    .end(body);
}

// The page is one large file that changes only with an upgrade. At a clean address it is revalidated
// on every load (`private, no-cache` + a weak validator, so a reload is a 304): it holds no project data
// and no secret (exception EX-S1-01, extended to the page shell by decision D8, 2026-10-31; every
// API answer stays `no-store`). At an address carrying the service token in its path it is `no-store`
// (ADR 0014: no token URL in a cache). It is sent compressed when the browser accepts it.
// gzip is made once per page, off the event loop, as soon as the page is built (`preparePage`).
// A gzip-capable reader waits for it (about 150 ms, shared by concurrent first readers); brotli q11
// takes seconds, so it starts only after gzip settled and a br-capable reader asked; that reader gets gzip until it exists.
// A reader that accepts neither coding is never made to wait. If compression fails, the page goes
// out raw. Decoded, every copy is the same bytes.
interface PageCopies {
  readonly etag: string;
  gzipReady?: Promise<Buffer | null>;
  gzip?: Buffer;
  br?: Buffer;
  brStarted?: boolean;
}
let gzipRunsStarted = 0,
  brotliRunsStarted = 0;
const pageCopies = new WeakMap<Buffer, PageCopies>();

function copiesOf(bytes: Buffer): PageCopies {
  let copies = pageCopies.get(bytes);
  if (copies === undefined) {
    // Weak: one validator for every encoding of the same page.
    copies = { etag: `W/"${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}"` };
    pageCopies.set(bytes, copies);
  }
  return copies;
}

/** Use compressed copies made earlier (at package time) of exactly these bytes; nothing is compressed at run time. */
export function adoptPageCopies(bytes: Buffer, gzip: Buffer, br: Buffer): void {
  const copies = copiesOf(bytes);
  copies.gzip = gzip;
  copies.br = br;
  copies.gzipReady = Promise.resolve(gzip);
}

/** Start compressing the page (idempotent) and resolve with its gzip copy, or null if that failed. */
export function preparePage(bytes: Buffer): Promise<Buffer | null> {
  const copies = copiesOf(bytes);
  if (copies.gzipReady === undefined) {
    gzipRunsStarted++;
    copies.gzipReady = new Promise<Buffer | null>((resolve) => {
      gzip(bytes, { level: 9 }, (failure, out) => {
        if (failure !== null) return resolve(null);
        copies.gzip = out;
        resolve(out);
      });
    });
  }
  return copies.gzipReady;
}

/**
 * Brotli q11 takes seconds of a libuv thread and cannot be cancelled, and a pending zlib job keeps the process alive:
 * so it starts only once a br-capable reader has asked (after gzip settled), never at start-up, where it would delay
 * a stop. A packaged copy (`adoptPageCopies`) makes this a no-op.
 */
function startBrotli(bytes: Buffer): void {
  const copies = copiesOf(bytes);
  if (copies.br !== undefined || copies.brStarted === true) return;
  copies.brStarted = true;
  brotliRunsStarted++;
  brotliCompress(
    bytes,
    { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: bytes.length } },
    (failure, out) => {
      if (failure === null) copies.br = out;
    },
  );
}

/** How many page gzip runs this process has started (for tests: concurrent first readers share one). */
export function pageGzipRuns(): number {
  return gzipRunsStarted;
}
/** How many page brotli runs this process has started (none until a br-capable reader asks). */
export function pageBrotliRuns(): number {
  return brotliRunsStarted;
}

/** The codings `accept-encoding` admits (q > 0), lower-cased. */
function acceptedCodings(header: string | string[] | undefined): ReadonlySet<string> {
  const accepted = new Set<string>();
  for (const part of (Array.isArray(header) ? header.join(",") : (header ?? "")).split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (name === undefined || name === "") continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    if (q !== undefined && !(Number(q.slice(2)) > 0)) continue;
    accepted.add(name);
  }
  return accepted;
}

export const PAGE_CACHE_CONTROL = "private, no-cache";

function sendPage(req: IncomingMessage, res: ServerResponse, bytes: Buffer): Promise<void> {
  const headers = timed("encode", () => ({ ...htmlHeaders(bytes), "cache-control": PAGE_CACHE_CONTROL }));
  return sendCompressible(req, res, bytes, "text/html; charset=utf-8", headers);
}

/**
 * A page asset (`/-/page-assets/<name>`): the name carries its content hash, so it is kept for good;
 * `private`, as a cookie admitted it. A worker loaded from a URL runs under its own response's policy,
 * and the layout worker loads and connects to nothing.
 */
const PAGE_ASSET_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'",
  "cache-control": "private, max-age=31536000, immutable",
};

/** `bytes` as gzip or brotli when the reader accepts them (the page's copies, above), with one weak ETag. */
async function sendCompressible(
  req: IncomingMessage,
  res: ServerResponse,
  bytes: Buffer,
  contentType: string,
  base: Readonly<Record<string, string>>,
): Promise<void> {
  const copies = timed("encode", () => copiesOf(bytes));
  const headers = { ...base, etag: copies.etag, vary: "accept-encoding" };
  if (notModified(req, copies.etag)) {
    res.writeHead(304, headers).end();
    return;
  }
  const codings = acceptedCodings(req.headers["accept-encoding"]);
  const wantsBr = codings.has("br"),
    wantsGzip = codings.has("gzip");
  if (wantsBr || wantsGzip) {
    const ready = preparePage(bytes);
    if (wantsBr) void ready.then(() => startBrotli(bytes)).catch(() => {});
    if (wantsGzip) await timed("compress", () => ready);
  }
  const [body, encoding] =
    wantsBr && copies.br !== undefined
      ? [copies.br, "br"]
      : wantsGzip && copies.gzip !== undefined
        ? [copies.gzip, "gzip"]
        : [bytes, undefined];
  if (res.writableEnded || res.destroyed) return;
  res
    .writeHead(200, {
      ...headers,
      "content-type": contentType,
      "content-length": body.length,
      ...(encoding === undefined ? {} : { "content-encoding": encoding }),
    })
    .end(body);
}

/** Whether `If-None-Match` names `etag` (weak comparison, RFC 9110 13.1.2). Only ever asked after authentication. */
function notModified(req: IncomingMessage, etag: string): boolean {
  const match = req.headers["if-none-match"];
  const bare = etag.replace(/^W\//, "");
  return (
    typeof match === "string" &&
    match.split(",").some((tag) => tag.trim() === "*" || tag.trim().replace(/^W\//, "") === bare)
  );
}

const gzipAnswer = promisify(gzip),
  brotliAnswer = promisify(brotliCompress);
/** Fast levels: a changed answer is compressed as it is sent (about 1 MB at scale M); an unchanged one is a 304. */
const ANSWER_GZIP_LEVEL = 6,
  ANSWER_BROTLI_QUALITY = 5;

/**
 * A large JSON answer the page reads again and again (the project catalog, every 15 s per tab): compressed
 * when the reader accepts it, with a weak ETag over its body (one validator for every coding, as the page
 * shell's), and a matching `If-None-Match` is a 304 with no body. It stays `no-store` (ADR 0014: project
 * data is kept in no cache); the page holds the last body and tag itself (ui project-directory.ts).
 */
async function sendRevalidatedJson(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
  const encodeStarted = phaseStart();
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  const headers = {
    ...SECURITY_HEADERS,
    etag: `W/"${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}"`,
    vary: "accept-encoding",
  };
  phaseEnd("encode", encodeStarted);
  if (notModified(req, headers.etag)) {
    res.writeHead(304, headers).end();
    return;
  }
  const codings = acceptedCodings(req.headers["accept-encoding"]);
  let sent: Buffer = bytes,
    encoding: string | undefined;
  const compressing = phaseStart();
  try {
    if (codings.has("br"))
      [sent, encoding] = [
        await brotliAnswer(bytes, {
          params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: ANSWER_BROTLI_QUALITY,
            [zlibConstants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
          },
        }),
        "br",
      ];
    else if (codings.has("gzip")) [sent, encoding] = [await gzipAnswer(bytes, { level: ANSWER_GZIP_LEVEL }), "gzip"];
  } catch {
    [sent, encoding] = [bytes, undefined];
  }
  if (encoding !== undefined) phaseEnd("compress", compressing);
  if (res.writableEnded || res.destroyed) return;
  res
    .writeHead(200, {
      ...headers,
      "content-type": "application/json",
      "content-length": sent.length,
      ...(encoding === undefined ? {} : { "content-encoding": encoding }),
    })
    .end(sent);
}

/**
 * A view's envelope with a strong ETag of its bytes. A matching `If-None-Match` (only ever read
 * after authentication) answers 304, so a page polling the open view can send the tag it last
 * saw and skip an unchanged body. The answer stays `no-store` (ADR 0014: project data is not
 * kept in the browser's cache); the page holds the last body and tag itself.
 */
function sendEnvelope(req: IncomingMessage, res: ServerResponse, envelope: unknown): void {
  const body = JSON.stringify(envelope);
  const etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
  const match = req.headers["if-none-match"];
  if (typeof match === "string" && match.split(",").some((tag) => tag.trim() === etag)) {
    res.writeHead(304, { ...SECURITY_HEADERS, etag }).end();
    return;
  }
  res
    .writeHead(200, {
      ...SECURITY_HEADERS,
      etag,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    })
    .end(body);
}

/** `compute()` as the request's `name` Server-Timing phase (S9): a read's own work, apart from encoding its answer. */
function timed<T>(name: string, compute: () => T): T {
  const started = phaseStart();
  const value = compute();
  if (value instanceof Promise) return value.finally(() => phaseEnd(name, started)) as T;
  phaseEnd(name, started);
  return value;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const started = phaseStart();
  const text = JSON.stringify(body);
  phaseEnd("encode", started);
  send(res, status, "application/json", text);
}

/** An error for a caller who holds the token, in ADR 0002's vocabulary. */
function error(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  json(res, status, { schemaVersion: 1, error: { code, message, ...(details === undefined ? {} : { details }) } });
}

function status(res: ServerResponse, code: number): void {
  res.writeHead(code, { ...SECURITY_HEADERS, "content-length": "0" }).end();
}

function search(plane: DataPlane, project: ProjectState, query: URLSearchParams, res: ServerResponse): void {
  try {
    json(
      res,
      200,
      timed("read", () => project.search(query.get("q"))),
    );
  } catch (failure) {
    if (failure instanceof SearchRefusal) return error(res, 422, failure.code, failure.message);
    plane.log(
      `[archer] ui: search failed: ${failure instanceof Error ? (failure.stack ?? failure.message) : String(failure)}`,
    );
    error(res, 500, "internal", "the search failed; the service log has the detail");
  }
}

let pendingOperations = 0;
async function browserOperation(
  plane: DataPlane,
  project: ProjectState,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!sameOrigin(req.headers)) {
    req.resume();
    return status(res, 403);
  }
  if (pendingOperations >= 4) {
    req.resume();
    return error(
      res,
      429,
      "operation_busy",
      "Four page operations are already running; try again after one completes.",
    );
  }
  pendingOperations++;
  try {
    const text = await readBody(req, res, MAX_SELECTION_BODY_BYTES);
    if (text === null) return;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new BrowserOperationRefusal("Page operation arguments must be JSON.");
    }
    const request = parseBrowserOperation(value);
    const answer = await plane.operation!(project.root, request.name, request.arguments);
    json(res, 200, answer.structured);
  } catch (failure) {
    if (failure instanceof BrowserOperationRefusal) return error(res, 422, failure.code, failure.message);
    if (failure instanceof OperationError) {
      const { code, ...details } = failure.data;
      return error(res, failure.code === -32603 ? 500 : 422, String(code), failure.message, details);
    }
    plane.log("[archer] page operation failed; inspect the service log");
    if (!res.headersSent) error(res, 500, "internal", "The page operation failed.");
  } finally {
    pendingOperations--;
  }
}

/** POST api/walkthrough-position: the step the reader is on, small and same-origin like a selection. */
async function handleReading(project: ProjectState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!sameOrigin(req.headers)) {
    req.resume();
    return status(res, 403);
  }
  const text = await readBody(req, res, 1024);
  if (text === null) return;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return status(res, 422);
  }
  const outcome = project.postReading(body);
  if (outcome.ok) return status(res, 204);
  error(res, 422, "invalid_walkthrough_position", outcome.message);
}

export async function handleSelection(project: ProjectState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!sameOrigin(req.headers)) {
    req.resume();
    return status(res, 403);
  }
  const text = await readBody(req, res, MAX_SELECTION_BODY_BYTES);
  if (text === null) return;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return status(res, 422);
  }
  try {
    const outcome = project.postSelection(body);
    if (outcome.ok) return status(res, 204);
    if (outcome.status === 409) return status(res, 409);
    if (outcome.code === "invalid_selection") return error(res, 422, outcome.code, outcome.message);
    status(res, 422);
  } catch (failure) {
    if (failure instanceof PersistenceError)
      return error(res, 500, failure.code, "The selection could not be saved; the previous context remains current.");
    error(res, 500, "internal", "The selection could not be saved.");
  }
}

// ----------------------------------------------------------- walkthroughs

/** GET api/walkthroughs?viewId=<id>: the store's refusals keep their code; nothing here throws. */
function walkthroughs(project: ProjectState, query: URLSearchParams, res: ServerResponse): void {
  const viewId = query.get("viewId");
  if (viewId === null) return error(res, 422, "invalid_request", "name the view: api/walkthroughs?viewId=<view id>");
  try {
    json(res, 200, project.walkthroughsFor(viewId, timed));
  } catch (failure) {
    if (failure instanceof WalkthroughsError) return error(res, failure.status, failure.code, failure.message);
    if (failure instanceof StateRefusal)
      return error(res, 404, failure.code, `no diagram view is registered as '${viewId.slice(0, 200)}'`);
    error(res, 500, "internal", "the walkthroughs could not be read");
  }
}

/** GET api/walkthroughs/old?viewId=<id>&id=<walkthrough id>: the old model, or why there is none; nothing here throws. */
async function oldVersion(project: ProjectState, query: URLSearchParams, res: ServerResponse): Promise<void> {
  const viewId = query.get("viewId"),
    id = query.get("id");
  if (viewId === null || id === null)
    return error(
      res,
      422,
      "invalid_request",
      "name the view and the walkthrough: api/walkthroughs/old?viewId=<view id>&id=<walkthrough id>",
    );
  try {
    const old = await project.oldVersion(viewId, id, timed);
    if (old === null)
      return error(
        res,
        404,
        "walkthrough_not_found",
        `view '${viewId.slice(0, 200)}' has no walkthrough '${id.slice(0, 200)}'`,
      );
    json(res, 200, old);
  } catch (failure) {
    if (failure instanceof WalkthroughsError) return error(res, failure.status, failure.code, failure.message);
    if (failure instanceof StateRefusal)
      return error(res, 404, failure.code, `no diagram view is registered as '${viewId.slice(0, 200)}'`);
    if (!res.headersSent) error(res, 500, "internal", "the old version could not be read");
  }
}

// ------------------------------------------------------------- expand

/**
 * GET api/expand-menu?viewId=<base>&element=<id>&expand=<canvas> (ADR 0036 §11–§13, A8, A9, A13): the same
 * credential as reading a diagram; sources only from this project's inventory. Revalidated JSON with a weak
 * ETag over the body, which carries the model generation and every revision it was cut from.
 */
async function expandMenuRoute(
  project: ProjectState,
  query: URLSearchParams,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const viewId = query.get("viewId"),
    element = query.get("element");
  if (viewId === null || element === null || viewId === "" || element === "")
    return error(
      res,
      422,
      "invalid_request",
      "name the view and the element: api/expand-menu?viewId=<view id>&element=<element id>",
    );
  const expand = decodeExpansions(query.get("expand"));
  if (!expand.ok) return error(res, 422, expand.code, expand.message);
  let menu;
  try {
    menu = timed("read", () => project.expandMenu(viewId, element, expand.expansions));
  } catch {
    return error(res, 500, "internal", "the Expand menu could not be read");
  }
  if ("status" in menu) return error(res, menu.status, menu.code, menu.message);
  try {
    await sendRevalidatedJson(req, res, menu);
  } catch {
    if (!res.headersSent) error(res, 500, "internal", "the Expand menu could not be sent");
  }
}

/**
 * GET api/exploration?viewId=<base>&expand=<list> (route 2: a link or the page's own list) or
 * ?viewId=<base>&presentationId=<id> (route 3: the agent's presented exploration). Every frame in one answer,
 * revalidated like the menu (A8, A9, ticket 14).
 */
async function explorationRoute(
  project: ProjectState,
  query: URLSearchParams,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const viewId = query.get("viewId"),
    presentationId = query.get("presentationId");
  if (viewId === null || viewId === "")
    return error(
      res,
      422,
      "invalid_request",
      "name the view: api/exploration?viewId=<view id>&expand=<list> or &presentationId=<id>",
    );
  if (presentationId !== null && query.has("expand"))
    return error(res, 422, "invalid_request", "name the expansions or the presentation, not both");
  let ask: { expand: readonly Expansion[] } | { presentationId: string };
  if (presentationId !== null) ask = { presentationId };
  else {
    const expand = decodeExpansions(query.get("expand"));
    if (!expand.ok) return error(res, 422, expand.code, expand.message);
    ask = { expand: expand.expansions };
  }
  let answer;
  try {
    answer = timed("read", () => project.exploration(viewId, ask));
  } catch {
    return error(res, 500, "internal", "the exploration could not be read");
  }
  if ("status" in answer) return error(res, answer.status, answer.code, answer.message);
  try {
    await sendRevalidatedJson(req, res, answer);
  } catch {
    if (!res.headersSent) error(res, 500, "internal", "the exploration could not be sent");
  }
}

/** POST api/reader-exploration (O1, route 4): the reader's own additions and frame selection, as walkthrough-position. */
const MAX_READER_EXPLORATION_BYTES = 16 * 1024;
async function handleReaderExploration(
  project: ProjectState,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!sameOrigin(req.headers)) {
    req.resume();
    return status(res, 403);
  }
  const text = await readBody(req, res, MAX_READER_EXPLORATION_BYTES);
  if (text === null) return;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return status(res, 422);
  }
  const outcome = project.postReaderExploration(body);
  if (outcome.ok) return status(res, 204);
  error(res, 422, "invalid_reader_exploration", outcome.message);
}

// ------------------------------------------------------ comments and notes
// The routes of ts/src/comments/contract.ts. Every change is checked for its
// origin and its size before its body is read; every refusal is the store's
// code and sentence, and nothing here throws.

/** A comments or notes read: its answer, or any refusal as `commentsFailure`. */
async function commentRead(
  ctx: RouteContext,
  answer: (project: ProjectState, query: URLSearchParams, res: ServerResponse) => void | Promise<void>,
): Promise<void> {
  try {
    await answer(projectOf(ctx), ctx.url.searchParams, ctx.res);
  } catch (failure) {
    commentsFailure(ctx.plane, ctx.res, failure);
  }
}

const COMMENT_READS: readonly RouteHandler[] = [
  {
    id: "comment-activity",
    handle: (ctx) =>
      commentRead(ctx, (project, _query, res) =>
        json(
          res,
          200,
          timed("read", () => project.commentActivity()),
        ),
      ),
  },
  {
    id: "notes",
    handle: (ctx) =>
      commentRead(ctx, (project, query, res) => {
        const viewId = query.get("viewId");
        if (viewId === null) return error(res, 422, "invalid_request", "name the view: api/notes?viewId=<view id>");
        const notes = timed("read", () => project.notesFor(viewId));
        return notes === null
          ? error(res, 404, "diagram_not_found", `no diagram view is registered as '${viewId.slice(0, 200)}'`)
          : json(res, 200, notes);
      }),
  },
  {
    id: "notes-content",
    handle: (ctx) =>
      commentRead(ctx, async (project, query, res) =>
        json(res, 200, await timed("read", () => project.noteWithFreshness(query.get("path") ?? ""))),
      ),
  },
  {
    id: "notes-diagram",
    handle: (ctx) =>
      commentRead(ctx, async (project, query, res) => {
        const address = query.get("address") ?? "";
        const diagram = await project.embeddedDiagram(address);
        return diagram === null
          ? error(
              res,
              404,
              "diagram_not_found",
              `no diagram embedded in a note is named '${address.slice(0, 200)}'; an address is <note path>#<name>`,
            )
          : json(res, 200, diagram);
      }),
  },
  {
    id: "notes-all",
    handle: (ctx) =>
      commentRead(ctx, (project, _query, res) =>
        json(
          res,
          200,
          timed("read", () => project.allNotes()),
        ),
      ),
  },
  {
    id: "comments",
    handle: (ctx) =>
      commentRead(ctx, (project, query, res) =>
        json(
          res,
          200,
          timed("read", () => project.listComments(query.get("target"))),
        ),
      ),
  },
  {
    id: "comments-pending",
    handle: (ctx) =>
      commentRead(ctx, (project, _query, res) =>
        json(
          res,
          200,
          timed("read", () => project.pendingComments()),
        ),
      ),
  },
];

/** What a comment write does with its body, and what follows it. */
interface CommentWrite {
  readonly action: (
    project: ProjectState,
    body: unknown,
    params: Readonly<Record<string, string>>,
    realm: string,
  ) => unknown;
  /** It may publish its thread (a new thread, a reply, an edit). */
  readonly publishes?: boolean;
  /**
   * An operation (ADR 0016): `{ operation, payload }`, answered with a receipt. A body that is not one is refused
   * as `invalid_operation`. A new thread, a reply and a submit are operations.
   */
  readonly operation?: boolean;
  /** Send queued comments (`comments/submit`). */
  readonly submits?: boolean;
}

const commentWriteRoute = (id: string, write: CommentWrite): RouteHandler => ({
  id,
  handle: (ctx) => commentWrite(ctx, write),
});

const COMMENT_WRITES: readonly RouteHandler[] = [
  commentWriteRoute("comments-create", {
    action: (project, body, _params, realm) => project.createThreadOnce(body, realm),
    publishes: true,
    operation: true,
  }),
  commentWriteRoute("comments-submit", {
    action: (project, body, _params, realm) => project.submitCommentsOnce(body, realm),
    operation: true,
    submits: true,
  }),
  commentWriteRoute("comments-reply", {
    action: (project, body, params, realm) => project.replyThreadOnce(params["threadId"]!, body, realm),
    publishes: true,
    operation: true,
  }),
  commentWriteRoute("comments-resolve", {
    action: (project, _body, params) => project.resolveThread(params["threadId"]!),
  }),
  commentWriteRoute("comments-dismiss", {
    action: (project, _body, params) => project.dismissThread(params["threadId"]!),
  }),
  commentWriteRoute("comments-edit", {
    action: (project, body, params) => project.editComment(params["threadId"]!, params["commentId"]!, body),
    publishes: true,
  }),
  commentWriteRoute("comments-delete", {
    action: (project, _body, params) => project.deleteComment(params["threadId"]!, params["commentId"]!),
  }),
];

/** A comment write: checked for its origin and its size before its body is read. */
async function commentWrite(ctx: RouteContext, write: CommentWrite): Promise<void> {
  const { plane, req, res } = ctx,
    project = projectOf(ctx),
    realm = ctx.access.realm,
    owner = ctx.access.owner && ctx.access.local;
  const publishesThread = write.publishes === true,
    isOperation = write.operation === true;
  const action = (body: unknown): unknown => write.action(project, body, ctx.params, realm);
  try {
    if (!sameOrigin(req.headers)) {
      req.resume();
      return status(res, 403);
    }
    const text = await readBody(req, res, MAX_COMMENTS_BODY_BYTES);
    if (text === null) return;
    let body: unknown;
    try {
      body = text.trim() === "" ? undefined : (JSON.parse(text) as unknown);
    } catch {
      return error(res, 422, "invalid_comment", "the request body is not JSON");
    }
    // What this write sends to the agents, so the delivery order can act on it with the sender's sign-in.
    const arrived = plane.listeners?.arrived;
    const submits = write.submits === true;
    // A submit names its scope in its payload (O83).
    const scope = submits ? (body as { payload?: unknown } | undefined)?.payload : undefined;
    const named = (scope as { threadId?: unknown } | undefined)?.threadId;
    const before =
      submits && arrived !== undefined && typeof named !== "string"
        ? new Set(project.waitingThreads().map((thread) => thread.id))
        : undefined;
    let sent: readonly string[] = [];
    // The write and its publish are told to the page once, after both (O250).
    const value = project.announcingOnce(() => {
      const written = action(body);
      // Only an actual new submission or change arrives (X-17): an edit to the same text leaves the thread as it
      // was (sent, not a draft), and a submit of a thread already sent submits nothing; neither calls the order.
      const ack = isOperation ? (written as OperationAck) : null;
      if (
        !(
          publishesThread &&
          plane.settings.read().commentSubmission === "immediate" &&
          (ack === null || ack.thread !== null)
        )
      )
        return written;
      // An operation answered from its receipt is published too: its first answer may have been lost before
      // the publish (a draft still), and publishing a sent thread again sends nothing.
      const thread = ack === null ? (written as Thread) : ack.thread!;
      const changed = thread.status === "draft";
      const published = project.publishThread(thread);
      if (changed) sent = [published.id];
      return ack === null ? published : { ...ack, thread: published };
    });
    if (submits && arrived !== undefined)
      sent =
        before !== undefined
          ? project
              .waitingThreads()
              .map((thread) => thread.id)
              .filter((id) => !before.has(id))
          : // A submit answered from its receipt sent this thread before (and the order ran then): nothing arrives now.
            (value as { submitted?: unknown }).submitted === 1 && (value as { replayed?: unknown }).replayed !== true
            ? [String(named)]
            : [];
    if (sent.length > 0) {
      try {
        arrived?.(project, sent, { owner });
      } catch (failure) {
        plane.log(
          `[archer] ui: delivery order failed: ${failure instanceof Error ? failure.message : String(failure)}`,
        );
      }
    }
    json(res, 200, value);
  } catch (failure) {
    commentsFailure(plane, res, failure);
  }
}

/** A comments or notes route's refusal: the store's code and sentence, else fixed text; nothing here throws. */
function commentsFailure(plane: DataPlane, res: ServerResponse, failure: unknown): void {
  // A thread_changed refusal carries the thread as it is now (O124: a stale edit), which the page may read anyway.
  if (failure instanceof CommentsError)
    return error(
      res,
      failure.status,
      failure.code,
      failure.message,
      failure.code === "thread_changed" ? failure.details : undefined,
    );
  if (failure instanceof WriteRuleDenied) return ruleDenied(plane, res, failure);
  if (failure instanceof NoteNotFound) return error(res, 404, failure.code, failure.message);
  // A sidecar or note that is a link out of the Archer folder: refused with fixed text (its message names a path).
  if (
    failure instanceof ProjectError &&
    (failure.code === "path_outside_archer_folder" || failure.code === "path_outside_project")
  ) {
    plane.log(`[archer] ui: comments route refused: ${failure.message}`);
    return error(
      res,
      403,
      "path_outside_archer_folder",
      "that comment file is a link that leads out of the Archer folder; nothing was written",
    );
  }
  plane.log(
    `[archer] ui: comments route failed: ${failure instanceof Error ? (failure.stack ?? failure.message) : String(failure)}`,
  );
  if (!res.headersSent)
    error(res, 500, "internal", "the comment could not be read or written; the service log has the detail");
}

const COMMENT_ROUTES: readonly RouteHandler[] = [...COMMENT_READS, ...COMMENT_WRITES];

// ------------------------------------------------------------- listeners
// The bubble's delivery (ADR 0035 §7–8): who listens (GET), the person's pick (POST pin) and Launch (POST
// launch). The writes are the person's alone (review decision 1): the owner's own sign-in on this computer
// (the service token's cookie or path, from this machine), never an access link or a paired device's grant,
// which may read the listing but not re-route messages or start a process; and, as for the other page
// writes that act beyond the page, the exact Origin and a JSON body, so an agent's token without an Origin
// is refused. Archer's settings themselves are read-only in every page (ADR 0028); this is the authority
// such a write would need.

const MAX_LISTENER_BODY_BYTES = 1024;
const LISTENER_STATUS: Readonly<Record<string, number>> = {
  agent_unknown: 404,
  thread_not_found: 404,
  project_not_attached: 404,
  agent_not_in_checkout: 422,
  cross_checkout_deferred: 422,
  invalid_listener_request: 422,
  launcher_not_configured: 409,
  launcher_cwd_outside_project: 409,
  launcher_cwd_missing: 409,
  launch_busy: 429,
  launcher_failed: 502,
  listener_live: 409,
  thread_not_waiting: 409,
  launch_off: 409,
  // The person's own archer.toml cannot be read: Launch says why, as `archer` would at the terminal.
  manifest_error: 409,
  untrusted_manifest: 409,
};

async function listeners(
  plane: DataPlane,
  backend: ListenerBackend,
  project: ProjectState,
  req: IncomingMessage,
  res: ServerResponse,
  route: string,
  owner: boolean,
): Promise<void> {
  const method = req.method ?? "GET";
  try {
    if (route === LISTENER_ROUTES.list) {
      if (method !== "GET") return bare404(res);
      // The same check as pin and Launch: the listing says `personal` (and `launcher`) only to that caller.
      return json(res, 200, backend.listing(project, { personal: owner }));
    }
    if ((route !== LISTENER_ROUTES.pin && route !== LISTENER_ROUTES.launch) || method !== "POST") return bare404(res);
    if (typeof req.headers.origin !== "string" || !sameOrigin(req.headers)) {
      req.resume();
      return status(res, 403);
    }
    if (!owner) {
      req.resume();
      return error(
        res,
        403,
        "person_only",
        route === LISTENER_ROUTES.pin
          ? "Only the person, signed in on this computer, picks who listens; an access link or paired device cannot."
          : "Only the person, signed in on this computer, can launch an agent; an access link or paired device cannot.",
      );
    }
    if (req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      req.resume();
      return error(res, 415, "invalid_listener_request", "send the request as application/json");
    }
    const text = await readBody(req, res, MAX_LISTENER_BODY_BYTES);
    if (text === null) return;
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return error(res, 422, "invalid_listener_request", "the request body is not JSON");
    }
    const fields =
      typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    if (route === LISTENER_ROUTES.pin) {
      const agentId = fields?.["agentId"];
      if (
        fields === null ||
        Object.keys(fields).some((key) => key !== "agentId") ||
        (agentId !== null && (typeof agentId !== "string" || !/^ag-[0-9a-f]{12}$/.test(agentId)))
      )
        return error(
          res,
          422,
          "invalid_listener_request",
          'send { "agentId": "<an agent id from the listing>" }, or { "agentId": null } to clear the pick',
        );
      return json(res, 200, backend.pin(project, agentId as string | null));
    }
    const threadId = fields?.["threadId"];
    if (
      fields === null ||
      Object.keys(fields).some((key) => key !== "threadId") ||
      typeof threadId !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(threadId)
    )
      return error(res, 422, "invalid_listener_request", 'send { "threadId": "<the thread to launch an agent for>" }');
    return json(res, 200, await backend.launch(project, threadId));
  } catch (failure) {
    const code = (failure as { code?: unknown }).code;
    // Paths never reach the page (review C15, L16): any absolute path in a refusal is written as the catalog writes it.
    if (typeof code === "string" && failure instanceof Error && LISTENER_STATUS[code] !== undefined)
      return error(res, LISTENER_STATUS[code]!, code, pageText(failure.message));
    plane.log(
      `[archer] ui: listeners route failed: ${failure instanceof Error ? (failure.stack ?? failure.message) : String(failure)}`,
    );
    if (!res.headersSent) error(res, 500, "internal", "the listener request failed; the service log has the detail");
  }
}

/** The body as text, or null when it was too large (answered 413) or the request ended early. */
export async function readBody(req: IncomingMessage, res: ServerResponse, limit: number): Promise<string | null> {
  const declared = Number(req.headers["content-length"] ?? "0");
  if (declared > limit) {
    tooLarge(req, res);
    return null;
  }
  const body = await readCapped(req, limit);
  if (body === TOO_LARGE) tooLarge(req, res);
  return Buffer.isBuffer(body) ? body.toString("utf8") : null;
}

export const TOO_LARGE = Symbol("too large");

/**
 * The body as text, TOO_LARGE once it passes `limit`, or null when the request ended early. Read with
 * listeners rather than `for await`: leaving a `for await` early destroys the request, and with it the
 * connection, before the 413 can reach the client (see tooLarge).
 */
export function readCapped(req: IncomingMessage, limit: number): Promise<Buffer | typeof TOO_LARGE | null> {
  // Already over before we listen: no event would come, and the promise would never settle.
  if (req.readableEnded || req.destroyed) return Promise.resolve(null);
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const settle = (value: Buffer | typeof TOO_LARGE | null): void => {
      req.off("data", onData).off("end", onEnd).off("error", onEarlyEnd).off("close", onEarlyEnd);
      resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) settle(TOO_LARGE);
      else chunks.push(chunk);
    };
    const onEnd = (): void => settle(Buffer.concat(chunks));
    const onEarlyEnd = (): void => settle(null);
    req.on("data", onData).on("end", onEnd).on("error", onEarlyEnd).on("close", onEarlyEnd);
  });
}

/** How long a refused body's remaining bytes are read and discarded before the connection is dropped. */
export const REFUSED_BODY_LINGER_MS = 2_000;

/** Answer 413 and close the connection without parsing the rest of the body (see closeAfterRefusal). */
export function tooLarge(req: IncomingMessage, res: ServerResponse): void {
  closeAfterRefusal(req, res);
  res.writeHead(413, { ...SECURITY_HEADERS, "content-length": "0" }).end(() => {
    if (req.httpVersionMajor >= 2) req.destroy();
  });
}

/**
 * Call before answering a request whose body is refused unread: the response closes the connection,
 * and on HTTP/1 the close lingers (RFC 9112 §9.6). The answer is sent, the write side is shut, and what
 * the client is still sending is read and discarded for at most REFUSED_BODY_LINGER_MS. Closing with
 * unread bytes in the receive buffer resets the connection, and a client still writing its body then
 * sees EPIPE/ECONNRESET instead of the answer (on macOS for any body larger than the socket buffers, so
 * a 2 MiB upload never learned why it failed). HTTP/2 refuses the one stream, not the connection.
 */
export function closeAfterRefusal(req: IncomingMessage, res: ServerResponse): void {
  if (req.httpVersionMajor < 2) {
    markRefusedConnection(req);
    res.setHeader("connection", "close");
    const socket = req.socket;
    // node:http ends a `connection: close` response with socket.destroySoon() (or socket.end() where it is absent).
    socket.destroySoon = () => {
      socket.end();
      const drop = setTimeout(() => socket.destroy(), REFUSED_BODY_LINGER_MS);
      drop.unref();
      socket.once("end", () => socket.destroy()).once("close", () => clearTimeout(drop));
    };
  }
  req.resume();
}

/** Rebase only transport metadata; source text and semantic/revision identities stay untouched. */
function cleanPresentation(project: ProjectState, payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
  const snapshot = payload as Record<string, unknown>;
  if (typeof snapshot["ui"] !== "object" || snapshot["ui"] === null || Array.isArray(snapshot["ui"])) return payload;
  return {
    ...snapshot,
    ui: {
      ...(snapshot["ui"] as Record<string, unknown>),
      url: new URL(`/projects/${project.slug}/?follow`, project.url).href,
    },
  };
}

/**
 * Bytes an event stream may hold unsent before it is closed. A tab that stops reading (a suspended
 * laptop, a paused process, a stalled network) otherwise has every later event buffered in the service
 * without bound. The page reconnects on its own and adopts the standing sequence, so closing loses nothing.
 */
export const MAX_EVENT_STREAM_BACKLOG_BYTES = 4 * 1024 * 1024;

/** Writes `text` unless the stream already holds more than `limit` unsent bytes; then calls `overflow` once. */
export function boundedWrite(
  res: Pick<ServerResponse, "writableLength" | "write" | "destroyed">,
  text: string,
  overflow: () => void,
  limit = MAX_EVENT_STREAM_BACKLOG_BYTES,
): boolean {
  if (res.destroyed) return false;
  if (res.writableLength > limit) {
    overflow();
    return false;
  }
  res.write(text);
  return true;
}

function events(
  plane: DataPlane,
  project: ProjectState,
  req: IncomingMessage,
  res: ServerResponse,
  owner = false,
): void {
  // One link's share first (server review S14); its streams are those registered under its grant, this one included.
  const grant = plane.grantStreams?.get(res);
  if (
    grant !== undefined &&
    [...plane.grantStreams!.values()].filter((id) => id === grant).length > MAX_EVENT_STREAMS_PER_GRANT
  ) {
    plane.log(`[archer] ui: events=refused reason=too_many_connections_for_link limit=${MAX_EVENT_STREAMS_PER_GRANT}`);
    return error(
      res,
      503,
      "too_many_connections",
      `This access link already has ${MAX_EVENT_STREAMS_PER_GRANT} live pages open, the most one link keeps. Close a tab and reload.`,
    );
  }
  const acquired = plane.cap.acquire();
  if (acquired === null) {
    activeTelemetry()?.stream("refused", plane.cap.open, plane.cap.limit);
    plane.log(`[archer] ui: events=refused reason=too_many_connections limit=${MAX_EVENT_STREAMS}`);
    return error(
      res,
      503,
      "too_many_connections",
      `Archer is already serving ${MAX_EVENT_STREAMS} live pages, which is the most it keeps open. Close a tab that has this diagram open and reload.`,
    );
  }
  // HTTP/2 forbids connection-specific headers (the stream is the connection's own business).
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "content-type": "text/event-stream",
    ...(req.httpVersionMajor < 2 ? { connection: "keep-alive" } : {}),
  });
  // A first body byte, so the page reads the standing state as soon as the stream opens.
  res.write(": open\n\n");
  plane.streams.set(res, project);
  activeTelemetry()?.stream("opened", plane.cap.open, plane.cap.limit);
  const release = (): void => {
    acquired();
    activeTelemetry()?.stream("closed", plane.cap.open, plane.cap.limit);
  };
  const grantId = plane.grantStreams?.get(res);
  let overflowed = false;
  const send = (text: string): void => {
    boundedWrite(res, text, () => {
      if (overflowed) return;
      overflowed = true;
      plane.log(
        `[archer] ui: events=closed reason=backlog bytes=${res.writableLength} limit=${MAX_EVENT_STREAM_BACKLOG_BYTES}`,
      );
      res.destroy();
    });
  };
  const authorized = (): boolean => {
    if (res.writableEnded) return false;
    if (grantId === undefined || plane.authority.grants.isActive(grantId) === true) return true;
    res.end();
    return false;
  };
  const unsubscribe = project.subscribe((event, payload) => {
    if (!authorized()) return;
    // The delivery steps are the owner's alone (D10): every other stream gets the listing without them.
    const shown =
      event === "presentation"
        ? cleanPresentation(project, payload)
        : event === LISTENER_EVENT && !owner
          ? withoutSteps(payload)
          : payload;
    send(`event: ${event}\ndata: ${JSON.stringify(shown)}\n\n`);
  });
  // Taken now, in the same turn as the subscription: everything past this count arrives as an event.
  send(`event: standing\ndata: ${JSON.stringify({ seq: project.eventSeq })}\n\n`);
  const beat = setInterval(() => {
    if (!authorized()) return;
    // Older pages ignore the unknown named event. Newer pages can distinguish
    // a live connection from a stalled stream and detect replacement backends.
    send(`: keep-alive\nevent: heartbeat\ndata: ${JSON.stringify({ serverEpoch: plane.connection.serverEpoch })}\n\n`);
  }, KEEP_ALIVE_MS);
  let done = false;
  const close = (): void => {
    if (done) return;
    done = true;
    clearInterval(beat);
    unsubscribe();
    plane.streams.delete(res);
    release();
  };
  req.on("close", close);
  res.on("close", close);
}

/** A `listeners` event's payload without the owner-only `pending` delivery steps (D10). */
function withoutSteps(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || !("pending" in payload)) return payload;
  const { pending: _steps, ...rest } = payload as Record<string, unknown>;
  return rest;
}

/** Settings (read-only in every page, ADR 0028), note emphasis, the bubble's listeners and browser authoring. */
const SETTINGS_ROUTES: readonly RouteHandler[] = [
  { id: "settings", handle: ({ plane, req, res }) => settings(plane, req, res) },
  { id: "settings-put", handle: ({ plane, req, res }) => settings(plane, req, res) },
  { id: "project-settings", handle: (ctx) => projectSettings(ctx.plane, projectOf(ctx), ctx.req, ctx.res) },
  { id: "project-settings-patch", handle: (ctx) => projectSettings(ctx.plane, projectOf(ctx), ctx.req, ctx.res) },
  {
    id: "note-emphases",
    handle: (ctx) => noteEmphases(ctx.plane, projectOf(ctx), ctx.req, ctx.res, ctx.url.searchParams),
  },
  {
    id: "note-emphases-set",
    handle: (ctx) => noteEmphases(ctx.plane, projectOf(ctx), ctx.req, ctx.res, ctx.url.searchParams),
  },
];

const listenerRoute = (id: string, route: string): RouteHandler => ({
  id,
  enabled: (plane) => plane.listeners !== undefined,
  handle: (ctx) =>
    listeners(
      ctx.plane,
      ctx.plane.listeners!,
      projectOf(ctx),
      ctx.req,
      ctx.res,
      route,
      ctx.access.owner && ctx.access.local,
    ),
});

const authoringRoute = (id: string, action: AuthoringAction): RouteHandler => ({
  id,
  enabled: (plane) => plane.authoring !== undefined,
  handle: (ctx) =>
    handleAuthoringHttp(ctx.plane.authority, ctx.plane.authoring!, projectOf(ctx).root, action, ctx.req, ctx.res),
});

const DELIVERY_ROUTES: readonly RouteHandler[] = [
  listenerRoute("listeners", LISTENER_ROUTES.list),
  listenerRoute("listeners-pin", LISTENER_ROUTES.pin),
  listenerRoute("listeners-launch", LISTENER_ROUTES.launch),
  authoringRoute("authoring-status", "status"),
  authoringRoute("authoring-mutate", "mutate"),
  authoringRoute("authoring-open", "open"),
  authoringRoute("authoring-snapshot", "snapshot"),
  authoringRoute("authoring-preview", "preview"),
  authoringRoute("authoring-edit", "edit"),
  authoringRoute("authoring-presentation", "presentation"),
  authoringRoute("authoring-operation", "operation"),
];

/** Every API route's handler (shared/api-routes.mts names the routes; `dispatchApi` picks one). */
const API_HANDLERS = routeHandlers([...STATE_ROUTES, ...COMMENT_ROUTES, ...SETTINGS_ROUTES, ...DELIVERY_ROUTES]);
