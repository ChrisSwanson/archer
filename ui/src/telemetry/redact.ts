// The browser half of telemetry redaction: the same rules as the service's (ts/src/telemetry/redact.ts),
// applied before an event is kept in the page or sent, so nothing secret is retained even locally.
// No service token, grant secret, cookie or authorization value, and no file contents; data is cut
// to a bounded depth, width and string length (longer strings here: stacks stay readable).
//
// Credentials are recognised after URL decoding (percent-encoding and `+`, up to
// three layers), because the service decodes parameters before it authenticates:
// `?%74oken=%61…` is a token parameter and must not survive in reversible form.

const SECRET_KEY =
  /token|secret|cookie|pairing|authori[sz]ation|password|credential|grant|api[-_]?key|^key$|^source$|^text$|^content$|^body$|^bytes$/i;
/** A field that may hold a pairing code (`code`, `pairingCode`); hidden only when its value is one. */
const CODE_KEY = /code$/i;
/** URL parameter names whose values are credentials. */
// `code`: a pairing code is never sent in a URL, but one typed into a query must not be kept.
const CREDENTIAL_PARAM =
  /token|grant|secret|key|cookie|authori[sz]ation|^auth$|bearer|passw|credential|signature|^sig$|^code$|pairing/i;
/**
 * Service tokens and grant secrets are 32 or 64 hex digits; any run of 16 or more is redacted (either case),
 * so a prefix of a grant, which is kept only as its hash and cannot be known, is hidden too (C-35).
 */
const SECRET_VALUE = /[a-f0-9]{16,}/gi;
const HAS_SECRET_VALUE = /[a-f0-9]{16}/i;
/**
 * A pairing code (ADR 0014: 8 Crockford base32 characters, issued as `XXXX-XXXX`) standing alone: not
 * inside a longer word, an id or a dashed run (a UUID's groups). Which candidates are codes is `codeShaped`.
 */
const PAIRING_RUN = /(^|[^0-9A-Za-z%-])([0-9A-Za-z]{4}-?[0-9A-Za-z]{4})(?![0-9A-Za-z-])/g;
/** What a person could type as a code: 8 Crockford characters (no I, L, O, U), either case, one optional dash. */
const PAIRING_TYPED = /^[0-9a-hjkmnp-tv-z]{4}[-\s]?[0-9a-hjkmnp-tv-z]{4}$/i;
/** A code as issued, inside decoded text. */
const PAIRING_ISSUED = /(^|[^0-9A-Z-])[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}(?![0-9A-Z-])/;
/**
 * Whether a free-text candidate is redacted as a code: upper case (as issued) with a letter, any case with
 * a letter and a digit, or digits only in the issued `dddd-dddd` spelling (the alphabet allows it, X-04).
 * Ordinary words (`overview`, `read-only`) and plain numbers (`10485760`) stay readable.
 */
function codeShaped(candidate: string): boolean {
  if (!/[A-Za-z]/.test(candidate)) return /^[0-9]{4}-[0-9]{4}$/.test(candidate);
  // Eight lower-case hex letters (`deadbeef`) are a token's prefix, not a word (C-29).
  return !/[a-z]/.test(candidate) || /[0-9]/.test(candidate) || /^[a-f]{8}$/.test(candidate);
}
/** Whether decoded text holds a code standing alone, by the free-text rule. */
function holdsCode(text: string): boolean {
  for (const match of text.matchAll(PAIRING_RUN)) if (codeShaped(match[2]!)) return true;
  return false;
}
// ------------------------------------------------------------------ known secrets
//
// Shapes miss a live secret cut short or respelled: a token cut to 31 digits, an 8-digit prefix that is
// all decimal, a code typed `kqmx drtw` or with an en dash (re-score 2: C-34, X-04). The service tells
// the redactor its token and each code it issues; any 8 characters in a row of one (after the folding
// the redeemer does: case, spaces and dashes, I/L as 1, O as 0), or of the base64 of the token, are
// hidden wherever they appear. 8 characters of 40-plus random bits match ordinary text about once in
// 10⁹ places. One pass over the text per check, with a set lookup per place: linear.

