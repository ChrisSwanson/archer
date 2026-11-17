// The browser listener. Plain HTTP is node:http (HTTP/1.1). TLS is node:https, or with
// ARCHER_HTTP2=1 node:http2's secure server with allowHTTP1, so one port answers HTTP/2 and
// HTTP/1.1 by ALPN. Handlers are written against node:http; for an HTTP/2 request the
// compatibility layer's objects stand in, with one difference repaired here: HTTP/2 carries
// the authority as `:authority`, not `Host`, and every authority check reads `Host`.
// (The other difference, no connection-specific response headers, is kept by the handlers:
// they send `connection` only on HTTP/1.)
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from "node:http";
import { createSecureServer, type Http2ServerRequest, type Http2ServerResponse } from "node:http2";
import { createServer as createHttpsServer } from "node:https";
import type { Server as NetServer, Socket } from "node:net";
import type { PreparedTransport } from "./transport.ts";
import { PersistenceError } from "../state/account.ts";

/** A listener that can drop every connection at once (node:http's closeAllConnections, or its equivalent). */
export type WebServer = NetServer & { closeAllConnections(): void };

/** ARCHER_HTTP2: "1" serves HTTP/2 beside HTTP/1.1 on a TLS port; "0" or unset does not. */
export function http2Requested(env: NodeJS.ProcessEnv): boolean {
  const value = env["ARCHER_HTTP2"];
  if (value !== undefined && value !== "0" && value !== "1")
    throw new PersistenceError("invalid_configuration", "ARCHER_HTTP2 must be 1 or 0");
  return value === "1";
}

/**
 * HSTS on every HTTPS response (security rubric R2), set before any handler writes, so the data plane,
 * authoring, debug and every bare 404 carry it alike. Browsers ignore it for an IP-literal host (RFC 6797
 * §8.1). It is left off for `localhost` names: one HTTPS sandbox there would make the browser upgrade every
 * plain-HTTP development server on localhost, whatever its port. No includeSubDomains: Archer does not own
 * the names beneath the one it answers on.
 */
export const STRICT_TRANSPORT_SECURITY = "max-age=31536000";

/** HTTP/1 connections whose request body was refused unread: closing, so nothing more on them is served. */
const refusedConnections = new WeakSet<object>();
/** Marks `req`'s connection as closing after a refused body (closeAfterRefusal in http.ts). */
export function markRefusedConnection(req: IncomingMessage): void {
  refusedConnections.add(req.socket);
}
/**
 * A request that arrives on a connection whose earlier body was refused, while it drains (RFC 9112 §9.6),
 * is read and dropped, never dispatched: its answer could never reach the client, and a write it asked for
 * would run unseen.
 */
function servingOnly(handler: RequestListener): RequestListener {
  return (req, res) => {
    if (refusedConnections.has(req.socket)) {
      req.resume();
      return;
    }
    handler(req, res);
  };
}
function withHsts(handler: RequestListener): RequestListener {
  return (req, res) => {
    const name = (req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
    if (name !== "localhost" && !name.endsWith(".localhost"))
      res.setHeader("strict-transport-security", STRICT_TRANSPORT_SECURITY);
    handler(req, res);
  };
}

export function createWebServer(
  transport: PreparedTransport,
  unguardedHandler: RequestListener,
  http2: boolean,
): WebServer {
  const plainHandler = servingOnly(unguardedHandler);
  if (transport.scheme === "http") return createHttpServer(plainHandler);
  const handler = withHsts(plainHandler);
  if (!http2) return createHttpsServer(transport.tls, handler);
  const server = createSecureServer(
    { ...transport.tls, allowHTTP1: true },
    (req: IncomingMessage | Http2ServerRequest, res: ServerResponse | Http2ServerResponse) => {
      if (req.httpVersionMajor === 2 && req.headers.host === undefined) {
        const authority = req.headers[":authority"];
        if (typeof authority === "string") req.headers.host = authority;
      }
      handler(req as IncomingMessage, res as ServerResponse);
    },
  );
  // HTTP/1.1 and HTTP/2 connections alike arrive as TLS sockets.
  const sockets = new Set<Socket>();
  server.on("secureConnection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return Object.assign(server, {
    closeAllConnections: (): void => {
      for (const socket of sockets) socket.destroy();
    },
  }) as unknown as WebServer;
}
