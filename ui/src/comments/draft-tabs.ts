/**
 * Whose draft is whose, when one browser has several tabs of Archer open (claude-201, O103; the ownership rule of
 * 2026-11-02, ADR 0016 note, O117). One deterministic rule for comments, replies, edits of comments, the chat and the
 * diagram editor's recovery:
 *
 * 1. Each tab has its own owner id, unique among the open tabs. It is kept in `sessionStorage`, so a reload and a
 *    reopened closed tab keep it; a duplicated tab copies `sessionStorage` too, so the id is claimed before anything is
 *    restored (`tabReady`, awaited before the page renders): a tab holds its id as a Web Lock (`archer.tab.v1:<id>`)
 *    for its whole life. A tab that starts with a held id takes that lock; when a live tab answers that it holds the id
 *    (the opener of a duplicate) it takes a new id instead. Nothing is read as this tab's until that is settled.
 * 2. A tab writes and restores only its own drafts (each stored key ends in `~<owner>`).
 * 3. Another tab's draft is never restored by itself. Its owner open (its lock is held: `liveTabs`, read from the lock
 *    manager, no wait), it is said to be written in another tab and stays there. Its owner closed, it is offered, and
 *    only the person's "Use it here" moves it, with the identity its last Send was made under, in one step.
 * 4. An operation's identity belongs to the draft it was sent from (operations.ts), not to its words.
 * 5. No timing decides ownership. The one timeout here (`CLAIM_GIVE_UP_MS`) can only give this tab a NEW id, which never
 *    takes anything from another tab: at worst this tab's own earlier drafts are then offered back instead of restored.
 *
 * Where the browser has no Web Locks, every page load takes a new id and other tabs' drafts are offered (never taken).
 * So too where it has them but refuses every request: an opaque-origin frame (an MCP host's sandbox without
 * allow-same-origin) rejects `locks.request` with a SecurityError. The first refusal switches the locks off for the
 * page; before, the claim retried new ids for ever and the page never rendered (O175).
 */

import { browserStateKey } from "../runtime/address.ts";

const TAB_KEY = "archer.tab-id.v1";
const CHANNEL = "archer.tabs.v2";
export const TAB_LOCK_PREFIX = "archer.tab.v1:";
/** A start-up claim nobody answered and no lock granted in this long: take a new id (see rule 5 above). */
export const CLAIM_GIVE_UP_MS = 5000;

const newId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
const VALID = /^[0-9a-f]{16}$/;

function session(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}
/** Set once the lock manager refused a request: this page then behaves as one without Web Locks. */
let refused = false;
function lockManager(): LockManager | null {
  if (refused) return null;
  try {
    return typeof navigator !== "undefined" &&
      navigator.locks !== undefined &&
      typeof navigator.locks.request === "function"
      ? navigator.locks
      : null;
  } catch {
    return null;
  }
}

type Message = { readonly type: "who-has" | "have"; readonly id: string };

let id: string | null = null;
let ready: Promise<string> | null = null;
let channel: BroadcastChannel | null | undefined;
let testing = false;

function tabsChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  try {
    channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(browserStateKey(CHANNEL)) : null;
  } catch {
    channel = null;
  }
  // A tab that holds its id answers anyone starting with the same id (a duplicate): that one takes another.
  channel?.addEventListener("message", (event: MessageEvent<Message>) => {
    if (event.data?.type === "who-has" && id !== null && event.data.id === id && held.has(id))
      channel?.postMessage({ type: "have", id } satisfies Message);
  });
  return channel;
}

/** The ids whose lock this page holds (one; a test may switch it). */
const held = new Set<string>();

function setId(next: string): void {
  id = next;
  try {
    session()?.setItem(browserStateKey(TAB_KEY), next);
  } catch {
    /* the page's memory holds it */
  }
}

/**
 * Holds `name` for the life of the page; resolves true once granted, false when it is held elsewhere (`ifAvailable`)
 * or `signal` aborts first, and "refused" when the lock manager rejected the request without granting anything.
 */
function holdLock(locks: LockManager, name: string, options: LockOptions = {}): Promise<boolean | "refused"> {
  return new Promise((granted) => {
    let answered = false;
    locks
      .request(name, options, (lock) => {
        answered = true;
        if (lock === null) {
          granted(false);
          return undefined;
        }
        granted(true);
        return new Promise<void>(() => {
          /* held until the page goes */
        });
      })
      .catch(() => {
        if (answered) granted(false);
        else if (options.signal?.aborted === true) granted(false);
        else {
          refused = true;
          granted("refused");
        }
      });
  });
}

/** No lock to be had: an id for this page alone, as where there are no Web Locks. */
function unlocked(): string {
  setId(newId());
  return id!;
}

