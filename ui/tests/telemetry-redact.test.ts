// The page's and the service's redactors hold one contract: every credential shape is hidden, and the
// cost is linear in the input, so a long console error or request can't stall the page. Both
// implementations run the same table (ui/src/telemetry/redact.ts, ts/src/telemetry/redact.ts).
import { describe, expect, it } from "vitest";
import * as page from "../src/telemetry/redact";
import * as service from "../../ts/src/telemetry/redact";

/** What both redactors offer; the table runs against each. */
interface Redactor {
  redactText(text: string, max?: number): string;
  redactUrl(url: string): string;
  redact(value: unknown): unknown;
  knowSecret(kind: "token" | "pairing-code", value: string): () => void;
}
const implementations: Record<"page" | "service", Redactor> = { page, service };

// Live secrets each redactor is told about (the service registers its token and every issued code): their
// prefixes and respellings are hidden even where no shape gives them away (re-score 2: C-34, X-04).
// The token's first 8 digits are all decimal; one code is all letters, one holds the look-alikes 1 and 0.
// Synthetic test-only values, never issued by a service.
const KNOWN_TOKEN = "40213958c7e1a9f06b3d52e8a4f7c1d9";
const KNOWN_CODES = ["KQMX-DRTW", "R1V0-T8NB"] as const;
for (const r of Object.values(implementations)) {
  r.knowSecret("token", KNOWN_TOKEN);
  for (const code of KNOWN_CODES) r.knowSecret("pairing-code", code);
}
const bytesOf = (hexText: string): string =>
  String.fromCharCode(...hexText.match(/../g)!.map((pair) => parseInt(pair, 16)));

const hex = (n: number, offset = 3): string =>
  Array.from({ length: n }, (_, i) => "0123456789abcdef"[(i * 7 + offset) % 16]).join("");
const pct = (text: string): string =>
  [...text].map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join("");
const fill = (unit: string, bytes: number): string => unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);

const T32 = hex(32),
  T64 = hex(64, 5),
  REDACTED = "[redacted]";
const b64 = (text: string): string => btoa(text);
const b64u = (text: string): string => btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Re-score 3 (C-35): a grant is kept only as its hash, so a prefix of one cannot be recognised as known; any
// run of 16 or more hex digits in free text is hidden instead. Shorter runs (commit hashes, ids) stay readable.
describe.each(Object.entries(implementations))("%s redactor: hex runs", (_, r) => {
  it("hides 16 to 31 hex digits in free text", () => {
    for (const n of [16, 20, 31]) expect(r.redactText(`grant ${hex(n, 9)} failed`)).toBe(`grant ${REDACTED} failed`);
  });
  it("keeps shorter hex runs", () => {
    for (const text of ["commit 9f3c2a1b5d", "id 0123456789abcde"]) expect(r.redactText(text)).toBe(text);
  });
});