/** How many characters of a known secret, in a row, are hidden. */
const KNOWN_WINDOW = 8;
/** At most this many secrets are known at once (a service: its token and its remembered codes). */
const MAX_KNOWN = 32;
/** What the redeemer ignores between a code's characters (normalizePairingCode), and `+` (a URL's space). */
const KNOWN_SEPARATOR = /[\s\-\u2010-\u2015\u2212+]/;
const known = new Map<object, { readonly folded: readonly string[]; readonly exact: readonly string[] }>();
let foldedWindows = new Set<string>(),
  exactWindows = new Set<string>();

const windowsOf = (text: string): string[] =>
  Array.from({ length: Math.max(0, text.length - KNOWN_WINDOW + 1) }, (_, i) => text.slice(i, i + KNOWN_WINDOW));
/** A character as the redeemer reads it: upper case, I and L as 1, O as 0; one that is not a letter or digit is a break. */
function folded(c: string): string {
  const upper = c.toUpperCase();
  if (upper === "I" || upper === "L") return "1";
  if (upper === "O") return "0";
  return /^[0-9A-Z]$/.test(upper) ? upper : "\0";
}
const base64Of = (bytes: string): string[] => {
  const b = btoa(bytes);
  return [b, b.replace(/\+/g, "-").replace(/\//g, "_")];
};

/**
 * Hides a live secret (the service token, hex; or a pairing code, any spelling) in every later redaction,
 * until the returned function is called. A value of neither shape is ignored.
 */
export function knowSecret(kind: "token" | "pairing-code", value: string): () => void {
  let entry: { readonly folded: readonly string[]; readonly exact: readonly string[] };
  if (kind === "token" && /^(?:[0-9a-f]{2}){8,}$/i.test(value)) {
    const bytes = String.fromCharCode(...value.match(/../g)!.map((pair) => parseInt(pair, 16)));
    entry = {
      folded: windowsOf(value.toUpperCase()),
      exact: [...base64Of(bytes), ...base64Of(value.toLowerCase())].flatMap(windowsOf),
    };
  } else if (kind === "pairing-code") {
    const canonical = [...value]
      .filter((c) => !KNOWN_SEPARATOR.test(c))
      .map(folded)
      .join("");
    if (!/^[0-9A-Z]{8}$/.test(canonical)) return () => undefined;
    entry = { folded: [canonical], exact: [] };
  } else return () => undefined;
  const handle = {};
  known.set(handle, entry);
  if (known.size > MAX_KNOWN) known.delete(known.keys().next().value!);
  rebuildKnown();
  return () => {
    if (known.delete(handle)) rebuildKnown();
  };
}

function rebuildKnown(): void {
  foldedWindows = new Set([...known.values()].flatMap((entry) => entry.folded));
  exactWindows = new Set([...known.values()].flatMap((entry) => entry.exact));
}

/** The `[start, end)` spans of `text` that hold a known secret's window, in order (at most the first, with `first`). */
function knownSpans(text: string, first = false): [number, number][] {
  const spans: [number, number][] = [];
  if (known.size === 0) return spans;
  const add = (start: number, end: number): void => {
    const last = spans[spans.length - 1];
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else spans.push([start, end]);
  };
  // Folded: separators are skipped, so the stream's place `i` is the text's `at[i]`.
  let stream = "";
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (KNOWN_SEPARATOR.test(c)) continue;
    stream += folded(c);
    at.push(i);
  }
  for (let i = 0; i + KNOWN_WINDOW <= stream.length; i++)
    if (foldedWindows.has(stream.slice(i, i + KNOWN_WINDOW))) {
      add(at[i]!, at[i + KNOWN_WINDOW - 1]! + 1);
      if (first) return spans;
    }
  // Exact (base64 is case-sensitive): every place of the text as it is.
  if (exactWindows.size > 0) {
    const exact: [number, number][] = [];
    for (let i = 0; i + KNOWN_WINDOW <= text.length; i++)
      if (exactWindows.has(text.slice(i, i + KNOWN_WINDOW))) {
        exact.push([i, i + KNOWN_WINDOW]);
        if (first) return exact;
      }
    if (exact.length > 0) {
      const all = [...spans, ...exact].sort((a, b) => a[0] - b[0]);
      spans.length = 0;
      for (const [start, end] of all) add(start, end);
    }
  }
  return spans;
}

/** Whether `text` holds a known secret's window. */
const holdsKnown = (text: string): boolean => knownSpans(text, true).length > 0;

/** `text` with each span holding a known secret replaced. */
function hideKnown(text: string): string {
  const spans = knownSpans(text);
  if (spans.length === 0) return text;
  let out = "",
    from = 0;
  for (const [start, end] of spans) {
    out += `${text.slice(from, start)}${REDACTED}`;
    from = end;
  }
  return out + text.slice(from);
}

/** A run of the base64 and base64url alphabets long enough to hold an encoded pairing code (11: 8 bytes, unpadded) or token. */
const BASE64_RUN = /[A-Za-z0-9+/_-]{11,}={0,2}/g;
/** How far past each `/` inside a run a decode looks for an encoded credential (a token in a path segment). */
const BASE64_WINDOW = 96;
const BASE64_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** `run` decoded as base64 or base64url to one character per byte (latin-1); a partial last group is dropped. */
function base64Bytes(run: string): string {
  let out = "",
    bits = 0,
    value = 0;
  for (let i = 0; i < run.length; i++) {
    const c = run.charCodeAt(i);
    const digit =
      c === 0x2b || c === 0x2d ? 62 : c === 0x2f || c === 0x5f ? 63 : c === 0x3d ? -1 : BASE64_DIGITS.indexOf(run[i]!);
    if (digit < 0) break;
    value = ((value << 6) | digit) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((value >> bits) & 0xff);
    }
  }
  return out;
}
/**
 * Whether decoded bytes hold a token or a prefix of one: 16 hex digits in a row, or 8 with a letter and a
 * digit. Random bytes give 8 hex characters in a row about once in 3·10⁸ places, and base64 of hex text
 * or of a number decodes to no hex at all, so ordinary encoded data is kept. One pass: linear.
 */
