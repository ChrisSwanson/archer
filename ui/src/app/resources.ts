import { runtime } from "./runtime.ts";
/**
 * The page's one read layer: every shared question the page asks the service (the project catalog, comment activity,
 * the authoring status, a note's diagram, the file route's listings) is one entry here, by key.
 *
 * - One request per question: a read while one for the key is in flight joins it and makes no request of its own.
 *   Only the reader that starts a request tags it with its poll tick (`withPollTag`): a tick that joins another's
 *   read, or one inside `freshMs` of an answer (which takes that answer), makes no request.
 * - An event or an edit overtakes a read (`supersede`): a read that set out before it lands as `Superseded` and is
 *   never held or heard; anyone reading after it starts a read of their own. `stale` and `standing` only say the
 *   held answer is no longer fresh: the next reader reads, and a read in flight still serves.
 * - A conditional policy sends the held ETag: a 304 is the held answer, the same object. A 200 whose text is the
 *   held text keeps the held body too, so nothing built from it rebuilds.
 * - Bounded: at most `maxEntries` entries and `maxBytes` of answer text, least recently used first. A read in flight,
 *   an entry someone listens to and the entry just answered are never dropped.
 * API answers stay `no-store` (ADR 0014): the page keeps its own copy here, the browser keeps none.
 */
import { type PollTag, withPollTag } from "./polls.ts";

/** What identifies a question: its absolute URL, or a name for it when readers ask it at different URLs. */
export type ResourceKey = string;
export type Answer<T> = {
  readonly body: T;
  readonly etag: string | null;
  /** The service's publication count the answer was given at (`x-archer-event-seq`), or null. */
  readonly seq: number | null;
  /** When it was answered (a 304 keeps the answer it confirms, and its time). */
  readonly at: number;
};
/** A read an event or an edit overtook. `late` is what it was answered, for a reader that asked before the change. */
export type Superseded<T = unknown> = { readonly superseded: true; readonly late?: Answer<T> };
export type ResourceKind =
  | "inventory"
  | "compile"
  | "presentation"
  | "emphasis"
  | "comments"
  | "comment-activity"
  | "notes"
  | "note-emphasis"
  | "documents"
  | "catalog"
  | "walkthroughs"
  | "authoring-status"
  | "view"
  | "listeners";
export interface ResourcePolicy<T> {
  readonly kind: ResourceKind;
  /** How long an answer serves every reader without a request. */
  readonly freshMs: number;
  /** Send the held ETag (`if-none-match`); a 304 is the held answer. */
  readonly conditional?: boolean;
  /**
   * The body of an answer (any status but a 304 to a conditional read): `raw` is its JSON (undefined when it is
   * none), `text` as sent. Undefined when it is no answer to the question: the read fails. It may throw its own error.
   */
  readonly parse: (raw: unknown, response: Response, text: string) => T | undefined | Promise<T | undefined>;
  /** The revision an answer was given at, for readers that know which one they need (`ReadOptions.revision`). */
  readonly revision?: (body: T) => string | undefined;
}
export type Transport = (url: string, init: RequestInit) => Promise<Response>;
export interface ReadOptions {
  /** The tick asking (app/polls.ts): sent on the request only when this read starts it. */
  readonly poll?: PollTag | undefined;
  readonly signal?: AbortSignal | undefined;
  /**
   * The revision the reader knows: a held answer at another one is not taken, and a read joined in flight that
   * answers at another one is read once more. Without one, any fresh answer serves.
   */
  readonly revision?: string | undefined;
  /** What `supersede(kind, scope)` names, besides the kind. */
  readonly scope?: string | undefined;
  /** This read's fetch, when not the store's (a caller's own fetcher). */
  readonly fetch?: Transport | undefined;
  /** Where to ask, when the key is not the URL. */
  readonly url?: string | undefined;
}
export interface ResourceStore {
  read<T>(key: ResourceKey, policy: ResourcePolicy<T>, opts?: ReadOptions): Promise<Answer<T> | Superseded<T>>;
  peek<T>(key: ResourceKey): Answer<T> | undefined;
  /** The read of `key` in flight, if any: joined without starting one. */
  flight<T>(key: ResourceKey): Promise<Answer<T> | Superseded<T>> | undefined;
  /** The held answer, once: it is forgotten as it is handed over. */
  take<T>(key: ResourceKey): Answer<T> | undefined;
  /** Hears every answer `key`'s reads bring (not a superseded one, not a `replace`). */
  subscribe<T>(key: ResourceKey, fn: (answer: Answer<T>) => void): () => void;
  /** An event or edit changed `kind` (in `scope`): reads out now are overtaken, held answers stale. */
  supersede(kind: ResourceKind, scope?: string): void;
  /** Held answers of `kind` are stale: the next reader reads (a read in flight still serves). */
  stale(kind: ResourceKind): void;
  /** The service has published `seq`: answers given before it are stale. */
  standing(seq: number): void;
  /** Changes the held body (an acknowledged edit): no longer fresh, its ETag and text dropped, nobody told. */
  replace<T>(key: ResourceKey, update: (held: T) => T): void;
  /** Forgets every entry (or those whose key starts with `prefix`). */
  forget(prefix?: string): void;
}

