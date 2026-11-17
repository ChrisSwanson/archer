// `archer serve --foreground`: run the service in this process until it is
// stopped (`archer stop`, SIGINT or SIGTERM). The front doors start it this
// way, detached (client.ts).
import { startService, type ServiceOptions } from "./service.ts";
import type { Env } from "./paths.ts";
import { isAbsolute } from "node:path";

/**
 * Service options set by the environment. `ARCHER_HOST` is the address the
 * page is served on (loopback when unset): set `0.0.0.0` to open it from
 * another machine. HTTPS by default; insecure HTTP requires explicit operator authorization.
 */
export function optionsFromEnv(
  env: Env,
): Pick<
  ServiceOptions,
  | "host"
  | "stateDir"
  | "socketPath"
  | "tlsCert"
  | "tlsKey"
  | "forceHttp"
  | "handover"
  | "previousPagePath"
  | "retainedPagePath"
> {
  const set = (name: string): string | undefined => {
    const value = env[name];
    return value === undefined || value === "" ? undefined : value;
  };
  const host = set("ARCHER_HOST"),
    stateDir = set("ARCHER_STATE_DIR"),
    socketPath = set("ARCHER_SOCKET");
  const tlsCert = set("ARCHER_TLS_CERT"),
    tlsKey = set("ARCHER_TLS_KEY"),
    forceHttp = set("ARCHER_FORCE_HTTP");
  if (forceHttp !== undefined && forceHttp !== "true" && forceHttp !== "false")
    throw new Error("ARCHER_FORCE_HTTP must be true or false");
  // Set by `archer restart` for its replacement (ADR 0032): warm first, then wait for the hand-over.
  const readyPath = set("ARCHER_HANDOVER_READY"),
    waitMs = set("ARCHER_HANDOVER_WAIT_MS");
  if (readyPath !== undefined && (!isAbsolute(readyPath) || (waitMs !== undefined && !/^\d{1,7}$/.test(waitMs))))
    throw new Error("ARCHER_HANDOVER_READY must be an absolute path, and ARCHER_HANDOVER_WAIT_MS whole milliseconds");
  // The page of the build handing over: its assets stay served for the tabs it loaded.
  const previousPagePath = readyPath === undefined ? undefined : set("ARCHER_HANDOVER_PREVIOUS_PAGE");
  if (previousPagePath !== undefined && !isAbsolute(previousPagePath))
    throw new Error("ARCHER_HANDOVER_PREVIOUS_PAGE must be an absolute path");
  // The previous build's page the running service still serves: kept when the hand-over is to the same build.
  const retainedPagePath = readyPath === undefined ? undefined : set("ARCHER_HANDOVER_RETAINED_PAGE");
  if (retainedPagePath !== undefined && !isAbsolute(retainedPagePath))
    throw new Error("ARCHER_HANDOVER_RETAINED_PAGE must be an absolute path");
  return {
    ...(previousPagePath === undefined ? {} : { previousPagePath }),
    ...(retainedPagePath === undefined ? {} : { retainedPagePath }),
    ...(readyPath === undefined
      ? {}
      : { handover: { readyPath, waitMs: waitMs === undefined ? 15_000 : Number(waitMs) } }),
    ...(tlsCert === undefined ? {} : { tlsCert }),
    ...(tlsKey === undefined ? {} : { tlsKey }),
    ...(forceHttp === undefined ? {} : { forceHttp: forceHttp === "true" }),
    ...(host === undefined ? {} : { host }),
    ...(stateDir === undefined ? {} : { stateDir }),
    ...(socketPath === undefined ? {} : { socketPath }),
  };
}

/**
 * Runs the service until it stops; resolves to the exit code. `ARCHER_STATE_DIR`
 * and `ARCHER_SOCKET` override where it keeps itself (ensureService passes
 * them when it was given its own directories).
 */
export async function serveForeground(env: Env = process.env, options: ServiceOptions = {}): Promise<number> {
  const svc = await startService({ env, ...optionsFromEnv(env), ...options });
  const stop = (): void => void svc.close();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await svc.closed;
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  return 0;
}