function holdsHexPrefix(decoded: string): boolean {
  let length = 0,
    letter = false,
    digit = false;
  for (let i = 0; i < decoded.length; i++) {
    const c = decoded.charCodeAt(i),
      lower = c | 0x20;
    const isDigit = c >= 0x30 && c <= 0x39,
      isLetter = lower >= 0x61 && lower <= 0x66;
    if (!isDigit && !isLetter) {
      length = 0;
      letter = digit = false;
      continue;
    }
    length++;
    digit ||= isDigit;
    letter ||= isLetter;
    if (length >= 16 || (length >= 8 && letter && digit)) return true;
  }
  return false;
}
/**
 * Whether base64 text decodes to a token, a truncated token (a 40-character prefix of base64url(token)
 * is 30 of its 32 hex digits: C-29) or an issued pairing code.
 */
const encodesSecret = (run: string): boolean => {
  const decoded = base64Bytes(run);
  return holdsHexPrefix(decoded) || PAIRING_ISSUED.test(decoded) || holdsKnown(decoded);
};
/**
 * `run` with an encoded credential hidden: decoded from its start, and from just past each `/` (a path
 * segment) over a bounded window, so the cost stays linear. What follows the start that decodes is dropped.
 */
function redactBase64(run: string): string {
  if (encodesSecret(run)) return REDACTED;
  for (let at = run.indexOf("/"); at !== -1 && at < run.length - 12; at = run.indexOf("/", at + 1))
    if (encodesSecret(run.slice(at + 1, at + 1 + BASE64_WINDOW))) return `${run.slice(0, at + 1)}${REDACTED}`;
  return run;
}
/** An `Authorization: Bearer …` value, whatever its alphabet or length (quoted or not). */
const BEARER = /\b(bearer)(\s+)"?[^\s"]+"?/gi;
/**
 * `name=value` after a separator: query strings, form bodies, cookie-ish text. The name holds no separator,
 * so each is scanned from one start only (linear, with no length cap). The value runs past `;` while what
 * follows is no `name=` (`?token=;x` hides `x`). A quoted value with spaces is not one value (a known gap).
 */
