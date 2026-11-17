// The P12 scanner (security rubric R9): every spelling of a seeded secret a log could hold, and a scan
// of collected channels that reports only where a secret was found — kind, form, channel, location —
// never the secret itself.

export type SecretKind = "service-token" | "grant" | "pairing-code" | "ca-key-path" | "ca-key" | "tls-key";
export type Form = "raw" | "url-encoded" | "percent-every-byte" | "base64" | "base64url" | "prefix-8" | "canonical";

export interface Secret {
  readonly kind: SecretKind;
  readonly value: string;
}
export interface Needle {
  readonly kind: SecretKind;
  readonly form: Form;
  readonly text: string;
}
/** One collected record: a log line, a JSON entry, a response. `location` names it without its content. */
export interface Record_ {
  readonly channel: string;
  readonly location: string;
  readonly text: string;
}
export interface Hit {
  readonly kind: SecretKind;
  readonly form: Form;
  readonly channel: string;
  readonly location: string;
}

const percentEvery = (text: string, upper: boolean): string =>
  [...Buffer.from(text, "utf8")]
    .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
    .map((e) => (upper ? e.toUpperCase() : e))
    .join("");

/**
 * The spellings scanned for. A path is not prefix-scanned (its first 8 characters are the temp root every
 * path shares); key material is scanned as a 48-character run from the middle of its PEM body, which is
 * what any copy of the key must contain.
 */
export function needles(secret: Secret): Needle[] {
  const out: Needle[] = [];
  const add = (form: Form, text: string): void => {
    if (text.length > 0 && !out.some((n) => n.text === text && n.form === form))
      out.push({ kind: secret.kind, form, text });
  };
  if (secret.kind === "ca-key" || secret.kind === "tls-key") {
    const body = secret.value.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    const run = body.slice(Math.floor(body.length / 2), Math.floor(body.length / 2) + 48);
    add("raw", run);
    add("url-encoded", encodeURIComponent(run));
    return out;
  }
  const value = secret.value;
  add("raw", value);
  add("url-encoded", encodeURIComponent(value));
  add("percent-every-byte", percentEvery(value, false));
  add("percent-every-byte", percentEvery(value, true));
  const b64 = Buffer.from(value, "utf8").toString("base64");
  add("base64", b64);
  add("base64", b64.replace(/=+$/, ""));
  add("base64url", Buffer.from(value, "utf8").toString("base64url"));
  if (secret.kind === "pairing-code") {
    const canonical = value.replace(/-/g, "");
    add("canonical", canonical);
    add("canonical", canonical.toLowerCase());
    add("prefix-8", value.slice(0, 8));
  } else if (secret.kind !== "ca-key-path") {
    add("prefix-8", value.slice(0, 8));
    add("prefix-8", value.slice(0, 8).toUpperCase());
  }
  return out;
}

/** Every (secret, form) found in every record, case-sensitively except where the form says otherwise. */
export function scan(records: readonly Record_[], secrets: readonly Secret[]): Hit[] {
  const all = secrets.flatMap(needles);
  const hits: Hit[] = [];
  for (const record of records)
    for (const needle of all)
      if (record.text.includes(needle.text))
        hits.push({ kind: needle.kind, form: needle.form, channel: record.channel, location: record.location });
  return hits;
}

/** Hits grouped as `channel location kind/form` strings: safe to print, and what an assertion compares. */
export const described = (hits: readonly Hit[]): string[] =>
  [...new Set(hits.map((hit) => `${hit.channel} ${hit.location} <redacted:${hit.kind}>/${hit.form}`))].sort();

/** A key is printed only when it cannot hold a secret: short, word characters, no 8-hex run. */
const safeKey = (key: string): string =>
  key.length <= 24 && /^[A-Za-z_][\w-]*$/.test(key) && !/[0-9a-f]{8}/i.test(key) ? key : `<key ${key.length} chars>`;

/** Records of a JSON value: one per leaf string or key, located by its JSON path (keys count too). */
export function jsonRecords(channel: string, value: unknown, path = "$"): Record_[] {
  if (typeof value === "string") return [{ channel, location: path, text: value }];
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item, i) => jsonRecords(channel, item, `${path}[${i}]`));
  return Object.entries(value).flatMap(([key, item], i) => [
    { channel, location: `${path}{key ${safeKey(key) === key ? key : `#${i}`}}`, text: key },
    ...jsonRecords(channel, item, `${path}.${safeKey(key) === key ? key : `<key #${i}>`}`),
  ]);
}

/** Records of text lines, located by line number. */
export const lineRecords = (channel: string, lines: readonly string[]): Record_[] =>
  lines.map((text, i) => ({ channel, location: `line ${i + 1}`, text }));