/** Inputs of `bytes` length: realistic page reports, and shapes built to trip regex backtracking. */
const inputs: Record<string, (bytes: number) => string> = {
  urls: (b) => fill(`GET https://h.example/${T32}/p/demo/api/views?token=${T64}&q=a+b%20c&grant=${T32} 200\n`, b),
  json: (b) =>
    fill(JSON.stringify({ url: `/x?token=${T32}`, headers: { authorization: `Bearer ${T64}` }, items: [1, "abc"] }), b),
  stack: (b) =>
    fill(
      `Error: failed\n    at fn (https://h/${T32}/p/demo/app.js:12:34)\n    at g (https://h/p/x.js?grant=${T64}:1:2)\n`,
      b,
    ),
  longHex: (b) => fill("a0", b),
  longBase64: (b) => fill("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0123+/=", b),
  urlSafeRunThenPercent: (b) => fill("abc.def_ghi-jkl~", b - 1) + "%",
  urlSafeRunThenBang: (b) => fill("abc.def_ghi-jkl~", b - 2) + "!a",
  escapesThenBang: (b) => fill("%41", b - 1) + "!",
  strayPercents: (b) => fill("%4%%a", b),
  nearMissHex: (b) => fill(`${hex(31)}g`, b),
  nearMissEncoded: (b) => fill(`%6${hex(30)}%zz `, b),
  manyParams: (b) => fill("&a=b", b),
  longParamNames: (b) => fill(` ${"n".repeat(127)}`, b),
  // Each a malformed escape: decodeURIComponent throws, and a throw per name was 0.5 s at 64 KB.
  malformedParamNames: (b) => fill("&key%ff=x", b),
  malformedEscapes: (b) => fill("%ff%fe%41", b),
  nestedEscapes: (b) => fill("%25252561", b),
  semicolonValues: (b) => fill("&token=a;b;c", b),
  // Re-score 1 (X-04, C-29): short encoded runs, each decoded and checked for a code; truncated base64.
  encodedCodes: (b) => fill(`/${pct("7KQ4-M2XD")}`, b),
  shortEncodedRuns: (b) => fill("a%41bcdefgh ", b),
  partlyEncodedCodes: (b) => fill("x%2F7KQ4-M2X ", b),
  base64Prefixes: (b) => fill(`/${b64u(T32).slice(0, 40)}`, b),
  base64NearMissHex: (b) => fill(`${b64(`x${hex(7)}x`)} `, b),
  // Re-score 2 (C-34, X-04): known secrets in many spellings, and near misses of them.
  knownPrefixes: (b) => fill(`/${KNOWN_TOKEN.slice(0, 12)}/x ${KNOWN_TOKEN.slice(0, 7)} kqmx drt `, b),
  knownCodeSpellings: (b) => fill(`kqmx%20drtw KQMX\u2013DRTW r l v o t 8 n b `, b),
  spacedAlphanumerics: (b) => fill("a b-c d ", b),
};
const SIZES = [2, 8, 16, 64].map((kb) => kb * 1024);

/** Milliseconds of this process's CPU time a run takes: time spent waiting for a core on a busy host is not
 *  the redactor's, and wall-clock bounds failed under heavy host load with an unchanged redactor (O251).
 *  Vitest runs each test file in its own process, so no other file's work is counted. */
function cpuMs(run: () => void): number {
  const start = process.cpuUsage();
  run();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000;
}

/** The fastest of a few runs. */
function fastest(run: () => void): number {
  let best = Infinity;
  for (let i = 0; i < 5; i++) best = Math.min(best, cpuMs(run));
  return best;
}

/** The fastest of a few runs of each, taken in turn. */
function fastestOfEach(runs: readonly (() => void)[]): number[] {
  const best = runs.map(() => Infinity);
  for (let i = 0; i < 7; i++)
    runs.forEach((run, j) => {
      best[j] = Math.min(best[j]!, cpuMs(run));
    });
  return best;
}

