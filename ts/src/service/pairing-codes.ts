// Pairing codes (ADR 0014, amended 2026-10-22; docs/proposals/pairing-code.md): a short code the
// person types on Archer's base page instead of carrying a tokened link to another device.
//
// 8 Crockford base32 characters (40 bits, never all digits), single use, a configured 1–60 minutes, at most 3 live.
// The strength is in the limits, not the entropy, so they are global (an attacker on a LAN can
// change address) and checked before any comparison: 5 wrong tries a minute, and 20 wrong tries in
// one window void every live code. A window starts when a code is issued while none is live.
// Only each code's sha256 is kept, in memory: a restart or a hot swap voids every code. The tries
// already spent are not voided: with a store (the service's state directory), the per-minute tries,
// the window's count and when the window can end are persisted after each change and restored at
// startup, so a restart gives no fresh budget (rubric R1, X-13).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { knowSecret } from "../telemetry/redact.ts";

export const PAIRING_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PAIRING_MINUTES_DEFAULT = 5;
export const PAIRING_MINUTES_MIN = 1;
export const PAIRING_MINUTES_MAX = 60;
export const MAX_LIVE_PAIRING_CODES = 3;
export const WRONG_PER_MINUTE = 5;
export const WRONG_PER_WINDOW = 20;
/** Spent, expired and voided codes are remembered (by hash) only to say why one was refused. */
const REMEMBERED = 8;
const MAX_INPUT_CHARS = 64;
/** Draws before issue gives up on a random source that yields only all-digit codes (real odds: 10⁻¹²⁸). */
const MAX_DRAWS = 32;
const MINUTE = 60_000;
const CANONICAL = /^[0-9A-HJKMNP-TV-Z]{8}$/;

export type PairingRefusal = "invalid" | "wrong" | "expired" | "used" | "throttled" | "too_many_tries";
export type PairingOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: Exclude<PairingRefusal, "throttled"> }
  | { readonly ok: false; readonly reason: "throttled"; readonly retryAfterSeconds: number };

export interface IssuedPairingCode {
  /** `XXXX-XXXX`. */
  readonly code: string;
  readonly minutes: number;
  readonly expiresAt: string;
}

/** Whether `minutes` is an accepted code lifetime. */
export const validPairingMinutes = (minutes: unknown): minutes is number =>
  typeof minutes === "number" &&
  Number.isInteger(minutes) &&
  minutes >= PAIRING_MINUTES_MIN &&
  minutes <= PAIRING_MINUTES_MAX;

/**
 * The 8 canonical characters of what the person typed, or null when it cannot be a code. Case,
 * spaces and dashes are ignored, and Crockford's look-alikes read as digits: I and L as 1, O as 0.
 */
export function normalizePairingCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > MAX_INPUT_CHARS) return null;
  const bare = input.replace(/[\s\-‐-―−]/gu, "");
  // ASCII only before upper-casing: "ß" or a ligature would otherwise become code letters, a spelling no
  // redactor can match character by character (security round 1, re-score 3).
  if (!/^[\x21-\x7e]*$/u.test(bare)) return null;
  const text = bare.toUpperCase().replace(/[IL]/g, "1").replace(/O/g, "0");
  return CANONICAL.test(text) ? text : null;
}

const digest = (canonical: string): Buffer => createHash("sha256").update(canonical).digest();

interface Entry {
  readonly verifier: Buffer;
  readonly expiresAt: number;
  state: "live" | "used" | "replaced" | "voided";
  /** Ends telemetry's knowledge of the code (it hides the code in every spelling while it can be redeemed). */
  readonly forget: () => void;
}

/** What survives a restart: no code, no verifier, only the tries spent and when their window can end. */
export interface PairingAttempts {
  /** When the wrong tries of the last minute happened (at most WRONG_PER_MINUTE). */
  readonly recentWrong: readonly number[];
  readonly wrongInWindow: number;
  /** The latest expiry of a code issued in this window: until then it is still open. */
  readonly windowEndsAt: number | null;
}

/** Where the attempts are kept. `load` gives undefined when there is nothing, and throws when what is there cannot be trusted. */
export interface PairingAttemptStore {
  load(): PairingAttempts | undefined;
  save(attempts: PairingAttempts): void;
}

export const PAIRING_ATTEMPT_FILE = "pairing-attempts.json";
const MAX_ATTEMPT_FILE_BYTES = 4096;

/** The attempts as a private (0600, owner's, regular, no symlink) file in the state directory, replaced atomically. */
export class PairingAttemptFile implements PairingAttemptStore {
  readonly #path: string;
  constructor(readonly stateDir: string) {
    this.#path = join(stateDir, PAIRING_ATTEMPT_FILE);
  }

