// The page CSP's script hashes (G5, R2, H5): computed from the bytes served, as the browser hashes them.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { contentSecurityPolicy, inlineScriptHashes, pageCsp } from "../../src/service/page-csp.ts";

const sha = (text: string): string => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

test("each inline script is hashed in order; comments, external scripts and script-like text in code are not scripts", () => {
  const html = `<!doctype html><!-- <script>no()</script> --><script type="module" crossorigin>let s = "<script>"; f("\\x3C/script>")</script>
<script src="/x.js"></script><SCRIPT>b()</SCRIPT ><script
data-x="1">c()</script>`;
  expect(inlineScriptHashes(html)).toEqual([sha('let s = "<script>"; f("\\x3C/script>")'), sha("b()"), sha("c()")]);
});

test("CR LF and lone CR are hashed as LF, as the HTML parser normalises them; UTF-8 bytes hash alike from a Buffer or a string", () => {
  expect(inlineScriptHashes("<script>a()\r\nb()\rc()</script>")).toEqual([sha("a()\nb()\nc()")]);
  const html = "<script>label('Größe — 図')</script>";
  expect(inlineScriptHashes(Buffer.from(html, "utf8"))).toEqual([sha("label('Größe — 図')")]);
  expect(inlineScriptHashes(html)).toEqual(inlineScriptHashes(Buffer.from(html, "utf8")));
});

test("no inline script is script-src 'none'; the policy never allows 'unsafe-inline' or 'unsafe-eval'", () => {
  expect(contentSecurityPolicy([])).toContain("script-src 'none';");
  const policy = pageCsp(Buffer.from("<script>x()</script>"));
  expect(policy).toContain(`script-src ${sha("x()")};`);
  expect(/script-src ([^;]*)/.exec(policy)?.[1]).not.toMatch(/unsafe-(inline|eval)/);
  expect(policy).toContain("base-uri 'none'");
  expect(policy).toContain("frame-ancestors 'none'");
  // C-32: default-src does not cover form-action, so every HTML policy names it.
  expect(policy).toMatch(/; form-action 'self'$/);
  expect(contentSecurityPolicy([])).toMatch(/; form-action 'none'$/);
});

const built = join(import.meta.dirname, "../../../ui/dist/index.html");
test.runIf(existsSync(built))(
  "the built page has an inline script to hash, and neither it nor its layout worker calls eval or new Function",
  () => {
    const page = readFileSync(built);
    expect(inlineScriptHashes(page).length).toBeGreaterThan(0);
    const assets = join(built, "..", "page-assets");
    const sources = [
      page.toString("latin1"),
      ...(existsSync(assets) ? readdirSync(assets).map((name) => readFileSync(join(assets, name), "latin1")) : []),
    ];
    for (const source of sources) expect(source).not.toMatch(/[^\w$.]eval\(|new Function\(|[^\w$.]Function\(["'`]/);
  },
);
