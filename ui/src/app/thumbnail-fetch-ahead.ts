/**
 * Fetch-ahead of the CURRENT project's first screen of diagram thumbnails, once the reader reaches
 * for the gallery (a pointer over, or focus on, a control marked `GALLERY_INTENT`: the Diagrams tab)
 * and the page has settled and is idle: the browser's image cache is filled with those cards'
 * thumbnails, so opening the project's Diagrams tab finds them there (the service answers each
 * address immutably; `serviceThumbnailUrl` spells the one address a card will use). A page whose
 * reader never reaches for the gallery asks for none (PF-4: it cost every other page of the project
 * 12 images, ~160 KB).
 *
 * It must never slow the page it runs on, nor look like a misbehaving client:
 *   - only the current project, and only its first `FETCH_AHEAD_LIMIT` cards: asking for every
 *     project's cards cost each page ~25 requests (400 KB) and tripped `svc.request-burst`;
 *   - at most `FETCH_AHEAD_LIMIT` asks per page in all, counted here, however often the catalog
 *     changes, so it can never add up to a burst;
 *   - nothing starts before the page's own requests have settled and the main thread is idle;
 *   - low priority, at most `MAX_IN_FLIGHT` at once, starts paced to `MIN_START_GAP_MS`;
 *   - each address is asked for once per page (shared with `prefetchServiceThumbnails`) and once per
 *     browser session (sessionStorage), so neither `ui.fetch-duplicate` nor `svc.duplicate-request`
 *     can see it twice; the catalog it reads is the page's own read (no listing is read for it);
 *   - none in the MCP host embed (no HTTP), with Save-Data, on a coarse pointer or a screen under
 *     600px (a phone pays for every byte and shows few cards), while the page is hidden or the browser
 *     is offline (an ask sent offline fails, logs a console error and spends its address for the
 *     page), or while the page is an editor (`?edit`, `/-/edit/`); the asks wait until the page reads
 *     again.
 */
import { claimThumbnail, serviceThumbnailUrl, THUMBNAIL_PREFETCH_LIMIT } from "./document-previews";
import type { FileRow } from "./file-index";
import type { ProjectLifecycle } from "./project-lifecycle";
import { thumbnailVersion } from "./thumbnail-version";
import { browserStateKey } from "../runtime/address.ts";

export const MAX_IN_FLIGHT = 2;
/** The first screen of cards: half the Diagrams tab's own two-screen prefetch. Also the page's whole budget. */
export const FETCH_AHEAD_LIMIT = Math.ceil(THUMBNAIL_PREFETCH_LIMIT / 2);
/** A phone or a narrow window: fetch-ahead is not worth its bytes there. */
const SMALL_SCREEN_QUERY = "(pointer: coarse), (max-width: 599.98px)";
/** 40 starts per 5 s at most. */
export const MIN_START_GAP_MS = 125;
/** How long the page's requests must have been quiet before the first ask. */
const QUIET_MS = 500;
/** Asking anyway after this long, if the page never goes quiet (a busy live page). */
const SETTLE_LIMIT_MS = 8_000;
const IDLE_TIMEOUT_MS = 2_000;
/** A thumbnail that never answers gives its slot back after this long. */
const LOAD_TIMEOUT_MS = 15_000;
const SESSION_KEY = "archer.thumbnails-ahead.";
/** How often an editor page checks whether it reads again. */
const EDITING_RECHECK_MS = 5_000;

export type FetchAheadProject = {
  readonly slug: string;
  readonly lifecycle: ProjectLifecycle;
  readonly views: readonly { readonly id: string; readonly registration?: string; readonly modelRevision?: string }[];
};

