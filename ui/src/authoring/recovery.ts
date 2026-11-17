import { liveTabs, tabId, withDraftsLock } from "../comments/draft-tabs";
import {
  parseAuthoringRequest,
  parseAuthoringTarget,
  type AuthoringRequest,
  type AuthoringOpen,
} from "../../../shared/authoring-contract.mts";
export type EditorPositions = Record<string, { x: number; y: number }>;
export interface Recovery {
  version: 1;
  checkpointKind?: "draft" | "document";
  positions?: EditorPositions;
  positionsDirty?: boolean;
  presentationRevision?: string | null;
  source: string;
  intent: string;
  draftId: string;
  draftRevision: number | null;
  opened: AuthoringOpen | null;
  pending: AuthoringRequest | null;
  /** `pending` has not left this browser: a Save made with no connection, sent once when it returns (O92). */
  held?: boolean;
  /** The tab that keeps it (comments/draft-tabs.ts, O117): stamped by `saveRecovery`, so every stored record has one. */
  owner?: string;
  /** When it was last kept (ms since the epoch, O137), stamped the same way: with several closed tabs' copies of one
   * diagram the newest is offered first. */
  savedAt?: number;
}
/** A record as browser storage holds it: always with its owner and when it was kept (a record without them is not read). */
export type StoredRecovery = Recovery & { owner: string; savedAt: number };
export const recoveryKey = (origin: string, slug: string, storeId: string, generation: string, draftId: string) =>
  `archer.authoring.v1:${origin}:${slug}:${storeId}:${generation}:${draftId}`;
export function saveRecovery(storage: Storage, key: string, value: Recovery): boolean {
  const {
      version,
      source,
      intent,
      draftId,
      draftRevision,
      opened,
      pending,
      positions,
      positionsDirty,
      presentationRevision,
      checkpointKind,
    } = value,
    held = value.held === true && pending !== null;
  return putBounded(
    storage,
    key,
    {
      version,
      source,
      intent,
      draftId,
      draftRevision,
      opened,
      pending,
      positions,
      positionsDirty,
      presentationRevision,
      checkpointKind,
      ...(held ? { held } : {}),
      owner: value.owner ?? tabId(),
      savedAt: Date.now(),
    },
    1024 * 1024,
  );
}
/**
 * The one way the page keeps a draft in browser storage (the editor's recovery here, a comment being written in
 * comments/comment-draft.ts): bounded JSON under a namespaced key. False, never a throw, when the browser refuses
 * it (storage full, `SecurityError`, blocked) or it is larger than `limit` bytes, so the caller can say so.
 */