/** The service's publication count a response was answered at (`x-archer-event-seq`), or null when it names none. */
export function eventSeqOf(response: {
  readonly headers?: { get(name: string): string | null } | undefined;
}): number | null {
  const raw = response.headers?.get?.("x-archer-event-seq") ?? null;
  const seq = raw === null ? Number.NaN : Number(raw);
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : null;
}

/** A body read: the answered one, or the one a superseded read was given (for a reader that asked before it). */
export const bodyOf = <T>(result: Answer<T> | Superseded<T>): T | undefined =>
  "superseded" in result ? result.late?.body : result.body;

type Flight = { readonly promise: Promise<Answer<unknown> | Superseded>; readonly epoch: string };
type Entry = {
  kind?: ResourceKind;
  scope?: string | undefined;
  answer?: Answer<unknown>;
  /** The held answer's text, null once `replace` changed its body. */
  text?: string | null;
  /** When the held answer was last given or confirmed. */
  checked: number;
  stale?: boolean;
  flight?: Flight;
};

export function createResourceStore(
  transport: Transport,
  limits: { readonly maxEntries: number; readonly maxBytes: number },
): ResourceStore {
  // A property, not a local: the leak gate (tools/perf/leak-declared-caches.json) names a declared cache by a name on
  // its retainer path, and a minified page keeps property names but not local ones.
  const storeCache = { resourceStoreEntries: new Map<ResourceKey, Entry>() };
  const listeners = new Map<ResourceKey, Set<(answer: Answer<unknown>) => void>>();
  const epochs = new Map<string, number>();
  let standingSeq = -1;
  const epochOf = (kind: ResourceKind, scope: string | undefined): string =>
    `${epochs.get(kind) ?? 0}.${scope === undefined ? "" : (epochs.get(`${kind}\0${scope}`) ?? 0)}`;
  const touch = (key: ResourceKey, entry: Entry): void => {
    storeCache.resourceStoreEntries.delete(key);
    storeCache.resourceStoreEntries.set(key, entry);
  };
  const prune = (keep: ResourceKey): void => {
    let bytes = 0;
    for (const entry of storeCache.resourceStoreEntries.values()) bytes += entry.text?.length ?? 0;
    for (const [key, entry] of storeCache.resourceStoreEntries) {
      if (storeCache.resourceStoreEntries.size <= limits.maxEntries && bytes <= limits.maxBytes) return;
      if (key === keep || entry.flight !== undefined || listeners.has(key)) continue;
      bytes -= entry.text?.length ?? 0;
      storeCache.resourceStoreEntries.delete(key);
    }
  };
  const fresh = (entry: Entry, policy: ResourcePolicy<unknown>, revision: string | undefined): boolean =>
    entry.answer !== undefined &&
    !entry.stale &&
    Date.now() - entry.checked < policy.freshMs &&
    (revision === undefined || policy.revision?.(entry.answer.body) === revision);

  function start(key: ResourceKey, entry: Entry, policy: ResourcePolicy<unknown>, opts: ReadOptions): Flight {
    const epoch = epochOf(policy.kind, opts.scope);
    const held = entry.answer;
    const validator = policy.conditional && entry.text !== null ? (held?.etag ?? null) : null;
    const signal = opts.signal;
    const ask = (async (): Promise<Answer<unknown> | Superseded> => {
      const response = await (opts.fetch ?? transport)(
        opts.url ?? key,
        withPollTag(
          {
            cache: "no-store",
            ...(signal === undefined ? {} : { signal }),
            ...(validator === null ? {} : { headers: { "if-none-match": validator } }),
          },
          opts.poll,
        ),
      );
      const etag = response.headers?.get?.("etag") ?? null;
      const seq = eventSeqOf(response);
      let answer: Answer<unknown>;
      let text: string | null | undefined = entry.text;
      if (response.status === 304 && validator !== null && held !== undefined) answer = held;
      else {
        text = typeof response.text === "function" ? await response.text() : JSON.stringify(await response.json());
        if (response.ok && held !== undefined && entry.text === text)
          answer = { body: held.body, etag, seq, at: Date.now() };
        else {
          let raw: unknown;
          try {
            raw = JSON.parse(text);
          } catch {
            raw = undefined;
          }
          const body = await policy.parse(raw, response, text);
          if (body === undefined) throw new Error(`HTTP ${response.status}: no answer to ${opts.url ?? key}`);
          answer = { body, etag, seq, at: Date.now() };
        }
      }
      if (signal?.aborted) throw signal.reason;
      if (epochOf(policy.kind, opts.scope) !== epoch) return { superseded: true, late: answer };
      entry.answer = answer;
      entry.text = text;
      entry.checked = Date.now();
      entry.stale = answer.seq !== null && answer.seq < standingSeq;
      for (const listener of [...(listeners.get(key) ?? [])]) listener(answer);
      return answer;
    })();
    // A read its starter gave up on (a deadline, a stalled body) is over for everyone who joined it, too.
    const promise =
      signal === undefined
        ? ask
        : Promise.race([
            ask,
            new Promise<never>((_, reject) => {
              const stop = (): void => reject(signal.reason);
              if (signal.aborted) stop();
              else signal.addEventListener("abort", stop, { once: true });
            }),
          ]);
    const flight: Flight = { promise, epoch };
    entry.flight = flight;
    entry.kind = policy.kind;
    entry.scope = opts.scope;
    const done = (): void => {
      if (entry.flight === flight) delete entry.flight;
      if (
        entry.answer === undefined &&
        entry.flight === undefined &&
        storeCache.resourceStoreEntries.get(key) === entry
      )
        storeCache.resourceStoreEntries.delete(key);
      else prune(key);
    };
    promise.then(done, done);
    return flight;
  }

  const store: ResourceStore = {
    async read<T>(key: ResourceKey, policy: ResourcePolicy<T>, opts: ReadOptions = {}) {
      const loose = policy as ResourcePolicy<unknown>;
      let entry = storeCache.resourceStoreEntries.get(key);
      if (entry === undefined) entry = { checked: 0 };
      touch(key, entry);
      const current = entry.flight?.epoch === epochOf(policy.kind, opts.scope) ? entry.flight : undefined;
      if (current === undefined && fresh(entry, loose, opts.revision)) return entry.answer as Answer<T>;
      const flight = current ?? start(key, entry, loose, opts);
      const result = (await flight.promise) as Answer<T> | Superseded<T>;
      // Joined (or held) at another revision than the reader knows: once more, joining a newer read if one is out.
      if (
        current === undefined ||
        opts.revision === undefined ||
        "superseded" in result ||
        policy.revision?.(result.body) === opts.revision
      )
        return result;
      const now = storeCache.resourceStoreEntries.get(key) ?? entry;
      touch(key, now);
      const next =
        now.flight !== undefined && now.flight !== flight && now.flight.epoch === epochOf(policy.kind, opts.scope)
          ? now.flight
          : start(key, now, loose, opts);
      return (await next.promise) as Answer<T> | Superseded<T>;
    },
    peek: <T>(key: ResourceKey) => storeCache.resourceStoreEntries.get(key)?.answer as Answer<T> | undefined,
    flight: <T>(key: ResourceKey) =>
      storeCache.resourceStoreEntries.get(key)?.flight?.promise as Promise<Answer<T> | Superseded<T>> | undefined,
    take<T>(key: ResourceKey) {
      const entry = storeCache.resourceStoreEntries.get(key);
      const answer = entry?.answer as Answer<T> | undefined;
      if (entry !== undefined) {
        delete entry.answer;
        delete entry.text;
        if (entry.flight === undefined) storeCache.resourceStoreEntries.delete(key);
      }
      return answer;
    },
    subscribe<T>(key: ResourceKey, fn: (answer: Answer<T>) => void) {
      const set = listeners.get(key) ?? new Set();
      listeners.set(key, set);
      const listener = fn as (answer: Answer<unknown>) => void;
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0 && listeners.get(key) === set) listeners.delete(key);
      };
    },
    supersede(kind, scope) {
      const name = scope === undefined ? kind : `${kind}\0${scope}`;
      epochs.set(name, (epochs.get(name) ?? 0) + 1);
      for (const entry of storeCache.resourceStoreEntries.values())
        if (entry.kind === kind && (scope === undefined || entry.scope === scope)) entry.stale = true;
    },
    stale(kind) {
      for (const entry of storeCache.resourceStoreEntries.values()) if (entry.kind === kind) entry.stale = true;
    },
    standing(seq) {
      standingSeq = Math.max(standingSeq, seq);
      for (const entry of storeCache.resourceStoreEntries.values()) {
        const answered = entry.answer?.seq;
        if (answered !== undefined && answered !== null && answered < seq) entry.stale = true;
      }
    },
    replace<T>(key: ResourceKey, update: (held: T) => T) {
      const entry = storeCache.resourceStoreEntries.get(key);
      if (entry?.answer === undefined) return;
      entry.answer = { ...entry.answer, body: update(entry.answer.body as T), etag: null };
      entry.text = null;
      entry.stale = true;
    },
    forget(prefix) {
      for (const key of [...storeCache.resourceStoreEntries.keys()])
        if (prefix === undefined || key.startsWith(prefix)) storeCache.resourceStoreEntries.delete(key);
    },
  };
  return store;
}

/** The page's store: 64 storeCache.resourceStoreEntries, 8 MiB of answer text (tools/perf/leak-declared-caches.json). */
export const RESOURCE_LIMITS = { maxEntries: 64, maxBytes: 8 * 1024 * 1024 } as const;
/** The page's store. Each reader passes its own fetch (`ReadOptions.fetch`); the global one only stands in. */
export const resources: ResourceStore = /* @__PURE__ */ pageStore();
function pageStore(): ResourceStore {
  const store = createResourceStore((url, init) => runtime.request(url, init), RESOURCE_LIMITS);
  // A page leaving holds nothing for the next one.
  if (typeof window !== "undefined") window.addEventListener("pagehide", () => store.forget());
  return store;
}
