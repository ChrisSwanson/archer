import { expectOwnWrite } from "../app/file-updates";
import { useEffect, useRef, useState } from "react";
import { STARTER_SOURCE } from "../../../shared/authoring-starter.mts";
import type {
  AuthoringAccessStatus,
  AuthoringDraftSummary,
  AuthoringOpen,
  AuthoringReceipt,
  AuthoringRequest,
  AuthoringTarget,
} from "../../../shared/authoring-contract.mts";
import {
  AuthoringRefusal,
  authoringClient,
  definitiveRefusal,
  newOperationId,
  type AuthoringClient,
  type Edited,
  type FlowchartEdit,
  type Preview,
} from "./client";
import { describeRefusal, type Refusal, type RefusalDetail } from "./refusals";
import { authoringStatus, forgetAuthoringStatus } from "./status-cache";
import { editorHref, type EditorAddress } from "./address";
import {
  discardRecovery,
  newestFirst,
  readRecovery,
  recoveryKey,
  recoveryOwnership,
  saveRecovery,
  takeRecovery,
  type Recovery,
  type StoredRecovery,
  type EditorPositions,
} from "./recovery";
import { liveTabs } from "../comments/draft-tabs";
import { noteOwnSave } from "../app/own-saves";
import { devReport, doubleCommitDetector, requestMetadata } from "../telemetry/dev";
type RequestWithoutId<T = AuthoringRequest> = T extends unknown ? Omit<T, "operationId"> : never;
const HTTP = authoringClient();
// Dev builds: the same edit or write requested twice within 300 ms (`ui.edit.double-commit`).
const issued = __ARCHER_DEBUG__ ? doubleCommitDetector() : null;
const samePositions = (a: EditorPositions = {}, b: EditorPositions = {}) =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.keys(a).every((id) => Object.hasOwn(b, id) && a[id]?.x === b[id]?.x && a[id]?.y === b[id]?.y);
const sameTarget = (a: AuthoringTarget, b: AuthoringTarget) =>
  a.kind === b.kind &&
  (a.kind === "view" ? a.viewId === (b as typeof a).viewId : a.address === (b as typeof a).address);
const BINDING_CHANGED =
  "This diagram target changed. Your local copy is retained; reopen the current original before saving.";
const STARTER = STARTER_SOURCE;
/** A state Undo returns to; `label` says what the change made from it was ("Added “Cache”"), for the status line. */
interface HistoryEntry {
  source: string;
  positions: EditorPositions;
  label?: string;
}
/** A Save of the original made (or explicitly resumed) in this session, once its layout has settled too. */
export interface SaveCompletion {
  operationId: string;
  target: AuthoringTarget;
  path: string | null;
  layoutSaved: boolean;
}
/** An earlier working copy of the same diagram with unsaved changes, kept in browser recovery. */
export interface Resumable {
  draftId: string;
  /** Its recovery key, when it is a closed tab's (taken over by Resume, O117). */
  key?: string;
  /** The closed tab that kept it when it was offered; Resume takes it only while it still does (codex-401). */
  owner?: string;
  /** When it was last kept (O137). */
  savedAt?: number;
  /** It holds a save, not only unsaved edits (claude-501): `held` was kept offline and never sent; `unconfirmed` was sent
   * and its answer never came, so whether it reached Archer is not known. */
  save?: "held" | "unconfirmed";
}
/** One of the earlier working copies of this diagram kept in this browser, offered newest first (O137). `key` is always
 * its record; `closed` says it is a closed tab's (taken under the adoption rule), not this tab's own earlier edit. */
export interface ResumableCopy {
  draftId: string;
  key: string;
  closed: boolean;
  owner?: string;
  savedAt?: number;
  save?: "held" | "unconfirmed";
  /** What it changes, for telling copies apart (claude-502): the first changed line and the change in line count. */
  change?: string;
}
const asResumable = (c: ResumableCopy): Resumable => ({
  draftId: c.draftId,
  ...(c.closed ? { key: c.key, ...(c.owner !== undefined ? { owner: c.owner } : {}) } : {}),
  ...(c.savedAt !== undefined ? { savedAt: c.savedAt } : {}),
  ...(c.save ? { save: c.save } : {}),
});
/** A short, plain account of what `source` changes from `base` (claude-502): its first changed line, and lines added or removed. */
export function changeSummary(base: string, source: string): string {
  const a = base.split("\n"),
    b = source.split("\n");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const line = (b[i] ?? "").trim(),
    shown = line.length > 60 ? line.slice(0, 59) + "…" : line,
    delta = b.length - a.length;
  const parts = [
    i < b.length && line ? `first change: “${shown}”` : i < a.length ? "lines removed at the end" : "layout only",
  ];
  if (delta !== 0) parts.push(`${delta > 0 ? "+" : "−"}${Math.abs(delta)} line${Math.abs(delta) === 1 ? "" : "s"}`);
  return parts.join(", ");
}
/** A private proposal saved in this session; `diverged` says the file moved on since it was opened (null: not known). */
export interface ProposalSaved {
  operationId: string;
  draftRevision: number;
  diverged: boolean | null;
}
/** Where a refusal's copy came from: its code and the actions worth offering. */
export type ShownRefusal = Refusal & { code: string };
/**
 * A save that left and whose answer was lost (claude-11): being checked, found not to have reached Archer (Save again
 * sends the same operation), or not known because the check got no answer either (Check again).
 */
/** `not-found`: Archer has no record of it yet. That is not "not saved" (claude-307): a request cut on the way can still
 * reach Archer a moment later, so it is checked again by itself, and Save again sends that same operation. */
export interface LostAnswer {
  operationId: string;
  state: "checking" | "not-found" | "unknown";
  /** `not-found` after the last look (LOST_RECHECK_MS): nothing checks again by itself (claude-407). */
  checked?: true;
}
/** When a save Archer has no record of yet is looked for again (a read, never a resend). */
export const LOST_RECHECK_MS: readonly number[] = [2000, 6000, 15000];
/** How often the missing-file screen looks for the file again (claude-409). */
export const MISSING_RECHECK_MS = 5000;
/**
 * Unsaved work (or a held offline save) whose diagram file is gone: deleted, renamed or moved before it was saved
 * (claude-203). Its text is shown with Copy; the person saves it as a new diagram at the old path, keeps it as a
 * private proposal, or discards it. Nothing is sent to the missing file, and nothing is written over another one.
 */
export interface MissingTarget {
  draftId: string;
  key: string;
  /** The person's Mermaid; null when this browser holds no unsaved work on it (the panel then only says the file is gone). */
  source: string | null;
  intent: string;
  /** With no work of this tab's: another tab's work on it is kept in this browser, that tab still `open`, or closed and
   * `offered` (Resume them takes it, claude-403). */
  other?: "open" | "offered";
  /** That other tab's work holds a save (claude-603), named as one: held offline, or sent with no answer. */
  otherSave?: "held" | "unconfirmed";
  /** Where it was, inside the Archer folder (`diagrams/flow.mmd`), and its block name when it was embedded in a note. */
  path: string | null;
  blockId: string | null;
  /** It was a save held offline (never sent), not only unsaved edits. */
  held: boolean;
}
/** An earlier working copy whose file is gone, made from the same bytes as the diagram open now: renamed or moved here. */
export interface MovedWork {
  draftId: string;
  key: string;
  fromPath: string;
  source: string;
}
/** The open's refusal says the diagram's file (or its view, or its block) is not there. */
const gone = (failure: unknown) =>
  failure instanceof AuthoringRefusal &&
  ["ENOENT", "diagram_not_found", "authoring_not_found"].includes(failure.code ?? "");
const PREFIX = "archer.authoring.v1:";
/** A kept copy still holds work worth offering (claude-601): a save not yet known to be done, edits, or a moved layout,
 * and not text the file already holds (`file`, the file as this tab last read it; unknown before it is opened). */
/** The save a kept copy holds, if any (claude-501, claude-603): held offline, or sent with no answer. */
const saveOf = (r: Recovery): "held" | "unconfirmed" | undefined =>
  r.pending ? (r.held === true ? "held" : "unconfirmed") : undefined;
