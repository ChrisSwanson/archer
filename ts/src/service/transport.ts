// Trusted service transport settings. Project manifests cannot enable HTTP.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isIP } from "node:net";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { createSecureContext, type SecureContextOptions } from "node:tls";
import { PersistenceError } from "../state/account.ts";
import { accessRefusalText } from "./access-fix.ts";

export const MAX_TLS_PEM_BYTES = 1024 * 1024;
export interface TransportOptions {
  readonly forceHttp?: boolean;
  readonly tlsCert?: string;
  readonly tlsKey?: string;
}
export type PreparedTransport =
  /** `automatic`: no setting asked for HTTP; the bind is loopback, so no other device can reach it. */
  | { readonly scheme: "http"; readonly automatic?: true }
  | { readonly scheme: "https"; readonly tls: SecureContextOptions; readonly certificateHost?: string };

/** Every transport refusal is the agent's to fix through setup_network_access (access-fix.ts). */
function invalid(message: string): never {
  throw new PersistenceError("tls_invalid", accessRefusalText("tls_invalid", message));
}

/** Fixed-depth validation and bounded descriptor reads, including special files. */
export function prepareTransport(options: TransportOptions, host: string): PreparedTransport {
  if (options.forceHttp !== undefined && typeof options.forceHttp !== "boolean")
    return invalid("force_http must be true or false");
  if (options.forceHttp === true) {
    if (options.tlsCert !== undefined || options.tlsKey !== undefined)
      return invalid("force_http cannot be combined with TLS certificate/key settings");
    return { scheme: "http" };
  }
  if (options.tlsCert === undefined && options.tlsKey === undefined && loopbackBind(host))
    return { scheme: "http", automatic: true };
  if (options.tlsCert === undefined || options.tlsKey === undefined)
    throw new PersistenceError(
      "tls_required",
      accessRefusalText(
        "tls_required",
        `Archer is set to listen on ${host}, which other devices can reach, and serves that only over HTTPS: no tls_cert and tls_key are configured.`,
      ),
    );

  const cert = readPem(options.tlsCert, "certificate");
  const key = readPem(options.tlsKey, "private key");
  try {
    const leaf = new X509Certificate(cert);
    const now = Date.now();
    if (Date.parse(leaf.validFrom) > now || Date.parse(leaf.validTo) <= now)
      return invalid("TLS certificate is expired or not yet valid");
    if (!leaf.checkPrivateKey(createPrivateKey(key))) return invalid("TLS certificate and private key do not match");
    // A wildcard bind advertises `certificateHost` (or, failing that, is checked
    // against the LAN address by the service caller). A bind address is never a certificate name.
    if (host !== "0.0.0.0" && host !== "::") {
      const match = isIP(host) !== 0 ? leaf.checkIP(host) : leaf.checkHost(host);
      if (match === undefined) return invalid("TLS certificate does not cover the configured host");
    }
    const tls: SecureContextOptions = { cert, key, minVersion: "TLSv1.2" };
    createSecureContext(tls);
    const named = certificateHost(leaf);
    return named === undefined ? { scheme: "https", tls } : { scheme: "https", tls, certificateHost: named };
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    return invalid("TLS certificate/private key cannot establish a valid TLS context");
  }
}

/**
 * A bind no other device can reach: 127.0.0.0/8, ::1 in its spellings, IPv4-mapped 127/8, or
 * `localhost` exactly (the service also checks the address it actually bound: see service.ts).
 * Wildcards, LAN addresses and every other name (even one that resolves to loopback) are not.
 */
export function loopbackBind(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare === "localhost") return true;
  if (isIP(bare) === 4) return /^127\./.test(bare);
  if (isIP(bare) !== 6) return false;
  const v6 = bare.toLowerCase();
  return (
    (/^(?:0{0,4}:){0,7}:?0{0,4}:?0*1$/.test(v6) && expandsToLoopback(v6)) ||
    /^(?:0{0,4}:){0,5}:?ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v6)
  );
}
/** ::1 written any way: seven zero groups, then 1. */
function expandsToLoopback(v6: string): boolean {
  const [head = "", tail] = v6.split("::");
  const parts =
    tail === undefined
      ? head.split(":")
      : [
          ...(head === "" ? [] : head.split(":")),
          ...Array(8 - (head === "" ? 0 : head.split(":").length) - (tail === "" ? 0 : tail.split(":").length)).fill(
            "0",
          ),
          ...(tail === "" ? [] : tail.split(":")),
        ];
  return parts.length === 8 && parts.slice(0, 7).every((p) => /^0{1,4}$/.test(p)) && /^0{0,3}1$/.test(parts[7] ?? "");
}
/** localhost, 127.0.0.0/8 and ::1 in its spellings (also IPv4-mapped): names no other device can use. */
const loopback = (name: string): boolean =>
  name === "localhost" ||
  name.endsWith(".localhost") ||
  /^(?:::ffff:)?127\./.test(name) ||
  name === "::1" ||
  /^(?:0+:){7}0*1$/.test(name);
/** The first concrete non-loopback name the certificate covers: the address a wildcard bind advertises. */
function certificateHost(leaf: X509Certificate): string | undefined {
  for (const entry of (leaf.subjectAltName ?? "").split(/,\s*/)) {
    const match = /^(DNS|IP Address):(.+)$/.exec(entry.trim());
    const name = match?.[2]?.toLowerCase();
    if (name === undefined || name.includes("*") || loopback(name)) continue;
    if (match?.[1] === "IP Address" ? isIP(name) === 0 : isIP(name) !== 0) continue;
    return name;
  }
  return undefined;
}

/** A PEM file read bounded and non-blocking, as the transport reads its own (for setup's certificate reuse). */
export function readPemFile(path: string, label: string): Buffer {
  return readPem(path, label);
}

function readPem(path: unknown, label: string): Buffer {
  if (typeof path !== "string" || path.length === 0 || path.length > 4096 || path.includes("\0") || !isAbsolute(path))
    return invalid(`TLS ${label} requires an absolute path`);
  let fd: number | undefined;
  try {
    // O_NONBLOCK prevents a configured FIFO from blocking startup before fstat.
    // Certificate symlinks are allowed for operator-managed renewal; validation
    // applies to the opened regular descriptor rather than an earlier pathname.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_TLS_PEM_BYTES)
      return invalid(`TLS ${label} must be a nonempty regular file of at most ${MAX_TLS_PEM_BYTES} bytes`);
    const buffer = Buffer.alloc(MAX_TLS_PEM_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const count = readSync(fd, buffer, total, buffer.length - total, null);
      if (count === 0) break;
      total += count;
    }
    if (total === 0 || total > MAX_TLS_PEM_BYTES) return invalid(`TLS ${label} exceeds the bounded PEM size`);
    return buffer.subarray(0, total);
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    return invalid(`TLS ${label} cannot be read`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