const PARAM = /(^|[?&;\s])([^=&;#\s?]+)=([^&;#\s]*(?:;+(?![^&;#\s=]*=)[^&;#\s=]+)*)/g;
// A run of URL-safe characters and proper `%XX` escapes. The two alternatives start with different
// characters, so the match can't backtrack: linear time. A stray `%` ends the run instead of joining it.
// (`(?:…)*%XX(?:…)*` rescanned every run with no escape from each of its characters: 0.7 s for 16 KB of hex.)
// Eight long, the shortest that can spell a code (`%37KQ4M2XD`, X-04); each run is decoded at most 4 times.
const ENCODED_RUN = /(?:%[0-9a-f]{2}|[a-z0-9+._~-]){8,}/gi;
const HAS_ESCAPE = /%[0-9a-f]{2}/i;
const ESCAPES = /(?:%[0-9a-f]{2})+/gi;
/** An escape of a byte above 0x7f: only these can make `decodeURIComponent` throw (malformed UTF-8). */
const HIGH_ESCAPE = /%[89a-f][0-9a-f]/i;
/**
 * Whether any decoding layer of `run` (raw, then up to three decodes) holds a token-shaped value, or a
 * decoded layer a code standing alone (`/%37%4B%51%34%2D…`, `7KQ4%2DM2XD`: X-04).
 */
function holdsSecret(run: string): boolean {
  let current = run;
  for (let i = 0; i < 4; i++) {
    if (HAS_SECRET_VALUE.test(current) || (i > 0 && (holdsCode(current) || holdsKnown(current)))) return true;
    const next = decodeOnce(current);
    if (next === current) return false;
    current = next;
  }
  return HAS_SECRET_VALUE.test(current) || holdsCode(current) || holdsKnown(current);
}
export const REDACTED = "[redacted]";
export const MAX_STRING = 2000;
/** Bounds on a redacted copy: keys per object, items per array, nesting, values visited and text read in all. */
const MAX_KEYS = 40,
  MAX_ITEMS = 40,
  MAX_DEPTH = 4,
  MAX_VALUES = 1000,
  MAX_TEXT = 32 * 1024;

const utf8 = new TextDecoder();
/**
 * One URL-decoding pass that never throws: `+` is a space; escapes of ASCII bytes go to the native
 * `decodeURIComponent` (which cannot throw on them), others decode run by run as UTF-8 (a malformed
 * sequence as U+FFFD, a malformed escape stays as it is). A throw per `%ff` was 0.5 s for 64 KB of them.
 */
function decodeOnce(text: string): string {
  const spaced = text.replace(/\+/g, " ");
  if (!spaced.includes("%")) return spaced;
  if (!HIGH_ESCAPE.test(spaced)) return decodeURIComponent(spaced.replace(/%(?![0-9a-f]{2})/gi, "%25"));
  return spaced.replace(ESCAPES, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
    // A lone ASCII byte needs no decoder (most runs between high escapes are one).
    return bytes.length === 1 && bytes[0]! < 0x80 ? String.fromCharCode(bytes[0]!) : utf8.decode(bytes);
  });
}

/** `text` URL-decoded until it stops changing (at most three layers: `%2574` is `%74` is `t`). */
export function urlDecoded(text: string): string {
  let current = text;
  for (let i = 0; i < 3; i++) {
    const next = decodeOnce(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

/** Text with credential parameters and every token-shaped run (plain or encoded) replaced, cut to `max`. */
export function redactText(text: string, max = MAX_STRING): string {
  // Cut before any pattern runs, so a huge input can't make redaction expensive. A token the cut splits
  // would be too short to recognise, so the partial run touching the cut is dropped, never shown.
  const bounded = text.length > max * 2 ? withoutTrailingRun(text.slice(0, max * 2)) : text;
  // Known secrets first, in the text as given; their encoded spellings when each run is decoded below.
  const clean = hideKnown(bounded)
    .replace(PARAM, (whole, separator: string, name: string, value: string) => {
      const decoded = urlDecoded(name);
      if (CREDENTIAL_PARAM.test(decoded)) return `${separator}${encodeURIComponent(decoded).slice(0, 64)}=${REDACTED}`;
      // A value that is a typed pairing code is one under any name (`?pair=`, `?ticket=`).
      return PAIRING_TYPED.test(urlDecoded(value)) ? `${separator}${name}=${REDACTED}` : whole;
    })
    // After PARAM, so `Bearer "token"=x` is still a token parameter.
    .replace(BEARER, `$1$2${REDACTED}`)
    .replace(ENCODED_RUN, (run) => (HAS_ESCAPE.test(run) && holdsSecret(run) ? REDACTED : run))
    .replace(SECRET_VALUE, REDACTED)
    // Reversible encodings (a Basic header, a data URL), then codes standing alone (D-2).
    .replace(BASE64_RUN, redactBase64)
    .replace(PAIRING_RUN, (whole, before: string, candidate: string) =>
      codeShaped(candidate) ? `${before}${REDACTED}` : whole,
    );
  const total = clean.length + (text.length - bounded.length);
  return total <= max ? clean : `${clean.slice(0, max)}…[${total - max} more]`;
}

/** Whether `code` is a character a token-shaped run can hold: `[a-z0-9%+._~-]`, either case. */
function inRun(code: number): boolean {
  const lower = code | 0x20;
  return (
    (lower >= 0x61 && lower <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x25 ||
    code === 0x2b ||
    code === 0x2e ||
    code === 0x5f ||
    code === 0x7e ||
    code === 0x2d
  );
}

/**
 * `text` without its trailing run of token-shaped characters, scanned back from the end once. The regex
 * `/[a-z0-9%+._~-]+$/` it replaces retried every run in the text from each of its characters (quadratic).
 */
export function withoutTrailingRun(text: string): string {
  let end = text.length;
  while (end > 0 && inRun(text.charCodeAt(end - 1))) end--;
  return text.slice(0, end);
}

/** A URL's path and query with credential parameters and token-shaped segments replaced. */
export function redactUrl(url: string): string {
  return redactText(url, 256);
}

/**
 * A JSON-safe, bounded copy of `value` with secret-named fields and token-shaped strings replaced. At most
 * MAX_VALUES values and MAX_TEXT characters are read, and a cycle stops at `[cycle]`: 40 keys pointing back
 * at their object were 40⁴ visits (seconds) under the depth bound alone.
 */
export function redact(value: unknown): unknown {
  return redactValue(value, 0, { left: MAX_VALUES, text: MAX_TEXT, path: new Set() });
}

interface Walk {
  left: number;
  text: number;
  path: Set<object>;
}

/** `text` redacted to `max`, charged to the walk's text budget (what redactText reads: at most 2 × max). */
function walkText(text: string, max: number, walk: Walk): string {
  if (walk.text <= 0) return "[more]";
  walk.text -= Math.min(text.length, max * 2);
  return redactText(text, max);
}

function redactValue(value: unknown, depth: number, walk: Walk): unknown {
  if (walk.left-- <= 0) return "[more]";
  // A number can be a token's digits (an 8-digit prefix that is all decimal): checked when a token is known.
  if (
    typeof value === "number" &&
    known.size > 0 &&
    Number.isInteger(value) &&
    Math.abs(value) >= 1e7 &&
    holdsKnown(String(Math.abs(value)))
  )
    return REDACTED;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return walkText(value, MAX_STRING, walk);
  // A bigint past 40 digits is token-sized, and printing a huge one is itself slow: never printed.
  if (typeof value === "bigint")
    return value < 10n ** 40n && value > -(10n ** 40n) ? walkText(String(value), MAX_STRING, walk) : REDACTED;
  if (typeof value !== "object") return undefined;
  if (depth >= MAX_DEPTH) return "[depth]";
  if (walk.path.has(value)) return "[cycle]";
  walk.path.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ITEMS).map((item) => redactValue(item, depth + 1, walk));
      if (value.length > MAX_ITEMS) items.push(`[${value.length - MAX_ITEMS} more]`);
      return items;
    }
    if (value instanceof Error)
      return {
        name: walkText(String(value.name), 256, walk),
        message: walkText(String(value.message), MAX_STRING, walk),
        ...(value.stack === undefined ? {} : { stack: walkText(String(value.stack), 2048, walk) }),
      };
    const out: Record<string, unknown> = {};
    let n = 0;
    // `for…in`, not Object.entries: an object with 100 000 keys is not copied whole to read 40.
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (n++ >= MAX_KEYS || walk.text <= 0) {
        out["…"] = "[more keys]";
        break;
      }
      // A key over 1 KB is not decoded to look for a secret name: its value is hidden instead.
      walk.text -= Math.min(key.length, 1024);
      const decodedKey = key.length > 1024 ? "" : urlDecoded(key);
      const item = (value as Record<string, unknown>)[key];
      // A `code` field is usually an error code, kept; one holding a typed pairing code is hidden.
      const secret =
        key.length > 1024 ||
        SECRET_KEY.test(decodedKey) ||
        (CODE_KEY.test(decodedKey) && typeof item === "string" && PAIRING_TYPED.test(item.trim()));
      out[walkText(key, 64, walk)] = secret ? REDACTED : redactValue(item, depth + 1, walk);
    }
    return out;
  } finally {
    walk.path.delete(value);
  }
}
