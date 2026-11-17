// What a project state saves (ProjectState's persist and continuity writes, moved here whole): the
// recovery record, bounded and ranked so a large project never makes it unwritable, with each kept
// view's last-good source; and the advisory continuity file (ADR 0032), written only when it changed.
import type { AccountStateStore, RecoveryRecord } from "../../state/account.ts";
import { serializeContinuity, type ContinuityRecord } from "../../state/continuity.ts";
import { activeTelemetry } from "../../telemetry/index.ts";

/** Views whose last-good source the recovery record keeps (the bound `parseRecovery` enforces). */
export const RECOVERY_VIEWS = 256;

/**
 * How a commit is saved. `durable`: now, before the change is acknowledged; a failure refuses it.
 * `deferred`: the change already holds in memory and is acknowledged; its save waits up to DEFER_MS,
 * coalescing with any deferred commit after it. A durable commit meanwhile saves it too; a failed
 * deferred save is logged (svc.state-save) and made again with the next commit or the flush.
 */
export type Durability = "durable" | "deferred";

/** How long a deferred commit waits for more before it is saved (a reader dragging a selection posts many). */
export const DEFER_MS = 250;

/** What the recovery record reads of a view. */
export interface RecoverableView {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly path: string;
  readonly sourceRevision: string | null;
  readonly envelope: { readonly revision: string } | null;
  readonly lastGoodSource?: Uint8Array;
}

/** The state a recovery record is cut from, as it stands at the commit. */
export interface RecoveryState {
  readonly views: Iterable<RecoverableView>;
  readonly presentation: { readonly viewId: string } | null;
  readonly selection: { readonly viewId: string } | null;
  readonly captions: ReadonlyMap<string, RecoveryRecord["captions"][number][1]>;
  readonly lastChange: ReadonlyMap<string, RecoveryRecord["lastChange"][number][1]>;
  /** The emphasis store's snapshot: one entry per view, each naming its `viewId`. */
  readonly emphases: () => readonly unknown[];
}

export class Persister {
  readonly #store: AccountStateStore | undefined;
  readonly #root: () => string;
  readonly #log: (line: string) => void;
  /** The continuity file's text as last written, so an unchanged one is not written again. */
  #continuityText: string | undefined;
  readonly #deferMs: number;
  /** The latest deferred commit not yet saved: its readers are of the live state, so the latest is all of them. */
  #pending: { readonly state: () => RecoveryState; readonly continuity: () => ContinuityRecord } | null = null;
  #timer: NodeJS.Timeout | undefined;
  /** Closed (flushed for good): a deferred commit after it is saved at once, as before deferral. */
  #closed = false;

  /** `root` is read at each save: a reload may find the project's root moved. */
  constructor(
    store: AccountStateStore | undefined,
    root: () => string,
    log: (line: string) => void,
    options: { readonly deferMs?: number } = {},
  ) {
    this.#store = store;
    this.#root = root;
    this.#log = log;
    this.#deferMs = options.deferMs ?? DEFER_MS;
  }

