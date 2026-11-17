// Browser credentials (the service token, grant secrets): 16 random bytes as 32 hex characters,
// in every data-plane URL. Those issued before 2026-10-22 have 32 bytes (64 hex) and stay valid
// (ADR 0014, amended). Compared without revealing where a guess first differs.
import { randomBytes, timingSafeEqual } from "node:crypto";

/** A credential's spelling: 32 hex digits, or 64 for one issued before the change. */
export const TOKEN_PATTERN = /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/;

/** A new credential: 128 bits, short enough to copy without slips. */
export const newSecret = (): string => randomBytes(16).toString("hex");
export const newToken = newSecret;

export const isToken = (value: unknown): value is string => typeof value === "string" && TOKEN_PATTERN.test(value);

/** Only the length short-circuits; it says which of the two lengths the secret has, not the secret. */
export function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
