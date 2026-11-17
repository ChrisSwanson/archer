// `archer status`, `archer stop --stale [--include-main]` and `archer preferences` (ADR 0031).
//
// status          every registered running copy
// stop --stale    stops copies that are isolated and idle, whose state directory is gone, or that
//                 run an older version; the main one only with --include-main. Only a process
//                 verified as that Archer through its owner identity is signalled.
// preferences     shows ~/.archer/preferences.md's flags; `set instances <mode> [--note "…"]` records one
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { INSTANCE_MODES, readPreferences, setPreference } from "../config/preferences.ts";
import { printable } from "../terminal/printable.ts";
import { version as currentVersion } from "../version.ts";
import { compareVersions, entryVerified, listInstances, type InstanceEntry } from "./instances.ts";
import { readNetworkAccessRecord } from "./network-access-record.ts";
import { loopbackBind } from "./transport.ts";
import type { Env } from "./paths.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import { CliUsageError, type CliIo } from "./cli.ts";

/** An isolated copy idle at least this long is stale for `stop --stale`. */
export const STALE_IDLE_MS = 60_000;
const STOP_WAIT_MS = 5_000;

interface Row {
  readonly kind: "main" | "isolated";
  readonly version: string;
  readonly pid: number | null;
  readonly owner: string | null;
  readonly stateDir: string;
  readonly url: string | null;
  readonly startedAt: string | null;
  readonly idleSince: string | null | undefined;
  readonly stateDirGone: boolean;
  readonly older: boolean;
  /** Present while this copy answers on an address other devices can reach (ticket 11, ADR 0017): where, and since when when known. */
  readonly networkAccess?: { readonly address: string; readonly since?: string };
}

/** Where a copy is open to the network, from the address it advertises and the record `setup_network_access` keeps. */
function networkAccessOf(url: string | null, stateDir: string, startedAt: string | null): Row["networkAccess"] {
  if (url === null) return undefined;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  if (loopbackBind(host)) return undefined;
  const record = readNetworkAccessRecord(stateDir);
  const since = record?.enabled === true ? record.since : (startedAt ?? undefined);
  return { address: url, ...(since === undefined ? {} : { since }) };
}

const rowOf = (entry: InstanceEntry, mine: string): Row => ({
  kind: entry.kind,
  version: entry.version,
  pid: entry.pid,
  owner: entry.owner,
  stateDir: entry.stateDir,
  url: entry.url,
  startedAt: entry.startedAt,
  idleSince: entry.idleSince,
  stateDirGone: !existsSync(entry.stateDir),
  older: compareVersions(entry.version, mine) < 0 || entry.protocolVersion !== PROTOCOL_VERSION,
  ...optional("networkAccess", networkAccessOf(entry.url, entry.stateDir, entry.startedAt)),
});

const optional = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } =>
  value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });

/** Every registered copy. */
function rows(env: Env): Row[] {
  const mine = currentVersion();
  return listInstances(env).map((entry) => rowOf(entry, mine));
}

