/**
 * Playwright global setup: the built page and its assets get the compressed copies the packager
 * makes (`ts/scripts/bundle.ts`), so each test's service serves them as an installed one does.
 *
 * Without them every service a worker starts (one per test) compressed the 2.4 MB page and the 1.5 MB
 * layout worker at brotli q11 on first load: about 5 s each of a libuv thread, uncancellable and
 * outliving the service. A worker's four pool threads filled up across tests, and every later
 * compressed answer queued behind them; on a loaded CI host the project catalog missed the page's
 * 10 s read deadline (O33).
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { namedPageAssets, PAGE_ASSETS_DIR } from "../../../../shared/page-assets.mts";
import {
  readPrecompressed,
  withApplicationVersion,
  writePrecompressed,
} from "../../../../ts/src/service/page-version.ts";
import { version } from "../../../../ts/src/version.ts";

export default function precompressPage(): void {
  const page = process.env["ARCHER_PAGE"] ?? resolve(import.meta.dirname, "../../../dist/index.html");
  let built: Buffer;
  try {
    built = readFileSync(page);
  } catch {
    return;
  } // Unbuilt: the tests report it themselves.
  const served = withApplicationVersion(built, version());
  if (readPrecompressed(page, served) === null) writePrecompressed(page, served);
  for (const name of namedPageAssets(built.toString("latin1"))) {
    const path = join(dirname(page), PAGE_ASSETS_DIR, name);
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      continue;
    }
    if (readPrecompressed(path, bytes) === null) writePrecompressed(path, bytes);
  }
}
