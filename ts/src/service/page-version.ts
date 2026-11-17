// The page the service serves: the built page with the serving version stamped in, and the
// compressed copies the packager made of exactly those bytes (so a start or hot swap need not
// spend seconds of CPU on brotli).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";

/** The page with `<meta name="archer-application-version">` first in its head. */
export function withApplicationVersion(page: Buffer, applicationVersion: string): Buffer {
  const meta = `<meta name="archer-application-version" content="${applicationVersion.replace(/[^\w.+-]/g, "")}">`;
  const text = page.toString("utf8");
  const head = /<head[^>]*>/i.exec(text);
  return Buffer.from(
    head === null
      ? `${meta}${text}`
      : `${text.slice(0, head.index + head[0].length)}${meta}${text.slice(head.index + head[0].length)}`,
    "utf8",
  );
}

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Writes `<page>.gz`, `<page>.br` and `<page>.sha256` for the page as it will be served (stamped with `version`).
 * The sidecar holds three lines: the sha256 of the served bytes, of the .gz file and of the .br file.
 */
export function writePrecompressedPage(pagePath: string, version: string): void {
  writePrecompressed(pagePath, withApplicationVersion(readFileSync(pagePath), version));
}

/** Writes `<path>.gz`, `<path>.br` and `<path>.sha256` for `served`, the bytes served for `path` (the page, or a page asset). */
export function writePrecompressed(path: string, served: Buffer): void {
  const gzip = gzipSync(served, { level: 9 });
  const br = brotliCompressSync(served, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: served.length },
  });
  writeFileSync(`${path}.gz`, gzip);
  writeFileSync(`${path}.br`, br);
  writeFileSync(`${path}.sha256`, `${sha256Hex(served)}\n${sha256Hex(gzip)}\n${sha256Hex(br)}\n`);
}

/**
 * The packaged compressed copies of `served` (the page, or a page asset), or null when there are none or they were made from other bytes
 * (a dev checkout, a `pagePath` override, a page edited after packaging). The copies are checked by their recorded
 * hashes (a few ms) rather than by decoding them (40-60 ms), so a damaged file is still never served.
 */
export function readPrecompressed(
  pagePath: string,
  served: Buffer,
): { readonly gzip: Buffer; readonly br: Buffer } | null {
  try {
    if (![".gz", ".br", ".sha256"].every((ext) => existsSync(pagePath + ext))) return null;
    const [page, gz, brotli] = readFileSync(`${pagePath}.sha256`, "utf8").trim().split("\n");
    if (page !== sha256Hex(served)) return null;
    const gzip = readFileSync(`${pagePath}.gz`),
      br = readFileSync(`${pagePath}.br`);
    if (gz !== sha256Hex(gzip) || brotli !== sha256Hex(br)) return null;
    return { gzip, br };
  } catch {
    return null;
  }
}
