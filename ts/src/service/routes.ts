// The data plane's API dispatch: shared/api-routes.mts says which routes exist, and the handlers here (given by
// http.ts) answer them. handleRequest authenticates, serves pages and resolves the project first; everything under
// `api/` then goes through `dispatchApi`, and a request no entry matches is the bare 404.
import type { IncomingMessage, ServerResponse } from "node:http";
import { API_ROUTES, matchApiRoute, type ApiRouteSpec } from "../../../shared/api-routes.mts";
import type { DataPlane } from "./http.ts";
import type { ProjectState } from "./project-state.ts";

/** Who asked, as browserAccess admitted them. */
export interface RequestAccess {
  /** The owner's own sign-in (the service token's session), not an access link or a paired device's grant. */
  readonly owner: boolean;
  /** A Bearer header carried the credential: a Bearer never makes an Edit-cell change (rubric §1). */
  readonly bearer: boolean;
  /** Who a comment operation's receipt belongs to (ADR 0016): the service's own credential, or one grant. */
  readonly realm: string;
  /** The peer is this computer (read when a route asks: it may list the interfaces). */
  readonly local: boolean;
  readonly grantId?: string;
}

export interface RouteContext {
  readonly plane: DataPlane;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly access: RequestAccess;
  /** The project at project scope; null at service scope. */
  readonly project: ProjectState | null;
  readonly params: Readonly<Record<string, string>>;
}

export interface RouteHandler {
  /** An `API_ROUTES` id. */
  readonly id: string;
  /** Whether the route exists on this plane (its backend is there); absent means always. */
  readonly enabled?: (plane: DataPlane) => boolean;
  handle(ctx: RouteContext): void | Promise<void>;
}

/** Handlers by route id, each id checked against the table once. */
export function routeHandlers(handlers: readonly RouteHandler[]): ReadonlyMap<string, RouteHandler> {
  const ids = new Set(API_ROUTES.map((spec) => spec.id));
  const byId = new Map<string, RouteHandler>();
  for (const handler of handlers) {
    if (!ids.has(handler.id)) throw new Error(`no API route is named ${handler.id}`);
    if (byId.has(handler.id)) throw new Error(`two handlers for API route ${handler.id}`);
    byId.set(handler.id, handler);
  }
  return byId;
}

/**
 * Answers `segments` (from `api` on) with its handler and true, or false for the caller's bare 404. At project
 * scope a GET read is answered at the project's event count (`x-archer-event-seq`), and so is a GET at most three
 * segments deep that matches nothing under a name no route owns: the header goes out with that 404 too.
 */
export function dispatchApi(
  handlers: ReadonlyMap<string, RouteHandler>,
  ctx: Omit<RouteContext, "params">,
  scope: "project" | "service",
  segments: readonly string[],
): boolean {
  const live = (spec: ApiRouteSpec): boolean => {
    const handler = handlers.get(spec.id);
    return handler !== undefined && (handler.enabled === undefined || handler.enabled(ctx.plane));
  };
  const method = ctx.req.method ?? "GET";
  const found = matchApiRoute(method, scope, segments, live);
  const project = ctx.project;
  if (found === null) {
    if (
      project !== null &&
      method === "GET" &&
      segments[0] === "api" &&
      segments.length <= 3 &&
      !API_ROUTES.some((spec) => spec.owned === true && spec.name === segments[1] && live(spec))
    )
      ctx.res.setHeader("x-archer-event-seq", String(project.eventSeq));
    return false;
  }
  // The publication count this read is answered at: a page that read before its stream opened can
  // tell whether something was published in between (ui host-bridge `checkAdopted`).
  if (found.spec.eventSeq && project !== null) ctx.res.setHeader("x-archer-event-seq", String(project.eventSeq));
  void handlers.get(found.spec.id)!.handle({ ...ctx, params: found.params });
  return true;
}