  load(): PairingAttempts | undefined {
    let fd: number;
    try {
      fd = openSync(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("the pairing attempt file cannot be opened");
    }
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.size > MAX_ATTEMPT_FILE_BYTES ||
        (stat.mode & 0o077) !== 0 ||
        (process.getuid !== undefined && stat.uid !== process.getuid())
      )
        throw new Error("the pairing attempt file is not a bounded private regular file");
      const bytes = Buffer.alloc(stat.size);
      let used = 0;
      while (used < bytes.length) {
        const count = readSync(fd, bytes, used, bytes.length - used, used);
        if (count === 0) break;
        used += count;
      }
      return parseAttempts(bytes.subarray(0, used).toString("utf8"));
    } finally {
      closeSync(fd);
    }
  }

  save(attempts: PairingAttempts): void {
    const text = `${JSON.stringify({ version: 1, ...attempts })}\n`;
    const temporary = join(this.stateDir, `.${PAIRING_ATTEMPT_FILE}.${randomBytes(16).toString("hex")}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const bytes = Buffer.from(text);
      let used = 0;
      while (used < bytes.length) used += writeSync(fd, bytes, used, bytes.length - used);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, this.#path);
    } catch (error) {
      // Cleanup after a failed write: the write's error is the one reported, whatever the cleanup meets.
      try {
        if (fd !== undefined) closeSync(fd);
      } catch {
        /* the write's error is reported */
      }
      try {
        unlinkSync(temporary);
      } catch {
        /* the write's error is reported */
      }
      throw error;
    }
    try {
      unlinkSync(temporary);
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure;
    }
  }
}

const instant = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function parseAttempts(text: string): PairingAttempts {
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (
    typeof raw !== "object" ||
    raw === null ||
    raw.version !== 1 ||
    !Array.isArray(raw.recentWrong) ||
    raw.recentWrong.length > WRONG_PER_MINUTE ||
    !raw.recentWrong.every(instant) ||
    !Number.isSafeInteger(raw.wrongInWindow) ||
    (raw.wrongInWindow as number) < 0 ||
    (raw.windowEndsAt !== null && !instant(raw.windowEndsAt))
  )
    throw new Error("the pairing attempt file is not valid");
  return {
    recentWrong: raw.recentWrong as number[],
    wrongInWindow: raw.wrongInWindow as number,
    windowEndsAt: raw.windowEndsAt as number | null,
  };
}

export class PairingCodes {
  readonly #now: () => number;
  readonly #random: (bytes: number) => Buffer;
  readonly #store: PairingAttemptStore | undefined;
  #entries: Entry[] = [];
  /** When the last wrong tries happened, for the per-minute limit. */
  #recentWrong: number[] = [];
  #wrongInWindow = 0;
  /** When the window restored from before a restart can end (its codes are gone; its tries are not). */
  #restoredWindowEndsAt: number | null = null;

  constructor(
    options: {
      readonly now?: () => number;
      readonly random?: (bytes: number) => Buffer;
      readonly store?: PairingAttemptStore;
    } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? randomBytes;
    this.#store = options.store;
    if (this.#store !== undefined) this.#restore(this.#store);
  }

  /** Restores the spent tries; what cannot be read or trusted fails closed: a full minute's budget is spent. */
  #restore(store: PairingAttemptStore): void {
    const now = this.#now();
    let saved: PairingAttempts | undefined;
    try {
      saved = store.load();
    } catch {
      saved = { recentWrong: Array<number>(WRONG_PER_MINUTE).fill(now), wrongInWindow: 0, windowEndsAt: null };
    }
    if (saved === undefined) return;
    // A try recorded in the future (a clock set back) counts as now, never as a longer wait.
    this.#recentWrong = saved.recentWrong.map((at) => Math.min(at, now)).filter((at) => now - at < MINUTE);
    this.#wrongInWindow = saved.wrongInWindow;
    this.#restoredWindowEndsAt = saved.windowEndsAt;
  }

  #save(): void {
    if (this.#store === undefined) return;
    const now = this.#now();
    const ends = Math.max(
      this.#restoredWindowEndsAt ?? 0,
      ...this.#entries.filter((entry) => this.#isLive(entry, now)).map((entry) => entry.expiresAt),
    );
    this.#store.save({
      recentWrong: this.#recentWrong.slice(-WRONG_PER_MINUTE),
      wrongInWindow: this.#wrongInWindow,
      windowEndsAt: ends > now ? ends : null,
    });
  }

  #isLive(entry: Entry, now: number): boolean {
    if (entry.state === "live" && now >= entry.expiresAt) entry.forget();
    return entry.state === "live" && now < entry.expiresAt;
  }

  /** A live code is spent, replaced or voided: it is no longer a secret to hide. */
  #end(entry: Entry, state: Exclude<Entry["state"], "live">): void {
    entry.state = state;
    entry.forget();
  }

  /** Whether this window is still open: a code is live, or the window restored from before a restart has not ended or been spent. */
  #windowOpen(now: number): boolean {
    if (this.#entries.some((entry) => this.#isLive(entry, now))) return true;
    return (
      this.#restoredWindowEndsAt !== null && now < this.#restoredWindowEndsAt && this.#wrongInWindow < WRONG_PER_WINDOW
    );
  }

  /** How many codes can be redeemed now. */
  live(): number {
    const now = this.#now();
    return this.#entries.filter((entry) => this.#isLive(entry, now)).length;
  }

  issue(minutes: number): IssuedPairingCode {
    if (!validPairingMinutes(minutes))
      throw new RangeError(`a pairing code lasts ${PAIRING_MINUTES_MIN} through ${PAIRING_MINUTES_MAX} whole minutes`);
    const canonical = this.#draw();
    const now = this.#now();
    const live = this.#entries.filter((entry) => this.#isLive(entry, now));
    // A new window: tries made while nothing could be redeemed do not count against this code.
    if (!this.#windowOpen(now)) {
      this.#wrongInWindow = 0;
      this.#restoredWindowEndsAt = null;
    }
    if (live.length >= MAX_LIVE_PAIRING_CODES) this.#end(live[0]!, "replaced");
    // Telemetry knows the code while it is live, so no spelling of it is logged (C-34, X-04).
    const entries: Entry[] = [
      ...this.#entries,
      {
        verifier: digest(canonical),
        expiresAt: now + minutes * MINUTE,
        state: "live" as const,
        forget: knowSecret("pairing-code", canonical),
      },
    ];
    for (const gone of entries.slice(0, -REMEMBERED)) gone.forget();
    this.#entries = entries.slice(-REMEMBERED);
    this.#save();
    return {
      code: `${canonical.slice(0, 4)}-${canonical.slice(4)}`,
      minutes,
      expiresAt: new Date(now + minutes * MINUTE).toISOString(),
    };
  }

  /**
   * 40 random bits, 5 per character, drawn again while all eight are digits (X-04): telemetry keeps an
   * undashed 8-digit number readable, so no code may be one. Every code with a letter stays equally
   * likely; (10/32)⁸ ≈ 10⁻⁴ of draws are redrawn, and a source that gives only digits fails closed.
   */
  #draw(): string {
    for (let attempt = 0; attempt < MAX_DRAWS; attempt++) {
      const bits = this.#random(5).readUIntBE(0, 5);
      let canonical = "";
      for (let shift = 35; shift >= 0; shift -= 5) canonical += PAIRING_ALPHABET[Math.floor(bits / 2 ** shift) % 32];
      if (/[A-Z]/.test(canonical)) return canonical;
    }
    throw new Error(`the random source gave ${MAX_DRAWS} codes of digits only`);
  }

  /**
   * Spends a correct live code and returns `mint()`'s value. Synchronous from check to spend, so
   * two requests cannot both redeem one code, and the code is spent before `mint` runs: a failed
   * mint is not retried with the same code.
   */
  redeem<T>(input: unknown, mint: () => T): PairingOutcome<T> {
    const canonical = normalizePairingCode(input);
    if (canonical === null) return { ok: false, reason: "invalid" };
    const now = this.#now();
    this.#recentWrong = this.#recentWrong.filter((at) => now - at < MINUTE);
    if (this.#recentWrong.length >= WRONG_PER_MINUTE)
      return {
        ok: false,
        reason: "throttled",
        retryAfterSeconds: Math.max(1, Math.ceil((this.#recentWrong[0]! + MINUTE - now) / 1000)),
      };
    const presented = digest(canonical);
    let matched: Entry | undefined;
    // Every remembered verifier is compared, with no early exit.
    for (const entry of this.#entries) if (timingSafeEqual(presented, entry.verifier)) matched = entry;
    if (matched !== undefined && this.#isLive(matched, now)) {
      this.#end(matched, "used");
      return { ok: true, value: mint() };
    }
    const reason =
      matched === undefined
        ? this.#voidedByLimit(now)
          ? "too_many_tries"
          : "wrong"
        : matched.state === "used"
          ? "used"
          : matched.state === "voided"
            ? "too_many_tries"
            : "expired";
    this.#recentWrong.push(now);
    this.#wrongInWindow += 1;
    if (this.#wrongInWindow >= WRONG_PER_WINDOW) {
      for (const entry of this.#entries) if (this.#isLive(entry, now)) this.#end(entry, "voided");
    }
    // Persisted before the refusal is answered: a try the store could not keep fails closed.
    try {
      this.#save();
    } catch {
      this.#recentWrong = Array<number>(WRONG_PER_MINUTE).fill(now);
    }
    return { ok: false, reason };
  }

  /** Whether the attempt limit voided the codes and none has been issued since. */
  #voidedByLimit(now: number): boolean {
    return this.#wrongInWindow >= WRONG_PER_WINDOW && !this.#entries.some((entry) => this.#isLive(entry, now));
  }
}
