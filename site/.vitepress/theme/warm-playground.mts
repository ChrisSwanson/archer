/**
 * Warms the HTTP cache for the Playground from every docs page, so a click into it draws from cache (ADR 0037,
 * amendment 3). Once the page has loaded and gone idle, it reads the build's list of the first view's files
 * (`playground/app/warm.json`, derived from the build manifest by `site/scripts/playground-build.mts`) and adds a
 * `<link rel="prefetch">` for each: low priority, so it never competes with the page being read.
 * Once per session; skipped when the reader asked to save data or the connection is 2G.
 */
const DONE = "archer-playground-warmed";
const SLOW = new Set(["slow-2g", "2g"]);
/** Also held in memory, for a page whose session storage is unavailable. */
const warmedHere = new WeakSet<Window>();

type Fetch = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
interface Connection {
  readonly saveData?: boolean;
  readonly effectiveType?: string;
}

function alreadyWarmed(win: Window): boolean {
  try {
    return warmedHere.has(win) || win.sessionStorage.getItem(DONE) === "1";
  } catch {
    return warmedHere.has(win);
  }
}
function markWarmed(win: Window): void {
  warmedHere.add(win);
  try {
    win.sessionStorage.setItem(DONE, "1");
  } catch {}
}

/** A file named by the list, as a path inside the Playground's folder; anything else is dropped. */
function inside(file: unknown): file is string {
  return typeof file === "string" && /^[\w.-]+(?:\/[\w.-]+)*$/u.test(file) && !file.split("/").includes("..");
}

function afterLoadIdle(win: Window): Promise<void> {
  return new Promise((done) => {
    const idle = () => {
      const request = (
        win as Window & { requestIdleCallback?: (fn: () => void, options?: { timeout: number }) => void }
      ).requestIdleCallback;
      if (request) request(() => done(), { timeout: 5000 });
      else win.setTimeout(done, 1500);
    };
    if (win.document.readyState === "complete") idle();
    else win.addEventListener("load", idle, { once: true });
  });
}

export async function warmPlayground(
  win: Window,
  base: string,
  fetcher: Fetch = (url) => win.fetch(url),
): Promise<void> {
  if (alreadyWarmed(win)) return;
  const connection = (win.navigator as Navigator & { connection?: Connection }).connection;
  if (connection?.saveData || SLOW.has(connection?.effectiveType ?? "")) return;
  markWarmed(win);
  await afterLoadIdle(win);
  const folder = `${base}playground/app/`;
  let files: unknown;
  try {
    const response = await fetcher(`${folder}warm.json`);
    if (!response.ok) return;
    files = ((await response.json()) as { files?: unknown }).files;
  } catch {
    return;
  }
  if (!Array.isArray(files)) return;
  const head = win.document.head;
  for (const file of files.filter(inside)) {
    const link = win.document.createElement("link");
    link.rel = "prefetch";
    link.href = `${folder}${file}`;
    head.append(link);
  }
}
