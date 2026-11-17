// The web page a service serves, and its own files (page-assets.ts). The page is read once, on first need, and
// names the version that serves it (ADR 0032): one loaded just before a hand-over still sees the new version.
// Its assets are read with it, from the same build. The previous build's assets are kept too: the build handing
// over, or, when that is this build, the one it kept (ADR 0032, page assets across an upgrade).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { adoptPageCopies } from "./http.ts";
import { readPageAssets, readPreviousPageAssets, type PageAsset } from "./page-assets.ts";
import { readPrecompressed, withApplicationVersion } from "./page-version.ts";

export interface PageServingOptions {
  /** The page to serve. */
  readonly path: string;
  /** The page of the build this service took over from (ServiceOptions.previousPagePath). */
  readonly previousPagePath?: string | undefined;
  /** The previous build's page the service handing over still served (ServiceOptions.retainedPagePath). */
  readonly retainedPagePath?: string | undefined;
  readonly version: () => string;
}

export class PageServing {
  readonly #path: string;
  readonly #version: () => string;
  #bytes: Buffer | null = null;
  // Read with the page, from the same build: its own files (`page-assets.ts`).
  #assets: ReadonlyMap<string, PageAsset> = new Map();
  readonly #previousAssets: ReadonlyMap<string, PageAsset>;
  /** The previous build's page whose assets are served as well; undefined when there is none. */
  readonly retainedPage: string | undefined;

  constructor(options: PageServingOptions) {
    this.#path = options.path;
    this.#version = options.version;
    // Current plus one previous build: the build handing over, or, when that is this build, the one it kept.
    this.retainedPage = [options.previousPagePath, options.retainedPagePath]
      .map((path) => (path === undefined ? undefined : resolve(path)))
      .find((path) => path !== undefined && path !== resolve(options.path));
    this.#previousAssets =
      this.retainedPage === undefined ? new Map<string, PageAsset>() : readPreviousPageAssets(this.retainedPage);
  }

  /** The page's bytes, read on first need; throws when the page cannot be read. */
  page(): Buffer {
    if (this.#bytes === null) {
      const built = readFileSync(this.#path);
      this.#assets = readPageAssets(this.#path, built.toString("latin1"));
      this.#bytes = withApplicationVersion(built, this.#version());
      const packaged = readPrecompressed(this.#path, this.#bytes);
      if (packaged !== null) adoptPageCopies(this.#bytes, packaged.gzip, packaged.br);
    }
    return this.#bytes;
  }

  /** An asset the current page names, else one the previous build's names; null when neither, or the page is unreadable. */
  asset(name: string): PageAsset | null {
    try {
      this.page();
    } catch {
      return null;
    }
    return this.#assets.get(name) ?? this.#previousAssets.get(name) ?? null;
  }
}
