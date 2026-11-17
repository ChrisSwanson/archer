import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  MAX_LIVE_PAIRING_CODES,
  PAIRING_ATTEMPT_FILE,
  PairingAttemptFile,
  PairingCodes,
  WRONG_PER_MINUTE,
  WRONG_PER_WINDOW,
  normalizePairingCode,
  type PairingOutcome,
} from "../../src/service/pairing-codes.ts";

const MINUTE = 60_000;
const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

function clock(start = Date.parse("2026-10-22T10:00:00.000Z")) {
  let at = start;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

/** A code from `issue` that differs from `code` in its last character (still well formed). */
function wrongOf(code: string): string {
  const last = code.at(-1)!;
  return `${code.slice(0, -1)}${last === "Z" ? "Y" : "Z"}`;
}

const redeemed = (codes: PairingCodes, input: string): PairingOutcome<string> => codes.redeem(input, () => "grant");

describe("normalizePairingCode", () => {
  test.each([
    ["7KQ4-M2XD", "7KQ4M2XD"],
    ["7kq4m2xd", "7KQ4M2XD"],
    [" 7kq4 - m2xd ", "7KQ4M2XD"],
    ["7KQ4–M2XD", "7KQ4M2XD"],
    ["IL0O-1100", "11001100"],
    ["il0o1100", "11001100"],
  ])("%j reads as %j", (input, expected) => expect(normalizePairingCode(input)).toBe(expected));

  test.each([
    "",
    "7KQ4-M2X",
    "7KQ4-M2XDD",
    "7KQ4-M2XU",
    "7KQ4_M2XD",
    "7KQ4-M2X!",
    "x".repeat(65),
    "７KQ4M2XD",
    // Re-score 3: a letter outside ASCII that upper-cases to code letters (ligatures, ß) is not a spelling of a code.
    "7KQ4M2X\uFB00",
    "\uFB06KQ4M2XD",
    "7KQ4M2\u00DF",
  ])("%j is not a code", (input) => expect(normalizePairingCode(input)).toBeNull());

  test("only strings are read", () => {
    for (const value of [undefined, null, 12345678, {}, ["7KQ4M2XD"]]) expect(normalizePairingCode(value)).toBeNull();
  });
});

describe("PairingCodes", () => {
  test("a code is 8 Crockford characters shown as XXXX-XXXX, and expires after the configured minutes", () => {
    const time = clock();
    const codes = new PairingCodes({ now: time.now });
    const issued = codes.issue(7);
    expect(issued.code).toMatch(CROCKFORD);
    expect(issued.minutes).toBe(7);
    expect(issued.expiresAt).toBe(new Date(time.now() + 7 * MINUTE).toISOString());
  });

  test("a code is never digits only: such a draw is drawn again (X-04), and a source of nothing else fails closed", () => {
    // Eight 5-bit groups below 10 are eight digits; the second draw (all 31s) is `ZZZZZZZZ`.
    const digits = Buffer.alloc(5);
    digits.writeUIntBE(
      [1, 2, 3, 4, 5, 6, 7, 8].reduce((value, group) => value * 32 + group, 0),
      0,
      5,
    );
    const draws = [digits, Buffer.alloc(5, 0xff)];
    const codes = new PairingCodes({ random: () => draws.shift() ?? Buffer.alloc(5, 0xff) });
    expect(codes.issue(5).code).toBe("ZZZZ-ZZZZ");
    expect(() => new PairingCodes({ random: () => Buffer.from(digits) }).issue(5)).toThrow(/digits/);
    // Real draws: none is all digits, and every one has a letter.
    const real = new PairingCodes();
    for (let i = 0; i < 200; i++) expect(real.issue(5).code).toMatch(/[A-Z]/);
  });

  test("codes are random: 200 issues give 200 different codes", () => {
    const seen = new Set<string>();
    const codes = new PairingCodes();
    for (let i = 0; i < 200; i++) seen.add(codes.issue(5).code);
    expect(seen.size).toBe(200);
  });

  test("the minutes are bounded to 1–60 whole minutes", () => {
    const codes = new PairingCodes();
    for (const minutes of [0, 61, 1.5, Number.NaN, -1]) expect(() => codes.issue(minutes)).toThrow(/1 through 60/);
    expect(codes.issue(1).minutes).toBe(1);
    expect(codes.issue(60).minutes).toBe(60);
  });

  test("a correct code, typed loosely, mints once; a second use is refused as used", () => {
    const codes = new PairingCodes();
    const { code } = codes.issue(5);
    let minted = 0;
    expect(codes.redeem(` ${code.toLowerCase().replace("-", " ")} `, () => ++minted)).toEqual({ ok: true, value: 1 });
    expect(codes.redeem(code, () => ++minted)).toEqual({ ok: false, reason: "used" });
    expect(minted).toBe(1);
  });

  test("a code expires at its deadline under the configured value", () => {
    const time = clock();
    const codes = new PairingCodes({ now: time.now });
    const short = codes.issue(1).code;
    const long = codes.issue(10).code;
    time.advance(MINUTE - 1);
    expect(codes.live()).toBe(2);
    time.advance(1);
    expect(redeemed(codes, short)).toEqual({ ok: false, reason: "expired" });
    time.advance(9 * MINUTE - 1);
    expect(redeemed(codes, long)).toEqual({ ok: true, value: "grant" });
  });

  test("a malformed entry is refused without counting as a try", () => {
    const codes = new PairingCodes();
    const { code } = codes.issue(5);
    for (let i = 0; i < 30; i++) expect(redeemed(codes, "nope")).toEqual({ ok: false, reason: "invalid" });
    expect(redeemed(codes, code)).toMatchObject({ ok: true });
  });

  test(`at most ${MAX_LIVE_PAIRING_CODES} codes are live: a fourth voids the oldest`, () => {
    const codes = new PairingCodes();
    const issued = Array.from({ length: MAX_LIVE_PAIRING_CODES + 1 }, () => codes.issue(5).code);
    expect(codes.live()).toBe(MAX_LIVE_PAIRING_CODES);
    expect(redeemed(codes, issued[0]!)).toEqual({ ok: false, reason: "expired" });
    for (const code of issued.slice(1)) expect(redeemed(codes, code)).toMatchObject({ ok: true });
  });

  test(`${WRONG_PER_MINUTE} wrong tries a minute, then every try waits, even the right code, without comparing`, () => {
    const time = clock();
    const codes = new PairingCodes({ now: time.now });
    const { code } = codes.issue(5);
    for (let i = 0; i < WRONG_PER_MINUTE; i++)
      expect(redeemed(codes, wrongOf(code))).toEqual({ ok: false, reason: "wrong" });
    let minted = false;
    expect(
      codes.redeem(code, () => {
        minted = true;
        return "grant";
      }),
    ).toEqual({ ok: false, reason: "throttled", retryAfterSeconds: 60 });
    expect(minted).toBe(false);
    time.advance(MINUTE - 1000);
    expect(redeemed(codes, code)).toEqual({ ok: false, reason: "throttled", retryAfterSeconds: 1 });
    time.advance(1000);
    expect(redeemed(codes, code)).toMatchObject({ ok: true });
  });

  test(`${WRONG_PER_WINDOW} wrong tries void every live code; a new code starts a new window`, () => {
    const time = clock();
    const codes = new PairingCodes({ now: time.now });
    const first = codes.issue(60).code;
    const second = codes.issue(60).code;
    for (let i = 0; i < WRONG_PER_WINDOW; i++) {
      if (i > 0 && i % WRONG_PER_MINUTE === 0) time.advance(MINUTE);
      expect(redeemed(codes, wrongOf(first) === second ? wrongOf(second) : wrongOf(first))).toEqual({
        ok: false,
        reason: "wrong",
      });
    }
    expect(codes.live()).toBe(0);
    time.advance(MINUTE);
    expect(redeemed(codes, first)).toEqual({ ok: false, reason: "too_many_tries" });
    expect(redeemed(codes, second)).toEqual({ ok: false, reason: "too_many_tries" });
    const fresh = codes.issue(5).code;
    expect(redeemed(codes, wrongOf(fresh))).toEqual({ ok: false, reason: "wrong" });
    expect(redeemed(codes, fresh)).toMatchObject({ ok: true });
  });

  test("wrong tries while no code is live do not burn the next code's window", () => {
    const time = clock();
    const codes = new PairingCodes({ now: time.now });
    for (let i = 0; i < WRONG_PER_WINDOW - 1; i++) {
      if (i > 0 && i % WRONG_PER_MINUTE === 0) time.advance(MINUTE);
      redeemed(codes, "AAAA-AAAA");
    }
    time.advance(MINUTE);
    const { code } = codes.issue(5);
    for (let i = 0; i < WRONG_PER_MINUTE; i++)
      expect(redeemed(codes, wrongOf(code))).toEqual({ ok: false, reason: "wrong" });
    time.advance(MINUTE);
    expect(redeemed(codes, code)).toMatchObject({ ok: true });
  });

  test("a mint that throws still spends the code: nothing is replayed", () => {
    const codes = new PairingCodes();
    const { code } = codes.issue(5);
    expect(() =>
      codes.redeem(code, () => {
        throw new Error("disk full");
      }),
    ).toThrow("disk full");
    expect(redeemed(codes, code)).toEqual({ ok: false, reason: "used" });
  });

  test("never throws on arbitrary input", () => {
    const codes = new PairingCodes();
    codes.issue(5);
    const vocabulary = ["0", "Z", "-", " ", "I", "L", "O", "U", "\u0000", "\uD800", "é", "ab", "\n"];
    let seed = 7;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let i = 0; i < 2000; i++) {
      const text = Array.from({ length: next(14) }, () => vocabulary[next(vocabulary.length)]).join("");
      const outcome = redeemed(codes, text);
      expect(["invalid", "wrong", "throttled", "too_many_tries", "expired"]).toContain(
        outcome.ok ? "ok" : outcome.reason,
      );
    }
  });
});