function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86_400)}d`;
}

const notes = (row: Row): string =>
  [row.older ? "older" : "", row.stateDirGone ? "state gone" : ""].filter(Boolean).join(", ");

export async function status(args: readonly string[], io: CliIo): Promise<number> {
  const json = args.length === 1 && args[0] === "--json";
  if (args.length > 0 && !json) throw new CliUsageError("status takes only --json");
  const found = rows(io.env);
  const now = Date.now();
  if (json) {
    io.stdout(`${JSON.stringify({ instances: found }, null, 2)}\n`);
    return 0;
  }
  if (found.length === 0) {
    io.stdout("No Archer is running.\n");
    return 0;
  }
  const table = [
    ["KIND", "VERSION", "PID", "AGE", "IDLE", "URL", "STATE DIR", "NOTE"],
    ...found.map((row) => [
      row.kind,
      row.version,
      row.pid === null ? "?" : String(row.pid),
      row.startedAt === null ? "?" : span(now - Date.parse(row.startedAt)),
      row.idleSince === undefined ? "?" : row.idleSince === null ? "active" : span(now - Date.parse(row.idleSince)),
      row.url ?? "?",
      row.stateDir,
      notes(row),
    ]),
  ];
  const widths = table[0]!.map((_, column) => Math.max(...table.map((line) => line[column]!.length)));
  const lines = table.map((line) =>
    printable(
      line
        .map((cell, column) => cell.padEnd(widths[column]!))
        .join("  ")
        .trimEnd(),
    ),
  );
  // Open to the network: where, since when, and the one command that turns it off (the page never switches it, ADR 0028).
  for (const row of found)
    if (row.networkAccess !== undefined)
      lines.push(
        printable(
          `pid ${row.pid ?? "?"} is open to your network at ${row.networkAccess.address}${row.networkAccess.since === undefined ? "" : ` since ${row.networkAccess.since}`}; turn it off with  archer network-access off  (or ask your agent)`,
        ),
      );
  io.stdout(lines.join("\n") + "\n");
  return 0;
}

/** Why `row` is stale, or null when it is not. */
function staleness(row: Row, now: number): string | null {
  if (row.stateDirGone) return "its state directory is gone";
  if (row.older) return `it runs an older version (${row.version})`;
  if (row.kind === "isolated" && typeof row.idleSince === "string" && now - Date.parse(row.idleSince) >= STALE_IDLE_MS)
    return `isolated and idle for ${span(now - Date.parse(row.idleSince))}`;
  return null;
}

const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export async function stopStale(args: readonly string[], io: CliIo): Promise<number> {
  const includeMain = args.includes("--include-main");
  if (args.some((arg) => arg !== "--stale" && arg !== "--include-main"))
    throw new CliUsageError("stop takes --stale [--include-main]");
  const now = Date.now();
  const found = rows(io.env);
  let failures = 0,
    stopped = 0;
  const waits: Promise<void>[] = [];
  for (const row of found) {
    const why = staleness(row, now);
    if (why === null) continue;
    const name = `${row.kind} ${row.version} (pid ${row.pid ?? "?"}, ${row.stateDir})`;
    if (row.kind === "main" && !includeMain) {
      io.stdout(`kept ${name}: ${why}, but it is the main one; add --include-main to stop it\n`);
      continue;
    }
    // Verified: the pid still runs the incarnation that registered.
    const verified =
      row.pid !== null &&
      row.owner !== null &&
      row.pid !== process.pid &&
      entryVerified({ pid: row.pid, owner: row.owner });
    if (!verified) {
      io.stdout(`kept ${name}: ${why}, but it cannot be verified as that Archer process\n`);
      failures++;
      continue;
    }
    const pid = row.pid!;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      continue;
    }
    waits.push(
      (async () => {
        const deadline = Date.now() + STOP_WAIT_MS;
        while (running(pid) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
        if (running(pid)) {
          io.stdout(`asked ${name} to stop (${why}); it is still stopping\n`);
          failures++;
        } else {
          io.stdout(`stopped ${name}: ${why}\n`);
          stopped++;
        }
      })(),
    );
  }
  await Promise.all(waits);
  if (stopped === 0 && failures === 0) io.stdout("No stale Archer copies.\n");
  return failures === 0 ? 0 : 1;
}

export async function preferences(args: readonly string[], io: CliIo): Promise<number> {
  if (args.length === 0) {
    const read = readPreferences(io.env);
    io.stdout(`${printable(read.path)}${read.exists ? "" : " (not written yet)"}\ninstances: ${read.instances}\n`);
    for (const warning of read.warnings) io.stderr?.(`warning: ${printable(warning)}\n`);
    return 0;
  }
  const { values, positionals } = (() => {
    try {
      return parseArgs({
        args: [...args],
        options: { note: { type: "string" } },
        strict: true,
        allowPositionals: true,
      });
    } catch (error) {
      throw new CliUsageError(error instanceof Error ? error.message : String(error));
    }
  })();
  const [verb, key, value, ...extra] = positionals;
  if (verb !== "set" || key === undefined || value === undefined || extra.length > 0)
    throw new CliUsageError(
      `preferences takes no arguments, or: set instances <${INSTANCE_MODES.join("|")}> [--note "…"]`,
    );
  if (key !== "instances" || !(INSTANCE_MODES as readonly string[]).includes(value))
    throw new CliUsageError(`preferences set takes instances <${INSTANCE_MODES.join("|")}>`);
  const written = setPreference(io.env, key, value, values.note);
  io.stdout(`instances: ${written.instances} (recorded in ${printable(written.path)})\n`);
  return 0;
}
