// The HTML Content-Security-Policy (security rubric G5, R2; H5). Scripts run only by hash: each inline
// `<script>` of the bytes actually served is hashed when they are first served (`pageCsp`), so the policy
// can never drift from the page, and neither `'unsafe-inline'` nor `'unsafe-eval'` is allowed. A page with no
// inline script gets `script-src 'none'`. External scripts (`<script src>`) were never allowed (no `'self'`).
import { createHash } from "node:crypto";

/** Every directive but script-src and form-action. Workers: the web page's layout worker is its own file (`'self'`, `/-/page-assets/`); a single-file page given with `--page` carries it inline, as a blob. */
const REST =
  "worker-src 'self' blob:; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src data:; base-uri 'none'; frame-ancestors 'none'";

/**
 * `form-action` is not covered by `default-src` (C-32), so it is always named. A page that runs script may
 * submit a form only to this origin (`'self'`: the pairing form posts to `/-/pair`; the web page's forms are
 * handled by its script and never navigate). A page with no script has no form to submit (`'none'`).
 */
export function contentSecurityPolicy(scriptSources: readonly string[]): string {
  const scripted = scriptSources.length > 0;
  return `default-src 'none'; script-src ${scripted ? scriptSources.join(" ") : "'none'"}; ${REST}; form-action ${scripted ? "'self'" : "'none'"}`;
}

/** The policy of an HTML response with no inline script (refusal, not-found and loading pages; every non-HTML answer). */
export const SCRIPTLESS_CSP = contentSecurityPolicy([]);

/**
 * `'sha256-…'` of each inline script, in document order, as the browser hashes it: the element's text after
 * the HTML parser's newline normalisation (CR LF and lone CR become LF), as the page's bytes (UTF-8). Read as
 * the HTML tokenizer does for the shapes a build writes: comments are skipped, and a script's text ends at the
 * first `</script` whatever its case (a bundler escapes that sequence inside code, or the page itself would
 * break). Scripts with a `src` are not inline and get no hash.
 */
export function inlineScriptHashes(html: Buffer | string): string[] {
  const text = typeof html === "string" ? html : html.toString("latin1");
  const bytes = (part: string): Buffer =>
    typeof html === "string" ? Buffer.from(part, "utf8") : Buffer.from(part, "latin1");
  const next = /<!--|<script(?=[\s>/])([^>]*)>/gi,
    close = /<\/script/gi;
  const hashes: string[] = [];
  for (let at = 0; ; ) {
    next.lastIndex = at;
    const open = next.exec(text);
    if (open === null) return hashes;
    if (open[0] === "<!--") {
      const end = text.indexOf("-->", open.index + 4);
      if (end < 0) return hashes;
      at = end + 3;
      continue;
    }
    const start = open.index + open[0].length;
    close.lastIndex = start;
    const ended = close.exec(text);
    const end = ended === null ? text.length : ended.index;
    if (!/(^|\s)src\s*=/i.test(open[1] ?? "")) {
      const body = text.slice(start, end).replace(/\r\n?/g, "\n");
      hashes.push(`'sha256-${createHash("sha256").update(bytes(body)).digest("base64")}'`);
    }
    if (ended === null) return hashes;
    at = end;
  }
}

const policies = new WeakMap<Buffer, string>();
/** The policy for these page bytes, computed once per page buffer (the served page is read once per build). */
export function pageCsp(html: Buffer): string {
  let policy = policies.get(html);
  if (policy === undefined) {
    policy = contentSecurityPolicy(inlineScriptHashes(html));
    policies.set(html, policy);
  }
  return policy;
}