export function holdsWork(r: Recovery, file?: string | null): boolean {
  if (r.positionsDirty === true) return true;
  const text = r.pending && "source" in r.pending ? r.pending.source : r.source;
  if (file != null && text === file && (!r.pending || "source" in r.pending)) return false;
  return r.pending !== null || r.source !== (r.opened?.source ?? STARTER);
}
export interface EditorData extends Recovery {
  savedSource: string;
  savedOpened: AuthoringOpen | null;
  recoveryBindingChanged: boolean;
  savedPositions: EditorPositions;
  savedIntent: string;
  savedPresentationRevision: string | null;
  key: string;
  receipt: AuthoringReceipt | null;
}
/** `hrefFor` names the page address a checkpoint is kept under; the standalone editor's by default. */
export function useAuthoring(
  projectSlug: string,
  address: EditorAddress,
  api: AuthoringClient = HTTP,
  hrefFor: (target: AuthoringTarget | null, draftId: string, checkpoint?: "document" | "draft") => string | null = (
    target,
    draftId,
    checkpoint,
  ) => editorHref(projectSlug, target, draftId, checkpoint),
  connected = true,
  /** The model revision the page shows for the open view (the inventory's), recorded with an own save (own-saves.ts). */
  shownRevision?: string,
) {
  const [access, setAccess] = useState<AuthoringAccessStatus | null>(null),
    [data, setData] = useState<EditorData | null>(null),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState<Preview | null>(null),
    [previewBusy, setPreviewBusy] = useState(false),
    [storageFailed, setStorageFailed] = useState(false),
    [presentationError, setPresentationError] = useState<string | null>(null),
    [probedOperationId, setProbedOperationId] = useState<string | null>(null),
    [unfinished, setUnfinished] = useState<AuthoringReceipt | null>(null),
    [writeQueued, setWriteQueued] = useState(false),
    [previewUnreachable, setPreviewUnreachable] = useState(false);
  /** Unsaved changes to this diagram are kept by another tab that is still open (O117): said, never taken. */
  const [elsewhere, setElsewhere] = useState(false);
  // Keyed on the records said to be open elsewhere, so it goes when they no longer hold work (claude-601).
  const elsewhereKeys = useRef(new Set<string>());
  const noteElsewhere = (key: string) => {
    elsewhereKeys.current.add(key);
    setElsewhere(true);
  };
  // An offered closed tab's copy taken by another tab meanwhile: the offer is withdrawn here at once, and that tab named
  // (claude-401). The storage event fires in every other tab of this browser when the record is rewritten.
  const offeredRef = useRef<{ key?: string; owner?: string } | null>(null);
  // Every listed copy is checked again, not only the offered one (codex-502): a row another tab took or discarded leaves
  // the list, and the count, order and offer follow. Taking or discarding still checks the lock at the time (takeRecovery).
  // claude-601: a record is judged again whoever owns it. Sent, cleared or the file holding its text, it is no longer
  // offered (nor said to be open elsewhere); its tab open again (a reopened tab keeps its owner id), it is said, not offered.
  useEffect(() => {
    let mounted = true;
    const onStorage = (event: StorageEvent) => {
      const touched = (key: string) => event.key === null || event.key === key;
      const offered0 = offeredRef.current;
      if (
        !copiesRef.current.some((c) => touched(c.key)) &&
        !(offered0?.key && touched(offered0.key)) &&
        ![...elsewhereKeys.current].some(touched)
      )
        return;
      // Taken, gone or done is decided at once; whether a same-owner record's tab is open again needs the lock manager.
      const settle = (live: ReadonlySet<string> | null) => {
        const file = dataRef.current?.savedOpened?.source;
        let reopened = false;
        const judge = (key: string, owner: string | undefined): "kept" | "gone" | "elsewhere" => {
          let now: StoredRecovery | null = null;
          try {
            now = readRecovery(localStorage, key);
          } catch {
            return "kept";
          }
          if (now === null || !holdsWork(now, file)) return "gone";
          if (now.owner !== owner) return "elsewhere";
          if (live === null) {
            reopened = true;
            return "kept";
          }
          return recoveryOwnership(now, live) === "open" ? "elsewhere" : "kept";
        };
        for (const key of [...elsewhereKeys.current])
          if (touched(key)) {
            let now: Recovery | null = null;
            try {
              now = readRecovery(localStorage, key);
            } catch {
              continue;
            }
            if (now === null || !holdsWork(now, file)) elsewhereKeys.current.delete(key);
          }
        const list = copiesRef.current;
        const rest = list.filter((c) => {
          if (!touched(c.key)) return true;
          const v = judge(c.key, c.owner);
          if (v === "elsewhere") elsewhereKeys.current.add(c.key);
          return v === "kept";
        });
        if (rest.length !== list.length) offerCopies(rest);
        // An offer that is not in the list (another tab's copy under this address's own draft id).
        const r = offeredRef.current;
        if (r?.key && touched(r.key) && !list.some((c) => c.key === r.key)) {
          const v = judge(r.key, r.owner);
          if (v !== "kept") {
            offer(null);
            if (v === "elsewhere") elsewhereKeys.current.add(r.key);
          }
        }
        setElsewhere(elsewhereKeys.current.size > 0);
        return reopened;
      };
      if (settle(null))
        void liveTabs().then((live) => {
          if (mounted && live !== null) settle(live);
        });
    };
    window.addEventListener("storage", onStorage);
    return () => {
      mounted = false;
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  /** Restored unsaved work whose file was changed by someone else meanwhile: said at once, not first at Save (claude-306). */
  const [changedSinceKept, setChangedSinceKept] = useState(false);
  const [missing, setMissingState] = useState<MissingTarget | null>(null),
    missingRef = useRef<MissingTarget | null>(null);
  const setMissing = (next: MissingTarget | null) => {
    missingRef.current = next;
    setMissingState(next);
  };
  const [moved, setMoved] = useState<MovedWork | null>(null);
  const [lost, setLostState] = useState<LostAnswer | null>(null),
    lostRef = useRef<LostAnswer | null>(null);
  const setLost = (next: LostAnswer | null) => {
    lostRef.current = next;
    setLostState(next);
  };
  const [errorText, setErrorText] = useState<string | null>(null),
    [refusal, setRefusal] = useState<ShownRefusal | null>(null),
    [completed, setCompleted] = useState<SaveCompletion | null>(null),
    [resumable, setResumable] = useState<Resumable | null>(null),
    [restored, setRestored] = useState(false),
    [proposalSaved, setProposalSaved] = useState<ProposalSaved | null>(null);
  offeredRef.current = resumable;
  // Every copy offered, newest first (O137); `resumable` is the first. Taking or discarding one keeps the rest.
  const [copies, setCopiesState] = useState<readonly ResumableCopy[]>([]),
    copiesRef = useRef<readonly ResumableCopy[]>([]);
  // The offer and its ref change together (codex-801): `offeredRef` follows `resumable` only at the next render, so a
  // check after a promotion here would otherwise still see the copy just withdrawn and clear the promoted offer.
  const offer = (next: Resumable | null) => {
    offeredRef.current = next;
    setResumable(next);
  };
  const offerCopies = (list: readonly ResumableCopy[]) => {
    copiesRef.current = list;
    setCopiesState(list);
    offer(list[0] ? asResumable(list[0]) : null);
  };
  /** Kept copies whose text the file (`fileNow`) already holds are no longer offered, nor said to be open elsewhere
   * (claude-601): judged when the file is opened, and again when a refreshed file is read in place (codex-701). */
  const pruneHeld = (fileNow: string) => {
    const still = (k: string) => {
      try {
        const r = readRecovery(localStorage, k);
        return r !== null && holdsWork(r, fileNow);
      } catch {
        return true;
      }
    };
    // Filtering and promotion are one decision (codex-801): the offer outside the list (another tab's copy under this
    // address's own draft id) is judged by itself; a listed copy that goes promotes the next one still holding work.
    const list = copiesRef.current,
      r = offeredRef.current,
      outside = !!r?.key && !list.some((c) => c.key === r.key);
    const kept = list.filter((c) => still(c.key));
    if (kept.length !== list.length) offerCopies(kept);
    if (outside && r?.key && !still(r.key)) offer(null);
    for (const k of [...elsewhereKeys.current]) if (!still(k)) elsewhereKeys.current.delete(k);
    if (elsewhereKeys.current.size === 0) setElsewhere(false);
  };
  // The missing-file screen while the file comes back (claude-409): looked for every MISSING_RECHECK_MS; there again,
  // `fileBack` asks the workspace to open it afresh (nothing is written; kept work is restored as this tab's).
  const [fileBack, setFileBack] = useState(false);
  const missingTarget = missing?.path != null ? (address.target ?? null) : null;
  useEffect(() => {
    if (!missing || !address.target || fileBack) return;
    const target = address.target;
    let live = true;
    const timer = setInterval(() => {
      void api.open(target).then(
        () => {
          if (live) setFileBack(true);
        },
        () => undefined,
      );
    }, MISSING_RECHECK_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [missing, missingTarget, fileBack]);
  // One message at a time: a new one (or none) replaces whatever was shown, refusal details included.
  const setError = (text: string | null) => {
    setErrorText(text);
    setRefusal(null);
  };
  const refuse = (code: string, detail: RefusalDetail = {}) => {
    const shown = { ...describeRefusal(code, detail), code };
    setErrorText(shown.message);
    setRefusal(shown);
  };
  const showWriteRefusal = (request: AuthoringRequest, code: string, serverMessage: string) => {
    const named =
      request.op === "document.publish"
        ? publishRefusal(code, request.path)
        : request.op === "draft.save" && code === "revision_conflict"
          ? PROPOSAL_REFUSED
          : null;
    const shown = { ...describeRefusal(code, { message: serverMessage }), code };
    if (named) {
      setErrorText(named);
      setRefusal({ ...shown, what: named, todo: "", message: named });
    } else {
      setErrorText(shown.message);
      setRefusal(shown);
    }
  };
  const journalGeneration = useRef<string | null>(null),
    busyRef = useRef(false),
    previewFor = useRef<string | null>(null),
    previewSettledFor = useRef<string | null>(null),
    queuedWrite = useRef<(() => void) | null>(null);
  // A write requested while another request or structured edit is in flight runs once it settles, rebuilt from the latest copy; it is never dropped.
  const whenIdle = (run: () => void) => {
    if (!busyRef.current) {
      run();
      return;
    }
    queuedWrite.current = run;
    setWriteQueued(true);
  };
  const release = () => {
    busyRef.current = false;
    setBusy(false);
    const run = queuedWrite.current;
    queuedWrite.current = null;
    if (run) {
      setWriteQueued(false);
      run();
    }
  };
  const dataRef = useRef(data);
  dataRef.current = data;
  const histories = useRef<{ undo: HistoryEntry[]; redo: HistoryEntry[] }>({ undo: [], redo: [] });
  const subjectOperation = (status: AuthoringAccessStatus, opened: AuthoringOpen | null) =>
    status.authorized && opened
      ? ((status.unfinishedOperations ?? status.operations.filter((operation) => operation.state !== "terminal")).find(
          (operation) =>
            operation.subject?.path === opened.path && (operation.subject.blockId ?? null) === opened.blockId,
        ) ?? null)
      : null;
  // A Save held while offline follows the editor: it always holds the latest text, under its one operation identity (O92).
  const follow = (next: EditorData): EditorData => {
    const p = next.pending;
    if (!next.held || !p || !("source" in p)) return next;
    if (p.source === next.source && p.intent === next.intent) return next;
    return { ...next, pending: { ...p, source: next.source, intent: next.intent } };
  };
  const replace = (given: EditorData) => {
    const next = follow(given);
    dataRef.current = next;
    setData(next);
  };
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  const shownRef = useRef(shownRevision);
  shownRef.current = shownRevision;
  const sentFrom = useRef<string | undefined>(undefined);
  /** Whether a write can leave now: the page's connection is up and the browser does not say it is offline. */
  const writable = () => connectedRef.current && (typeof navigator === "undefined" || navigator.onLine !== false);
  const storageFailedRef = useRef(false);
  // The diagram could not be opened because Archer did not answer (claude-602): said as not connected, with Try again,
  // and opened again by itself when the connection returns. `opens` counts the tries; `failedTries` the ones that failed.
  const [unreachable, setUnreachable] = useState(false),
    [opens, setOpens] = useState(0),
    [failedTries, setFailedTries] = useState(0),
    unreachableRef = useRef(false);
  unreachableRef.current = unreachable;
  const retryOpen = () => setOpens((n) => n + 1);
  useEffect(() => {
    if (!unreachable) return;
    const online = () => retryOpen();
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [unreachable]);
  useEffect(() => {
    if (connected && unreachableRef.current) retryOpen();
  }, [connected]);
  const persist = (given: EditorData): boolean => {
    const next = follow(given);
    let saved = false;
    try {
      saved = saveRecovery(localStorage, next.key, {
        ...next,
        positionsDirty: !samePositions(next.positions, next.savedPositions),
      });
    } catch {
      /* blocked browser storage */
    }
    if (storageFailedRef.current === saved) {
      storageFailedRef.current = !saved;
      setStorageFailed(!saved);
    }
    return saved;
  };
  useEffect(() => {
    let live = true;
    void (api === HTTP ? authoringStatus() : api.status())
      .then(async (status) => {
        if (!live) return;
        setAccess(status);
        if (!status.authorized) return;
        journalGeneration.current ??= status.generation;
        let draftId = address.draftId ?? `drf_${newOperationId()}`,
          key = recoveryKey(location.origin, projectSlug, status.storeId, status.generation, draftId);
        let recovered: StoredRecovery | null = null;
        try {
          recovered = readRecovery(localStorage, key);
        } catch {
          /* unavailable recovery */
        }
        // Another tab's working copy is never restored by itself (O117, claude-303): this tab edits its own copy instead.
        // Its tab still open, that is said; its tab closed, it is offered (Resume them takes it over).
        const live0 = await liveTabs();
        if (!live) return;
        let forked = false;
        // Another tab's work on this diagram, kept for the missing-file screen (claude-403): never dropped before it.
        let foreign: {
          readonly key: string;
          readonly record: Recovery;
          readonly whose: "open" | "closed" | "mine";
        } | null = null;
        const hasWork = (r: Recovery) => r.pending !== null || r.source !== (r.opened?.source ?? STARTER);
        if (recovered) {
          const whose = recoveryOwnership(recovered, live0);
          if (whose !== "mine") {
            forked = true;
            if (hasWork(recovered)) foreign = { key, record: recovered, whose };
            // Only while it still holds work (claude-601, n12 H1-A-reopened): a save another tab sent since is not offered back.
            if (holdsWork(recovered)) {
              if (whose === "open") noteElsewhere(key);
              else {
                const save = saveOf(recovered);
                offer({ draftId, key, owner: recovered.owner, ...(save ? { save } : {}) });
              }
            }
            draftId = `drf_${newOperationId()}`;
            key = recoveryKey(location.origin, projectSlug, status.storeId, status.generation, draftId);
            recovered = null;
          }
        }
        // Re-entering Edit without a draft: an earlier working copy of this diagram with unsaved edits is offered, never silently lost (or silently shared with another tab).
        if (address.draftId === null && address.target) {
          const prefix = key.slice(0, key.length - draftId.length);
          const found: ResumableCopy[] = [];
          const work: { key: string; record: Recovery; whose: "open" | "closed" | "mine" }[] = [];
          try {
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i);
              if (!k?.startsWith(prefix) || !k.startsWith(PREFIX)) continue;
              const r = readRecovery(localStorage, k);
              if (!r?.opened || !sameTarget(r.opened.target, address.target)) continue;
              const whose = recoveryOwnership(r, live0);
              // A held or unconfirmed save is offered like unsaved edits, on any edit address (claude-501): before, it was kept
              // only for the missing-file screen, so a new tab on a file that is still there said "no changes yet".
              const save = saveOf(r);
              if (holdsWork(r)) {
                work.push({ key: k, record: r, whose });
                if (whose === "open") noteElsewhere(k);
                else
                  found.push({
                    draftId: r.draftId,
                    key: k,
                    closed: whose === "closed",
                    ...(r.owner !== undefined ? { owner: r.owner } : {}),
                    ...(r.savedAt !== undefined ? { savedAt: r.savedAt } : {}),
                    ...(save ? { save } : {}),
                    change: changeSummary(
                      r.opened.source,
                      r.pending && "source" in r.pending ? r.pending.source : r.source,
                    ),
                  });
              }
            }
          } catch {
            /* unavailable recovery */
          }
          // Several copies of this diagram: the newest is offered, the others listed, never one chosen by storage order (O137).
          if (!foreign) {
            const newest = newestFirst(work.map((w) => ({ ...w, savedAt: w.record.savedAt })))[0];
            if (newest) foreign = { key: newest.key, record: newest.record, whose: newest.whose };
          }
          offerCopies(newestFirst(found));
        }
        const pendingRecovery = recovered?.pending ?? null;
        if (address.checkpoint && recovered?.checkpointKind && address.checkpoint !== recovered.checkpointKind)
          recovered = null;
        let source = STARTER,
          intent = "",
          opened: AuthoringOpen | null = null,
          draftRevision: number | null = null,
          savedSource = STARTER;
        const saved = status.drafts.find((d) => d.draftId === draftId);
        if (saved) {
          const snapshot = await api.snapshot(draftId, saved.draftRevision);
          source = snapshot.source;
          savedSource = source;
          intent = snapshot.intent ?? "";
          draftRevision = saved.draftRevision;
        }
        const target = address.target ?? recovered?.opened?.target ?? saved?.origin.target ?? null;
        let canonical: AuthoringOpen | null = null;
        if (target)
          try {
            canonical = await api.open(target);
          } catch (failure) {
            // The file is gone, and this browser holds work on it: keep it reachable, never send it there (claude-203).
            if (!gone(failure)) throw failure;
            if (!live) return;
            if (
              recovered &&
              (recovered.pending !== null || recovered.source !== (recovered.opened?.source ?? STARTER))
            ) {
              setMissing(missingOf(recovered, key));
              return;
            }
            // Nothing of this tab's, but another tab's work on it is kept here: offered (closed), or said to be open there.
            if (foreign) {
              const { record: r, key: k, whose } = foreign;
              if (whose === "open") noteElsewhere(k);
              else {
                const save = saveOf(r);
                offer({
                  draftId: r.draftId,
                  ...(whose === "closed" ? { key: k, ...(r.owner !== undefined ? { owner: r.owner } : {}) } : {}),
                  ...(save ? { save } : {}),
                });
              }
              const otherSave = saveOf(r);
              setMissing({
                draftId,
                key,
                source: null,
                intent: "",
                path: r.opened?.authoringPath ?? null,
                blockId: r.opened?.blockId ?? null,
                held: false,
                other: whose === "open" ? "open" : "offered",
                ...(otherSave ? { otherSave } : {}),
              });
              return;
            }
            // Nothing unsaved here: say the file is gone, plainly, with a way back (G3), not the service's errno text.
            const where = recovered?.opened
              ? { path: recovered.opened.authoringPath, blockId: recovered.opened.blockId }
              : target.kind === "embedded"
                ? { path: target.address.split("#")[0] ?? null, blockId: target.address.split("#")[1] ?? null }
                : { path: null, blockId: null };
            setMissing({ draftId, key, source: null, intent: "", ...where, held: false });
            return;
          }
        // A copy whose text the file already holds is not offered as unsaved work (claude-601).
        if (canonical) pruneHeld(canonical.source);
        const useDraftCheckpoint =
          !!saved &&
          address.checkpoint !== "document" &&
          (address.checkpoint === "draft" || recovered?.checkpointKind !== "document");
        let recoveryBindingChanged = false;
        if (canonical) {
          opened = canonical;
          if (!useDraftCheckpoint) {
            source = canonical.source;
            savedSource = canonical.source;
          } else if (saved?.origin.kind === "document") {
            const matches = !!saved.origin.target && sameTarget(saved.origin.target, canonical.target);
            opened = {
              ...canonical,
              sourceRevision: saved.origin.baseSourceRevision ?? canonical.sourceRevision,
              ...(saved.origin.targetRevision ? { targetRevision: saved.origin.targetRevision } : {}),
              writable: canonical.writable && matches && !!saved.origin.targetRevision,
            };
          }
        }
        const savedOpened = opened;
        if (recovered) {
          const localSourceDirty = recovered.opened
            ? recovered.source !== recovered.opened.source
            : recovered.source !== savedSource;
          if (!canonical || useDraftCheckpoint || localSourceDirty) source = recovered.source;
          if (localSourceDirty || recovered.positionsDirty === true) setRestored(true);
          if (canonical && recovered.opened) {
            const old = recovered.opened;
            const sameBinding =
              sameTarget(old.target, canonical.target) &&
              old.targetRevision === canonical.targetRevision &&
              old.path === canonical.path &&
              old.blockId === canonical.blockId;
            if (!sameBinding) {
              recoveryBindingChanged = true;
              source = recovered.source;
              opened = { ...canonical, writable: false };
              setError(BINDING_CHANGED);
            } else if (localSourceDirty || useDraftCheckpoint)
              opened = {
                ...canonical,
                source: old.source,
                sourceRevision: old.sourceRevision,
                writable: canonical.writable && (!useDraftCheckpoint || opened?.writable === true),
              };
            if (
              sameBinding &&
              localSourceDirty &&
              !useDraftCheckpoint &&
              old.sourceRevision !== canonical.sourceRevision
            )
              setChangedSinceKept(true);
          }
        }
        let serverPositions: EditorPositions = {},
          presentationRevision: string | null = null;
        if (canonical) {
          try {
            const result = await api.presentation({
              op: "read",
              target: canonical.target,
              expectedTargetRevision: canonical.targetRevision,
              sourceRevision: canonical.sourceRevision,
            });
            serverPositions = result.presentation?.positions ?? {};
            presentationRevision = result.presentation?.revision ?? null;
          } catch {
            setPresentationError("Layout could not be loaded. Browser positions are retained.");
          }
        }
        if (!live) return;
        const positions = recovered?.positionsDirty ? (recovered.positions ?? {}) : serverPositions;
        const next: EditorData = {
          version: 1,
          checkpointKind: address.checkpoint ?? recovered?.checkpointKind,
          positions,
          presentationRevision: recovered?.positionsDirty
            ? (recovered.presentationRevision ?? null)
            : presentationRevision,
          positionsDirty: !samePositions(positions, serverPositions),
          source,
          intent: recovered?.intent ?? intent,
          draftId,
          draftRevision: recovered?.draftRevision ?? draftRevision,
          opened,
          pending: pendingRecovery,
          held: pendingRecovery !== null && recovered?.held === true,
          savedSource,
          key,
          receipt: null,
          savedOpened: recoveryBindingChanged && savedOpened ? { ...savedOpened, writable: false } : savedOpened,
          recoveryBindingChanged,
          savedPositions: serverPositions,
          savedIntent: intent,
          savedPresentationRevision: presentationRevision,
        };
        const held = opened
          ? (status.heldSourceOperations ?? []).find(
              (operation) =>
                operation.state === "terminal" &&
                operation.review?.state === "tracked_held" &&
                operation.subject?.path === opened.path &&
                (operation.subject.blockId ?? null) === opened.blockId,
            )
          : undefined;
        if (held) next.receipt = held;
        replace(next);
        persist(next);
        setUnfinished(subjectOperation(status, opened));
        // Opening a diagram fresh: unsaved work on a file that is gone, made from these same bytes, was renamed or moved here.
        if (address.draftId === null && canonical && !recovered) {
          const found = await movedHere(key.slice(0, key.length - draftId.length), canonical);
          if (live && found) setMoved(found);
        }
        if (forked || address.draftId === null || (!address.target && canonical && !recoveryBindingChanged)) {
          const href = hrefFor(
            canonical?.target ?? address.target,
            draftId,
            address.checkpoint ?? (recovered?.checkpointKind === "document" ? "document" : undefined),
          );
          if (href) history.replaceState(null, "", href);
        }
        // A save whose answer was lost before this page opened: ask Archer now whether it happened (a read; nothing is resent).
        if (pendingRecovery && recovered?.held !== true && !busyRef.current) {
          busyRef.current = true;
          setBusy(true);
          void check(pendingRecovery.operationId).finally(release);
        }
      })
      .then(
        () => {
          if (live) setUnreachable(false);
        },
        (failure) => {
          if (!live) return;
          // No answer at all: not a problem with the diagram. Nothing was read or sent; it is opened again on reconnect.
          if (failure instanceof TypeError) {
            setUnreachable(true);
            setFailedTries((n) => n + 1);
            setError(null);
          } else {
            setUnreachable(false);
            setError(message(failure));
          }
        },
      );
    return () => {
      live = false;
    };
  }, [
    opens,
    api,
    projectSlug,
    address.checkpoint,
    address.draftId,
    address.target?.kind,
    address.target?.kind === "view" ? address.target.viewId : address.target?.address,
  ]);
  // Previews already compiled this session (Undo/Redo walk back and forth over the same sources): reused, not re-requested.
  const previews = useRef(new Map<string, Preview>());
  const remember = (source: string, result: Preview) => {
    const cache = previews.current;
    cache.delete(source);
    cache.set(source, result);
    if (cache.size > 32) cache.delete(cache.keys().next().value!);
  };
  useEffect(() => {
    if (!data) return;
    if (previewFor.current === data.source) {
      previewSettledFor.current = data.source;
      if (previewBusy) setPreviewBusy(false);
      return;
    }
    const known = previews.current.get(data.source);
    if (known) {
      previewFor.current = data.source;
      previewSettledFor.current = data.source;
      setPreview(known);
      setPreviewBusy(false);
      return;
    }
    let live = true;
    setPreviewBusy(true);
    const timer = setTimeout(() => {
      void api
        .preview(data.source)
        .then(
          (result) => {
            remember(data.source, result);
            if (live && dataRef.current?.source === data.source) {
              previewFor.current = data.source;
              previewSettledFor.current = data.source;
              setPreview(result);
              setPreviewUnreachable(false);
            }
          },
          (failure) => {
            if (live && dataRef.current?.source === data.source) {
              previewFor.current = null;
              previewSettledFor.current = data.source;
              setPreview(null);
              // No answer (offline): the Mermaid is checked when it is saved; that is not a problem in it (O92).
              if (failure instanceof TypeError) setPreviewUnreachable(true);
              else setError(message(failure));
            }
          },
        )
        .finally(() => {
          if (live) setPreviewBusy(false);
        });
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, data?.source]);
  /*
   * The service's answer to an edit is a function of the source and the edit. One already answered this session (a refusal
   * repeated by a second key press, a step walked back over by Undo) is answered here and sends nothing; only what is
   * actually sent counts for `ui.edit.double-commit`, keyed as the service sees it (source and edit).
   */
  const answers = useRef(new Map<string, Edited>()),
    lastApplied = useRef<{ edits: string; source: string } | null>(null);
  const answer = async (source: string, step: FlowchartEdit): Promise<Edited> => {
    const key = `${JSON.stringify(step)}\u0000${source}`,
      cache = answers.current,
      known = cache.get(key);
    if (known) {
      cache.delete(key);
      cache.set(key, known);
      return known;
    }
    if (__ARCHER_DEBUG__) issued?.("edit", key, step);
    const result = await api.edit(source, step);
    cache.set(key, result);
    if (cache.size > 16) cache.delete(cache.keys().next().value!);
    return result;
  };
  const updateSource = (source: string, recordHistory = true, label?: string) => {
    const old = dataRef.current;
    if (!old || source === old.source) return;
    if (new TextEncoder().encode(source).length > 262144) {
      setError("Mermaid source exceeds 262,144 bytes.");
      return;
    }
    if (recordHistory) {
      histories.current.undo.push({ source: old.source, positions: old.positions ?? {}, ...(label ? { label } : {}) });
      if (histories.current.undo.length > 100) histories.current.undo.shift();
      histories.current.redo = [];
    }
    const next = { ...old, source };
    replace(next);
    persist(next);
  };
  /**
   * Structured edits, checked by the service. Several edits are ONE step: each applies to the previous one's result,
   * the source changes once (one Undo), and a refusal at any step shows that refusal and leaves the source as it was.
   * `base`/`expect`: apply to an earlier source instead, only while the current one is still `expect`, and replace the
   * last step in place (no new Undo entry): a just-added shape re-added under the name typed for it.
   */
  async function run(
    edits: readonly FlowchartEdit[],
    detail: RefusalDetail,
    label: string | undefined,
    amend?: { base: string; expect: string },
  ): Promise<Edited | undefined> {
    const old = dataRef.current;
    if (!old || busyRef.current || edits.length === 0) return;
    if (amend && old.source !== amend.expect) return;
    // The same step again on its own result (Enter then blur, a second key press, a select set to what it shows) is not a new edit.
    const asked = JSON.stringify(edits);
    if (!amend && lastApplied.current?.edits === asked && lastApplied.current.source === old.source) return;
    busyRef.current = true;
    setBusy(true);
    if (!amend) setError(null);
    try {
      let source = amend?.base ?? old.source,
        result: Edited | undefined;
      for (const step of edits) {
        result = await answer(source, step);
        if (!result.ok) {
          if (__ARCHER_DEBUG__)
            devReport("ui.edit.edit-refused", `${step.kind} refused: ${result.code}`, {
              code: result.code,
              ...requestMetadata(step),
              ...(edits.length > 1 ? { chain: edits.length } : {}),
            });
          if (!amend)
            refuse(result.code, {
              edit: step.kind,
              ...detail,
              ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
              ...(result.existingId ? { existingId: result.existingId } : {}),
            });
          return result;
        }
        source = result.source;
      }
      if (dataRef.current?.source !== old.source) {
        if (!amend) setError("The source changed while this edit was checked. Try the edit again.");
        return;
      }
      const done = result as Edited & { ok: true };
      previewFor.current = source;
      previewSettledFor.current = source;
      remember(source, { envelope: done.envelope, diagnostics: done.diagnostics });
      lastApplied.current = { edits: asked, source };
      if (amend) {
        const top = histories.current.undo.at(-1);
        if (top && label) top.label = label;
        updateSource(source, false);
      } else updateSource(source, true, label);
      setPreview(done);
      setPreviewBusy(false);
      return done;
    } catch (failure) {
      if (!amend)
        setError(
          failure instanceof TypeError
            ? "This change needs Archer, which did not answer; nothing changed. You can still type in the Mermaid source."
            : message(failure),
        );
    } finally {
      release();
    }
  }
  const edit = async (edit: FlowchartEdit, detail: RefusalDetail = {}, label?: string) => {
    const result = await run([edit], detail, label);
    return result?.ok ? result : undefined;
  };
  /** Edits as one step (a shape and its connections): all of them, or none. */
  const editChain = async (edits: readonly FlowchartEdit[], detail: RefusalDetail = {}, label?: string) => {
    const result = await run(edits, detail, label);
    return result?.ok ? result : undefined;
  };
  /** Redo the last step from the source before it (`base`), while the current source is still that step's result (`expect`). Quiet: a refusal returns false and changes nothing. */
  const amendLast = async (base: string, expect: string, edit: FlowchartEdit, label?: string) => {
    const result = await run([edit], {}, label, { base, expect });
    return result?.ok === true;
  };
  async function acknowledged(receipt: AuthoringReceipt, saveLayout = false) {
    const old = dataRef.current;
    if (!old) return;
    const terminal = receipt.state === "terminal",
      op = old.pending?.op;
    const savedDraft = terminal && op === "draft.save" && ["saved", "unchanged"].includes(receipt.outcome ?? "");
    const savedDocument =
      terminal &&
      ((op === "document.apply" && ["applied", "unchanged"].includes(receipt.outcome ?? "")) ||
        (op === "document.publish" && receipt.outcome === "created")) &&
      !!receipt.document;
    const checkpointSucceeded = savedDraft || savedDocument;
    const next: EditorData = {
      ...old,
      receipt,
      pending: terminal ? null : old.pending,
      ...(receipt.draft ? { draftRevision: receipt.draft.draftRevision } : {}),
      ...(checkpointSucceeded
        ? {
            savedSource: old.pending && "source" in old.pending ? old.pending.source : old.savedSource,
            savedIntent: old.intent,
            checkpointKind: savedDraft ? ("draft" as const) : ("document" as const),
          }
        : {}),
    };
    // The person's own save: its echo in the files event stays quiet (ADR 0028). A standalone file's
    // revision is exact; an embedded block's is not the note's, so that path is quiet for a moment.
    if (savedDocument && receipt.document)
      expectOwnWrite(receipt.document.path, receipt.document.blockId ? null : receipt.document.sourceRevision);
    // The header says "Saved" for this revision only, not for whatever writes the file next (claude-206).
    const savedTarget = savedDocument ? receipt.document?.target : undefined;
    if (savedTarget)
      noteOwnSave(
        projectSlug,
        savedTarget.kind === "view" ? savedTarget.viewId : savedTarget.address,
        sentFrom.current,
        receipt.outcome === "unchanged",
        Date.now(),
        receipt.document?.blockId ? undefined : receipt.document?.sourceRevision,
      );
    if (savedDocument && receipt.document?.target && receipt.document.targetRevision) {
      next.opened = {
        target: receipt.document.target,
        targetRevision: receipt.document.targetRevision,
        path: receipt.document.path,
        authoringPath: old.opened?.authoringPath ?? (old.pending?.op === "document.publish" ? old.pending.path : ""),
        blockId: receipt.document.blockId ?? null,
        source: next.savedSource,
        sourceRevision: receipt.document.sourceRevision,
        writable: true,
      };
      next.savedOpened = next.opened;
    }
    replace(next);
    persist(next);
    if (checkpointSucceeded) {
      const target = savedDocument ? receipt.document?.target : old.opened?.target;
      const href = hrefFor(target ?? null, old.draftId, savedDocument ? "document" : "draft");
      if (href) history.replaceState(null, "", href);
    }
    if (
      terminal &&
      ["document.apply", "document.publish"].includes(op ?? "") &&
      !savedDocument &&
      receipt.outcome === "no_effect"
    )
      setError("The original was not saved. Your working copy is retained.");
    if (
      terminal &&
      op === "document.publish" &&
      receipt.outcome === "conflict" &&
      old.pending?.op === "document.publish"
    ) {
      showWriteRefusal(old.pending, "EEXIST", "");
      backToMissing();
    }
    if (savedDocument) adoptedMissing.current = null;
    let layoutSaved = true;
    if (terminal && receipt.outcome === "resolved" && receipt.evidence === "inferred_confirmed" && old.opened) {
      try {
        const canonical = await api.open(old.opened.target);
        if (
          !sameTarget(canonical.target, old.opened.target) ||
          canonical.targetRevision !== old.opened.targetRevision ||
          canonical.path !== old.opened.path ||
          canonical.blockId !== old.opened.blockId
        )
          throw new Error(BINDING_CHANGED);
        let positions = old.savedPositions,
          revision = old.savedPresentationRevision;
        try {
          const result = await api.presentation({
            op: "read",
            target: canonical.target,
            expectedTargetRevision: canonical.targetRevision,
            sourceRevision: canonical.sourceRevision,
          });
          positions = result.presentation?.positions ?? {};
          revision = result.presentation?.revision ?? null;
        } catch {
          setPresentationError(
            "Confirmation recorded; the saved layout could not be loaded. Your positions are retained.",
          );
        }
        const latest = dataRef.current;
        if (latest) {
          const refreshed = {
            ...latest,
            opened: canonical,
            savedOpened: canonical,
            savedSource: canonical.source,
            savedPositions: positions,
            savedPresentationRevision: revision,
            presentationRevision: revision,
            positionsDirty: !samePositions(latest.positions, positions),
            checkpointKind: "document" as const,
          };
          replace(refreshed);
          persist(refreshed);
          const href = hrefFor(canonical.target, latest.draftId, "document");
          if (href) history.replaceState(null, "", href);
        }
      } catch {
        const latest = dataRef.current;
        if (latest?.opened) {
          const blocked = { ...latest, opened: { ...latest.opened, writable: false } };
          replace(blocked);
          persist(blocked);
        }
        setError(
          "Confirmation recorded. Reopen the current original before saving again. Your working copy is retained.",
        );
      }
    }
    // A new diagram published with no layout (no positions, none read): nothing is written, so an earlier layout of the same file is not refused over (codex-302).
    const noLayout =
      op === "document.publish" && old.presentationRevision === null && Object.keys(next.positions ?? {}).length === 0;
    if (
      saveLayout &&
      !noLayout &&
      terminal &&
      receipt.document &&
      next.opened &&
      ["applied", "created", "unchanged"].includes(receipt.outcome ?? "")
    ) {
      // A layout save whose answer was lost is read back: the positions there are the person's, so it is saved (write sweep).
      const layoutOnce = async (request: Parameters<AuthoringClient["presentation"]>[0] & { op: "save" }) => {
        try {
          return await api.presentation(request);
        } catch (failure) {
          if (!(failure instanceof TypeError)) throw failure;
          const read = await api.presentation({
            op: "read",
            target: request.target,
            expectedTargetRevision: request.expectedTargetRevision,
            sourceRevision: request.sourceRevision,
          });
          if (read.presentation && samePositions(read.presentation.positions ?? {}, request.positions)) return read;
          throw failure;
        }
      };
      try {
        const positions = next.positions ?? {},
          result = await layoutOnce({
            op: "save",
            target: next.opened.target,
            expectedTargetRevision: next.opened.targetRevision,
            sourceRevision: receipt.document.sourceRevision,
            expectedRevision: old.presentationRevision ?? null,
            positions,
          });
        const latest = dataRef.current;
        if (latest) {
          const unchanged = JSON.stringify(latest.positions ?? {}) === JSON.stringify(positions),
            saved = {
              ...latest,
              presentationRevision: result.presentation?.revision ?? null,
              savedPresentationRevision: result.presentation?.revision ?? null,
              savedPositions: positions,
              positionsDirty: !unchanged,
            };
          replace(saved);
          persist(saved);
        }
        setPresentationError(null);
      } catch {
        layoutSaved = false;
        setPresentationError("Diagram saved; layout not saved. Your positions remain in browser recovery.");
      }
    }
    if (savedDocument && receipt.document?.target)
      setCompleted({
        operationId: receipt.operationId,
        target: receipt.document.target,
        path: old.pending?.op === "document.publish" ? old.pending.path : null,
        layoutSaved,
      });
    if (terminal) {
      forgetAuthoringStatus();
      let listed: AuthoringAccessStatus | null = null;
      try {
        const status = await (api === HTTP ? authoringStatus() : api.status());
        listed = status;
        setAccess(status);
        setUnfinished((previous) => {
          const next = subjectOperation(status, dataRef.current?.opened ?? null);
          return next && previous?.operationId === next.operationId && previous.current
            ? { ...previous, state: next.state }
            : next;
        });
      } catch {
        /* receipt remains acknowledged even if the list refresh fails */
      }
      // A proposal of an existing diagram: say it was saved, where it is, and whether the file moved on since it was opened (O84).
      if (savedDraft && receipt.outcome === "saved" && receipt.draft && old.opened) {
        const listedDraft = listed?.authorized
          ? listed.drafts.find((draft) => draft.draftId === receipt.draft!.draftId)
          : undefined;
        setProposalSaved({
          operationId: receipt.operationId,
          draftRevision: receipt.draft.draftRevision,
          diverged: listedDraft?.origin.diverged ?? null,
        });
      }
    }
  }
  async function submit(request: AuthoringRequest) {
    if (__ARCHER_DEBUG__ && !busyRef.current) {
      const {
        operationId: _id,
        journalGeneration: _generation,
        ...content
      } = request as AuthoringRequest & { journalGeneration?: string };
      issued?.("write", JSON.stringify(content), content);
    }
    if (busyRef.current) {
      whenIdle(() => void submit(request));
      return;
    }
    const old = dataRef.current;
    if (!old) return;
    if (!request.journalGeneration) {
      if (old.pending) {
        setError(
          "This older unresolved request lacks its original journal generation. Check status; it cannot be retried.",
        );
        return;
      }
      if (!journalGeneration.current) {
        setError("Authoring generation is unknown. Refresh access before saving.");
        return;
      }
      request = { ...request, journalGeneration: journalGeneration.current };
    }
    if (!writable()) {
      // No connection: nothing leaves this browser. The Save is kept in recovery and sent once when the connection returns.
      const held = { ...old, pending: request, held: true };
      if (!persist(held)) {
        setError(NOT_KEPT_OFFLINE);
        return;
      }
      replace(held);
      setError(null);
      return;
    }
    sentFrom.current = shownRef.current;
    setLost(null);
    const next = { ...old, pending: request, held: false };
    if (!persist(next)) {
      setError("Recovery storage is unavailable. No write was sent; copy your Mermaid before closing this tab.");
      return;
    }
    replace(next);
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await acknowledged(await api.mutate(request), true);
    } catch (failure) {
      if (definitiveRefusal(failure)) {
        // The service refused the request outright (4xx): nothing was written, so nothing is left unresolved.
        const latest = dataRef.current;
        if (latest && latest.pending?.operationId === request.operationId) {
          const cleared = { ...latest, pending: null };
          replace(cleared);
          persist(cleared);
        }
        showWriteRefusal(request, failure.code ?? "", failure.message);
        if (request.op === "document.publish") backToMissing();
        return;
      }
      // The answer was lost: ask at once whether it was saved. A status read, never a resend (ADR 0015).
      setError(null);
      await check(request.operationId);
    } finally {
      release();
    }
  }
  /** Whether the save `id` happened: Saved (acknowledged), Not saved (Save again sends it), or not known (Check again). */
  async function check(id: string) {
    setLost({ operationId: id, state: "checking" });
    try {
      const known = await api.operation(id);
      setProbedOperationId(id);
      if (!known) {
        setLost({ operationId: id, state: "not-found" });
        recheck(id, 0);
        return;
      }
      setLost(null);
      await acknowledged(known);
      if (known.state === "terminal") setError(null);
    } catch {
      setLost({ operationId: id, state: "unknown" });
    }
  }
  /** Archer had no record of the save: looked for again later, while it is still the one pending and nothing else runs. */
  function recheck(id: string, attempt: number) {
    const delay = LOST_RECHECK_MS[attempt];
    if (delay === undefined) {
      const l = lostRef.current;
      if (l?.operationId === id && l.state === "not-found")
        setLost({ operationId: id, state: "not-found", checked: true });
      return;
    }
    setTimeout(() => {
      const d = dataRef.current,
        l = lostRef.current;
      if (!d?.pending || d.pending.operationId !== id || l?.operationId !== id || l.state !== "not-found") return;
      if (busyRef.current) {
        recheck(id, attempt + 1);
        return;
      }
      void api.operation(id).then(
        async (known) => {
          if (lostRef.current?.operationId !== id || lostRef.current.state !== "not-found") return;
          if (!known) {
            recheck(id, attempt + 1);
            return;
          }
          busyRef.current = true;
          setBusy(true);
          try {
            setLost(null);
            await acknowledged(known);
            if (known.state === "terminal") setError(null);
          } finally {
            release();
          }
        },
        () => recheck(id, attempt + 1),
      );
    }, delay);
  }
  /** Archer had no record of the pending save: send that same operation again, as the person asked (never twice: same id). */
  const sendAgain = (op: AuthoringRequest["op"]): boolean => {
    const d = dataRef.current,
      l = lostRef.current;
    if (
      !d?.pending ||
      d.held ||
      l?.state !== "not-found" ||
      l.operationId !== d.pending.operationId ||
      d.pending.op !== op
    )
      return false;
    void submit(d.pending);
    return true;
  };
  function start(request: RequestWithoutId) {
    const d = dataRef.current;
    if (d?.pending && d.held && d.pending.op === request.op) {
      setError(null);
      flush();
      return;
    }
    if (sendAgain(request.op)) return;
    if (d?.pending) {
      setError(d.held ? HELD_BLOCKS : "Check the unresolved operation before another write.");
      return;
    }
    void submit({ ...request, operationId: newOperationId() } as AuthoringRequest);
  }
  async function probe() {
    const d = dataRef.current,
      id = d?.pending?.operationId ?? unfinished?.operationId;
    if (!id || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    if (d?.pending && !d.held) {
      try {
        await check(id);
      } finally {
        release();
      }
      return;
    }
    try {
      const known = await api.operation(id);
      setProbedOperationId(id);
      if (known) {
        if (!d?.pending) setUnfinished(known.state === "terminal" ? null : known);
        await acknowledged(known);
        setError(null);
      } else
        setError(
          d?.pending
            ? "No durable operation was found. Retry explicitly with the same saved request."
            : "This unfinished operation could not be found. Refresh access before saving.",
        );
    } catch (failure) {
      setError(message(failure));
    } finally {
      release();
    }
  }
  const save = () =>
    whenIdle(() => {
      const d = dataRef.current;
      if (!d) return;
      const request: AuthoringRequest = {
        op: "draft.save",
        operationId: newOperationId(),
        draftId: d.draftId,
        expectedDraftRevision: d.draftRevision,
        source: d.source,
        intent: d.intent,
        ...(d.draftRevision === null
          ? {
              origin: d.opened
                ? {
                    kind: "document" as const,
                    target: d.opened.target,
                    expectedSourceRevision: d.opened.sourceRevision,
                    expectedTargetRevision: d.opened.targetRevision,
                    baseSource: d.opened.source,
                  }
                : { kind: "new" as const },
            }
          : {}),
      };
      if (sendAgain("draft.save")) return;
      if (d.pending) {
        setError(d.held ? HELD_BLOCKS : "Check the unresolved operation before saving again.");
        return;
      }
      void submit(request);
    });
  const send = () =>
    whenIdle(() => {
      const d = dataRef.current;
      if (!d?.draftRevision) return;
      start({ op: "draft.send", draftId: d.draftId, draftRevision: d.draftRevision } as RequestWithoutId);
    });
  const sendOperation = () =>
    whenIdle(() => {
      const d = dataRef.current;
      if (d?.receipt) start({ op: "operation.send", targetOperationId: d.receipt.operationId });
    });
  const discard = () =>
    whenIdle(() => {
      const d = dataRef.current;
      if (!d?.draftRevision) return;
      start({ op: "draft.discard", draftId: d.draftId, draftRevision: d.draftRevision } as RequestWithoutId);
    });
  const apply = (path: string) =>
    whenIdle(() => {
      const d = dataRef.current;
      if (!d) return;
      if (d.opened?.writable === false) {
        setError(BINDING_CHANGED);
        return;
      }
      start(
        d.opened
          ? {
              op: "document.apply",
              target: d.opened.target,
              source: d.source,
              expectedSourceRevision: d.opened.sourceRevision,
              expectedTargetRevision: d.opened.targetRevision,
              intent: d.intent,
            }
          : ({ op: "document.publish", path, source: d.source, intent: d.intent } as RequestWithoutId),
      );
    });
  const resolve = (resolution: "confirm_candidate" | "abandon") => {
    const d = dataRef.current,
      operation = d?.pending ? d.receipt : unfinished;
    if (!d || !operation || operation.state !== "uncertain" || !operation.current) return;
    replace({ ...d, pending: null });
    start({
      op: "operation.resolve_uncertain",
      targetOperationId: operation.operationId,
      resolution,
    } as RequestWithoutId);
  };
  const setPositions = (positions: EditorPositions, recordHistory = true, dirty = recordHistory, label?: string) => {
    const d = dataRef.current;
    if (!d) return;
    if (recordHistory) {
      histories.current.undo.push({ source: d.source, positions: d.positions ?? {}, ...(label ? { label } : {}) });
      if (histories.current.undo.length > 100) histories.current.undo.shift();
      histories.current.redo = [];
    }
    const next = { ...d, positions, positionsDirty: d.positionsDirty || dirty };
    replace(next);
    persist(next);
  };
  const cancel = () => {
    const d = dataRef.current,
      never =
        !!d?.pending && lostRef.current?.state === "not-found" && lostRef.current.operationId === d.pending.operationId;
    if (!d || busyRef.current || (d.pending && !d.held && !never)) return;
    setRestored(false);
    setLost(null);
    histories.current = { undo: [], redo: [] };
    replace({
      ...d,
      ...(d.held || never ? { pending: null, held: false } : {}),
      source: d.savedSource,
      intent: d.savedIntent,
      opened: d.savedOpened,
      positions: d.savedPositions,
      presentationRevision: d.savedPresentationRevision,
      positionsDirty: false,
    });
    setError(d.recoveryBindingChanged ? BINDING_CHANGED : null);
    setPresentationError(null);
    try {
      localStorage.removeItem(d.key);
    } catch {
      storageFailedRef.current = true;
      setStorageFailed(true);
    }
  };
  /** Saved positions for shapes the diagram no longer has (a revert, an agent's edit) are not the person's change. */
  const prunePositions = (ids: ReadonlySet<string>) => {
    const d = dataRef.current;
    if (!d) return;
    const keep = (p: EditorPositions = {}) => Object.fromEntries(Object.entries(p).filter(([id]) => ids.has(id)));
    const positions = keep(d.positions),
      savedPositions = keep(d.savedPositions);
    if (samePositions(positions, d.positions) && samePositions(savedPositions, d.savedPositions)) return;
    const next = { ...d, positions, savedPositions, positionsDirty: !samePositions(positions, savedPositions) };
    replace(next);
    persist(next);
  };
  /** A Save-as refusal (file exists) belongs to the path it named: changing the path clears it. */
  const clearConflict = () => {
    const d = dataRef.current;
    if (d && !d.opened && d.receipt?.outcome === "conflict") {
      const next = { ...d, receipt: null };
      replace(next);
    }
    setError(null);
  };
  const setIntent = (intent: string) => {
    const d = dataRef.current;
    if (!d) return;
    const next = { ...d, intent };
    replace(next);
    persist(next);
  };
  /** Each returns what it undid or redid (its label), or null when there was nothing to. */
  const undo = (): string | null => {
    const previous = histories.current.undo.pop(),
      d = dataRef.current;
    if (previous === undefined || !d) return null;
    histories.current.redo.push({
      source: d.source,
      positions: d.positions ?? {},
      ...(previous.label ? { label: previous.label } : {}),
    });
    const restored = {
      ...d,
      source: previous.source,
      positions: previous.positions,
      positionsDirty: !samePositions(previous.positions, d.savedPositions),
    };
    replace(restored);
    persist(restored);
    return previous.label ?? "";
  };
  const redo = (): string | null => {
    const next = histories.current.redo.pop(),
      d = dataRef.current;
    if (next === undefined || !d) return null;
    histories.current.undo.push({
      source: d.source,
      positions: d.positions ?? {},
      ...(next.label ? { label: next.label } : {}),
    });
    const restored = {
      ...d,
      source: next.source,
      positions: next.positions,
      positionsDirty: !samePositions(next.positions, d.savedPositions),
    };
    replace(restored);
    persist(restored);
    return next.label ?? "";
  };
  /**
   * The original changed elsewhere while this editor holds no unsaved work (ADR 0028): read the new
   * version into the editor in place. False (and nothing changed) when there is work to keep, a
   * save in flight, a draft checkpoint, or the open target moved.
   */
  const refreshClean = async (): Promise<"refreshed" | "dirty" | "skipped"> => {
    const d = dataRef.current;
    if (!d?.opened || d.pending || busyRef.current || d.draftRevision !== null || d.checkpointKind === "draft")
      return "skipped";
    if (d.source !== d.savedSource || d.intent !== d.savedIntent || !samePositions(d.positions, d.savedPositions))
      return "dirty";
    let canonical: AuthoringOpen;
    try {
      canonical = await api.open(d.opened.target);
    } catch {
      return "skipped";
    }
    // A save, an edit or another refresh landed meanwhile: that one decides, not this one.
    if (dataRef.current !== d || busyRef.current) return "skipped";
    // The same file and block under the same mapping only; a moved binding needs an explicit reopen.
    if (
      !sameTarget(canonical.target, d.opened.target) ||
      canonical.targetRevision !== d.opened.targetRevision ||
      canonical.path !== d.opened.path ||
      canonical.blockId !== d.opened.blockId
    )
      return "dirty";
    const next: EditorData = {
      ...d,
      opened: canonical,
      savedOpened: canonical,
      source: canonical.source,
      savedSource: canonical.source,
    };
    histories.current = { undo: [], redo: [] };
    replace(next);
    persist(next);
    pruneHeld(canonical.source);
    return "refreshed";
  };
  /**
   * The held Save goes out once the connection is back: exactly the kept request (its operation identity, the revision
   * the person edited from). It is marked sent before it leaves, so a second trigger, or a reload mid-request, never
   * sends it again by itself; an unanswered send then takes the explicit Check status path like any other.
   */
  function flush() {
    const d = dataRef.current;
    if (
      !d?.pending ||
      !d.held ||
      busyRef.current ||
      leaving.current ||
      checkingTarget.current ||
      missingRef.current ||
      !writable()
    )
      return;
    const request = d.pending;
    // A held save goes only to a file that is still there: one read first. Gone, the work is offered instead (claude-203).
    if (request.op !== "document.apply") {
      replace({ ...d, held: false });
      void submit(request);
      return;
    }
    checkingTarget.current = true;
    void api
      .open(request.target)
      .then(
        () => false,
        (failure) => gone(failure),
      )
      .then((isGone) => {
        checkingTarget.current = false;
        const now = dataRef.current;
        if (!now?.pending || !now.held || now.pending.operationId !== request.operationId) return;
        if (isGone) {
          setMissing(missingOf(now, now.key));
          return;
        }
        if (busyRef.current || leaving.current || !writable()) return;
        replace({ ...now, held: false });
        void submit(now.pending);
      });
  }
  const checkingTarget = useRef(false);
  /** Earlier working copies (this project and store) whose file is gone and whose base is these bytes; checked one by one. */
  async function movedHere(prefix: string, canonical: AuthoringOpen): Promise<MovedWork | null> {
    const candidates: { key: string; r: Recovery }[] = [];
    try {
      for (let i = 0; i < localStorage.length && candidates.length < 4; i++) {
        const k = localStorage.key(i);
        if (!k?.startsWith(prefix)) continue;
        const r = readRecovery(localStorage, k);
        if (
          r?.opened &&
          !sameTarget(r.opened.target, canonical.target) &&
          r.opened.source === canonical.source &&
          (r.source !== r.opened.source || r.pending !== null)
        )
          candidates.push({ key: k, r });
      }
    } catch {
      /* unavailable recovery */
    }
    for (const { key, r } of candidates) {
      try {
        await api.open(r.opened!.target);
      } catch (failure) {
        if (gone(failure)) return { draftId: r.draftId, key, fromPath: r.opened!.authoringPath, source: r.source };
      }
    }
    return null;
  }
  /** Bring renamed-away work into this editor as an unsaved change from the same base; the old copy is then removed. */
  const takeMoved = () => {
    const m = moved;
    if (!m) return;
    setMoved(null);
    updateSource(m.source, true, `Brought in your changes from ${m.fromPath}`);
    try {
      localStorage.removeItem(m.key);
    } catch {
      /* blocked storage: it stays offered */
    }
  };
  /**
   * The missing file's work, as the person chose. "new": publish it at `path` (a new file; the service never writes over
   * one that exists). "proposal": keep it as a private draft. Either way it continues as a new diagram in this editor,
   * under the same draft id; the held save to the missing file is dropped, never sent.
   */
  /** A missing file's work being saved as a new diagram: a refusal (a file is at that path again) goes back to its screen (claude-305). */
  const adoptedMissing = useRef<MissingTarget | null>(null);
  const backToMissing = () => {
    const m = adoptedMissing.current;
    if (!m) return;
    adoptedMissing.current = null;
    const d = dataRef.current;
    setMissing({ ...m, source: d?.source ?? m.source, intent: d?.intent ?? m.intent, held: false });
    setRefusal(null);
    setErrorText(
      `A file is at ${m.path ?? "that path"} again, so nothing was written over it. Your change is still kept in this browser: save it as a proposal, copy it, or open the diagram that is there now.`,
    );
  };
  const adoptMissing = (as: "new" | "proposal", path?: string) => {
    const m = missingRef.current;
    if (!m || m.source === null || busyRef.current) return;
    adoptedMissing.current = as === "new" ? m : null;
    const next: EditorData = {
      version: 1,
      positions: {},
      positionsDirty: false,
      presentationRevision: null,
      source: m.source,
      intent: m.intent,
      draftId: m.draftId,
      draftRevision: null,
      opened: null,
      pending: null,
      held: false,
      savedSource: STARTER,
      key: m.key,
      receipt: null,
      savedOpened: null,
      recoveryBindingChanged: false,
      savedPositions: {},
      savedIntent: "",
      savedPresentationRevision: null,
    };
    if (!persist(next)) {
      setError("Recovery storage is unavailable. Copy your Mermaid before closing this tab.");
      return;
    }
    replace(next);
    setMissing(null);
    setError(null);
    const href = hrefFor(null, m.draftId);
    if (href) history.replaceState(null, "", href);
    if (as === "new" && path)
      start({ op: "document.publish", path, source: m.source, intent: m.intent } as RequestWithoutId);
    else if (as === "proposal") save();
  };
  /** Discard the missing file's work, as the person asked: it is removed from this browser and nothing is sent. */
  const discardMissing = () => {
    const m = missingRef.current;
    if (!m) return;
    try {
      localStorage.removeItem(m.key);
    } catch {
      setError("This browser could not remove it: its storage is blocked.");
      return;
    }
    setMissing(null);
    setMissingDiscarded(true);
  };
  const [missingDiscarded, setMissingDiscarded] = useState(false);
  useEffect(() => {
    if (connected && data?.held) flush();
  }, [connected, data?.held]);
  /*
   * Not while the page is being left: its answer would never be read, leaving the save unresolved on return. Chromium's
   * offline emulation even fires `online` during an offline reload (seen 2026-11-02, J9d). Still here 2 s after
   * `beforeunload`, the leave was cancelled and the held save may go.
   */
  const leaving = useRef(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const online = () => flush();
    const leave = () => {
      leaving.current = true;
      clearTimeout(timer);
      timer = setTimeout(() => {
        leaving.current = false;
        flush();
      }, 2000);
    };
    const stay = () => {
      clearTimeout(timer);
      leaving.current = false;
      flush();
    };
    window.addEventListener("online", online);
    window.addEventListener("beforeunload", leave);
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", stay);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("online", online);
      window.removeEventListener("beforeunload", leave);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", stay);
    };
  }, []);
  return {
    unreachable,
    failedTries,
    retryOpen,
    fileBack,
    changedSinceKept,
    elsewhere,
    missing,
    missingDiscarded,
    adoptMissing,
    discardMissing,
    moved,
    takeMoved,
    dismissMoved: () => setMoved(null),
    previewUnreachable,
    held: !!data?.pending && data.held === true,
    refreshClean,
    isBusy: () => busyRef.current,
    access,
    data,
    proposalSaved,
    unfinished,
    refusal,
    completed,
    resumable,
    copies,
    restored,
    dismissResumable: () => offerCopies([]),
    /** Resume a copy the person picked from the list (O137); the others stay kept. True when it is now this tab's. */
    takeCopy: async (c: ResumableCopy): Promise<boolean> => {
      if (!c.closed) return true;
      const ok = await takeRecovery(localStorage, c.key, c.owner);
      if (!ok) {
        offerCopies(copiesRef.current.filter((x) => x.key !== c.key));
        let there: Recovery | null = null;
        try {
          there = readRecovery(localStorage, c.key);
        } catch {
          /* unavailable */
        }
        if (there !== null && holdsWork(there)) noteElsewhere(c.key);
      }
      return ok;
    },
    /** Discard one copy the person was offered (O137); only that one. False when it was taken meanwhile (then said). */
    discardCopy: async (c: ResumableCopy): Promise<boolean> => {
      const ok = await discardRecovery(localStorage, c.key, c.owner);
      offerCopies(copiesRef.current.filter((x) => x.key !== c.key));
      if (!ok) {
        let there: Recovery | null = null;
        try {
          there = readRecovery(localStorage, c.key);
        } catch {
          /* unavailable */
        }
        if (there !== null && holdsWork(there)) noteElsewhere(c.key);
      }
      return ok;
    },
    // Resume: a closed tab's copy is taken under the adoption rule (recovery.ts takeRecovery); refused (another tab has it
    // now), the offer goes and that tab is said to have it. True when the caller may reopen on it (codex-401).
    takeResumable: async (): Promise<boolean> => {
      const r = resumable;
      if (!r) return false;
      if (!r.key) return true;
      const ok = await takeRecovery(localStorage, r.key, r.owner);
      if (!ok) {
        const listed = copiesRef.current.some((x) => x.key === r.key);
        if (listed) offerCopies(copiesRef.current.filter((x) => x.key !== r.key));
        else if (offeredRef.current?.key === r.key) offer(null);
        let there: Recovery | null = null;
        try {
          there = readRecovery(localStorage, r.key);
        } catch {
          /* unavailable */
        }
        if (there !== null && holdsWork(there)) noteElsewhere(r.key);
      }
      return ok;
    },
    prunePositions,
    clearConflict,
    error: errorText,
    dirty:
      !!data &&
      (data.source !== data.savedSource ||
        data.intent !== data.savedIntent ||
        !samePositions(data.positions, data.savedPositions)),
    presentationError,
    busy,
    writeQueued,
    preview,
    previewBusy: previewBusy || (!!data && previewSettledFor.current !== data.source),
    storageFailed,
    edit,
    editChain,
    amendLast,
    updateSource,
    setPositions,
    cancel,
    setIntent,
    save,
    send,
    sendOperation,
    discard,
    apply,
    probe,
    resolve,
    undo,
    redo,
    canUndo: histories.current.undo.length > 0,
    canRedo: histories.current.redo.length > 0,
    canRetry: !!data?.pending?.journalGeneration && probedOperationId === data.pending.operationId,
    lost,
    retry: () => {
      const pending = dataRef.current?.pending;
      if (pending && probedOperationId === pending.operationId) void submit(pending);
      else setError("Check status before retrying the retained request.");
    },
    resume: (draft: AuthoringDraftSummary) => {
      const target = (draft.origin as typeof draft.origin & { target?: AuthoringTarget }).target ?? null;
      const href = editorHref(projectSlug, target, draft.draftId, "draft");
      if (href) location.assign(href);
    },
  };
}
/** The work kept for a file that is gone. */
function missingOf(r: Recovery, key: string): MissingTarget {
  return {
    draftId: r.draftId,
    key,
    source: r.source,
    intent: r.intent,
    path: r.opened?.authoringPath ?? null,
    blockId: r.opened?.blockId ?? null,
    held: r.held === true && r.pending !== null,
  };
}
/** A proposal the service would not save (the file changed and the opened version could not be its base): nothing was kept by it. */
/** A Save with no connection that the browser would not keep (storage full or blocked): nothing is kept, nothing sent. */
const NOT_KEPT_OFFLINE =
  "This browser could not keep your change: its storage is full or blocked. Nothing was saved. Copy your Mermaid before closing this tab, and Save again when you are back online.";
/** Another write while a held Save waits for the connection. */
const HELD_BLOCKS =
  "Your save is kept in this browser and will be sent when you are back online. Cancel it first to do something else.";
const PROPOSAL_REFUSED =
  "The proposal was not saved: the file changed and the version you opened could not be kept as its base. Your working copy is still in this editor; copy your Mermaid to keep it.";
/** Save-as refusals name the path the person typed and say what to change. */
function publishRefusal(code: string, path: string): string | null {
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (code === "create_not_allowed")
    return ["diagrams", "notes"].includes(path.split("/")[0]!) && path.includes("/")
      ? `A new diagram can be at most ${MAX_CREATE_DEPTH} folders below ${path.split("/")[0]}/.`
      : "New diagrams go in diagrams/ or notes/, for example diagrams/checkout-flow.mmd.";
  if (code === "ENOENT")
    return folder
      ? `There is no folder “${folder}” in the project’s Archer folder. Save inside a folder that exists, such as diagrams/.`
      : "That folder doesn’t exist. Save inside a folder that exists, such as diagrams/.";
  if (code === "EEXIST") return `A file already exists at ${path}. Choose another name.`;
  if (code === "authoring_target_invalid" || code === "authoring_invalid_request" || code === "invalid_arguments")
    return "Name the file with letters, digits, - or _, ending in .mmd, inside the Archer folder (for example diagrams/checkout-flow.mmd).";
  if (code === "authoring_target_conflict")
    return `Another diagram is already named “${path
      .split("/")
      .at(-1)
      ?.replace(/\.mmd$/u, "")}”. Choose another name.`;
  if (code === "path_outside_archer_folder")
    return "Save inside the project’s Archer folder (for example diagrams/checkout-flow.mmd).";
  return null;
}
/** A Save-as path the service would refuse, said before anything is sent. */
/** The service's bound on folders below diagrams/ or notes/ (ts/src/project/source-writer.ts MAX_CREATE_DEPTH). */
export const MAX_CREATE_DEPTH = 8;
export function publishPathProblem(path: string): string | null {
  const p = path.trim();
  if (p === "") return "Choose where to save it, such as diagrams/new-diagram.mmd.";
  if (p.startsWith("/") || p.includes("\\") || p.split("/").some((part) => part === ".."))
    return "Save inside the project’s Archer folder (for example diagrams/checkout-flow.mmd).";
  // "diagrams/./a.mmd" or "diagrams//a.mmd" is inside the folder: say how to write it, never that it is outside.
  if (p.split("/").some((part, i, all) => part === "." || (part === "" && i < all.length - 1)))
    return "Write the path without “./” or “//”, for example diagrams/checkout-flow.mmd.";
  if (p.split("/").some((part) => part.startsWith(".")))
    return "Folders and files starting with a dot are hidden; choose another name.";
  if (!p.endsWith(".mmd")) return "The file name must end in .mmd.";
  // The service creates files only here (ADR 0028), and makes the folders on the way itself.
  if (!["diagrams", "notes"].includes(p.split("/")[0]!) || !p.includes("/"))
    return "New diagrams go in diagrams/ or notes/, for example diagrams/checkout-flow.mmd.";
  if (p.split("/").length - 2 > MAX_CREATE_DEPTH)
    return `A new diagram can be at most ${MAX_CREATE_DEPTH} folders below ${p.split("/")[0]}/.`;
  const base = p.split("/").at(-1)!.slice(0, -4);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(base))
    return "Name the file with letters, digits, - or _ (no spaces), starting with a letter or digit.";
  return null;
}
/** A failure in the person's words: a request that never got an answer (fetch's TypeError, "Failed to fetch") says so plainly. */
function message(failure: unknown): string {
  if (failure instanceof TypeError) return "Archer did not answer.";
  return failure instanceof Error ? failure.message : "Authoring is unavailable.";
}