async function takeNew(locks: LockManager): Promise<string> {
  for (;;) {
    const next = newId();
    const got = await holdLock(locks, browserStateKey(TAB_LOCK_PREFIX) + next, { ifAvailable: true });
    if (got === "refused") return unlocked();
    if (got) {
      held.add(next);
      setId(next);
      tabsChannel()?.postMessage({ type: "have", id: next } satisfies Message);
      return next;
    }
  }
}

async function claim(): Promise<string> {
  const locks = lockManager();
  if (locks === null) return unlocked();
  let kept: string | null = null;
  try {
    kept = session()?.getItem(browserStateKey(TAB_KEY)) ?? null;
  } catch {
    kept = null;
  }
  if (kept === null || !VALID.test(kept)) return takeNew(locks);
  const want = kept;
  // Free: nobody holds it (a reload whose old page has gone, a reopened tab, a duplicate of a closed tab).
  const free = await holdLock(locks, browserStateKey(TAB_LOCK_PREFIX) + want, { ifAvailable: true });
  if (free === "refused") return unlocked();
  if (free) {
    held.add(want);
    setId(want);
    return want;
  }
  // Held: by this tab's own page still being unloaded (a reload) or by another open tab (a duplicate's opener).
  // Wait for the lock, unless the holder says it is open: then this tab takes a new id.
  const c = tabsChannel();
  const stop = new AbortController();
  const answered = new Promise<"taken">((resolve) => {
    c?.addEventListener("message", (event: MessageEvent<Message>) => {
      if (event.data?.type === "have" && event.data.id === want) resolve("taken");
    });
  });
  const giveUp = new Promise<"taken">((resolve) => setTimeout(() => resolve("taken"), CLAIM_GIVE_UP_MS));
  c?.postMessage({ type: "who-has", id: want } satisfies Message);
  const outcome = await Promise.race([
    holdLock(locks, browserStateKey(TAB_LOCK_PREFIX) + want, { signal: stop.signal }).then((ok) =>
      ok === true ? ("granted" as const) : ("taken" as const),
    ),
    answered,
    giveUp,
  ]);
  if (outcome === "granted") {
    held.add(want);
    setId(want);
    return want;
  }
  stop.abort();
  return refused ? unlocked() : takeNew(locks);
}

/** Settles this tab's owner id (rule 1): awaited before the page renders, so nothing is restored before it is known. */
export function tabReady(): Promise<string> {
  ready ??= testing && id !== null ? Promise.resolve(id) : claim();
  return ready;
}

/** This tab's owner id. Before `tabReady` has settled (tests, tools) a new one, never one read from the session. */
export function tabId(): string {
  if (id !== null) return id;
  setId(newId());
  return id!;
}

/**
 * The owner ids of the other Archer tabs open in this browser now: those holding their tab lock (no wait). Null where
 * the browser cannot say (no Web Locks): every other draft is then offered, never taken by itself.
 */
export async function liveTabs(): Promise<ReadonlySet<string> | null> {
  const locks = lockManager();
  if (locks === null) return null;
  try {
    const state = await locks.query();
    const ids = new Set<string>();
    for (const lock of state.held ?? [])
      if (lock.name?.startsWith(browserStateKey(TAB_LOCK_PREFIX)))
        ids.add(lock.name.slice(browserStateKey(TAB_LOCK_PREFIX).length));
    ids.delete(tabId());
    return ids;
  } catch {
    return null;
  }
}

/**
 * Resolves once every tab in `ids` has closed (its tab lock released; claude-408). A shared request for the lock waits
 * behind the owner's and is let go at once when granted. Never resolves where the browser has no Web Locks (no tab is
 * then seen as open in the first place).
 */
export async function whenTabsClose(ids: readonly string[]): Promise<void> {
  const locks = lockManager();
  if (locks === null)
    return new Promise<void>(() => {
      /* never */
    });
  await Promise.all(
    ids.map((owner) =>
      locks
        .request(browserStateKey(TAB_LOCK_PREFIX) + owner, { mode: "shared" }, () => undefined)
        .catch(() => undefined),
    ),
  );
}

/** Runs `work` while holding the drafts lock, so one draft is moved by one tab at a time. */
export async function withDraftsLock<T>(work: () => T): Promise<T> {
  const locks = lockManager();
  if (locks === null) return work();
  return locks.request(browserStateKey("archer.drafts.v1"), () => work());
}

/** Tests only: act as another tab (its id, no lock taken). */
export function setTabIdForTests(next: string | null): void {
  id = next;
  ready = null;
  testing = next !== null;
  if (next !== null)
    try {
      session()?.setItem(browserStateKey(TAB_KEY), next);
    } catch {
      /* ignore */
    }
}