/** What the fetch-ahead needs from the page; the browser's by default, scripted in tests. */
export type FetchAheadEnvironment = {
  /** Runs `run` once the reader reaches for the gallery (`whenGalleryWanted`). */
  readonly whenWanted: (run: () => void) => () => void;
  /** Runs `run` once the page has loaded and its requests have been quiet a while. */
  readonly whenSettled: (run: () => void) => () => void;
  /** Runs `run` when the main thread is idle, no sooner than `delayMs` from now. */
  readonly whenIdle: (run: () => void, delayMs?: number) => () => void;
  readonly onVisible: (run: () => void) => () => void;
  readonly hidden: () => boolean;
  /** The browser says it is offline (`navigator.onLine`). */
  readonly offline: () => boolean;
  readonly onOnline: (run: () => void) => () => void;
  readonly saveData: () => boolean;
  /** A coarse pointer or a screen under 600px. */
  readonly smallScreen: () => boolean;
  readonly embedded: () => boolean;
  /** The page is an editor: the fetch-ahead waits until it reads again. */
  readonly editing: () => boolean;
  readonly now: () => number;
  readonly storage: Pick<Storage, "getItem" | "setItem"> | null;
  /** Fetches one image at `priority`; true when it loaded. */
  readonly load: (url: string, priority: "low") => Promise<boolean>;
};

type Job = { readonly slug: string; readonly url: string };

let queue: Job[] = [];
let inFlight = 0;
let lastStart = -Infinity;
/** Asks started on this page: never more than `FETCH_AHEAD_LIMIT`. */
let started = 0;
let scheduled: (() => void) | null = null;
let waitingToSettle = false;
let settled = false;
let wanted = false;
let waitingForWant = false;
let env: FetchAheadEnvironment | null = null;

/** A short, stable token for one address (FNV-1a, 32 bit): the session record holds tokens, not URLs. */
function token(url: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) hash = Math.imul(hash ^ url.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(36);
}