  /**
   * Saves the recovery record cut from `state` (read only when there is a store), then the continuity file
   * from `continuity`. Durable: a record the store refuses throws (a PersistenceError), the continuity file
   * is not written, and a deferred commit still pending stays pending; once saved, nothing is pending.
   * Deferred: never throws (see Durability).
   */
  commit(state: () => RecoveryState, continuity: () => ContinuityRecord, how: Durability): void {
    if (this.#store === undefined) return;
    if (how === "deferred") {
      this.#pending = { state, continuity };
      if (this.#closed) this.#savePending();
      else if (this.#timer === undefined) {
        this.#timer = setTimeout(() => {
          this.#timer = undefined;
          this.#savePending();
        }, this.#deferMs);
        this.#timer.unref();
      }
      return;
    }
    this.#save(state, continuity);
    this.#pending = null;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** Whether a deferred commit waits to be saved. */
  get pending(): boolean {
    return this.#pending !== null;
  }

  /**
   * Saves a pending deferred commit now, synchronously: before a detach, a stop or a hand-over releases the
   * project (ADR 0022, ADR 0032). A failure is logged, as for any deferred save.
   */
  flush(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#savePending();
  }

  /** Flushes, and saves any later deferred commit at once. */
  close(): void {
    this.flush();
    this.#closed = true;
  }

  #savePending(): void {
    const pending = this.#pending;
    if (pending === null || this.#store === undefined) return;
    try {
      this.#save(pending.state, pending.continuity);
      if (this.#pending === pending) this.#pending = null;
    } catch (e) {
      const root = this.#root(),
        message = e instanceof Error ? e.message : String(e);
      this.#log(`[archer] state for ${root} was not saved: ${message}; it is saved again with the next change`);
      activeTelemetry()?.log("warn", "svc.state-save", `state was not saved: ${message}`, {
        data: { project: root, code: (e as { code?: unknown }).code ?? null },
      });
    }
  }

  #save(state: () => RecoveryState, continuity: () => ContinuityRecord): void {
    if (this.#store === undefined) return;
    const now = state();
    const { views } = recoverable(now);
    // Each list the record holds is bounded by RECOVERY_VIEWS. Under it nothing is dropped; over it, the
    // entries of the kept views come first, then the rest in order, up to the bound.
    const kept = new Set(views.map((v) => v.id));
    const bounded = <T>(items: readonly T[], idOf: (item: T) => string): T[] =>
      items.length <= RECOVERY_VIEWS
        ? [...items]
        : [...items.filter((i) => kept.has(idOf(i))), ...items.filter((i) => !kept.has(idOf(i)))].slice(
            0,
            RECOVERY_VIEWS,
          );
    const record: RecoveryRecord = {
      version: 1,
      root: this.#root(),
      presentation: now.presentation,
      selection: now.selection,
      captions: bounded([...now.captions], ([id]) => id),
      lastChange: bounded([...now.lastChange], ([id]) => id),
      emphases: bounded(now.emphases(), (e) => (e as { viewId: string }).viewId),
      views: views.map((v) => ({
        id: v.id,
        path: v.path,
        kind: v.kind,
        title: v.title,
        revision: v.envelope!.revision,
        sourceRevision: v.sourceRevision,
        blob: v.envelope!.revision,
      })),
    };
    this.#store.save(
      record,
      views.map((v) => ({ revision: v.envelope!.revision, bytes: v.lastGoodSource! })),
    );
    this.continuity(continuity);
  }

  /**
   * Writes the continuity file (`state/continuity.ts`) when it changed. Advisory: a failure is
   * logged and never refuses the change that caused it, since without the file the next open
   * takes its baseline from disk and attributes changes to the person, as it always did.
   */
  continuity(continuity: () => ContinuityRecord): void {
    if (this.#store === undefined) return;
    const text = serializeContinuity(continuity());
    if (text === this.#continuityText) return;
    const root = this.#root();
    try {
      this.#store.saveContinuity(root, text);
      this.#continuityText = text;
    } catch (e) {
      this.#log(`[archer] continuity state for ${root} was not saved: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/**
 * The views whose last-good source goes into the recovery copy: at most RECOVERY_VIEWS (the bound
 * the saved record keeps), chosen by relevance so a large project never makes the record
 * unwritable. The presented view first, then the selected one, then views holding an emphasis,
 * then the most recently presented or changed; the rest are not recovered (a convenience, since
 * the source on disk is what a restart compiles). Registered order is kept, so equal state
 * serializes equally.
 */
function recoverable(state: RecoveryState): { views: RecoverableView[] } {
  const all = [...state.views].filter((v) => v.envelope !== null && v.lastGoodSource !== undefined);
  if (all.length <= RECOVERY_VIEWS) return { views: all };
  const emphasised = new Set(state.emphases().map((e) => (e as { viewId: string }).viewId));
  const recency = (id: string) =>
    [state.captions.get(id)?.at, state.lastChange.get(id)?.at].reduce<string>(
      (a, b) => (b !== undefined && b > a ? b : a),
      "",
    );
  const rank = (v: RecoverableView): [number, string] => [
    v.id === state.presentation?.viewId ? 0 : v.id === state.selection?.viewId ? 1 : emphasised.has(v.id) ? 2 : 3,
    recency(v.id),
  ];
  const chosen = new Set(
    all
      .map((v, order) => ({ v, order, r: rank(v) }))
      .sort((a, b) => a.r[0] - b.r[0] || (a.r[1] < b.r[1] ? 1 : a.r[1] > b.r[1] ? -1 : 0) || a.order - b.order)
      .slice(0, RECOVERY_VIEWS)
      .map((x) => x.v),
  );
  return { views: all.filter((v) => chosen.has(v)) };
}
