// The network access setup_network_access turned on (or off): read by the service, for the page's
// notice and its log, and by the next setup, to reuse a certificate the person already trusts.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

/** What the service and the next setup read: the network access in force, and the certificate it uses. */
export interface NetworkAccessRecord {
  readonly enabled: boolean;
  readonly host: string;
  readonly bind: string;
  readonly since: string;
  readonly tlsDirectory: string;
  readonly tlsCert: string;
  readonly tlsKey: string;
  readonly caCert: string;
  readonly caFingerprint256: string;
  readonly certificateExpiresAt: string;
}

export const NETWORK_ACCESS_FILE = "network-access.json";

const MAX_RECORD_BYTES = 64 * 1024;

/**
 * The record, or null. Read as untrusted local state: a regular file of the current user, not a link
 * (O_NOFOLLOW), opened non-blocking (a FIFO cannot hang startup), bounded, with finite dates.
 */
export function readNetworkAccessRecord(stateDir: string): NetworkAccessRecord | null {
  const text = readNetworkAccessText(stateDir);
  if (text === undefined) return null;
  try {
    const value = JSON.parse(text) as Partial<NetworkAccessRecord>;
    const strings = [
      "host",
      "bind",
      "since",
      "tlsDirectory",
      "tlsCert",
      "tlsKey",
      "caCert",
      "caFingerprint256",
      "certificateExpiresAt",
    ] as const;
    if (
      typeof value.enabled !== "boolean" ||
      !strings.every((key) => typeof value[key] === "string" && value[key]!.length <= 4096)
    )
      return null;
    // The page shows `since`: a short, finite time, as the page itself accepts it.
    if (
      value.since!.length > 64 ||
      !Number.isFinite(Date.parse(value.since!)) ||
      !Number.isFinite(Date.parse(value.certificateExpiresAt!))
    )
      return null;
    return value as NetworkAccessRecord;
  } catch {
    return null;
  }
}

/** The record's bytes as text: a regular file of this user, not a link, non-blocking, bounded; else undefined. */
export function readNetworkAccessText(stateDir: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(
      join(stateDir, NETWORK_ACCESS_FILE),
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
    );
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > MAX_RECORD_BYTES ||
      (process.getuid !== undefined && stat.uid !== process.getuid())
    )
      return undefined;
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
    let total = 0;
    for (;;) {
      const count = readSync(fd, buffer, total, buffer.length - total, null);
      if (count === 0) break;
      total += count;
      if (total > MAX_RECORD_BYTES) return undefined;
    }
    return buffer.subarray(0, total).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