function sessionDone(storage: FetchAheadEnvironment["storage"], slug: string): Set<string> {
  try {
    const value: unknown = JSON.parse(storage?.getItem(browserStateKey(SESSION_KEY + slug)) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
  } catch {
    return new Set();
  }
}

function markDone(storage: FetchAheadEnvironment["storage"], slug: string, url: string): void {
  const done = [...sessionDone(storage, slug), token(url)].slice(-4 * THUMBNAIL_PREFETCH_LIMIT);
  try {
    storage?.setItem(browserStateKey(SESSION_KEY + slug), JSON.stringify([...new Set(done)]));
  } catch {
    /* storage unavailable: asked again next session */
  }
}

/**
 * Queues the current project's first screen of thumbnails and starts once the page is settled and
 * idle. Called again with a newer catalog, it adds what changed, within the page's budget; what is
 * already asked for, this page or this session, is not asked for again.
 */
export function fetchThumbnailsAhead(
  projects: readonly FetchAheadProject[],
  options: {
    readonly baseUrl: string;
    readonly theme: "light" | "dark";
    readonly currentSlug: string | null;
    readonly environment?: FetchAheadEnvironment;
  },
): void {
  const environment = options.environment ?? browserEnvironment();
  if (
    environment === null ||
    environment.embedded() ||
    environment.saveData() ||
    environment.smallScreen() ||
    thumbnailVersion() === undefined
  )
    return;
  const project = projects.find((candidate) => candidate.slug === options.currentSlug);
  if (project === undefined || project.lifecycle.visibility === "hidden") return;
  env = environment;
  const queued = new Set(queue.map((job) => job.url));
  const done = sessionDone(environment.storage, project.slug);
  let taken = 0;
  for (const view of project.views) {
    if (taken >= FETCH_AHEAD_LIMIT) break;
    if (view.modelRevision === undefined) continue;
    const url = serviceThumbnailUrl(
      {
        kind: "diagram",
        failing: false,
        slug: project.slug,
        current: true,
        id: view.id,
        modelRevision: view.modelRevision,
      } as FileRow,
      options.baseUrl,
      options.theme,
    );
    if (url === null) continue;
    taken += 1;
    if (done.has(token(url)) || queued.has(url)) continue;
    queued.add(url);
    queue.push({ slug: project.slug, url });
  }
  if (queue.length > 0) start(environment);
}

function start(environment: FetchAheadEnvironment): void {
  if (!wanted) {
    if (waitingForWant) return;
    waitingForWant = true;
    environment.whenWanted(() => {
      waitingForWant = false;
      wanted = true;
      if (env === environment) start(environment);
    });
    return;
  }
  if (settled) {
    schedule(environment, 0);
    return;
  }
  if (waitingToSettle) return;
  waitingToSettle = true;
  environment.whenSettled(() => {
    waitingToSettle = false;
    settled = true;
    schedule(environment, 0);
  });
}

function schedule(environment: FetchAheadEnvironment, delayMs: number): void {
  if (scheduled !== null) return;
  scheduled = environment.whenIdle(() => {
    scheduled = null;
    pump(environment);
  }, delayMs);
}

function pump(environment: FetchAheadEnvironment): void {
  if (env !== environment || queue.length === 0 || inFlight >= MAX_IN_FLIGHT) return;
  if (started >= FETCH_AHEAD_LIMIT) {
    queue = [];
    return;
  }
  if (environment.hidden()) {
    // Shown again, the page may be busy with what it was shown for: settle again first.
    settled = false;
    environment.onVisible(() => start(environment));
    return;
  }
  if (environment.offline()) {
    // Back online, the page catches up on what it missed first: settle again.
    settled = false;
    environment.onOnline(() => start(environment));
    return;
  }
  if (environment.editing()) {
    schedule(environment, EDITING_RECHECK_MS);
    return;
  }
  const wait = lastStart + MIN_START_GAP_MS - environment.now();
  if (wait > 0) {
    schedule(environment, wait);
    return;
  }
  const job = queue.shift()!;
  // Asked for already on this page (the Diagrams tab's prefetch, or a card): nothing to do.
  if (!claimThumbnail(job.url)) {
    schedule(environment, 0);
    return;
  }
  inFlight += 1;
  started += 1;
  lastStart = environment.now();
  void environment
    .load(job.url, "low")
    .catch(() => false)
    .then((loaded) => {
      inFlight -= 1;
      if (loaded) markDone(environment.storage, job.slug, job.url);
      if (env === environment) schedule(environment, 0);
    });
  if (inFlight < MAX_IN_FLIGHT) schedule(environment, MIN_START_GAP_MS);
}

/** For tests: forget the queue and every timer's claim on it. */
export function forgetThumbnailFetchAhead(): void {
  queue = [];
  inFlight = 0;
  lastStart = -Infinity;
  started = 0;
  scheduled = null;
  browser = undefined;
  waitingToSettle = false;
  settled = false;
  wanted = false;
  waitingForWant = false;
  env = null;
}

/** The attribute that marks a control opening the project's diagram gallery (the Diagrams tab). */
export const GALLERY_INTENT = "data-gallery-intent";

/**
 * Runs `run` once, the first time a pointer comes over or focus lands on a control marked
 * `GALLERY_INTENT` in `doc`: the reader reaching for the gallery. Returns a function that calls it off.
 */
export function whenGalleryWanted(doc: Document, run: () => void): () => void {
  const reached = (event: Event): void => {
    const target = event.target as Element | null;
    if (typeof target?.closest !== "function" || target.closest(`[${GALLERY_INTENT}]`) === null) return;
    stop();
    run();
  };
  const stop = (): void => {
    doc.removeEventListener("pointerover", reached, true);
    doc.removeEventListener("focusin", reached, true);
  };
  doc.addEventListener("pointerover", reached, true);
  doc.addEventListener("focusin", reached, true);
  return stop;
}

let browser: FetchAheadEnvironment | null | undefined;

/** The browser's page; null where there is none to fetch in (a test environment without `Image`). */
function browserEnvironment(): FetchAheadEnvironment | null {
  if (browser !== undefined) return browser;
  if (typeof window === "undefined" || typeof document === "undefined" || typeof Image === "undefined")
    return (browser = null);
  const idle = (run: () => void, delayMs = 0): (() => void) => {
    let cancelIdle: (() => void) | null = null;
    const timer = setTimeout(() => {
      if (typeof window.requestIdleCallback === "function") {
        const handle = window.requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
        cancelIdle = () => window.cancelIdleCallback(handle);
      } else {
        const handle = setTimeout(run, 50);
        cancelIdle = () => clearTimeout(handle);
      }
    }, delayMs);
    return () => {
      clearTimeout(timer);
      cancelIdle?.();
    };
  };
  return (browser = {
    whenWanted: (run) => whenGalleryWanted(document, run),
    whenSettled: (run) => whenQuiet(run),
    whenIdle: idle,
    onVisible: (run) => {
      const shown = (): void => {
        if (document.visibilityState === "visible") {
          document.removeEventListener("visibilitychange", shown);
          run();
        }
      };
      document.addEventListener("visibilitychange", shown);
      return () => document.removeEventListener("visibilitychange", shown);
    },
    hidden: () => document.visibilityState === "hidden",
    offline: () => navigator.onLine === false,
    onOnline: (run) => {
      window.addEventListener("online", run, { once: true });
      return () => window.removeEventListener("online", run);
    },
    smallScreen: () => typeof window.matchMedia === "function" && window.matchMedia(SMALL_SCREEN_QUERY).matches,
    saveData: () =>
      (navigator as Navigator & { readonly connection?: { readonly saveData?: boolean } }).connection?.saveData ===
      true,
    embedded: () => window.location.protocol !== "http:" && window.location.protocol !== "https:",
    editing: () =>
      new URLSearchParams(window.location.search).has("edit") || /\/-\/edit(\/|$)/.test(window.location.pathname),
    now: () => performance.now(),
    storage: (() => {
      try {
        return window.sessionStorage;
      } catch {
        return null;
      }
    })(),
    load: (url, priority) =>
      new Promise<boolean>((done) => {
        const image = new Image();
        const timer = setTimeout(() => done(false), LOAD_TIMEOUT_MS);
        image.onload = () => {
          clearTimeout(timer);
          done(true);
        };
        image.onerror = () => {
          clearTimeout(timer);
          done(false);
        };
        image.decoding = "async";
        image.fetchPriority = priority;
        image.src = url;
      }),
  });
}

/**
 * After the load event, once no resource has finished for `QUIET_MS` (the page's own reads, its
 * scripts and images, seen through Resource Timing), or after `SETTLE_LIMIT_MS` whatever happens.
 */
function whenQuiet(run: () => void): () => void {
  let done = false,
    observer: PerformanceObserver | null = null,
    quiet: ReturnType<typeof setTimeout> | undefined,
    limit: ReturnType<typeof setTimeout> | undefined;
  const finish = (): void => {
    if (done) return;
    done = true;
    observer?.disconnect();
    clearTimeout(quiet);
    clearTimeout(limit);
    window.removeEventListener("load", loaded);
    run();
  };
  const rearm = (): void => {
    clearTimeout(quiet);
    quiet = setTimeout(finish, QUIET_MS);
  };
  function loaded(): void {
    limit = setTimeout(finish, SETTLE_LIMIT_MS);
    try {
      observer = new PerformanceObserver(rearm);
      observer.observe({ type: "resource" });
    } catch {
      observer = null;
    }
    rearm();
  }
  if (document.readyState === "complete") loaded();
  else window.addEventListener("load", loaded, { once: true });
  return () => {
    done = true;
    observer?.disconnect();
    clearTimeout(quiet);
    clearTimeout(limit);
    window.removeEventListener("load", loaded);
  };
}
