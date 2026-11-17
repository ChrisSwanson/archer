// setup_network_access: everything an agent needs to put Archer's page on the person's other devices,
// after the person's yes. It makes a local CA and certificate (tls setup), merges the [service] block
// into the account's archer.toml without touching anything else, restarts the service onto the
// network bind, and returns the address, a pairing code and the one step only the person can do.
import { spawnSync } from "node:child_process";
import { randomBytes, X509Certificate } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  readSync,
  writeFileSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { lookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";
import { basename, dirname, join } from "node:path";
import { isIP } from "node:net";
import type { OperationResult } from "./index.ts";
import { accessStartFailure, serviceError, toolError } from "./errors.ts";
import { linkText, pairingText } from "./link-text.ts";
import { PROTOCOL_VERSION } from "../service/protocol.ts";
import { loadGlobalConfiguration } from "../config/load.ts";
import { parseGlobalConfig, readGlobalConfigSnapshot } from "../config/index.ts";
import { resolveServiceConfiguration } from "../config/resolve.ts";
import { ensurePrivateDir, serviceDirs } from "../service/paths.ts";
import { loopbackBind, prepareTransport, readPemFile } from "../service/transport.ts";
import {
  NETWORK_ACCESS_FILE,
  readNetworkAccessRecord,
  readNetworkAccessText,
  type NetworkAccessRecord,
} from "../service/network-access-record.ts";
import { setupLocalTls } from "../service/tls-setup.ts";
import {
  connectService,
  ServiceCallError,
  ServiceUnavailableError,
  type ServiceClient,
} from "../service/service-client.ts";

type Env = Readonly<Record<string, string | undefined>>;

export interface NetworkAccess {
  readonly env: Env;
  readonly acquire: (startIfNeeded: boolean, explicit?: boolean) => Promise<ServiceClient | null>;
  readonly disconnect: () => void;
  /** Test seams: this machine's interfaces and whether openssl runs. */
  readonly interfaces?: () => ReturnType<typeof networkInterfaces>;
  readonly openssl?: () => boolean;
  readonly platform?: NodeJS.Platform;
  /** Asks the person directly when the client can (MCP elicitation). */
  readonly askPerson?: AskPerson;
  /** Test seam: a host name's IPv4 addresses. */
  readonly resolveName?: (name: string) => Promise<readonly string[]>;
  /**
   * Test seam: resolves true once the service asked to stop has let go of this caller's socket (nothing
   * answers there, or something other than a stopping service does), false if it still holds it at the deadline.
   */
  readonly serviceGone?: () => Promise<boolean>;
}

/** How long a stopped service may take to let go (its HTTP and management drains are 5 s each). */
const STOP_WAIT_MS = 15_000;

/** The default serviceGone: watches this caller's socket until the stopping service no longer holds it. */
function socketReleased(env: Env): () => Promise<boolean> {
  return async () => {
    const { socketPath } = serviceDirs(env);
    const deadline = Date.now() + STOP_WAIT_MS;
    for (;;) {
      try {
        (await connectService(socketPath)).close();
        return true; /* a service that admits a hello is not stopping */
      } catch (error) {
        const stopping = error instanceof ServiceCallError && error.error.code === "service_stopping";
        if (!stopping && error instanceof ServiceUnavailableError && /cannot reach/.test(error.message)) return true;
        // A connection the stopping service reset, or its service_stopping: it still holds the socket.
      }
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
}

const ASK =
  'Ask the person once, in one sentence, for example "Shall I open Archer to your other devices on this network (HTTPS with a local certificate you trust once on the phone)?", then call setup_network_access again with personConfirmed: true.';

/** Environment variables that override the settings file: with one set, the change would not take effect. */
const OVERRIDES = ["ARCHER_HOST", "ARCHER_FORCE_HTTP", "ARCHER_TLS_CERT", "ARCHER_TLS_KEY"] as const;

/** Virtual and tunnel interfaces a phone on the same Wi-Fi cannot reach. */
const VIRTUAL =
  /^(?:docker|br-|veth|virbr|vmnet|vboxnet|lxc|lxd|cni|flannel|cali|podman|tun|tap|utun|awdl|llw|bridge|zt)/i;

/** This machine's address on the local network: a private IPv4 on a real interface, else any non-internal IPv4. */
export function detectLanHost(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string | undefined {
  const candidates: { name: string; address: string }[] = [];
  for (const [name, entries] of Object.entries(interfaces))
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4" || /^169\.254\./.test(entry.address) || loopbackBind(entry.address))
        continue;
      candidates.push({ name, address: entry.address });
    }
  const privateRange = (a: string) => /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(a);
  return (
    candidates.find((c) => !VIRTUAL.test(c.name) && privateRange(c.address)) ??
    candidates.find((c) => !VIRTUAL.test(c.name)) ??
    candidates[0]
  )?.address;
}

const SERVICE_HEADER = /^\s*\[\s*service\s*\]\s*(?:#.*)?$/;
const TABLE_HEADER = /^\s*\[/;

/** The four transport settings setup_network_access owns: a value to write, or null to remove the key. */
export interface ServiceTransportSettings {
  readonly host: string;
  readonly forceHttp: false | null;
  readonly tlsCert: string | null;
  readonly tlsKey: string | null;
}

/**
 * `text` with the `[service]` table's `host`, `force_http`, `tls_cert` and `tls_key` set (or removed) as
 * `values` says, everything else (other keys, tables, comments, blank lines) left as it was. A key already in
 * the table is replaced on its line or removed; a missing one is added after the table's last key; a missing
 * table is appended. Refuses (throws) when the result would not read back as exactly those values with every
 * other setting unchanged.
 */
export function mergeServiceSettings(text: string, values: ServiceTransportSettings): string {
  const literal = (value: string | false | null) =>
    value === null ? null : value === false ? "false" : JSON.stringify(value);
  const entries: [string, string | null][] = [
    ["host", literal(values.host)],
    ["force_http", literal(values.forceHttp)],
    ["tls_cert", literal(values.tlsCert)],
    ["tls_key", literal(values.tlsKey)],
  ];
  const written = entries.filter((entry): entry is [string, string] => entry[1] !== null);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text === "" ? [] : text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const headers = lines.flatMap((line, at) => (SERVICE_HEADER.test(line) ? [at] : []));
  let merged: string[];
  if (headers.length === 0) {
    const lead = lines.length === 0 ? ["version = 1"] : [];
    merged = [
      ...lead,
      ...lines,
      ...(lines.length === 0 ? [""] : lines[lines.length - 1]!.trim() === "" ? [] : [""]),
      "[service]",
      ...written.map(([k, v]) => `${k} = ${v}`),
    ];
  } else {
    const start = headers[0]!;
    let end = lines.findIndex((line, at) => at > start && TABLE_HEADER.test(line));
    if (end < 0) end = lines.length;
    const table = lines.slice(start + 1, end);
    const pending = new Map(entries);
    const keyOf = (line: string) => /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1];
    const replaced = table.flatMap((line) => {
      const key = keyOf(line);
      if (key === undefined || !pending.has(key)) return [line];
      const value = pending.get(key)!;
      pending.delete(key);
      return value === null ? [] : [`${key} = ${value}`];
    });
    let lastKey = -1;
    replaced.forEach((line, at) => {
      if (keyOf(line) !== undefined) lastKey = at;
    });
    replaced.splice(lastKey + 1, 0, ...[...pending].filter(([, v]) => v !== null).map(([k, v]) => `${k} = ${v}`));
    merged = [...lines.slice(0, start + 1), ...replaced, ...lines.slice(end)];
  }
  const result = `${merged.join(newline)}${newline}`;
  // Read back as the service will: the four values, and every other setting as it was.
  const before = text === "" ? undefined : parseGlobalConfig(text);
  const after = parseGlobalConfig(result);
  const service = after.service;
  const expected = (value: string | false | null) => (value === null ? undefined : value);
  if (
    service?.host !== values.host ||
    service.forceHttp !== expected(values.forceHttp) ||
    service.tlsCert !== expected(values.tlsCert) ||
    service.tlsKey !== expected(values.tlsKey)
  )
    throw new Error("the merged settings do not read back as written");
  const rest = (config: ReturnType<typeof parseGlobalConfig> | undefined) => {
    const { host: _h, forceHttp: _f, tlsCert: _c, tlsKey: _k, ...others } = config?.service ?? {};
    const { service: _s, ...top } = config ?? {};
    return JSON.stringify([top, others]);
  };
  if (before !== undefined && rest(before) !== rest(after)) throw new Error("the merge would change other settings");
  return result;
}

/** Per-OS steps to install openssl, the one thing setup needs that Archer does not ship. */
function opensslInstall(platform: NodeJS.Platform): string {
  if (platform === "darwin")
    return "macOS: `brew install openssl` (Homebrew), or use the system's LibreSSL `openssl` if present";
  if (platform === "win32") return "Windows: `winget install ShiningLight.OpenSSL.Light`, then open a new terminal";
  return "Debian/Ubuntu: `sudo apt install openssl`; Fedora/RHEL: `sudo dnf install openssl`; Arch: `sudo pacman -S openssl`; Alpine: `sudo apk add openssl`";
}

const opensslRuns = (): boolean => spawnSync("openssl", ["version"], { stdio: "ignore", timeout: 10_000 }).status === 0;

/** The one step only the person can do: trust the public CA on the device, by OS (docs/tls.md, shortened). */
export const TRUST_STEPS = {
  iphone:
    "iPhone/iPad: open the file, allow the profile, install it in Settings → General → VPN & Device Management, then turn it on in Settings → General → About → Certificate Trust Settings.",
  android: 'Android: Settings → search "CA certificate" → install it as a CA certificate (Chrome trusts it).',
  macos: "macOS: double-click it, then in Keychain Access set Trust → Always Trust.",
  windows: "Windows: certmgr.msc → Trusted Root Certification Authorities → Import (current user).",
  linux:
    'Linux desktop: Chrome `certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n archer-ca -i ca-cert.pem`; Firefox Settings → Certificates → Import.',
  docs: "~/.local/share/archer/current/dist/docs/tls.md",
} as const;

/** The person's answer to a question the client puts to them itself (MCP elicitation); "unsupported" when it cannot. */
export type AskPerson = (question: string) => Promise<"yes" | "no" | "unsupported">;

/** The address to bind: the IP itself, or the first non-loopback IPv4 a name resolves to. */
async function bindAddressOf(
  host: string,
  resolveName: (name: string) => Promise<readonly string[]>,
): Promise<string | undefined> {
  if (isIP(host) !== 0) return host;
  try {
    return (await resolveName(host)).find(
      (address) => isIP(address) === 4 && !loopbackBind(address) && !/^169\.254\./.test(address),
    );
  } catch {
    return undefined;
  }
}

const resolveIPv4 = async (name: string): Promise<readonly string[]> =>
  (await lookup(name, { family: 4, all: true })).map((entry) => entry.address);

export async function setupNetworkAccess(
  args: Readonly<Record<string, unknown>>,
  access: NetworkAccess,
): Promise<OperationResult> {
  const made: { directory?: string } = {};
  try {
    return await configureNetworkAccess(args, access, made);
  } catch (error) {
    // A certificate this call made and no record names is never used again: a later call makes a new one
    // (O37: a refused first try left a CA key behind).
    if (
      made.directory !== undefined &&
      readNetworkAccessRecord(serviceDirs(access.env).stateDir)?.tlsDirectory !== made.directory
    )
      rmSync(made.directory, { recursive: true, force: true });
    throw error;
  }
}

async function configureNetworkAccess(
  args: Readonly<Record<string, unknown>>,
  access: NetworkAccess,
  made: { directory?: string },
): Promise<OperationResult> {
  const enable = args["enabled"] !== false;
  const env = access.env;
  const overridden = OVERRIDES.filter((name) => env[name] !== undefined && env[name] !== "");
  if (overridden.length > 0)
    throw toolError(
      "network_setup_blocked",
      `setup_network_access did nothing: this session's environment sets ${overridden.join(", ")}, which override${overridden.length === 1 ? "s" : ""} Archer's settings file. Remove ${overridden.length === 1 ? "it" : "them"} from the environment Archer runs in (the MCP server's env in the agent's config, or the shell), restart the session, and call setup_network_access again.`,
      {
        fix: {
          text: `unset ${overridden.join(", ")} where the Archer MCP server or CLI is started, then call setup_network_access again`,
          needsPersonYes: false,
        },
        variables: overridden,
      },
    );
  const resolved = resolveServiceConfiguration({ projectRoot: "/", ...loadGlobalConfiguration(env), env });
  if (resolved.serviceName !== "default")
    throw toolError(
      "network_setup_blocked",
      `setup_network_access sets up the default Archer service, and this session uses the named service '${resolved.serviceName}'. Nothing was changed. Run \`archer tls setup --host <name>\` and add its block to that service's [[services]] table.`,
      {
        fix: {
          text: "run archer tls setup for the named service",
          command: "archer tls setup --host <name>",
          needsPersonYes: false,
        },
      },
    );
  const stateDir = serviceDirs(env).stateDir;
  const previous = readNetworkAccessRecord(stateDir);

  let host = "127.0.0.1",
    bind = "127.0.0.1";
  if (enable) {
    const given = typeof args["host"] === "string" && args["host"] !== "" ? String(args["host"]) : undefined;
    const chosen = given ?? detectLanHost(access.interfaces?.() ?? networkInterfaces());
    if (chosen === undefined)
      throw toolError(
        "network_host_unknown",
        "setup_network_access could not find this machine's address on the local network. Nothing was changed. Ask the person which name or IP their phone uses for this computer, then call again with host.",
        {
          fix: {
            text: "ask the person for this computer's name or IP on their network, then call setup_network_access with host",
            tool: "setup_network_access",
            arguments: { host: "<name or IP>" },
            needsPersonYes: true,
          },
        },
      );
    if (
      loopbackBind(chosen) ||
      chosen === "0.0.0.0" ||
      chosen === "::" ||
      (isIP(chosen) === 0 && !/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(chosen))
    )
      throw toolError(
        "invalid_arguments",
        `host ${JSON.stringify(chosen.slice(0, 100))} is not an address another device uses: give this computer's LAN IP or name (not localhost, 127.x or 0.0.0.0). Nothing was changed.`,
      );
    const address = await bindAddressOf(chosen, access.resolveName ?? resolveIPv4);
    // Only an address of one of this machine's own interfaces: never a wildcard (0.0.0.0, :: in any spelling).
    const own = new Set(
      Object.values(access.interfaces?.() ?? networkInterfaces())
        .flat()
        .filter((entry) => entry !== undefined && !entry.internal)
        .map((entry) => entry!.address.toLowerCase()),
    );
    if (address === undefined || loopbackBind(address) || !own.has(address.toLowerCase()))
      throw toolError(
        "network_host_unknown",
        `setup_network_access could not find an address of this computer for ${JSON.stringify(chosen.slice(0, 100))} that another device reaches. Nothing was changed. Ask the person for this computer's LAN IP and call again with host.`,
        {
          fix: {
            text: "ask the person for this computer's LAN IP, then call setup_network_access with host",
            tool: "setup_network_access",
            arguments: { host: "<LAN IP>" },
            needsPersonYes: true,
          },
        },
      );
    host = chosen;
    bind = address;
    // The person's own yes, where the client can ask them (MCP elicitation): the agent cannot fake it.
    // Elsewhere the client's approval of this tool call is the safeguard, and personConfirmed the agent's word.
    const answer = await (access.askPerson ?? (async () => "unsupported" as const))(
      `Open Archer to other devices on your network at https://${host}? Anyone on that network can then reach its sign-in page; links and pairing codes are still needed to see anything.`,
    );
    if (answer === "no")
      throw toolError(
        "person_declined",
        "The person did not confirm opening Archer to their network: they declined Archer's question, or this client could not show it (a headless run cannot). Nothing was changed. Tell the person it is not turned on; if they still want it, they can run  archer network-access  in a terminal, which asks them there. Do not retry it yourself.",
        {
          fix: {
            text: "tell the person it is not on; they can run archer network-access in a terminal, which asks them",
            command: "archer network-access",
            needsPersonYes: true,
          },
        },
      );
    if (answer === "unsupported" && args["personConfirmed"] !== true)
      throw toolError(
        "person_confirmation_needed",
        `setup_network_access makes Archer reachable from other devices on the network, which needs the person's yes. Nothing was changed. ${ASK}`,
        {
          fix: { text: ASK, tool: "setup_network_access", arguments: { personConfirmed: true }, needsPersonYes: true },
        },
      );
    if (!(access.openssl ?? opensslRuns)() && !reusable(previous, host, bind))
      throw toolError(
        "openssl_missing",
        `setup_network_access needs openssl to make the certificate, and it is not installed. Nothing was changed. Install it (${opensslInstall(access.platform ?? process.platform)}), then call setup_network_access again.`,
        {
          fix: {
            text: `install openssl (${opensslInstall(access.platform ?? process.platform)}), then call setup_network_access again`,
            needsPersonYes: true,
          },
        },
      );
  }

  // The settings file, as the service reads it (a trusted regular file, or none yet).
  const configPath = loadGlobalConfiguration(env).paths.user;
  const required = env["ARCHER_CONFIG"] !== undefined && env["ARCHER_CONFIG"] !== "";
  const readSettings = () => readGlobalConfigSnapshot(configPath, { principal: "user", required }).source;
  const before = readSettings();
  assertPrivateParent(configPath);
  ensurePrivateDir(stateDir);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");

  // The certificate: the one made last time when it still fits this host and has a month left (the
  // person trusted its CA already), else a new one.
  let tls: Omit<NetworkAccessRecord, "enabled" | "host" | "bind" | "since"> | undefined;
  if (enable) {
    if (reusable(previous, host, bind)) tls = previous!;
    else {
      made.directory = join(stateDir, `tls-${stamp}-${randomBytes(3).toString("hex")}`);
      const fresh = await setupLocalTls({ directory: made.directory, host, addresses: bind === host ? [] : [bind] });
      tls = {
        tlsDirectory: fresh.directory,
        tlsCert: fresh.tlsCert,
        tlsKey: fresh.tlsKey,
        caCert: fresh.caCert,
        caFingerprint256: fresh.caFingerprint256,
        certificateExpiresAt: fresh.expiresAt,
      };
    }
  }
  const settings: ServiceTransportSettings = enable
    ? { host: bind, forceHttp: false, tlsCert: tls!.tlsCert, tlsKey: tls!.tlsKey }
    : { host: "127.0.0.1", forceHttp: null, tlsCert: null, tlsKey: null };
  let next: string;
  try {
    next = mergeServiceSettings(before, settings);
  } catch (error) {
    throw toolError(
      "network_setup_blocked",
      `setup_network_access could not change ${configPath} safely (${(error as Error).message}). The file is unchanged.${enable ? ` The certificate is in ${tls!.tlsDirectory}. The person adds these to its [service] table: host = ${JSON.stringify(bind)}, force_http = false, tls_cert = ${JSON.stringify(tls!.tlsCert)}, tls_key = ${JSON.stringify(tls!.tlsKey)}.` : ' The person sets host = "127.0.0.1" in its [service] table and removes tls_cert and tls_key.'}`,
      { fix: { text: "the person makes the printed change to the [service] table", needsPersonYes: true } },
    );
  }
  // What the service will actually use: a [[services]] entry named "default" overrides [service].
  const system = loadGlobalConfiguration(env).system;
  const effective = resolveServiceConfiguration({
    projectRoot: "/",
    ...(system === undefined ? {} : { system }),
    user: parseGlobalConfig(next),
    env: {},
  }).settings;
  if (
    effective.host !== settings.host ||
    (effective.tlsCert ?? null) !== settings.tlsCert ||
    (effective.tlsKey ?? null) !== settings.tlsKey ||
    effective.forceHttp === true
  )
    throw toolError(
      "network_setup_blocked",
      `setup_network_access did not change ${configPath}: another table (a [[services]] entry named "default", or the system settings in /etc/archer) overrides the [service] settings it would write. The person removes host, force_http, tls_cert and tls_key there, then the agent calls setup_network_access again.`,
      {
        fix: {
          text: "the person removes the overriding keys from the [[services]] entry named default",
          needsPersonYes: true,
        },
      },
    );
  const certificate = enable
    ? {
        tlsDirectory: tls!.tlsDirectory,
        tlsCert: tls!.tlsCert,
        tlsKey: tls!.tlsKey,
        caCert: tls!.caCert,
        caFingerprint256: tls!.caFingerprint256,
        certificateExpiresAt: tls!.certificateExpiresAt,
      }
    : undefined;
  const record: NetworkAccessRecord | null = enable
    ? {
        enabled: true,
        host,
        bind,
        since: previous?.enabled === true && previous.bind === bind ? previous.since : new Date().toISOString(),
        ...certificate!,
      }
    : previous === null
      ? null
      : { ...previous, enabled: false, since: new Date().toISOString() };
  const recordPath = join(stateDir, NETWORK_ACCESS_FILE);
  const recordText = record === null ? undefined : `${JSON.stringify(record, null, 2)}\n`;
  const current = resolveServiceConfiguration({ projectRoot: "/", ...loadGlobalConfiguration(env), env }).settings;
  if (current.publicUrl !== undefined)
    throw toolError(
      "network_setup_blocked",
      `setup_network_access did nothing: ${configPath} sets public_url (${current.publicUrl}), which names the page's address itself. The person removes public_url from its [service] table, then the agent calls setup_network_access again.`,
      { fix: { text: "the person removes public_url from the [service] table", needsPersonYes: true } },
    );

  // One setup at a time for this settings file: preflight, the file, the record and the restart are one
  // change, released whatever happens.
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const release = takeLock(`${configPath}.network-access.lock`);
  try {
    // The running service must be one these settings started, in this state folder, or a restart would not bring it back the same.
    const running = await access.acquire(false);
    if (running !== null) {
      const differs = (why: string) =>
        toolError(
          "network_setup_blocked",
          `setup_network_access did nothing: the running Archer ${why}, so it was not started from its settings file as it is now and a restart would not bring it back the same. Stop it (stop_service), start it again (start_service), then call setup_network_access again.`,
          {
            fix: {
              text: "stop_service, then start_service, then call setup_network_access again",
              tool: "stop_service",
              needsPersonYes: false,
            },
          },
        );
      const ran = (await running.call("restartConfiguration", {})) as unknown as StartedAs;
      const why = startedDifferently(ran, {
        stateDir,
        host: current.host,
        port: current.port,
        restore: current.restore,
        transport:
          current.tlsCert !== undefined && current.tlsKey !== undefined
            ? { scheme: "https", tlsCert: current.tlsCert, tlsKey: current.tlsKey }
            : { scheme: "http", forceHttp: current.forceHttp === true },
      });
      if (why !== null) throw differs(why);
    }
    // The record as it is now, under the lock (another setup may have finished since it was first read).
    const recordBefore = readNetworkAccessText(stateDir);
    const backup =
      before === "" ? undefined : `${configPath}.before-network-${stamp}-${randomBytes(3).toString("hex")}`;
    // The person's file as it was, private and created new: an existing name (a planted link too) is refused.
    if (backup !== undefined) writeFileSync(backup, before, { flag: "wx", mode: 0o600 });
    // Changed while the certificate was made (by the person or another writer): their change wins.
    if (readSettings() !== before)
      throw toolError(
        "network_setup_blocked",
        `${configPath} changed while setup_network_access was working, so it was left as it is now. Call setup_network_access again.`,
        { fix: { text: "call setup_network_access again", tool: "setup_network_access", needsPersonYes: false } },
      );

    // Onto the new bind: stop the running service, then start one from the new settings, and check that
    // the one answering is it: this state folder, this address exactly, this transport.
    const expectedTransport: Transport = enable
      ? { scheme: "https", tlsCert: tls!.tlsCert, tlsKey: tls!.tlsKey }
      : { scheme: "http", forceHttp: false };
    const serviceGone = access.serviceGone ?? socketReleased(env);
    const previousTransport: Transport =
      current.tlsCert !== undefined && current.tlsKey !== undefined
        ? { scheme: "https", tlsCert: current.tlsCert, tlsKey: current.tlsKey }
        : { scheme: "http", forceHttp: current.forceHttp === true };
    /** Stops what runs, waits until it has let go, starts one from the settings file and checks it is as `want` says. */
    const restart = async (want: { host: string; transport: Transport }): Promise<ServiceClient> => {
      const old = await access.acquire(false);
      if (old !== null) {
        // The stopping service may reset this connection before its answer is read (PD-3): that is a stop too.
        // Either way it must be gone before another starts, which is checked next.
        try {
          await old.call("stop", {});
        } catch (error) {
          if (!(error instanceof ServiceCallError) && !(error instanceof ServiceUnavailableError)) throw error;
        }
        access.disconnect();
        if (!(await serviceGone())) throw new Error(`the running Archer did not stop within ${STOP_WAIT_MS / 1000} s`);
      } else access.disconnect();
      const client = await access.acquire(true, true);
      if (client === null) throw new Error("the Archer service did not start");
      const why = await differs(client, want);
      if (why !== null) throw new Error(`the Archer that answered ${why}`);
      return client;
    };
    /** Why the service on `client` was not started as `want` says, or null. */
    const differs = async (
      client: ServiceClient,
      want: { host: string; transport: Transport },
    ): Promise<string | null> => {
      let started: StartedAs;
      try {
        started = (await client.call("restartConfiguration", {})) as unknown as StartedAs;
      } catch {
        return "cannot say how it was started";
      }
      return startedDifferently(started, {
        stateDir,
        host: want.host,
        port: current.port,
        restore: current.restore,
        transport: want.transport,
      });
    };
    let client: ServiceClient;
    // Publishing the settings and the record is part of what is rolled back.
    try {
      writeAtomically(configPath, next);
      if (recordText !== undefined) writeAtomically(recordPath, recordText);
      client = await restart({ host: settings.host, transport: expectedTransport });
    } catch (error) {
      // Put back only what this call wrote: a later change by someone else stays.
      let restored = false,
        recordBack = true;
      try {
        if (readSettings() === next) {
          writeAtomically(configPath, before === "" ? undefined : before);
          restored = true;
        }
      } catch {
        /* reported below */
      }
      if (recordText !== undefined) {
        try {
          if (readNetworkAccessText(stateDir) === recordText) writeAtomically(recordPath, recordBefore);
          else recordBack = false;
        } catch {
          recordBack = false;
        }
      }
      access.disconnect();
      // Back as the restored settings say (PD-2): a service of ours that does not run them (the replacement
      // started with the new ones, then a check failed) is stopped and started again; none running is started.
      let again = "";
      try {
        const running = await access.acquire(false);
        const ours =
          running === null
            ? null
            : await running.call("restartConfiguration", {}).then(
                (ran) => (ran as unknown as StartedAs).stateDir === stateDir,
                () => false,
              );
        if (running === null) {
          if ((await access.acquire(true, true)) === null)
            again = " Archer could not be started again: run start_service.";
        } else if (
          restored &&
          ours &&
          (await differs(running, { host: current.host, transport: previousTransport })) !== null
        )
          await restart({ host: current.host, transport: previousTransport });
      } catch (startError) {
        again = ` Archer could not be started again with the previous settings (${startError instanceof Error ? startError.message.split("\n")[0] : String(startError)}): run stop_service, then start_service.`;
      }
      const refused = accessStartFailure("setup_network_access", error);
      throw toolError(
        refused === null ? "io_failure" : (refused.data["code"] as "tls_invalid"),
        `setup_network_access changed the settings but Archer would not start with them; ${restored ? "the previous settings were put back" : "the file had changed again, so it was left as it is"}${backup === undefined ? "" : ` (${backup} keeps the old one)`}${recordBack ? "" : `; ${recordPath} was left as it is`}.${again} Cause: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!enable) {
      const status = await client.call("hello", { protocolVersion: PROTOCOL_VERSION });
      return {
        text: `${linkText("Network access is off: Archer serves only this computer again, the certificates kept for next time. Pages opened at the network address must be opened again here", status.homeUrl)}`,
        structured: { enabled: false, url: status.homeUrl, configPath, ...(backup === undefined ? {} : { backup }) },
      };
    }
    let issued;
    try {
      issued = await client.call("issuePairingCode", {});
    } catch (error) {
      if (error instanceof ServiceCallError)
        throw serviceError(error.error.code, error.error.message, error.error.details ?? {});
      throw error;
    }
    const trust = `Copy ${tls!.caCert} (public, safe to send: AirDrop, email) to the device and trust it once; check its SHA-256 fingerprint is ${tls!.caFingerprint256}.`;
    const reused = tls === previous;
    // The certificate this one replaced is never reused (it no longer fits, or is about to expire): only setup's own folders here.
    const replaced = previous?.tlsDirectory;
    if (
      !reused &&
      replaced !== undefined &&
      replaced !== tls!.tlsDirectory &&
      dirname(replaced) === stateDir &&
      basename(replaced).startsWith("tls-")
    )
      rmSync(replaced, { recursive: true, force: true });
    const text = [
      `Archer now serves your network over HTTPS at ${issued.url}, on ${bind} only (settings in ${configPath}${backup === undefined ? "" : `; the old file is kept as ${backup}`}). The page says so, with how to turn it off (setup_network_access with enabled: false, or archer network-access off). Pages opened before must be opened again at the new address.`,
      pairingText(issued),
      reused
        ? "The device already trusts this certificate if it trusted it before (it is the same one)."
        : `The one step only the person can do, on the device: ${trust}`,
      ...(reused ? [] : [`${TRUST_STEPS.iphone}\n${TRUST_STEPS.android}\nOther systems: ${TRUST_STEPS.docs}`]),
    ].join("\n");
    return {
      text,
      structured: {
        enabled: true,
        host,
        bind,
        url: issued.url,
        code: issued.code,
        minutes: issued.minutes,
        expiresAt: issued.expiresAt,
        configPath,
        ...(backup === undefined ? {} : { backup }),
        tlsDirectory: tls!.tlsDirectory,
        caCert: tls!.caCert,
        caFingerprint256: tls!.caFingerprint256,
        certificateExpiresAt: tls!.certificateExpiresAt,
        certificateReused: reused,
        trust: TRUST_STEPS,
      },
    };
  } finally {
    release();
  }
}

type Transport =
  | { readonly scheme: "https"; readonly tlsCert: string; readonly tlsKey: string }
  | { readonly scheme: "http"; readonly forceHttp: boolean };
/** What a service says about how it was started (its restartConfiguration). */
interface StartedAs {
  readonly stateDir?: unknown;
  readonly host?: unknown;
  readonly port?: unknown;
  readonly restoreState?: unknown;
  readonly transport?: {
    readonly scheme?: unknown;
    readonly forceHttp?: unknown;
    readonly tlsCert?: unknown;
    readonly tlsKey?: unknown;
  };
}

/** Why a service was not started as `want` says (null when it was): state folder, exact address, port, restore, transport. */
function startedDifferently(
  ran: StartedAs,
  want: { stateDir: string; host: string; port: number | undefined; restore: boolean; transport: Transport },
): string | null {
  if (
    typeof ran.stateDir !== "string" ||
    typeof ran.host !== "string" ||
    typeof ran.transport !== "object" ||
    ran.transport === null
  )
    return "cannot say how it was started";
  if (ran.stateDir !== want.stateDir) return `keeps its state in ${ran.stateDir}, not ${want.stateDir} (another copy)`;
  if (ran.host !== want.host) return `listens on ${ran.host}, not ${want.host}`;
  if (want.port !== undefined && ran.port !== want.port) return `uses port ${String(ran.port)}, not ${want.port}`;
  if (typeof ran.restoreState === "boolean" && ran.restoreState !== want.restore)
    return "restores its state differently";
  const t = ran.transport,
    w = want.transport;
  if (
    t.scheme !== w.scheme ||
    (w.scheme === "https" ? t.tlsCert !== w.tlsCert || t.tlsKey !== w.tlsKey : t.forceHttp !== w.forceHttp)
  )
    return `serves ${String(t.scheme)}${w.scheme === "https" ? " with other certificates" : ""}, not what its settings say`;
  return null;
}

/** The last certificate still fits: the same host and address, its files there, and at least 30 days left. */
function reusable(previous: NetworkAccessRecord | null, host: string, bind: string): boolean {
  if (previous === null || previous.host !== host || previous.bind !== bind) return false;
  try {
    prepareTransport({ tlsCert: previous.tlsCert, tlsKey: previous.tlsKey }, bind);
    // The certificate's own dates and the CA's fingerprint, not what the record says.
    const leaf = new X509Certificate(readPemFile(previous.tlsCert, "certificate"));
    const ca = new X509Certificate(readPemFile(previous.caCert, "CA certificate"));
    const month = Date.now() + 30 * 86_400_000;
    return (
      Date.parse(leaf.validTo) >= month &&
      Date.parse(ca.validTo) >= month &&
      Date.parse(ca.validFrom) <= Date.now() &&
      Date.parse(leaf.validFrom) <= Date.now() &&
      ca.fingerprint256 === previous.caFingerprint256 &&
      leaf.verify(ca.publicKey)
    );
  } catch {
    return false;
  }
}

/**
 * An exclusive lock file holding this process's pid and a random owner token. A lock whose process is
 * gone is a crashed setup's and is taken over; release removes it only while it is still ours.
 */
function takeLock(path: string): () => void {
  const token = `${process.pid} ${randomBytes(8).toString("hex")}\n`;
  // Published whole: the token is written to a private file first, then linked into place (fails if taken).
  const mine = `${path}.${randomBytes(6).toString("hex")}`;
  const fd = openSync(mine, "wx", 0o600);
  try {
    writeSync(fd, token);
  } finally {
    closeSync(fd);
  }
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(mine, path);
        let held = true;
        return () => {
          if (held) {
            held = false;
            if (readSmall(path) === token) {
              try {
                unlinkSync(path);
              } catch {
                /* gone */
              }
            }
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const seen = readSmall(path);
        const pid = Number(seen?.split(" ")[0]);
        let alive = seen === undefined ? false : Number.isInteger(pid) && pid > 0;
        if (alive) {
          try {
            process.kill(pid, 0);
          } catch (probe) {
            alive = (probe as NodeJS.ErrnoException).code === "EPERM";
          }
        }
        if (alive || attempt > 0)
          throw toolError(
            "network_setup_blocked",
            "Another setup_network_access is running. Nothing was changed. Wait for it to finish, then call again.",
            { fix: { text: "wait, then call setup_network_access again", needsPersonYes: false } },
          );
        // Take a dead owner's lock aside atomically; if what was taken aside is not that lock (another
        // caller got there first and made a new one), put it back.
        const aside = `${path}.stale-${randomBytes(6).toString("hex")}`;
        try {
          renameSync(path, aside);
        } catch {
          continue;
        }
        if (readSmall(aside) !== seen) {
          try {
            linkSync(aside, path);
          } catch {
            /* theirs is in place again or gone */
          }
        }
        try {
          unlinkSync(aside);
        } catch {
          /* gone */
        }
      }
    }
    throw toolError("network_setup_blocked", "setup_network_access could not take its lock. Nothing was changed.");
  } finally {
    try {
      unlinkSync(mine);
    } catch {
      /* gone */
    }
  }
}

/** A small file's text, read without following links or blocking; undefined when it is not one. */
function readSmall(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    if (!fstatSync(fd).isFile()) return undefined;
    const buffer = Buffer.alloc(256);
    const count = readSync(fd, buffer, 0, buffer.length, null);
    return buffer.subarray(0, count).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The settings file's folder is the person's own and nobody else can write in it (no planted backups or swaps). */
function assertPrivateParent(path: string): void {
  let stat;
  try {
    stat = lstatSync(dirname(path));
  } catch {
    return; /* made private below */
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o022) !== 0 ||
    (process.getuid !== undefined && stat.uid !== process.getuid())
  )
    throw toolError(
      "network_setup_blocked",
      `setup_network_access did nothing: the folder of ${path} is not the person's own or others can write in it. The person runs  chmod go-w ${dirname(path)}  then the agent calls setup_network_access again.`,
      {
        fix: {
          text: `the person runs chmod go-w ${dirname(path)}`,
          command: `chmod go-w ${dirname(path)}`,
          needsPersonYes: true,
        },
      },
    );
}

/** Replace `path` with `text` (or remove it for undefined) through a private temporary file and a rename. */
function writeAtomically(path: string, text: string | undefined): void {
  if (text === undefined) {
    try {
      unlinkSync(path);
    } catch {
      /* absent */
    }
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let mode = 0o600;
  try {
    const stat = lstatSync(path);
    if (stat.isFile()) mode = stat.mode & 0o644;
  } catch {
    /* new file */
  }
  const temporary = `${path}.tmp-${process.pid}`;
  const fd = openSync(temporary, "wx", mode);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}