// R1 (X-13): the attempt budgets hold across a restart. A restart voids every code (ADR 0014), but the
// tries already spent are persisted with the pairing state and restored before any attempt is read.
describe("PairingCodes across a restart", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  const stateDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "archer-pairing-"));
    chmodSync(dir, 0o700);
    dirs.push(dir);
    return dir;
  };
  /** A fresh instance on the same state directory, as service.ts constructs one at startup. */
  const start = (dir: string, now: () => number) => new PairingCodes({ now, store: new PairingAttemptFile(dir) });

  test(`${WRONG_PER_MINUTE} wrong tries, then a restart in the same minute: a fresh code is still throttled`, () => {
    const time = clock(),
      dir = stateDir();
    const before = start(dir, time.now);
    const old = before.issue(5).code;
    for (let i = 0; i < WRONG_PER_MINUTE; i++)
      expect(redeemed(before, wrongOf(old))).toEqual({ ok: false, reason: "wrong" });
    const after = start(dir, time.now);
    const fresh = after.issue(5).code;
    expect(redeemed(after, fresh)).toMatchObject({ ok: false, reason: "throttled" });
    expect(redeemed(after, old)).toMatchObject({ ok: false, reason: "throttled" });
    time.advance(MINUTE);
    expect(redeemed(after, old).ok).toBe(false); // the restart voided it
    expect(redeemed(after, fresh)).toEqual({ ok: true, value: "grant" });
  });

  test(`the window's ${WRONG_PER_WINDOW} wrong tries span a restart: the try that completes it voids the new code`, () => {
    const time = clock(),
      dir = stateDir();
    let codes = start(dir, time.now);
    const first = codes.issue(60).code;
    for (let i = 0; i < WRONG_PER_WINDOW - 1; i++) {
      expect(redeemed(codes, wrongOf(first)).ok).toBe(false);
      if (i % WRONG_PER_MINUTE === WRONG_PER_MINUTE - 1) time.advance(MINUTE);
    }
    time.advance(MINUTE);
    codes = start(dir, time.now);
    const next = codes.issue(5).code;
    expect(redeemed(codes, wrongOf(next))).toEqual({ ok: false, reason: "wrong" });
    expect(redeemed(codes, next)).toEqual({ ok: false, reason: "too_many_tries" });
    // Once the window has closed (no code live, none could be), a new code starts a new window.
    time.advance(61 * MINUTE);
    codes = start(dir, time.now);
    expect(redeemed(codes, codes.issue(5).code)).toEqual({ ok: true, value: "grant" });
  });

  test("the attempt file is private, bounded and validated; a damaged one fails closed for a minute", () => {
    const time = clock(),
      dir = stateDir();
    const codes = start(dir, time.now);
    expect(redeemed(codes, wrongOf(codes.issue(5).code)).ok).toBe(false);
    const file = join(dir, PAIRING_ATTEMPT_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toMatch(/[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}/);
    writeFileSync(file, "{not json", { mode: 0o600 });
    const damaged = start(dir, time.now);
    expect(redeemed(damaged, damaged.issue(5).code)).toMatchObject({ ok: false, reason: "throttled" });
    time.advance(MINUTE);
    expect(redeemed(damaged, damaged.issue(5).code)).toEqual({ ok: true, value: "grant" });
  });

  test("without a store, nothing is written (tests and one-shot tools keep the in-memory behaviour)", () => {
    const time = clock();
    const codes = new PairingCodes({ now: time.now });
    expect(redeemed(codes, codes.issue(5).code)).toEqual({ ok: true, value: "grant" });
  });
});
