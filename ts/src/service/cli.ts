// `archer serve [--foreground]` and `archer stop`.
//
// serve              start the service if it is not running (detached), attach
//                    this directory's project, and print its page
// serve --foreground run the service in this process until it is stopped
// stop               stop the running service
// stop --stale       stop abandoned copies (ADR 0031); status lists them; preferences records the choice
import type { Env } from "./paths.ts";
import { createApplication } from "../application/index.ts";
import { connectIfRunning, ensureService } from "./client.ts";
import { restartService } from "./restart.ts";

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly env: Env;
  readonly cwd?: string | undefined;
}

export class CliUsageError extends Error {}

export async function serve(args: readonly string[], io: CliIo): Promise<number> {
  const foreground = args[0] === "--foreground";
  const options: {
    port?: number;
    serviceName?: string;
    pagePath?: string;
    forceHttp?: boolean;
    tlsCert?: string;
    tlsKey?: string;
  } = {};
  if (args.length > 0 && !foreground) throw new CliUsageError("serve takes --foreground before any listener options");
  for (let index = 1; index < args.length; ) {
    if (args[index] === "--force-http") {
      options.forceHttp = true;
      index++;
      continue;
    }
    const flag = args[index],
      value = args[index + 1];
    if (value === undefined) throw new CliUsageError(`serve ${flag} needs a value`);
    if (flag === "--port" && /^\d+$/u.test(value) && Number(value) > 0 && Number(value) < 65536)
      options.port = Number(value);
    else if (flag === "--service") options.serviceName = value;
    else if (flag === "--page") options.pagePath = value;
    else if (flag === "--tls-cert") options.tlsCert = value;
    else if (flag === "--tls-key") options.tlsKey = value;
    else
      throw new CliUsageError(
        "serve --foreground accepts --port (1–65535), --service, --page, --tls-cert, --tls-key and --force-http",
      );
    index += 2;
  }
  if (foreground) {
    const { serveForeground } = await import("./foreground.ts");
    // The MCP relay's sessions are served here (ADR 0035 §6); the SDK loads on the first relay only.
    return serveForeground(io.env, {
      ...options,
      hostMcp: async (endpoint, launch) => (await import("../mcp/host.ts")).hostMcp(endpoint, launch),
    });
  }
  const app = createApplication({
    cwd: io.cwd ?? process.cwd(),
    env: io.env,
    ensureService: () => ensureService({ env: io.env }),
    startService: () => ensureService({ env: io.env, autoStart: true }),
    findService: () => connectIfRunning({ env: io.env }),
  });
  try {
    await app.call("start_service");
    const answer = await app.call("attach_project", { root: io.cwd ?? process.cwd() });
    const project = answer.structured["project"] as { url: string };
    io.stdout(`Archer is serving this project at\n${project.url}\n`);
    const warning = plainHttpWarning(project.url);
    if (warning !== undefined) io.stderr?.(`${warning}\n`);
    return 0;
  } finally {
    app.close();
  }
}

export async function status(args: readonly string[], io: CliIo): Promise<number> {
  return (await import("./instances-cli.ts")).status(args, io);
}

export async function preferences(args: readonly string[], io: CliIo): Promise<number> {
  return (await import("./instances-cli.ts")).preferences(args, io);
}

export async function restart(args: readonly string[], io: CliIo): Promise<number> {
  if (args.length > 0) throw new CliUsageError("restart takes no arguments");
  const replacement = await restartService(io.env);
  io.stdout(
    `Archer restarted (${replacement.version}) in ${replacement.gapMs} ms. Existing browser links are preserved.\n`,
  );
  return 0;
}

export async function stop(args: readonly string[], io: CliIo): Promise<number> {
  if (args.includes("--stale")) return (await import("./instances-cli.ts")).stopStale(args, io);
  if (args.length > 0) throw new CliUsageError("stop takes no arguments, or --stale [--include-main]");
  const app = createApplication({
    cwd: io.cwd ?? process.cwd(),
    findService: () => connectIfRunning({ env: io.env }),
  });
  try {
    const answer = await app.call("stop_service");
    io.stdout(`${answer.text}\n`);
    return 0;
  } finally {
    app.close();
  }
}

/**
 * A warning when the page is plain HTTP on an address other machines can reach: its links carry
 * a token anyone on the network can read. Served anyway (the owner may rely on it today).
 */
export function plainHttpWarning(url: string): string | undefined {
  const { protocol, hostname } = new URL(url);
  if (protocol !== "http:" || hostname === "localhost" || /^127\./.test(hostname) || hostname === "[::1]")
    return undefined;
  return `Warning: the page is plain HTTP on ${hostname}, reachable from other machines. Anyone on the network can read its links, and a link is a key to the page. Switch to HTTPS with  archer network-access  (or ask your agent), or serve on 127.0.0.1.`;
}