describe.each(Object.entries(implementations))("%s redactor", (_name, r: Redactor) => {
  describe("cost is linear in the input", () => {
    // Growth: 8x the input costs about 8x linear and 64x quadratic, so the bound is 24x. The ceilings are for
    // the old blowups: the quadratic patterns took 12 s at 64 KB, a throw per malformed escape 0.5 s.
    const SLACK_MS = 2;
    it.each(Object.keys(inputs))("%s from 8 to 64 KB", (kind) => {
      const [small, large] = [8 * 1024, 64 * 1024].map((bytes) => inputs[kind]!(bytes)) as [string, string];
      // What the page does (cut first): about the same whatever the length.
      const cutOf = (text: string) => () => {
        r.redactText(text);
        r.redactUrl(text);
        r.redact({ msg: text, error: Object.assign(new Error(text), { stack: text }) });
      };
      const [cutSmall, cutLarge] = fastestOfEach([cutOf(small), cutOf(large)]) as [number, number];
      expect(cutLarge, `${kind} cut: ${cutSmall.toFixed(1)} → ${cutLarge.toFixed(1)} ms`).toBeLessThan(
        3 * cutSmall + SLACK_MS,
      );
      expect(cutLarge, `${kind} cut`).toBeLessThan(250);
      // Every pattern over the whole input (no cut): linear.
      const [wholeSmall, wholeLarge] = fastestOfEach([
        () => r.redactText(small, small.length * 2),
        () => r.redactText(large, large.length * 2),
      ]) as [number, number];
      expect(wholeLarge, `${kind} whole: ${wholeSmall.toFixed(1)} → ${wholeLarge.toFixed(1)} ms`).toBeLessThan(
        24 * wholeSmall + SLACK_MS,
      );
      expect(wholeLarge, `${kind} whole`).toBeLessThan(2500);
    });

    it("drops the run at a pre-cut without rescanning it, for any cut length", () => {
      // A run of URL-safe characters that stops just short of the cut: a backtracking `run$` scan
      // revisits the whole run from every start (64 KB took seconds).
      // A cut of 32 KB keeps 64 KB, so it is held to the whole-input bound: with the known secrets set
      // up above, that scan takes about 10 ms here and 28 ms on CI (O63); a rescan took seconds.
      for (const max of [512, 2048, 32768]) {
        const text = `${"a".repeat(max * 2 - 2)}!a${"x".repeat(1000)}`;
        expect(
          fastest(() => r.redactText(text, max)),
          `max ${max}`,
        ).toBeLessThan(max > 2048 ? 250 : 25);
      }
    });
  });

  it("visits a bounded number of values, however the object shares or cycles", () => {
    // 40 keys that all point back at the object: without a budget, 40⁴ visits (seconds).
    const cyclic: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) cyclic[`k${i}`] = cyclic;
    const shared = Array.from({ length: 40 }, () => ({}) as Record<string, unknown>);
    for (const item of shared) for (let i = 0; i < 40; i++) item[`k${i}`] = shared;
    // Long keys, long strings, a shared object repeated, many numbers, many keys: bounded work each.
    const obj = (n: number, f: (i: number) => unknown) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, f(i)]));
    const longKeys = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}${"%ffx".repeat(400)}`, "x"]));
    const zeros = obj(40, () => 0);
    const heavy = {
      longKeys,
      strings: obj(40, () => fill("&key%ff=x", 1600)),
      sharedTwice: Array(40).fill(longKeys),
      numbers: Array(40).fill(Array(40).fill(zeros)),
    };
    // About 10–25 ms each, and unbounded was seconds: a ceiling for that.
    for (const [name, value] of Object.entries({ cyclic, shared, ...heavy }))
      expect(
        fastest(() => r.redact(value)),
        name,
      ).toBeLessThan(750);
    // 100 000 keys: the engine lists them all before the first 40 are read, so it costs what listing the keys
    // costs (both ~10 ms), not a copy as entries (2.6x).
    const wide = obj(100_000, () => 0);
    const [redacted, listed] = fastestOfEach([() => r.redact(wide), () => Object.keys(wide)]) as [number, number];
    expect(redacted, `wide: ${redacted.toFixed(1)} ms against ${listed.toFixed(1)} ms to list the keys`).toBeLessThan(
      1.8 * listed + 2,
    );
    expect(JSON.stringify(r.redact(cyclic))).toContain("[cycle]");
    expect(r.redact({ a: { b: 1 }, c: [{ token: T32 }] })).toEqual({ a: { b: 1 }, c: [{ token: "[redacted]" }] });
  });

  describe("still hides every credential shape", () => {
    const hidden: [string, string, string][] = [
      ["a 32-hex token", `see ${T32} here`, T32],
      ["a 64-hex token, upper case", `see ${T64.toUpperCase()}.`, T64.toUpperCase()],
      ["a token= parameter", `/projects/?follow&token=s3cr3t-value`, "s3cr3t-value"],
      ["a grant secret parameter", `/x?grant=${T32}&page=2`, T32],
      ["an encoded parameter name", `/?%74oken=opaque-value`, "opaque-value"],
      ["a bearer header", `authorization: Bearer ${T64}`, T64],
      ["a JSON bearer header", JSON.stringify({ headers: { Authorization: `Bearer ${T32}` } }), T32],
      ["a token in a URL path", `https://h/${T32}/p/demo/api/diagrams`, T32],
      ["a percent-encoded token", `/x?next=${pct(T32)}`, pct(T32)],
      ["a double-encoded token", `/x/${pct(pct(T32))}/y`, pct(pct(T32))],
      ["an encoded token after a stray %", `a%zz${pct(T32)}`, pct(T32)],
      ["an encoded token between stray %s", `x=%%${pct(T64)}%`, pct(T64)],
      ["a token after a long hex run", `${"0".repeat(5000)}g${T32}`, T32],
      ["a token after long URL-safe text", `${"abc.".repeat(4000)} ${T32}`, T32],
      ["a credential value past a semicolon", `/?token=;opaque-secret-value`, "opaque-secret-value"],
      ["a credential value with semicolons", `/x?grant=a;b;secret-part&page=2`, "secret-part"],
      ["an opaque bearer header", "Authorization: Bearer opaque-secret-value", "opaque-secret-value"],
      ["a bearer value shaped like a parameter", `Bearer "token"=opaque-secret-value`, "opaque-secret-value"],
      ["a short bearer value", "Authorization: Bearer s3cr3t", "s3cr3t"],
      ["a bearer value with punctuation", "Authorization: Bearer abcdefgh!suffix", "suffix"],
      ["a quoted bearer value", `Authorization: Bearer "opaque-secret-value"`, "opaque-secret-value"],
      ["a credential after an unclosed quote", `?foo="a&token=opaque-secret"`, "opaque-secret"],
      ["a credential name with punctuation", `?token,foo=opaque-secret`, "opaque-secret"],
      ["a credential value holding a quote", `?token=abc"opaque-secret`, "opaque-secret"],
      ["a credential value holding an escaped quote", `?token="abc\\"opaque-secret"`, "opaque-secret"],
      ["a credential in JSON text", JSON.stringify({ msg: "token=opaque-secret-value" }), "opaque-secret-value"],
      ["a credential after a long name", `?${"x".repeat(124)}token=opaque-secret-value`, "opaque-secret-value"],
      ["a token in a stack frame", `Error\n    at f (https://h/p/x.js?token=${T64}:1:2)`, T64],
      // Pairing codes (8 Crockford base32, `XXXX-XXXX`) and base64 forms of a credential (D-2, C-07/X-04).
      ["a pairing code in a path", "GET /7KQ4-M2XD 404", "7KQ4"],
      ["a pairing code under any query name", "/?pair=7KQ4-M2XD&x=1", "7KQ4"],
      ["a pairing code typed in lower case, under any query name", "/?ticket=7kq4m2xd", "7kq4"],
      ["a pairing code in free text", "pairing code 7KQ4-M2XD rejected", "7KQ4"],
      ["a pairing code without its dash", "code: 7KQ4M2XD.", "7KQ4"],
      ["a pairing code with no digit", "code ABCD-EFGH", "ABCD"],
      ["a base64 token (Basic)", `Authorization: Basic ${b64(`owner:${T32}`)}`, b64(`owner:${T32}`).slice(0, 12)],
      [
        "a base64 token in free text",
        `auth header Basic ${b64(`owner:${T32}`)} sent`,
        b64(`owner:${T32}`).slice(0, 12),
      ],
      ["a base64 token", `seen ${b64(T32)} here`, b64(T32).slice(0, 12)],
      ["an unpadded base64url token in a path", `/p/x/${b64u(T64)}/y`, b64u(T64).slice(0, 12)],
      ["a base64 token after a slash inside its run", `/x/${b64(`?/${T32}`)}`, b64(`?/${T32}`).slice(4, 16)],
      ["a base64 pairing code", `data:text/plain;base64,${b64("7KQ4-M2XD")}`, b64("7KQ4-M2XD")],
      // Re-score 1 (X-04): a code percent-encoded, wholly or in part, and a code of digits only.
      ["a pairing code percent-encoded byte by byte", `GET /${pct("7KQ4-M2XD")} 404`, pct("7KQ4-M2XD")],
      [
        "a pairing code percent-encoded in upper-case hex",
        `GET /${pct("7KQ4-M2XD").toUpperCase()} 404`,
        pct("7KQ4-M2XD").toUpperCase(),
      ],
      ["a pairing code with only its dash encoded", "GET /7KQ4%2DM2XD 404", "M2XD"],
      ["a pairing code with only its first character encoded", "GET /%37KQ4-M2XD 404", "KQ4-M2XD"],
      ["a pairing code after an encoded slash", "/x%2F7KQ4-M2XD", "7KQ4-M2XD"],
      ["a pairing code double-encoded", `/${pct(pct("7KQ4-M2XD"))}`, pct(pct("7KQ4-M2XD"))],
      ["a pairing code encoded in a query value", `/?pair=${pct("7KQ4-M2XD")}`, pct("7KQ4-M2XD")],
      ["a pairing code of digits only", "pair 1234-5678", "1234-5678"],
      ["a pairing code of digits only, encoded", `GET /${pct("1234-5678")} 404`, pct("1234-5678")],
      // C-29: a truncated base64 or base64url token keeps most of the token; a prefix of 8 hex letters.
      ["a truncated base64url token in a path", `GET /${b64u(T32).slice(0, 40)} 404`, b64u(T32).slice(0, 16)],
      ["a truncated base64 token after a slash", `GET /p/x/${b64(T32).slice(0, 24)} 404`, b64(T32).slice(0, 16)],
      [
        "a truncated base64 Basic header",
        `Authorization: Basic ${b64(`owner:${T32}`).slice(0, 24)}`,
        b64(`owner:${T32}`).slice(0, 16),
      ],
      ["a token prefix of hex letters only", "prefix deadbeef seen", "deadbeef"],
      // Re-score 2 (C-34): the live token cut short, in any case or encoding, and base64 of its bytes.
      ["the live token cut to 31 digits", `GET /${KNOWN_TOKEN.slice(0, 31)}/projects/ 404`, KNOWN_TOKEN.slice(0, 8)],
      ["the live token cut to 20 digits", `token ${KNOWN_TOKEN.slice(0, 20)} expired`, KNOWN_TOKEN.slice(0, 8)],
      [
        "the live token cut to 12 digits, upper case",
        `see ${KNOWN_TOKEN.slice(0, 12).toUpperCase()}`,
        KNOWN_TOKEN.slice(0, 8).toUpperCase(),
      ],
      [
        "the live token's first 8 digits (all decimal)",
        `retry ${KNOWN_TOKEN.slice(0, 8)} now`,
        KNOWN_TOKEN.slice(0, 8),
      ],
      ["the live token's 8 digits from its middle", `x${KNOWN_TOKEN.slice(10, 18)}y`, KNOWN_TOKEN.slice(10, 18)],
      [
        "the live token cut short, percent-encoded",
        `GET /${pct(KNOWN_TOKEN.slice(0, 12))} 404`,
        pct(KNOWN_TOKEN.slice(0, 8)),
      ],
      ["base64 of the live token's bytes", `key ${b64(bytesOf(KNOWN_TOKEN))}`, b64(bytesOf(KNOWN_TOKEN)).slice(0, 8)],
      [
        "base64url of the live token's bytes, cut",
        `/x/${b64u(bytesOf(KNOWN_TOKEN)).slice(0, 16)}`,
        b64u(bytesOf(KNOWN_TOKEN)).slice(0, 8),
      ],
      ["a short base64 prefix of the live token", `/x/${b64(KNOWN_TOKEN).slice(0, 16)}`, b64(KNOWN_TOKEN).slice(0, 8)],
      // Re-score 2 (C-34, X-04): a live code in every spelling the redeemer accepts.
      ["a live code without its dash", "pair KQMXDRTW", "KQMXDRTW"],
      ["a live code in lower case, all letters", "typed kqmxdrtw", "kqmxdrtw"],
      ["a live code split by a space", "typed kqmx drtw", "kqmx drtw"],
      ["a live code split by %20", "GET /KQMX%20DRTW 404", "KQMX%20DRTW"],
      ["a live code split by +", "/?q=KQMX+DRTW", "KQMX+DRTW"],
      ["a live code split by an en dash", "code KQMX\u2013DRTW", "KQMX\u2013DRTW"],
      ["a live code split by an encoded en dash", "GET /KQMX%E2%80%93DRTW 404", "KQMX%E2%80%93DRTW"],
      ["a live code split by an em dash", "code KQMX\u2014DRTW", "KQMX\u2014DRTW"],
      ["a live code typed with look-alikes (l for 1, o for 0)", "code rlvo-t8nb", "t8nb"],
      ["a live code spaced out", "code K Q M X D R T W", "D R T W"],
      ["a live code percent-encoded, lower case", `/${pct("kqmxdrtw")}`, pct("kqmxdrtw")],
      ["a live code in base64, lower case", `data ${b64("kqmxdrtw")}`, b64("kqmxdrtw")],
    ];
    it.each(hidden)("%s", (_shape, text, secret) => {
      expect(r.redactText(text, 100_000)).not.toContain(secret);
      expect(r.redactText(text)).not.toContain(secret);
      expect(JSON.stringify(r.redact({ text, nested: { msg: text } }))).not.toContain(secret);
    });

    it("in a `code` field holding a pairing code, but not an error code", () => {
      for (const key of ["code", "pairingCode", "pairing_code"])
        expect(JSON.stringify(r.redact({ [key]: "7kq4-m2xd" }))).not.toContain("7kq4");
      expect(r.redact({ code: "ENOENT", error: { code: "invalid_debug_query" } })).toEqual({
        code: "ENOENT",
        error: { code: "invalid_debug_query" },
      });
    });

    it("behind a long key, plain or encoded", () => {
      for (const key of [`${"x".repeat(256)}token`, `${"x".repeat(250)}%2574oken`, `${"x".repeat(2000)}`])
        expect(JSON.stringify(r.redact({ [key]: "opaque-secret-value" }))).not.toContain("opaque-secret-value");
    });

    it("in a number that is the live token's digits", () => {
      expect(r.redact({ n: Number(KNOWN_TOKEN.slice(0, 8)) })).toEqual({ n: REDACTED });
      expect(r.redact({ n: 40213957 })).toEqual({ n: 40213957 });
    });

    it("in an error's name and a bigint", () => {
      expect(JSON.stringify(r.redact(Object.assign(new Error("oops"), { name: T32, stack: "safe" })))).not.toContain(
        T32,
      );
      expect(r.redact(BigInt(`1${"2".repeat(40)}`))).toBe(REDACTED);
    });

    it("keeps ordinary words, ids and numbers that are not code- or token-shaped", () => {
      for (const text of [
        "read-only mode",
        "/p/demo/api/diagrams?view=overview",
        "id 550e8400-e29b-41d4-a716-446655440000",
        "eventSeq 10485760 bytes",
        "GET /p/journeys/api/configuration 200",
        "[redacted] x",
        // Re-score 1: encoded ordinary text, words of hex letters, short hex, plain numbers, base64 that is not a token.
        "/p/demo/api/diagrams?q=read%20only%20overview",
        "GET /notes/caf%C3%A9%20menu.md 200",
        "a %E2%80%94 dash",
        "facade decade feedback",
        "commit 1a2b3c4 at 2026-10-31",
        "session 01234567-89abcdef",
        "range 10485760-20971520 bytes",
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        `msg ${b64("hello, world: all fine")}`,
        // Re-score 2: with live secrets known, near misses of them and ordinary spaced text stay.
        `prefix ${KNOWN_TOKEN.slice(0, 7)} only`,
        `id ${KNOWN_TOKEN.slice(1, 8)}`,
        "kqmx drt",
        "KQMX DRTX",
        "page 2048 of 4096",
        "commit 9f3c2a1b5d",
        "line 1234 col 5678",
        "a b-c d e f g h",
      ])
        expect(r.redactText(text)).toBe(text);
    });

    it("leaves no partial token at a cut, whatever the input length", () => {
      for (const bytes of SIZES)
        for (const shift of [0, 7, 31]) {
          const text = `${"z ".repeat((bytes - shift) / 2)}${T64} ${T32}`;
          for (const max of [256, 512, 2000, 2048])
            expect(r.redactText(text, max), `${bytes}/${shift}/${max}`).not.toMatch(/[0-9a-f]{20,}/i);
        }
    });
  });
});

describe("the page and the service redact alike", () => {
  it.each(Object.keys(inputs))("%s", (kind) => {
    const text = inputs[kind]!(4096);
    for (const max of [96, 256, 512, 2048, 10_000])
      expect(page.redactText(text, max), `max ${max}`).toBe(service.redactText(text, max));
  });
});