export function putBounded(storage: Storage, key: string, value: unknown, limit: number): boolean {
  try {
    const text = JSON.stringify(value);
    if (new TextEncoder().encode(text).length > limit) return false;
    storage.setItem(key, text);
    return true;
  } catch {
    return false;
  }
}
/** What `putBounded` kept, parsed but not yet checked; null when absent, too large, unreadable or refused. */
export function getBounded(storage: Storage, key: string, limit: number): unknown {
  try {
    const text = storage.getItem(key);
    if (text === null || text.length > limit) return null;
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
export function readRecovery(storage: Storage, key: string): StoredRecovery | null {
  try {
    const text = storage.getItem(key);
    if (text === null || text.length > 1024 * 1024) return null;
    const v = JSON.parse(text) as Recovery;
    if (
      v.version !== 1 ||
      typeof v.source !== "string" ||
      new TextEncoder().encode(v.source).length > 262144 ||
      typeof v.intent !== "string" ||
      new TextEncoder().encode(v.intent).length > 2048 ||
      !/^drf_[a-f0-9]{32}$/.test(v.draftId) ||
      !(v.draftRevision === null || (Number.isSafeInteger(v.draftRevision) && v.draftRevision > 0))
    )
      return null;
    if (v.checkpointKind !== undefined && v.checkpointKind !== "draft" && v.checkpointKind !== "document") return null;
    if (
      typeof v.owner !== "string" ||
      !/^[0-9a-f]{16}$/.test(v.owner) ||
      !Number.isSafeInteger(v.savedAt) ||
      (v.savedAt as number) <= 0
    )
      return null;
    if (v.positionsDirty !== undefined && typeof v.positionsDirty !== "boolean") return null;
    if (v.held !== undefined && (typeof v.held !== "boolean" || v.pending === null)) return null;
    if (
      v.presentationRevision !== undefined &&
      v.presentationRevision !== null &&
      !/^sha256:[a-f0-9]{64}$/.test(v.presentationRevision)
    )
      return null;
    if (v.positions !== undefined) {
      if (
        !v.positions ||
        typeof v.positions !== "object" ||
        Array.isArray(v.positions) ||
        Object.keys(v.positions).length > 2048
      )
        return null;
      for (const [id, p] of Object.entries(v.positions)) {
        if (
          id.length > 128 ||
          /[\0-\x1f]/.test(id) ||
          !p ||
          typeof p !== "object" ||
          !Number.isFinite(p.x) ||
          !Number.isFinite(p.y) ||
          Math.abs(p.x) > 10000000 ||
          Math.abs(p.y) > 10000000
        )
          return null;
      }
    }
    if (v.pending !== null) v.pending = parseAuthoringRequest(v.pending);
    if (v.opened !== null) {
      const o = v.opened;
      if (
        !o ||
        typeof o !== "object" ||
        typeof o.source !== "string" ||
        new TextEncoder().encode(o.source).length > 262144 ||
        !/^sha256:[a-f0-9]{64}$/.test(o.sourceRevision) ||
        !/^sha256:[a-f0-9]{64}$/.test(o.targetRevision) ||
        typeof o.path !== "string" ||
        typeof o.authoringPath !== "string" ||
        typeof o.writable !== "boolean" ||
        !(o.blockId === null || (typeof o.blockId === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(o.blockId)))
      )
        return null;
      for (const path of [o.path, o.authoringPath])
        if (
          !path ||
          path.length > 1024 ||
          /[\\\0-\x1f]/.test(path) ||
          path.startsWith("/") ||
          path.split("/").some((part) => !part || part === "." || part === "..")
        )
          return null;
      v.opened = { ...o, target: parseAuthoringTarget(o.target) };
    }
    return {
      version: v.version,
      checkpointKind: v.checkpointKind,
      source: v.source,
      intent: v.intent,
      draftId: v.draftId,
      draftRevision: v.draftRevision,
      opened: v.opened,
      pending: v.pending,
      positions: v.positions,
      positionsDirty: v.positionsDirty,
      presentationRevision: v.presentationRevision,
      ...(v.held === true ? { held: true } : {}),
      owner: v.owner,
      savedAt: v.savedAt as number,
    };
  } catch {
    return null;
  }
}

/**
 * The ownership rule (comments/draft-tabs.ts, O117) for the editor's recovery: a record another tab keeps is never
 * restored by itself. `mine`: this tab's. `open`: kept by a tab still open (it stays there). `closed`: kept by a tab
 * now closed: offered, and taken only by the person (`takeRecovery`).
 */
export function recoveryOwnership(r: StoredRecovery, live: ReadonlySet<string> | null): "mine" | "open" | "closed" {
  if (r.owner === tabId()) return "mine";
  return live?.has(r.owner) ? "open" : "closed";
}
/**
 * The person resumed a closed tab's working copy: it becomes this tab's, by the adoption rule comment drafts follow
 * (comment-draft.ts `takeDraft`, codex-401): under the drafts lock the record is read again, and it is taken only while
 * its owner is still the one offered (`offeredOwner`) and that tab is not open. A stale offer (another tab took it
 * meanwhile, or its tab came back) is refused and nothing is written.
 */
export async function takeRecovery(storage: Storage, key: string, offeredOwner: string | undefined): Promise<boolean> {
  return withDraftsLock(async () => {
    const r = readRecovery(storage, key);
    if (r === null || r.owner !== offeredOwner) return false;
    if (r.owner === tabId()) return true;
    const live = await liveTabs();
    if (live?.has(r.owner)) return false;
    return saveRecovery(storage, key, { ...r, owner: tabId() });
  });
}
/** Newest first by `savedAt` (O137); a copy that names none is the oldest. Stable for equal times. */
export function newestFirst<T extends { readonly savedAt?: number | undefined }>(copies: readonly T[]): T[] {
  return copies
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (b.c.savedAt ?? 0) - (a.c.savedAt ?? 0) || a.i - b.i)
    .map((x) => x.c);
}
/**
 * The person discards one closed tab's copy they were offered (O137): by the adoption rule (`takeRecovery`), it is
 * removed only while its owner is still the one offered and that tab is not open. False, and nothing removed, otherwise.
 */
export async function discardRecovery(
  storage: Storage,
  key: string,
  offeredOwner: string | undefined,
): Promise<boolean> {
  return withDraftsLock(async () => {
    const r = readRecovery(storage, key);
    if (r === null || r.owner !== offeredOwner) return false;
    if (r.owner !== tabId()) {
      const live = await liveTabs();
      if (live?.has(r.owner)) return false;
    }
    try {
      storage.removeItem(key);
      return true;
    } catch {
      return false;
    }
  });
}
