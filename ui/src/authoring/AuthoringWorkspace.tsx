import { dismissFilePopupFor, filePopupIsChoice, showFilePopup, watchOpenFile } from "../app/file-updates";
import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import type { AuthoringTarget } from "../../../shared/authoring-contract.mts";
import { nextFreeId } from "./identities";
import type { ArrowChange, AuthoringClient, FlowchartEdit } from "./client";
import { editorAddress, editorHref, type EditorAddress } from "./address";
import { publishPathProblem, useAuthoring, type ShownRefusal } from "./useAuthoring";
import { useAnnouncedOnce } from "./announced-once";
import { OtherCopies } from "./OtherCopies";
import { describeRefusal, type RefusalDetail } from "./refusals";
import { InlineValue } from "./InlineValue";
import {
  FAMILIES,
  FAMILY_ORDER,
  familyOf,
  hasContent,
  insertPart,
  readableId,
  relabelInSource,
  withoutShownTechnology,
  type Family,
  type Part,
} from "./families";
import { PartGlyph } from "./PartGlyph";
import { DiagramCanvas, type CanvasState } from "../diagrams/DiagramCanvas";
import { projectEnvelope, type ProjectionResult } from "../diagrams/projection";
import { DiagramKey } from "../diagrams/DiagramKey";
import { computeBackgroundLayout } from "../layout/elk-worker-transport";
import type { LayoutResult } from "../layout/elk-layout";
import { DEFAULT_TYPEFACE } from "../layout/text-measure";
import { computeSequenceLayout } from "../layout/sequence-layout";
import { useMediaQuery, NARROW_QUERY } from "../app/media";
import { browserRoutePath } from "../app/browser-routes";
import { DevProfiler, useChromeOverlapCheck, useStaleSelectionCheck } from "../telemetry/dev-hooks";
import "./authoring.css";
import { useSourceEditor } from "../source-editor/lazy";
import { usePanelPlacement } from "./panel-place";

const SHAPES = ["rectangle", "rounded", "stadium", "circle", "diamond", "cylinder", "hexagon", "subroutine"] as const;
const DIRECTIONS = {
  "Left to right": "lr",
  "Right to left": "rl",
  "Top to bottom": "tb",
  "Bottom to top": "bt",
} as const;
const quoted = (text: string) => `“${text}”`;
/** What the editing shortcuts read from a key press (a real one, or one kept until the canvas settles). */
interface ShortcutKey {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  preventDefault(): void;
}
/** First-use hints, one per diagram type, dismissed for good per browser. */
const HINT_KEY = "archer.editor.hint.";
const hintDismissedStored = (family: Family): boolean => {
  try {
    return localStorage.getItem(HINT_KEY + family) === "1";
  } catch {
    return false;
  }
};
/** A file name from a diagram's name: `Checkout flow` → `checkout-flow`. */
/** A new diagram's Name and Save as, kept with its draft (O112): localStorage, else this tab's session. */
interface SaveAs {
  path: string;
  name: string;
  edited: boolean;
}
const SAVE_AS_PREFIX = "archer.editor.saveAs.v2:";
function readSaveAs(key: string): SaveAs | null {
  for (const store of [() => localStorage, () => sessionStorage]) {
    try {
      const text = store().getItem(key);
      if (text === null || text.length > 4096) continue;
      const v = JSON.parse(text) as Partial<SaveAs>;
      if (
        typeof v.path === "string" &&
        v.path.length <= 1024 &&
        typeof v.name === "string" &&
        v.name.length <= 100 &&
        typeof v.edited === "boolean"
      )
        return { path: v.path, name: v.name, edited: v.edited };
    } catch {
      /* blocked storage, or not ours */
    }
  }
  return null;
}
function writeSaveAs(key: string, draftId: string, value: SaveAs): void {
  const text = JSON.stringify(value);
  try {
    localStorage.setItem(key, text);
    // Entries whose draft is no longer kept (published, discarded) go: this one's draft may not be stored yet.
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter(
      (k): k is string => k !== null,
    );
    for (const k of keys)
      if (k.startsWith(SAVE_AS_PREFIX)) {
        const id = k.slice(SAVE_AS_PREFIX.length);
        if (
          id !== draftId &&
          !keys.some((other) => other.startsWith("archer.authoring.v1:") && other.endsWith(`:${id}`))
        )
          localStorage.removeItem(k);
      }
  } catch {
    try {
      sessionStorage.setItem(key, text);
    } catch {
      /* blocked storage */
    }
  }
}
const slugOf = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 100);

/** Editing a diagram on its own reading page: the page owns the address and the way out. */
export interface InPlaceEditing {
  readonly target: AuthoringTarget;
  /** Leave editing without saving (after Cancel). */
  readonly onExit: () => void;
  /** Leave editing after the original was saved. */
  readonly onSaved: () => void;
  /** Filled by the editor: the page calls it before navigating away, and it asks first when there are unsaved edits. */
  readonly guard?: { current: ((proceed: () => void) => void) | null };
  /** Called once, when the editor first has something to show (a drawing, or why there is none): the page keeps the reading drawing up until then. */
  readonly onFirstDrawing?: () => void;
}

const sameTarget = (a: AuthoringTarget | null, b: AuthoringTarget) =>
  a !== null &&
  a.kind === b.kind &&
  (a.kind === "view" ? a.viewId === (b as typeof a).viewId : a.address === (b as typeof a).address);

import { EDITOR_ENTRY_SELECTOR, inPlaceHref } from "./in-place-href";
import { MissingWork } from "./MissingWork";
import { holdForUnsavedWork } from "../app/application-update";
export { EDITOR_ENTRY_SELECTOR, inPlaceHref };

function inPlaceAddress(target: AuthoringTarget): EditorAddress {
  const q = new URLSearchParams(location.search);
  const draftId = q.get("draftId"),
    checkpoint = q.get("checkpoint");
  return {
    target,
    draftId: draftId !== null && /^drf_[a-f0-9]{32}$/.test(draftId) ? draftId : null,
    ...(checkpoint === "document" || checkpoint === "draft" ? { checkpoint } : {}),
  };
}

/** `externalRevision`: the diagram's revision as the page hears it (inventory); a change while editing means someone else wrote it. */
/** The editor could not open because Archer did not answer (claude-602). Work kept in this browser stays kept, and
 * nothing is sent until it opens; it opens again by itself when the connection returns. */
function OpenUnreachable({
  failedTries,
  onRetry,
  onBack,
  projectHref,
}: {
  failedTries: number;
  onRetry: () => void;
  onBack?: () => void;
  projectHref?: string | null;
}): JSX.Element {
  // The failures seen when Try again was pressed: more since means it failed again.
  const [pressed, setPressed] = useState<number | null>(null);
  const back = onBack ? (
    <button type="button" onClick={onBack}>
      Back to reading
    </button>
  ) : projectHref ? (
    <a href={projectHref}>Go to the project</a>
  ) : null;
  return (
    <section className="authoring-denied">
      <h2>Diagram Editor</h2>
      <p role="status">
        Not connected to Archer, so the diagram cannot open yet. Anything kept in this browser stays kept, and nothing
        is sent. It opens by itself when Archer answers again.
        {pressed === null ? "" : failedTries > pressed ? " Still not connected. Try again in a moment." : " Checking…"}
      </p>
      <p className="authoring-recovery-actions">
        <button
          type="button"
          onClick={() => {
            setPressed(failedTries);
            onRetry();
          }}
        >
          Try again
        </button>
        {back}
      </p>
    </section>
  );
}
/** The status line's offer of an earlier copy: a held or unconfirmed save is named as one, not as plain edits (claude-501). */
export function resumableText(r: { key?: string; save?: "held" | "unconfirmed" }): string {
  const from = r.key ? "from another tab, now closed," : "from an earlier edit";
  if (r.save === "held") return `A save of this diagram ${from} is held in this browser, not sent yet.`;
  if (r.save === "unconfirmed")
    return `A save of this diagram ${from} got no answer: not known whether it reached Archer.`;
  return r.key
    ? "You have unsaved changes to this diagram from another tab, now closed."
    : "You have unsaved changes from an earlier edit of this diagram.";
}
export function AuthoringWorkspace(props: {
  projectSlug: string;
  api?: AuthoringClient;
  toolbarHost?: HTMLElement | null;
  inPlace?: InPlaceEditing;
  externalRevision?: string | undefined;
  /** The page's connection to Archer is up (App's `connected`); without it a Save is kept in this browser until it is (O92). */
  connected?: boolean;
}): JSX.Element {
  const [addressResult, setAddressResult] = useState(() => {
    if (props.inPlace) return { address: inPlaceAddress(props.inPlace.target), error: null };
    try {
      return { address: editorAddress(location.search), error: null };
    } catch (error) {
      return {
        address: { target: null, draftId: null },
        error: error instanceof Error ? error.message : "Invalid editor address.",
      };
    }
  });
  // Resuming an earlier working copy reopens the editor on that draft, as its address says. Always a fresh open: from a
  // full draft address the editor forked its own copy under another id while this address kept the offered one, so the
  // draft id alone is no change (codex-403); each Resume is its own key.
  const [opens, setOpens] = useState(0);
  const resume = (draftId: string) => {
    const address = { ...addressResult.address, draftId };
    const href = props.inPlace ? inPlaceHref(draftId) : editorHref(props.projectSlug, address.target, draftId);
    if (href) history.replaceState(null, "", href);
    setAddressResult({ address, error: null });
    setOpens((n) => n + 1);
  };
  return addressResult.error ? (
    <section className="authoring-denied">
      <h2>Diagram Editor</h2>
      <p role="alert">{addressResult.error}</p>
    </section>
  ) : (
    <Workspace
      key={`${addressResult.address.draftId ?? "new"}:${opens}`}
      {...props}
      address={addressResult.address}
      onResume={resume}
      onReopen={() => setOpens((n) => n + 1)}
    />
  );
}

/**
 * The APG toolbar pattern for an editor toolbar (rubric H3): one Tab stop, the last item used; ←/→ move along it
 * (wrapping), Home and End go to its ends. Disabled buttons are skipped; a menu opened from an item keeps its own keys.
 */
function useRovingToolbar(): {
  ref: (element: HTMLElement | null) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  onFocus: (event: ReactFocusEvent<HTMLElement>) => void;
} {
  const bar = useRef<HTMLElement | null>(null),
    current = useRef<HTMLElement | null>(null);
  const items = () =>
    [...(bar.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])].filter(
      (item) => !item.disabled && !item.closest("[role=menu]"),
    );
  const settle = () => {
    const all = items();
    if (!all.length) return;
    const stop = current.current && all.includes(current.current as HTMLButtonElement) ? current.current : all[0]!;
    for (const item of all) item.tabIndex = item === stop ? 0 : -1;
  };
  // After every render: buttons come, go and change their disabled state with the selection.
  useLayoutEffect(settle);
  return {
    ref: useCallback((element: HTMLElement | null) => {
      bar.current = element;
    }, []),
    onFocus: (event) => {
      const item = event.target instanceof HTMLButtonElement ? event.target : null;
      if (item && items().includes(item)) {
        current.current = item;
        settle();
      }
    },
    onKeyDown: (event) => {
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        !(event.target instanceof HTMLElement) ||
        event.target.closest("[role=menu]")
      )
        return;
      const all = items(),
        at = all.indexOf(event.target as HTMLButtonElement);
      if (at === -1) return;
      const next =
        event.key === "ArrowRight"
          ? (at + 1) % all.length
          : event.key === "ArrowLeft"
            ? (at - 1 + all.length) % all.length
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? all.length - 1
                : -1;
      if (next < 0) return;
      event.preventDefault();
      current.current = all[next]!;
      settle();
      all[next]!.focus();
    },
  };
}
function Icon({ children }: { children: ReactNode }): JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      {children}
    </svg>
  );
}

const SOURCE_PREFERENCE = "archer.editor.source";
const readSourcePreference = (): boolean => {
  try {
    return sessionStorage.getItem(SOURCE_PREFERENCE) === "1";
  } catch {
    return false;
  }
};
const msgIndex = (id: string): number | null => {
  const m = /^msg-(\d+)$/u.exec(id);
  return m ? Number(m[1]) : null;
};
type ErrorSource = "hook" | "presentation" | "drawing";
/** Errors that stay true until their source clears them, in the order one is preferred when several hold. */
const ERROR_SOURCES: readonly ErrorSource[] = ["hook", "presentation", "drawing"];
// What a notice is (O155): a success or a plain fact is never drawn or announced as an error.
type Severity = "success" | "info" | "error";
type Notice = { from: ErrorSource | "interaction"; text: string; severity: Severity; refusal?: ShownRefusal };
/** The family a compiled model belongs to, when the source header alone doesn't say (an unusual preamble). */
const MODEL_FAMILY: Readonly<Record<string, Family>> = {
  "freeform-graph": "flowchart",
  "c4-model": "c4",
  "entity-relationship": "er",
  "state-machine": "state",
};

function Workspace({
  projectSlug,
  api,
  address,
  toolbarHost,
  inPlace,
  onResume,
  onReopen,
  externalRevision,
  connected: online = true,
}: {
  connected?: boolean;
  projectSlug: string;
  api?: AuthoringClient;
  toolbarHost?: HTMLElement | null;
  address: EditorAddress;
  inPlace?: InPlaceEditing;
  onResume: (draftId: string) => void;
  onReopen?: () => void;
  externalRevision?: string | undefined;
}): JSX.Element {
  // In place, the address stays the reading page's own while its work is unsaved or saved to the same diagram: a missing
  // file's work taken on as a new diagram (no target yet, no checkpoint) too, so its Save lands back on that page (codex-302).
  const hrefFor = useMemo(
    () =>
      inPlace
        ? (target: AuthoringTarget | null, draftId: string, checkpoint?: "document" | "draft") =>
            sameTarget(target, inPlace.target) || (target === null && checkpoint === undefined)
              ? inPlaceHref(draftId, checkpoint)
              : editorHref(projectSlug, target, draftId, checkpoint)
        : undefined,
    [inPlace, projectSlug],
  );
  const c = useAuthoring(projectSlug, address, api, hrefFor, online, externalRevision),
    phone = useMediaQuery(NARROW_QUERY);
  // The missing file is there again (claude-409): open it afresh, as a reload would.
  useEffect(() => {
    if (c.fileBack) onReopen?.();
  }, [c.fileBack]);
  const [selected, setSelected] = useState<{ kind: "node" | "edge"; id: string } | null>(null),
    [sourceShown, setSourceShownState] = useState(
      () => new URLSearchParams(location.search).has("source") || readSourcePreference(),
    ),
    [canvas, setCanvas] = useState<CanvasState>({ status: "empty" }),
    [drawingError, setDrawingError] = useState<string | null>(null),
    [laidOut, setLaidOut] = useState<ProjectionResult | null>(null),
    [publishPath, setPublishPath] = useState("diagrams/untitled.mmd");
  const [panelShown, setPanelShown] = useState(false);
  // Filled by the canvas: switches it from Hand to Select (picking a part is editing).
  const selectMode = useRef<(() => void) | null>(null);
  const [hintsDismissed, setHintsDismissed] = useState<readonly Family[]>([]);
  // A new diagram's name gives its file name until the path is edited by hand.
  const [newName, setNewName] = useState(""),
    pathEdited = useRef(false);
  // The Source pane is the person's choice, remembered for the session (every structured type opens canvas-only).
  const setSourceShown = (next: boolean | ((shown: boolean) => boolean)) =>
    setSourceShownState((shown) => {
      const value = typeof next === "function" ? next(shown) : next;
      try {
        sessionStorage.setItem(SOURCE_PREFERENCE, value ? "1" : "0");
      } catch {
        /* blocked storage */
      }
      return value;
    });
  // A drawing kept from the last valid source while the current text doesn't compile: shown greyed, not editable.
  const [stale, setStale] = useState(false);
  // A new diagram's Name and Save as are kept with its draft (G1, O112): the Save-as path is where the draft goes, so a
  // reload, or the same address in a new tab, must not quietly change it to the default. Kept in this browser beside
  // the draft's recovery (keyed by its draft id); an entry whose draft is no longer kept is dropped when another is
  // written. Before 0.10.0 it was kept for the tab's session only, and a new tab saved to diagrams/untitled.mmd.
  const saveAsKey = (draftId: string) => `archer.editor.saveAs.v2:${draftId}`;
  useEffect(() => {
    const id = c.data?.draftId;
    if (!id) return;
    try {
      const kept = readSaveAs(saveAsKey(id));
      if (kept) {
        setPublishPath(kept.path);
        setNewName(kept.name);
        pathEdited.current = kept.edited;
      }
    } catch {
      /* blocked storage */
    }
  }, [c.data?.draftId]);
  const keepSaveAs = (path: string, name: string) => {
    const id = c.data?.draftId;
    if (id) writeSaveAs(saveAsKey(id), id, { path, name, edited: pathEdited.current });
  };
  const changePublishPath = (path: string, name: string = newName) => {
    setPublishPath(path);
    keepSaveAs(path, name);
  };
  const [connectionKey, setConnectionKey] = useState<string | null>(null),
    [connectMenu, setConnectMenu] = useState(false);
  // A passing notice the editor said in reply to a gesture. It remembers the errors that were already showing, so an
  // error that changes after it is newer and takes its place.
  const [said, setSaid] = useState<{
    text: string;
    severity: Severity;
    refusal?: ShownRefusal;
    over: Readonly<Record<ErrorSource, string | null>>;
  } | null>(null);
  // Dismissal is per error and per message: a new message from the same source shows again.
  const [dismissed, setDismissed] = useState<Readonly<Partial<Record<ErrorSource, string>>>>({});
  const errorsNow = useRef<Readonly<Record<ErrorSource, string | null>>>({
    hook: null,
    presentation: null,
    drawing: null,
  });
  // A refusal says how bad it is itself; anything else says so at the call (an error unless told otherwise).
  const say = (text: string, { severity, refusal }: { severity?: Severity; refusal?: ShownRefusal } = {}) =>
    setSaid({
      text,
      severity: severity ?? (refusal?.severity === "info" ? "info" : "error"),
      ...(refusal ? { refusal } : {}),
      over: errorsNow.current,
    });
  const letGo = () => setSaid(null);
  const setInteractionError = (text: string) => say(text, { severity: "error" });
  const [editingNode, setEditingNode] = useState<string | null>(null),
    [editingEdge, setEditingEdge] = useState<string | null>(null);
  const flowPosition = useRef<((screen: { x: number; y: number }) => { x: number; y: number }) | null>(null);
  const [switchTo, setSwitchTo] = useState<Family | null>(null),
    [copied, setCopied] = useState(false);
  const previewElement = useRef<HTMLDivElement>(null);
  const framedShape = useRef(""),
    frameKey = useRef(1);
  const switchDialog = useRef<HTMLDialogElement>(null),
    discardDialog = useRef<HTMLDialogElement>(null),
    switchTitle = useId(),
    discardTitle = useId();
  const projection: ProjectionResult | null = useMemo(
    () => (c.preview?.envelope ? projectEnvelope(c.preview.envelope) : null),
    [c.preview],
  );
  // Setters run only on a change: one with the value already held still costs a render.
  useEffect(() => {
    let live = true;
    if (drawingError !== null) setDrawingError(null);
    // Mid-typing text that doesn't compile keeps the last good drawing (greyed) instead of blanking the canvas.
    if (!projection?.ok) {
      setLaidOut(projection);
      const source = c.data?.source;
      const keep = source !== undefined && hasContent(source);
      if (stale !== keep) setStale(keep);
      setCanvas((previous) =>
        keep && previous.status !== "empty" && previous.status !== "loading" ? previous : { status: "empty" },
      );
      return;
    }
    if (stale) setStale(false);
    if (projection.type === "sequence") {
      const sequenceLayout = computeSequenceLayout(projection.view);
      // Frame the whole sequence again when its participants or rows change.
      const shape = `seq|${sequenceLayout.participants.map((p) => p.id).join(",")}|${sequenceLayout.messages.length}|${sequenceLayout.notes.length}|${sequenceLayout.fragments.length}`;
      if (shape !== framedShape.current) {
        framedShape.current = shape;
        frameKey.current += 1;
      }
      setLaidOut(projection);
      setCanvas({ status: "sequence-ready", sequenceLayout, viewport: { mode: "fit-all", key: frameKey.current } });
      return;
    }
    if (projection.type === "journey") {
      setLaidOut(projection);
      setCanvas({ status: "journey-ready", journey: projection.view });
      return;
    }
    if (canvas.status !== "ready") setCanvas({ status: "loading" });
    const show = (layout: LayoutResult) => {
      // Automatically laid-out types move everything on each change: frame the whole drawing again when its parts change.
      const shape = layout.nodes.map((node) => node.id).join(",");
      let mode: "fit-all" | "preserve" = "fit-all";
      if (projection.view.modelType !== "freeform-graph" && shape !== framedShape.current) {
        const before = new Set(framedShape.current.split(",")),
          grew = framedShape.current === "" || layout.nodes.some((node) => !before.has(node.id));
        framedShape.current = shape;
        frameKey.current += 1;
        mode = grew ? "fit-all" : "preserve";
      }
      setCanvas(
        projection.view.modelType === "freeform-graph"
          ? { status: "ready", layout }
          : { status: "ready", layout, viewport: { mode, key: frameKey.current } },
      );
      setLaidOut(projection);
    };
    // A large graph is drawn at once from the last drawing with the edit made in it; ELK's layout replaces it (perf #9).
    void computeBackgroundLayout(projection.view, DEFAULT_TYPEFACE, {
      provisional: (layout) => {
        if (live) show(layout);
      },
    }).then(
      (layout) => {
        if (live) show(layout);
      },
      () => {
        if (live) {
          setLaidOut(projection);
          setDrawingError("The preview could not be laid out. Your Mermaid remains available.");
          setCanvas({ status: "empty" });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [projection]);
  // A layout is on its way while the canvas still shows an older one: derived, so a new preview is one render, not two.
  const layoutBusy = laidOut !== projection;
  // The drawing does not show the current source yet: an edit, its preview or its layout is still on its way.
  const drawingPending = useRef(false);
  drawingPending.current = c.busy || c.previewBusy || layoutBusy;
  const graph = projection?.ok && projection.type === "graph" ? projection.view : null,
    flow = graph?.modelType === "freeform-graph",
    c4 = graph?.modelType === "c4-model",
    er = graph?.modelType === "entity-relationship",
    stateModel = graph?.modelType === "state-machine";
  // Types the service edits structurally share every canvas gesture: add, connect, rename, delete.
  const sequence = projection?.ok === true && projection.type === "sequence" ? projection.view : null;
  const structured = flow || c4 || er || stateModel || sequence !== null;
  // What the last edit did, said in the status line ("Added “Cache” · Undo") and announced politely.
  const [lastAction, setLastAction] = useState<{ text: string; undone?: boolean } | null>(null);
  /*
   * Placing a shape without dragging (WCAG 2.1.1, 2.5.7): Alt+arrow nudges the selected shape (Shift: a bigger step),
   * and Move takes one click on the canvas as where the shape goes. Both save through the drag's position path.
   */
  const [moving, setMoving] = useState<string | null>(null);
  const [showCopies, setShowCopies] = useState(false);
  const nudgeRun = useRef<{ id: string; at: number } | null>(null);
  /** What the person sees an element called: its label, never its internal id when it has one. */
  const nameNow = (id: string): string =>
    graph?.nodes.find((node) => node.id === id)?.label ||
    graph?.groups.find((group) => group.id === id)?.label ||
    (canvas.status === "sequence-ready"
      ? canvas.sequenceLayout.participants.find((p) => p.id === id)?.label
      : undefined) ||
    id;
  const messageNow = (id: string) =>
    canvas.status === "sequence-ready" ? canvas.sequenceLayout.messages.find((m) => m.id === id) : undefined;
  const endsOf = (id: string): string | null => {
    const edge = graph?.edges.find((e) => e.id === id);
    if (edge) return `${nameNow(edge.source)} → ${nameNow(edge.target)}`;
    const m = messageNow(id);
    return m ? `${nameNow(m.from)} → ${nameNow(m.to)}` : null;
  };
  const describeEdit = (change: FlowchartEdit): string => {
    switch (change.kind) {
      case "add-node":
        return change.label ? `Added ${quoted(change.label)}` : `Added a ${change.state ?? "shape"}`;
      case "connect":
        return `Connected ${change.source === "[*]" ? "the start" : nameNow(change.source)} → ${change.target === "[*]" ? "the end" : nameNow(change.target)}`;
      case "delete-node":
        return `Deleted ${quoted(nameNow(change.id))}`;
      case "delete-edge": {
        const ends = endsOf(change.id);
        return ends ? `Deleted ${ends}` : "Deleted the connection";
      }
      case "relabel-node":
        return `Renamed ${quoted(nameNow(change.id))} to ${quoted(change.label)}`;
      case "relabel-edge": {
        const ends = endsOf(change.id) ?? "the connection";
        return change.label ? `Labelled ${ends} ${quoted(change.label)}` : `Cleared the label on ${ends}`;
      }
      case "change-shape":
        return `Made ${quoted(nameNow(change.id))} a ${change.shape}`;
      case "direction":
        return "Changed the direction";
      case "move-node":
        return `Moved ${quoted(nameNow(change.id))}`;
      case "move-edge":
        return `Moved ${endsOf(change.id) ?? "the message"}`;
      case "retarget-edge": {
        if (change.message)
          return `Made ${endsOf(change.id) ?? "the message"} ${change.message === "reply" ? "a reply" : change.message === "async" ? "async" : "a message"}`;
        if (change.cardinality) return `Changed the cardinality of ${endsOf(change.id) ?? "the relationship"}`;
        const edge = graph?.edges.find((e) => e.id === change.id),
          m = messageNow(change.id);
        const from = change.source ?? edge?.source ?? m?.from,
          to = change.target ?? edge?.target ?? m?.to;
        return from && to ? `Reconnected ${nameNow(from)} → ${nameNow(to)}` : "Reconnected the connection";
      }
      case "add-note":
        return "Added a note";
      case "wrap-edges":
        return `Wrapped ${change.ids.length === 1 ? "1 message" : `${change.ids.length} messages`} in ${change.fragment === "alt" ? "an if / else" : `a ${change.fragment}`} block`;
      case "relabel-note":
        return "Changed the note";
      case "delete-note":
        return "Deleted the note";
      case "unwrap-fragment":
        return "Removed the block, kept its messages";
      case "change-arrow": {
        const ends = endsOf(change.id),
          named = ends ? quoted(ends) : "the connection";
        return change.arrow === "reverse" ? `Reversed ${named}` : `Made ${named} ${change.arrow}`;
      }
      case "add-edge-ids":
        return "Added IDs to the connections";
    }
  };
  /** Every structured edit goes through here, so the status line can say what it did. */
  const edit = async (change: FlowchartEdit, detail?: RefusalDetail, label: string = describeEdit(change)) => {
    const done = await c.edit(change, detail, label);
    if (done) setLastAction({ text: label });
    return done;
  };
  // Sequence: everything picked with Shift, for a note over two participants or a fragment around several messages.
  const [picked, setPicked] = useState<{ nodes: string[]; edges: string[] }>({ nodes: [], edges: [] });
  // Sequence: a note or a block (fragment) picked for its own panel; `focus` asks the panel to put the caret in its text.
  const [part, setPart] = useState<{ kind: "note" | "fragment"; id: string; focus: number } | null>(null);
  const expectedNote = useRef<{ participants: string[]; afterY: number | null } | null>(null);
  /*
   * Graph types: a marquee or Shift-click picks several (`picked`); `selected` is the one the panels and
   * Connect to… act on. Several picked show as picked only while `selected` is one of them.
   */
  const graphPicked = picked.nodes.length + picked.edges.length;
  const graphMany =
    !sequence &&
    graphPicked > 1 &&
    selected !== null &&
    (selected.kind === "node" ? picked.nodes : picked.edges).includes(selected.id);
  const marqueeBase = useRef<{ nodes: string[]; edges: string[] }>({ nodes: [], edges: [] });
  const marqueeCovers = (nodeIds: readonly string[], edgeIds: readonly string[]) => {
    const base = marqueeBase.current,
      nodes = [...new Set([...base.nodes, ...nodeIds])],
      edges = [...new Set([...base.edges, ...edgeIds])];
    setPicked({ nodes, edges });
    setPart(null);
    const last = nodes.at(-1) ?? null,
      lastEdge = edges.at(-1) ?? null;
    setSelected(last !== null ? { kind: "node", id: last } : lastEdge !== null ? { kind: "edge", id: lastEdge } : null);
  };
  const pickGraph = (kind: "node" | "edge", id: string, additive: boolean) => {
    if (!additive || (!graphMany && selected === null)) {
      setSelected({ kind, id });
      setPicked(kind === "node" ? { nodes: [id], edges: [] } : { nodes: [], edges: [id] });
      return;
    }
    // Shift-click adds to (or takes out of) what is picked; the selection is always one that is still picked.
    const base = graphMany
      ? picked
      : selected !== null
        ? selected.kind === "node"
          ? { nodes: [selected.id], edges: [] }
          : { nodes: [], edges: [selected.id] }
        : { nodes: [], edges: [] };
    const list = kind === "node" ? base.nodes : base.edges,
      removing = list.includes(id),
      nextList = removing ? list.filter((item) => item !== id) : [...list, id];
    const next = kind === "node" ? { nodes: nextList, edges: base.edges } : { nodes: base.nodes, edges: nextList };
    setPicked(next);
    if (!removing) {
      setSelected({ kind, id });
      return;
    }
    const lastNode = next.nodes.at(-1),
      lastEdge = next.edges.at(-1);
    setSelected(
      lastNode !== undefined
        ? { kind: "node", id: lastNode }
        : lastEdge !== undefined
          ? { kind: "edge", id: lastEdge }
          : null,
    );
  };
  const pick = (kind: "node" | "edge", id: string, additive: boolean) => {
    setSelected({ kind, id });
    setPart(null);
    setPicked((previous) => {
      const list = kind === "node" ? previous.nodes : previous.edges;
      const next = additive ? (list.includes(id) ? list.filter((item) => item !== id) : [...list, id]) : [id];
      return kind === "node"
        ? { nodes: next, edges: additive ? previous.edges : [] }
        : { nodes: additive ? previous.nodes : [], edges: next };
    });
  };
  const editOff = c.access?.authorized === true && !c.access.edit.enabled;
  // Name and Save as wait with the Save that carries them: the row goes once the file is made (sweep after O207).
  const publishing = c.data?.pending?.op === "document.publish";
  const d = c.data,
    unresolved = !!d?.pending && !c.held,
    canEdit =
      c.access?.authorized === true && !editOff && !phone && !c.busy && !layoutBusy && !unresolved && !c.unfinished;
  // Write buttons keep a stable enabled state while a preview, layout or edit settles: a click that lands mid-settle is queued by the controller, never lost to a transient disabled flip.
  const canWrite = c.access?.authorized === true && !editOff && !phone && !unresolved && !c.unfinished;
  const conflict = d?.receipt?.outcome === "conflict",
    operation = unresolved ? d?.receipt : c.unfinished,
    uncertain = operation?.state === "uncertain";
  const valid =
    c.preview?.envelope !== null && c.preview?.envelope !== undefined && projection?.ok === true && !c.previewBusy;
  // Only a type without a structured editor is edited in its source; every structured type opens canvas-only.
  const sourceOnly = projection?.ok === true && !structured;
  const creating = !!d && !d.opened;
  const modelFamily: Family | null = sequence ? "sequence" : graph ? (MODEL_FAMILY[graph.modelType] ?? null) : null;
  const family: Family | null = d ? (familyOf(d.source) ?? modelFamily ?? (creating ? "flowchart" : null)) : null;
  // Saved positions for shapes the opened diagram no longer has are dropped once, so a pristine editor isn't "changed".
  const prunedOnce = useRef(false);
  useEffect(() => {
    if (!flow || canvas.status !== "ready" || !d || stale) return;
    const ids = new Set(canvas.layout.nodes.map((node) => node.id));
    if (!prunedOnce.current) {
      prunedOnce.current = true;
      c.prunePositions(ids);
      return;
    }
    const next = Object.fromEntries(Object.entries(d.positions ?? {}).filter(([id]) => ids.has(id)));
    const changed = Object.keys(next).length !== Object.keys(d.positions ?? {}).length;
    if (changed) c.setPositions(next, false);
  }, [flow, canvas]);
  // Leave editing once the original is saved: the reading page shows the new version.
  // Only a Save made (or resumed) in this session, once its layout has settled; a receipt restored from history never exits.
  // A layout that failed to save keeps the editor open with the warning and a way back.
  const handledSave = useRef<string | null>(null);
  const leaveAfterSave = () => {
    const done = c.completed;
    if (!done) return;
    const target = done.target;
    // Saved to another diagram than the one being read (a missing file's work saved elsewhere): that diagram is shown.
    if (inPlace && sameTarget(target, inPlace.target)) {
      inPlace.onSaved();
      return;
    }
    const path =
      target.kind === "view"
        ? browserRoutePath({
            kind: "view",
            projectSlug,
            viewId: target.viewId,
            ...(done.path ? { sourcePath: done.path } : {}),
          })
        : null;
    if (path) location.assign(path);
  };
  useEffect(() => {
    const done = c.completed;
    if (!done || handledSave.current === done.operationId) return;
    handledSave.current = done.operationId;
    if (done.layoutSaved) leaveAfterSave();
  }, [c.completed]);
  const editLabel = (kind: "node" | "edge", id: string) => {
    if (c.busy || !canEdit) return false;
    // Labels are typed in place: inside the shape, or on the connection.
    const seqHas = (list: readonly { id: string }[] | undefined) => list?.some((item) => item.id === id) === true;
    if (kind === "node") {
      if (
        !graph?.nodes.some((node) => node.id === id) &&
        !seqHas(canvas.status === "sequence-ready" ? canvas.sequenceLayout.participants : undefined)
      )
        return false;
      setSelected({ kind, id });
      setEditingEdge(null);
      setEditingNode(id);
      return true;
    }
    if (
      !graph?.edges.some((edge) => edge.id === id) &&
      !seqHas(canvas.status === "sequence-ready" ? canvas.sequenceLayout.messages : undefined)
    )
      return false;
    setSelected({ kind, id });
    setEditingNode(null);
    setEditingEdge(id);
    return true;
  };
  const takenIds = () => [
    ...(graph?.nodes.map((node) => node.id) ?? []),
    ...(graph?.edges.map((edge) => edge.id) ?? []),
    ...(canvas.status === "sequence-ready" ? canvas.sequenceLayout.participants.map((p) => p.id) : []),
  ];
  // Where a new shape goes: just right of the selected shape, or the middle of the view.
  const placeFor = (): { x: number; y: number } | null => {
    const layoutNodes = canvas.status === "ready" ? canvas.layout.nodes : [];
    const anchor = selected?.kind === "node" ? layoutNodes.find((node) => node.id === selected.id) : undefined;
    const host = previewElement.current,
      toFlow = flowPosition.current;
    const box = host?.getBoundingClientRect();
    // The part of the drawing on screen (below the tools row), in drawing coordinates.
    const view =
      box && toFlow
        ? {
            min: toFlow({ x: box.left + 40, y: box.top + 120 }),
            max: toFlow({ x: box.right - 200, y: box.bottom - 40 }),
          }
        : null;
    // Never on top of another shape: step down (then right) until the spot is free.
    const boxes = layoutNodes.map((node) => {
      const own = d?.positions?.[node.id];
      return { x: own?.x ?? node.x, y: own?.y ?? node.y, width: node.width, height: node.height };
    });
    const free = (at: { x: number; y: number }) => {
      for (let i = 0; i < 40; i++) {
        const spot = { x: at.x + Math.floor(i / 8) * 200, y: at.y + (i % 8) * 90 };
        if (
          !boxes.some(
            (b) =>
              spot.x < b.x + b.width + 20 &&
              spot.x + 180 > b.x - 20 &&
              spot.y < b.y + b.height + 20 &&
              spot.y + 70 > b.y - 20,
          )
        )
          return spot;
      }
      return at;
    };
    if (anchor) {
      const own = d?.positions?.[anchor.id];
      const x = own?.x ?? anchor.x,
        y = own?.y ?? anchor.y;
      const next = free({ x: x + anchor.width + 140, y });
      // Beside the selected shape while that is on screen; otherwise where the person is looking, never off screen.
      if (!view || (next.x >= view.min.x && next.x <= view.max.x && next.y >= view.min.y && next.y <= view.max.y))
        return next;
    }
    if (!box || !toFlow) return null;
    const centre = toFlow({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
    return free({ x: Math.round(centre.x - 80), y: Math.round(centre.y - 30) });
  };
  const connectionPart = (): Extract<Part, { kind: "connection" }> | undefined => {
    const all = (family ? FAMILIES[family].parts.flat() : []).filter(
      (part): part is Extract<Part, { kind: "connection" }> => part.kind === "connection",
    );
    return all.find((part) => part.key === connectionKey) ?? all[0];
  };
  /** A shape just added, until its first name is typed: that name completes the same step ("Added “Cache”", one Undo). */
  const justAdded = useRef<{
    id: string;
    edit: Extract<FlowchartEdit, { kind: "add-node" }>;
    before: string;
    after: string;
    readable: boolean;
  } | null>(null);
  const renameNode = async (id: string, label: string) => {
    const fresh = justAdded.current;
    justAdded.current = null;
    if (fresh && fresh.id === id && c.data?.source === fresh.after && label.trim() !== "") {
      const said = `Added ${quoted(label)}`;
      // ER entities and states are named by their ID in the source: the typed name gives a readable one (`OrderLine`, not `ENTITY_1`).
      const readable = fresh.readable
        ? readableId(
            label,
            takenIds().filter((taken) => taken !== id),
          )
        : null;
      if (
        readable &&
        readable !== id &&
        (await c.amendLast(fresh.before, fresh.after, { ...fresh.edit, id: readable, label }, said))
      ) {
        setLastAction({ text: said });
        setEditingNode(null);
        setSelected({ kind: "node", id: readable });
        setPicked({ nodes: [readable], edges: [] });
        restoreFocus(readable);
        return;
      }
      if (await c.amendLast(fresh.before, fresh.after, { ...fresh.edit, label }, said)) {
        setLastAction({ text: said });
        return;
      }
    }
    // Refused (or nothing to do): the field closes now, the refusal says why, and the label shows what was kept.
    if (!(await edit({ kind: "relabel-node", id, label }))) {
      setEditingNode((current) => (current === id ? null : current));
      restoreFocus(id);
    }
  };
  /** A C4 relationship shows `label [technology]`; renaming it sets the label only, so the shown technology is not sent back. */
  const edgeLabelToSend = (id: string, typed: string) => {
    const figure = graph?.edges.find((edge) => edge.id === id)?.figure;
    return withoutShownTechnology(typed, figure?.type === "c4" ? figure.technology : undefined);
  };
  const freshId = (prefix: string) => {
    const taken = new Set(takenIds());
    let n = 1;
    while (taken.has(`${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  };
  const addNode = async (part: Extract<Part, { kind: "node" }>) => {
    if (!canEdit) return;
    const id = freshId(part.idPrefix);
    const at = flow ? placeFor() : null;
    const create = part.create;
    const params =
      "shape" in create
        ? { shape: create.shape }
        : "element" in create
          ? { element: create.element, ...(create.external ? { external: true } : {}) }
          : "state" in create && create.state !== "state"
            ? { state: create.state }
            : "participant" in create
              ? { participant: create.participant }
              : {};
    // A choice (like fork and join) is drawn by its kind and has no label in the source.
    const unlabelled = "state" in create && create.state !== "state";
    const before = c.data?.source;
    const change = { kind: "add-node" as const, id, label: unlabelled ? "" : part.label, ...params };
    const added = await edit(change);
    if (!added) return;
    justAdded.current =
      unlabelled || before === undefined
        ? null
        : { id, edit: change, before, after: added.source, readable: family === "er" || family === "state" };
    if (at) c.setPositions({ ...(c.data?.positions ?? {}), [id]: at }, false, true);
    // A named part opens its name field (which takes focus); one without a name (a choice, fork or join) takes focus
    // itself once drawn, leaving the part button it was added from.
    setSelected({ kind: "node", id });
    if (unlabelled) {
      const from = document.activeElement;
      if (from instanceof HTMLElement && from.closest(".authoring-parts")) from.blur();
      restoreFocus(id);
    } else setEditingNode(id);
  };
  /*
   * Connect to… (the keyboard way) keeps the person on its button (F33): the source stays selected, so the next
   * connection is one more choice. A kind with a label opens it first; closing the label comes back to the button.
   */
  const connectReturn = useRef<{ edge: string; source: string } | null>(null);
  const focusConnectButton = () =>
    requestAnimationFrame(() =>
      document.querySelector<HTMLButtonElement>(".authoring-connect-to>button")?.focus({ preventScroll: true }),
    );
  const connect = async (source: string, target: string, fromMenu = false) => {
    const part = connectionPart();
    if (!canEdit || !part) return;
    const create = part.create;
    // Sequence (Connect to…): a new message at the end, from the selected participant.
    if ("message" in create) {
      await interactionRef.current.drawMessage(source, target);
      return;
    }
    if (!("line" in create)) {
      // Outside flowcharts a connection is named by its two ends, one per ordered pair: dragging again edits the one there.
      const id = `${source}--${target}`;
      if (graph?.edges.some((edge) => edge.id === id)) {
        setSelected({ kind: "edge", id });
        setEditingNode(null);
        setEditingEdge(id);
        setInteractionError("Already connected: editing the existing relationship.");
        return;
      }
      const params =
        "relation" in create
          ? { relation: create.relation, label: part.defaultLabel ?? "Uses" }
          : "cardinality" in create
            ? { cardinality: create.cardinality, label: "" }
            : {};
      const added = await edit({ kind: "connect", source, target, ...params });
      if (!added) return;
      connected(id, source, part.labelMode !== "none", fromMenu);
      return;
    }
    const id = nextFreeId("e", takenIds());
    const added = await edit({
      kind: "connect",
      id,
      source,
      target,
      ...(create.line === "solid" ? {} : { line: create.line }),
    });
    if (!added) return;
    connected(id, source, part.labelMode !== "none", fromMenu);
  };
  const connected = (id: string, source: string, labelled: boolean, fromMenu: boolean) => {
    if (!fromMenu) {
      setSelected({ kind: "edge", id });
      if (labelled) setEditingEdge(id);
      return;
    }
    if (labelled) {
      connectReturn.current = { edge: id, source };
      setSelected({ kind: "edge", id });
      setEditingEdge(id);
      return;
    }
    focusConnectButton();
  };
  /*
   * Sequence messages are named by their place (`msg-N`, in source order), so an edit that inserts, deletes or
   * reorders messages renames the others. Selection, picks and an open label follow each message to its new id.
   */
  const remapMessages = (map: (index: number) => number | null) => {
    const next = (id: string): string | null => {
      const n = msgIndex(id);
      if (n === null) return id;
      const to = map(n);
      return to === null ? null : `msg-${to}`;
    };
    setSelected((current) => {
      if (current?.kind !== "edge") return current;
      const id = next(current.id);
      return id === null ? null : { kind: "edge", id };
    });
    setPicked((current) => ({
      nodes: current.nodes,
      edges: current.edges.map(next).filter((id): id is string => id !== null),
    }));
    setEditingEdge((current) => (current === null ? null : next(current)));
  };
  const messageIds = () =>
    (canvas.status === "sequence-ready" ? canvas.sequenceLayout.messages.map((m) => m.id) : [])
      .filter((id) => msgIndex(id) !== null)
      .sort((a, b) => msgIndex(a)! - msgIndex(b)!);
  /** Move a message to stand before another (null: last), keeping every selection on the message it named. */
  const moveEdge = async (id: string, before: string | null) => {
    const ids = messageIds(),
      others = ids.filter((other) => other !== id),
      at = before === null ? others.length : others.indexOf(before);
    if (at < 0) return;
    const order = [...others.slice(0, at), id, ...others.slice(at)];
    const done = await edit({ kind: "move-edge", id, before });
    if (done)
      remapMessages((n) => {
        const i = order.indexOf(`msg-${n}`);
        return i < 0 ? n : i;
      });
  };
  // A message just drawn opens its text for typing once the redrawn layout shows it: the id it takes is its place.
  const expectedMessage = useRef<{ id: string; count: number } | null>(null),
    freshMessage = useRef<string | null>(null);
  const drawMessage = async (from: string, to: string, after?: string | null) => {
    const part = connectionPart();
    if (!canEdit || !part || !("message" in part.create)) return;
    const ids = messageIds(),
      count = ids.length;
    const index = after === undefined ? count : after === null ? 0 : (msgIndex(after) ?? count - 1) + 1;
    const added = await edit({
      kind: "connect",
      source: from,
      target: to,
      label: "",
      message: part.create.message,
      ...(after === undefined ? {} : { after }),
    });
    if (!added) return;
    // Everything at or after the new place moves down one.
    remapMessages((n) => (n >= index ? n + 1 : n));
    expectedMessage.current = { id: `msg-${index}`, count: count + 1 };
  };
  useEffect(() => {
    const expected = expectedMessage.current;
    if (expected === null || canvas.status !== "sequence-ready") return;
    if (canvas.sequenceLayout.messages.length !== expected.count) return;
    expectedMessage.current = null;
    if (!canvas.sequenceLayout.messages.some((m) => m.id === expected.id)) return;
    freshMessage.current = expected.id;
    setSelected({ kind: "edge", id: expected.id });
    setPicked({ nodes: [], edges: [expected.id] });
    setEditingNode(null);
    setEditingEdge(expected.id);
  }, [canvas]);
  // A note just added opens its text for typing: the "Note" over those participants, just below where it was asked for.
  useEffect(() => {
    const expected = expectedNote.current;
    if (expected === null || canvas.status !== "sequence-ready") return;
    const same = (a: readonly string[], b: readonly string[]) =>
      a.length === b.length && a.every((id) => b.includes(id));
    const candidates = canvas.sequenceLayout.notes
      .filter((note) => note.text === "Note" && same(note.participants, expected.participants))
      .sort((a, b) => a.y - b.y);
    if (!candidates.length) return;
    expectedNote.current = null;
    const fresh =
      expected.afterY === null
        ? candidates.at(-1)!
        : (candidates.find((note) => note.y > expected.afterY!) ?? candidates.at(-1)!);
    setSelected(null);
    setPicked({ nodes: [], edges: [] });
    setPart({ kind: "note", id: fresh.id, focus: 1 });
  }, [canvas]);
  /*
   * Keyboard focus goes back to what was just edited (a shape, a message), never to the page body. `gone`: what the
   * edit removed (a delete), whose element may still hold focus until the drawing catches up; focus is moved off it.
   */
  const restoreFocus = (id: string | null, gone: readonly string[] = []) => {
    const waitUntil = Date.now() + 5000;
    const goneSelector = gone
      .map((item) => `[data-id="${CSS.escape(item)}"], [data-seq-id="${CSS.escape(item)}"]`)
      .join(", ");
    const attempt = (tries: number) => {
      const root = workspaceElement.current;
      if (!root) return;
      const active = document.activeElement;
      // Still on what was removed, or on a button the edit disabled (Delete selected): that focus is about to be lost.
      const losing =
        active instanceof Element &&
        ((goneSelector !== "" && active.closest(goneSelector) !== null) ||
          (active instanceof HTMLButtonElement && active.disabled));
      if (losing && drawingPending.current && Date.now() < waitUntil) {
        setTimeout(() => attempt(tries), 60);
        return;
      }
      // Focus already somewhere in the editor (a label field that just opened, a button): leave it there.
      if (active && active !== document.body && root.contains(active) && !losing && active.isConnected) return;
      const escaped = id === null ? null : CSS.escape(id);
      const target =
        escaped === null
          ? null
          : root.querySelector<HTMLElement | SVGElement>(
              `.react-flow__node[data-id="${escaped}"], [data-seq-id="${escaped}"][tabindex], [data-seq-id="${escaped}"] [tabindex], .react-flow__edge[data-id="${escaped}"][tabindex], .react-flow__edge[data-id="${escaped}"] [tabindex]`,
            );
      if (target && "focus" in target) {
        target.focus({ preventScroll: true });
        if (document.activeElement === target) return;
      }
      // The element is still on its way (a new or re-identified part waits for its preview and layout): wait for the drawing.
      if (drawingPending.current && Date.now() < waitUntil) {
        setTimeout(() => attempt(tries), 60);
        return;
      }
      if (tries > 0) {
        setTimeout(() => attempt(tries - 1), 120);
        return;
      }
      previewElement.current?.focus({ preventScroll: true });
    };
    requestAnimationFrame(() => attempt(3));
  };
  /** The shape nearest to a removed one (centre to centre), for focus after a delete; a connection's nearest is its source. */
  const nearestShape = (id: string, kind: "node" | "edge"): string | null => {
    if (canvas.status === "sequence-ready") {
      if (kind === "edge") return null;
      const all = canvas.sequenceLayout.participants.map((p) => p.id),
        at = all.indexOf(id);
      return at === -1 ? null : (all[at + 1] ?? all[at - 1] ?? null);
    }
    if (canvas.status !== "ready") return null;
    const centre = (nodeId: string) => {
      const node = canvas.layout.nodes.find((n) => n.id === nodeId);
      if (!node) return null;
      const own = c.data?.positions?.[nodeId];
      return { x: (own?.x ?? node.x) + node.width / 2, y: (own?.y ?? node.y) + node.height / 2 };
    };
    if (kind === "edge") {
      const edge = canvas.layout.edges.find((e) => e.id === id);
      return edge && centre(edge.source) ? edge.source : null;
    }
    const from = centre(id);
    if (!from) return null;
    let best: string | null = null,
      bestDistance = Infinity;
    for (const node of canvas.layout.nodes) {
      if (node.id === id) continue;
      const at = centre(node.id)!;
      const distance = Math.hypot(at.x - from.x, at.y - from.y);
      if (distance < bestDistance) {
        best = node.id;
        bestDistance = distance;
      }
    }
    return best;
  };
  /** A shape the person can place: a top-level leaf of a laid-out graph (the shapes a drag moves), where it stands now. */
  const placeable = (id: string) => {
    if (canvas.status !== "ready") return null;
    const node = canvas.layout.nodes.find((n) => n.id === id);
    if (!node || node.groupId !== undefined || node.figure !== undefined) return null;
    const own = c.data?.positions?.[id];
    return { x: own?.x ?? node.x, y: own?.y ?? node.y, width: node.width, height: node.height };
  };
  const placeAt = (id: string, at: { x: number; y: number }, recordHistory = true) => {
    if (!canEdit) return;
    const said = `Moved ${quoted(nameNow(id))}`;
    c.setPositions(
      { ...c.data?.positions, [id]: { x: Math.round(at.x), y: Math.round(at.y) } },
      recordHistory,
      true,
      said,
    );
    setLastAction({ text: said });
  };
  /** One arrow press; presses in a quick run on the same shape are one Undo step. */
  const nudge = (id: string, dx: number, dy: number, now: number) => {
    const at = placeable(id);
    if (!at) return;
    const run = nudgeRun.current;
    placeAt(id, { x: at.x + dx, y: at.y + dy }, !(run && run.id === id && now - run.at < 1000));
    nudgeRun.current = { id, at: now };
  };
  /** Move's click: the shape's middle lands where the person clicked. */
  const placeMoving = (point: { x: number; y: number }) => {
    const id = moving;
    setMoving(null);
    if (id === null) return;
    const at = placeable(id);
    if (!at) return;
    nudgeRun.current = null;
    placeAt(id, { x: point.x - at.width / 2, y: point.y - at.height / 2 });
    restoreFocus(id);
  };
  const interactionRef = useRef({
    c,
    canEdit,
    connect,
    editLabel,
    drawMessage,
    moveEdge,
    restoreFocus,
    selected,
    edit,
    renameNode,
    edgeLabelToSend,
    nameNow,
    placeMoving,
    focusConnectButton,
  });
  interactionRef.current = {
    c,
    canEdit,
    connect,
    editLabel,
    drawMessage,
    moveEdge,
    restoreFocus,
    selected,
    edit,
    renameNode,
    edgeLabelToSend,
    nameNow,
    placeMoving,
    focusConnectButton,
  };
  // The file changed under the open editor (an agent, the CLI, another tab): say so now, not at Save.
  const firstRevision = useRef<string | undefined>(undefined),
    [changedOutside, setChangedOutside] = useState(false);
  // ADR 0028: when the open file changes elsewhere, a clean editor takes the new version in place;
  // unsaved work (including a field being typed in) gets a choice that stays until made.
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  // Reopening the original: in place, the reading page's own `?edit` address (its canonical one, claude-10), not the
  // standalone editor address (`-/edit/?viewId=`), which the entry turns into the reading address first.
  const reopenOriginal = (target: AuthoringTarget | null): string | null =>
    inPlace && sameTarget(target, inPlace.target) ? inPlaceHref(null) : editorHref(projectSlug, target);
  const reconcileOutside = (seen?: string): void => {
    const opened = c.data?.opened;
    if (!opened || c.completed) return;
    const name = opened.path.split("/").at(-1) ?? "This diagram";
    const active = document.activeElement;
    const typing =
      active instanceof HTMLElement &&
      active.closest('.authoring-workspace,[aria-label="Diagram Editor"]') !== null &&
      (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
    void (typing ? Promise.resolve("dirty" as const) : c.refreshClean()).then((outcome) => {
      if (!mounted.current || outcome === "skipped") return;
      if (outcome === "refreshed") {
        if (seen !== undefined) firstRevision.current = seen;
        showFilePopup(`${name} updated`, [opened.path]);
        return;
      }
      // Said once, by the conflict banner (role="alert", with its ways out) beside the ADR 0028 choice; no toast as well (claude-310).
      setChangedOutside(true);
      showFilePopup(`${name} updated. You have unsaved changes.`, [opened.path], {
        actions: [
          {
            label: "Load the new version",
            run: () => {
              if (
                !window.confirm(
                  "Load the new version? Your unsaved changes here will be lost. Copy your Mermaid first to keep it.",
                )
              )
                return false;
              location.assign(reopenOriginal(opened.target) ?? location.href);
              return true;
            },
          },
          { label: "Keep mine", run: () => true },
        ],
      });
    });
  };
  const reconcileRef = useRef(reconcileOutside);
  reconcileRef.current = reconcileOutside;
  // Unsaved work restored over a file someone else changed meanwhile: said now, before Save is refused (claude-306).
  useEffect(() => {
    if (c.changedSinceKept) setChangedOutside(true);
  }, [c.changedSinceKept]);
  // A private proposal was saved (O84): say so, where to find it, and that the file was not touched.
  useEffect(() => {
    const saved = c.proposalSaved;
    if (!saved) return;
    say(
      `Saved as a private proposal (revision ${saved.draftRevision})${saved.diverged ? ", based on the version you opened. The file has changed since and was not touched." : ". The file was not changed."} Find it under Draft and proposal tools.`,
      { severity: "success" },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per saved proposal
  }, [c.proposalSaved?.operationId]);
  useEffect(() => {
    if (externalRevision === undefined) return;
    if (firstRevision.current === undefined) {
      firstRevision.current = externalRevision;
      return;
    }
    if (externalRevision !== firstRevision.current) reconcileRef.current(externalRevision);
  }, [externalRevision]);
  // The open file speaks for itself. Without a revision from the reading page (the standalone
  // editor), its files event drives the same reconciliation; a removal says so and stays.
  const openPath = c.data?.opened?.path,
    standalone = externalRevision === undefined;
  useEffect(() => {
    if (openPath === undefined) return;
    const name = openPath.split("/").at(-1) ?? openPath;
    const stop = watchOpenFile(openPath, (update) => {
      if (update.removed) {
        showFilePopup(`${name} was removed. Your copy here is kept; copy your Mermaid to keep it.`, [openPath], {
          actions: [],
        });
        return;
      }
      if (standalone) {
        reconcileRef.current();
        return;
      }
      if (!filePopupIsChoice()) showFilePopup(`${name} updated`, [openPath]);
    });
    return () => {
      stop();
      dismissFilePopupFor(openPath);
    };
  }, [openPath, standalone]);
  // One feedback message at a time, pinned over the canvas, derived from what is true now: an error shows while its source
  // holds it (unless that message was dismissed), and a passing notice shows until let go of or replaced by a newer error.
  const errors: Readonly<Record<ErrorSource, string | null>> = {
    hook: c.error,
    presentation: c.presentationError,
    drawing: drawingError,
  };
  errorsNow.current = errors;
  // Adjusted during render, not in an effect: a dismissal ends when its message does, and a newer error replaces the passing notice.
  if (ERROR_SOURCES.some((source) => dismissed[source] !== undefined && dismissed[source] !== errors[source]))
    setDismissed((current) =>
      Object.fromEntries(Object.entries(current).filter(([source, text]) => errors[source as ErrorSource] === text)),
    );
  if (said && ERROR_SOURCES.some((source) => said.over[source] !== errors[source])) {
    if (ERROR_SOURCES.some((source) => errors[source] !== null && said.over[source] !== errors[source])) setSaid(null);
    else setSaid({ ...said, over: errors });
  }
  const errorShown = ERROR_SOURCES.find((source) => errors[source] !== null && dismissed[source] !== errors[source]);
  const notice: Notice | null = said
    ? {
        from: "interaction",
        text: said.text,
        severity: said.severity,
        ...(said.refusal ? { refusal: said.refusal } : {}),
      }
    : errorShown
      ? { from: errorShown, text: errors[errorShown]!, severity: "error" }
      : null;
  const dismissNotice = () => {
    if (!notice) return;
    if (notice.from === "interaction") letGo();
    else {
      const from = notice.from;
      setDismissed((current) => ({ ...current, [from]: notice.text }));
    }
  };
  const canvasEditable = c.access?.authorized === true && !editOff && !phone && !unresolved && !c.unfinished;
  /*
   * A shape being dragged (D10, WCAG 2.5.2): Escape puts it back and ends the drag, and a release outside the drawing
   * moves nothing. The canvas commits a drag on React Flow's drag end, which d3-drag fires on the window's `mouseup`:
   * Escape ends the gesture with one, and the move it reports is then dropped, so the canvas redraws the shape where it was.
   */
  const nodeDrag = useRef<{ id: string; cancelled: boolean; at: { x: number; y: number } | null } | null>(null);
  useEffect(() => {
    const down = (event: PointerEvent) => {
      const shape =
        event.button === 0 && event.target instanceof Element
          ? event.target.closest<HTMLElement>(".react-flow__node.draggable")
          : null;
      nodeDrag.current =
        shape?.dataset.id && previewElement.current?.contains(shape)
          ? { id: shape.dataset.id, cancelled: false, at: null }
          : null;
    };
    const move = (event: PointerEvent) => {
      const drag = nodeDrag.current;
      if (drag) drag.at = { x: event.clientX, y: event.clientY };
    };
    // Kept through the mouseup that ends the drag (it follows pointerup), then let go of.
    const up = (event: PointerEvent) => {
      const drag = nodeDrag.current;
      if (!drag) return;
      drag.at = { x: event.clientX, y: event.clientY };
      setTimeout(() => {
        if (nodeDrag.current === drag) nodeDrag.current = null;
      }, 0);
    };
    const key = (event: KeyboardEvent) => {
      const drag = nodeDrag.current;
      if (event.key !== "Escape" || !drag || drag.cancelled) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      drag.cancelled = true;
      const at = drag.at ?? { x: 0, y: 0 };
      window.dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 0,
          clientX: at.x,
          clientY: at.y,
        }),
      );
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      window.removeEventListener("keydown", key, true);
    };
  }, []);
  /** Whether a drag of this shape ends without moving it: Escape cancelled it, or it was let go outside the drawing. */
  const dragDropped = (id: string): boolean => {
    const drag = nodeDrag.current;
    if (!drag || drag.id !== id) return false;
    if (drag.cancelled) return true;
    const box = previewElement.current?.getBoundingClientRect(),
      at = drag.at;
    if (!box || !at || (at.x >= box.left && at.x <= box.right && at.y >= box.top && at.y <= box.bottom)) return false;
    say(`Let go outside the drawing: ${quoted(nameNow(id))} stays where it was.`, { severity: "info" });
    return true;
  };
  const dragDroppedRef = useRef(dragDropped);
  dragDroppedRef.current = dragDropped;
  const authoring = useMemo(
    () => ({
      enabled: structured && !phone,
      disabled: !canvasEditable,
      positions: d?.positions ?? {},
      ...(moving !== null
        ? { onPanePlace: (at: { x: number; y: number }) => interactionRef.current.placeMoving(at) }
        : {}),
      onNodeMove: (id: string, position: { x: number; y: number }) => {
        const latest = interactionRef.current;
        if (!latest.canEdit || dragDroppedRef.current(id)) return;
        const said = `Moved ${quoted(latest.nameNow(id))}`;
        latest.c.setPositions({ ...latest.c.data?.positions, [id]: position }, true, true, said);
        setLastAction({ text: said });
      },
      onConnect: (source: string, target: string) => {
        void interactionRef.current.connect(source, target);
      },
      onNodeLabelEdit: (id: string) => {
        interactionRef.current.editLabel("node", id);
      },
      onEdgeLabelEdit: (id: string) => {
        interactionRef.current.editLabel("edge", id);
      },
      onRefused: (reason: string) => setInteractionError(reason),
      onPartClick: (kind: "note" | "fragment", id: string, edit: boolean) => {
        setSelected(null);
        setPicked({ nodes: [], edges: [] });
        setPart((current) => ({
          kind,
          id,
          focus: edit ? (current?.focus ?? 0) + 1 : current?.id === id ? current.focus : 0,
        }));
      },
      selectedPart: part?.id ?? null,
      selectMode,
      flowPosition,
      editingNodeId: editingNode,
      relabel: !structured && !phone && family === "state",
      onNodeLabelCommit: (id: string, label: string) => {
        const latest = interactionRef.current;
        if (!latest.canEdit) {
          setEditingNode((current) => (current === id ? null : current));
          return;
        }
        if (structured) {
          void latest.renameNode(id, label);
          return;
        }
        const source = latest.c.data?.source;
        const next = source !== undefined && family ? relabelInSource(family, id, label, source) : null;
        if (next === null) {
          setInteractionError("This element’s name can’t be changed here; edit it in the Mermaid source.");
          return;
        }
        latest.c.updateSource(next);
      },
      onNodeLabelClose: () => {
        const id = interactionRef.current.selected?.id ?? null;
        setEditingNode(null);
        interactionRef.current.restoreFocus(id);
      },
      editingEdgeId: editingEdge,
      onEdgeLabelCommit: (id: string, label: string) => {
        const latest = interactionRef.current;
        if (!latest.canEdit) {
          setEditingEdge((current) => (current === id ? null : current));
          return;
        }
        void latest.edit({ kind: "relabel-edge", id, label: latest.edgeLabelToSend(id, label) }).then((done) => {
          if (!done) {
            setEditingEdge((current) => (current === id ? null : current));
            latest.restoreFocus(id);
          }
        });
      },
      ...(family !== "sequence"
        ? {
            onEdgeRetarget: (id: string, end: "source" | "target", node: string) => {
              const latest = interactionRef.current;
              if (!latest.canEdit) return;
              void latest
                .edit({ kind: "retarget-edge", id, ...(end === "source" ? { source: node } : { target: node }) })
                .then((done) => {
                  if (done) {
                    setSelected(null);
                    setPicked({ nodes: [], edges: [] });
                  }
                });
            },
          }
        : {}),
      onEdgeLabelClose: () => {
        setEditingEdge(null);
        const back = connectReturn.current;
        connectReturn.current = null;
        if (back !== null && interactionRef.current.selected?.id === back.edge) {
          setSelected({ kind: "node", id: back.source });
          setPicked({ nodes: [back.source], edges: [] });
          interactionRef.current.focusConnectButton();
          return;
        }
        interactionRef.current.restoreFocus(interactionRef.current.selected?.id ?? null);
        // A message just drawn and named is done: deselect it, so picking the next arrow type doesn't change it.
        if (freshMessage.current !== null) {
          freshMessage.current = null;
          setSelected(null);
          setPicked({ nodes: [], edges: [] });
        }
      },
      ...(family === "sequence"
        ? {
            onNodeReorder: (id: string, before: string | null) => {
              const latest = interactionRef.current;
              if (latest.canEdit) void latest.edit({ kind: "move-node", id, before });
            },
            onMessageDraw: (from: string, to: string, after: string | null) => {
              void interactionRef.current.drawMessage(from, to, after);
            },
            onEdgeRetarget: (id: string, end: "source" | "target", participant: string) => {
              const latest = interactionRef.current;
              if (latest.canEdit)
                void latest.edit({
                  kind: "retarget-edge",
                  id,
                  ...(end === "source" ? { source: participant } : { target: participant }),
                });
            },
            onEdgeMove: (id: string, before: string | null) => {
              const latest = interactionRef.current;
              if (latest.canEdit) void latest.moveEdge(id, before);
            },
          }
        : {}),
    }),
    [
      flow,
      structured,
      phone,
      canvasEditable,
      d?.positions,
      editingNode,
      editingEdge,
      family,
      part?.id,
      moving !== null,
    ],
  );
  /*
   * The canvas element is kept while what it draws is unchanged, so an edit's other renders (busy, the status line, the
   * panels) don't re-render the canvas. Its handlers read the latest state through `canvasEvents`.
   */
  const canvasEvents = useRef<{
    node: (id: string, additive?: boolean) => void;
    edge: (id: string, additive?: boolean) => void;
    pane: () => void;
    marqueeStart: (additive: boolean) => void;
    marqueeChange: (nodeIds: readonly string[], edgeIds: readonly string[]) => void;
  } | null>(null);
  const canvasSelection = sequence || graphMany ? picked : selected;
  const canvasView = useMemo(
    () =>
      canvas.status === "empty" ? null : (
        <DiagramCanvas
          authoring={authoring}
          primaryShell
          state={canvas}
          selection={
            canvasSelection === null
              ? {}
              : "kind" in canvasSelection
                ? canvasSelection.kind === "node"
                  ? { nodeIds: [canvasSelection.id] }
                  : { edgeIds: [canvasSelection.id] }
                : { nodeIds: canvasSelection.nodes, edgeIds: canvasSelection.edges }
          }
          onNodeClick={(id, additive) => canvasEvents.current?.node(id, additive)}
          onEdgeClick={(id, additive) => canvasEvents.current?.edge(id, additive)}
          onPaneClick={() => canvasEvents.current?.pane()}
          {...(sequence
            ? {}
            : {
                onMarqueeStart: (additive: boolean) => canvasEvents.current?.marqueeStart(additive),
                onMarqueeChange: (nodeIds: readonly string[], edgeIds: readonly string[]) =>
                  canvasEvents.current?.marqueeChange(nodeIds, edgeIds),
                onMarqueeEnd: () => {
                  marqueeBase.current = { nodes: [], edges: [] };
                },
              })}
        />
      ),
    [canvas, authoring, sequence !== null, canvasSelection],
  );
  // Dev builds: editing invariants (`ui.edit.stale-selection`, `ui.edit.chrome-overlap`); a production build drops these.
  const workspaceElement = useRef<HTMLElement>(null);
  // What the canvas draws now; null while a layout is on its way.
  const drawn = useMemo(
    () =>
      layoutBusy
        ? null
        : canvas.status === "ready"
          ? new Set([...canvas.layout.nodes, ...canvas.layout.edges, ...canvas.layout.groups].map((item) => item.id))
          : canvas.status === "sequence-ready"
            ? new Set(
                [
                  ...canvas.sequenceLayout.participants,
                  ...canvas.sequenceLayout.messages,
                  ...canvas.sequenceLayout.notes,
                  ...canvas.sequenceLayout.fragments,
                ].map((item) => item.id),
              )
            : null,
    [canvas, layoutBusy],
  );
  // A redrawn diagram that no longer has what was selected or being renamed (an Undo, a reattached connection's new id,
  // a change from elsewhere) lets go of it: the panels and an open label never act on something not drawn.
  useEffect(() => {
    if (drawn === null || stale) return;
    // Only what is gone is set (a no-op setter would still cost a render).
    if (selected && !drawn.has(selected.id)) setSelected(null);
    if (editingNode !== null && !drawn.has(editingNode)) setEditingNode(null);
    if (editingEdge !== null && !drawn.has(editingEdge)) setEditingEdge(null);
    if (part && !drawn.has(part.id)) setPart(null);
    if ([...picked.nodes, ...picked.edges].some((id) => !drawn.has(id)))
      setPicked({
        nodes: picked.nodes.filter((id) => drawn.has(id)),
        edges: picked.edges.filter((id) => drawn.has(id)),
      });
  }, [canvas]);
  // biome-ignore-start lint/correctness/useHookAtTopLevel: __ARCHER_DEBUG__ is a build-time constant (vite define), so the hook order never changes within a build.
  if (__ARCHER_DEBUG__) {
    useStaleSelectionCheck("editor", drawn, { selected: selected?.id, editingNode, editingEdge });
    useChromeOverlapCheck(
      workspaceElement,
      `${canvas.status}|${panelShown}|${selected?.kind ?? ""}|${c.data !== null}`,
    );
  }
  // biome-ignore-end lint/correctness/useHookAtTopLevel: see above
  const leave = () => {
    if (inPlace) {
      inPlace.onExit();
      return;
    }
    const path = browserRoutePath({ kind: "browse", projectSlug, folder: "" });
    if (path) location.assign(path);
  };
  // Leaving a dirty editor any way the page offers (breadcrumb, rail, search, Back) asks first; `proceed` is where it was going.
  const pendingLeave = useRef<(() => void) | null>(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = c.dirty;
  // Set by Discard: the person already confirmed, so the browser's own leave prompt stands down for the navigation that follows
  // (it would otherwise ask again, since `dirty` clears only on the next render, after location.assign).
  const discarding = useRef(false);
  const discard = () => {
    setLastAction(null);
    discarding.current = true;
    c.cancel();
    const proceed = pendingLeave.current;
    pendingLeave.current = null;
    if (proceed) proceed();
    else leave();
  };
  useEffect(() => {
    const guard = inPlace?.guard;
    if (!guard) return;
    guard.current = (proceed) => {
      if (!dirtyRef.current) {
        proceed();
        return;
      }
      pendingLeave.current = proceed;
      discardDialog.current?.showModal();
    };
    return () => {
      guard.current = null;
    };
  }, [inPlace?.guard]);
  // The first thing worth showing, once: the page hands over from the reading drawing (no blank canvas between them).
  const firstDrawing = useRef(false);
  const shown =
    canvas.status === "ready" ||
    canvas.status === "sequence-ready" ||
    canvas.status === "journey-ready" ||
    drawingError !== null ||
    stale ||
    (!!c.data && !c.previewBusy && canvas.status === "empty" && laidOut !== null);
  useEffect(() => {
    if (!shown || firstDrawing.current) return;
    firstDrawing.current = true;
    inPlace?.onFirstDrawing?.();
  }, [shown, inPlace]);
  useEffect(() => {
    if (!c.dirty) return;
    discarding.current = false;
    // Closing or reloading the tab with unsaved edits: the browser's own prompt (the work is also kept in recovery).
    const warn = (event: BeforeUnloadEvent) => {
      if (discarding.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [c.dirty]);
  // An upgraded service (ADR 0032) reloads the page only when no edit, and no save in flight, would be lost.
  const holdsWork = c.dirty || c.busy || !!c.data?.pending;
  useEffect(() => (holdsWork ? holdForUnsavedWork() : undefined), [holdsWork]);
  // Editing shortcuts work wherever focus is on the page (not only inside the editor), except while typing or in a dialog.
  const keysRef = useRef<(event: ShortcutKey) => void>(() => {});
  const editRoving = useRovingToolbar(),
    partsRoving = useRovingToolbar();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input,textarea,select,[contenteditable=true],dialog[open],[aria-modal="true"],[role=menu]'))
        return;
      if (
        target &&
        target !== document.body &&
        !workspaceElement.current?.contains(target) &&
        !target.closest(".archer-shell-local-tools,[data-archer-editor-tools]") &&
        target.closest("header,nav,aside")
      )
        return;
      keysRef.current(event);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // A shortcut pressed while an edit or the layout settles (Delete right after Undo) is kept and runs once it has, never dropped.
  const pendingKey = useRef<ShortcutKey | null>(null);
  useEffect(() => {
    if (!canEdit || pendingKey.current === null) return;
    const key = pendingKey.current;
    pendingKey.current = null;
    keysRef.current(key);
  }, [canEdit]);
  // A Connect to… choice made while an edit settles runs once it has (the button stays enabled meanwhile, keeping focus).
  const pendingConnect = useRef<readonly [string, string] | null>(null);
  useEffect(() => {
    if (!canEdit || pendingConnect.current === null) return;
    const [from, to] = pendingConnect.current;
    pendingConnect.current = null;
    void interactionRef.current.connect(from, to, true);
  }, [canEdit]);
  // A part picked while an edit is checked or a fresh preview is laid out waits for it and then runs (O17): the parts stay
  // enabled and say aria-busy meanwhile, so a click is never lost to a transient disabled flip or a busy controller.
  const pendingPart = useRef<Part | null>(null),
    applyPartRef = useRef<(part: Part) => void>(() => {});
  useEffect(() => {
    const part = pendingPart.current;
    if (part === null || !canEdit || c.isBusy()) return;
    pendingPart.current = null;
    applyPartRef.current(part);
  });
  // The source drawer's editor (CodeMirror), loaded on first use; a plain text area until it arrives.
  const SourceEditor = useSourceEditor();
  // The conflict banner (O156): an alert when the conflict first shows, so it is announced as it happens. What it says
  // after that (Save refused, a proposal saved) follows the person's own action and is said politely, never
  // re-announced assertively (announced-once.ts). Above the early returns: a hook. A new conflict is an alert again.
  const bannerText =
    (conflict || changedOutside) && !creating && !phone
      ? conflict
        ? "Save is blocked: the original changed while you edited. Your working copy is kept."
        : c.changedSinceKept
          ? "The original changed outside the editor after these unsaved changes were made. Saving will be refused; your working copy is kept."
          : "The original changed outside the editor while you edited. Saving will be refused; your working copy is kept."
      : null;
  const bannerRole = useAnnouncedOnce(bannerText);
  // No answer while opening (claude-602): not connected, Try again, and a way back; it opens by itself on reconnect.
  if (c.unreachable && !d)
    return (
      <OpenUnreachable
        failedTries={c.failedTries}
        onRetry={c.retryOpen}
        {...(inPlace
          ? { onBack: inPlace.onExit }
          : { projectHref: browserRoutePath({ kind: "browse", projectSlug, folder: "" }) })}
      />
    );
  if (c.access === null)
    return (
      <section className="authoring-denied">
        <h2>Diagram Editor</h2>
        <p role={c.error ? "alert" : "status"}>{c.error ?? "Checking editing access…"}</p>
      </section>
    );
  if (!c.access.authorized)
    return (
      <section className="authoring-denied">
        <h2>Diagram Editor</h2>
        <p>Editing is unavailable on this access link. Open Archer from a new link or pairing code to edit here.</p>
        <p>This address can read and comment but not edit.</p>
        {inPlace ? (
          <p>
            <button type="button" onClick={inPlace.onExit}>
              Back to reading
            </button>
          </p>
        ) : null}
      </section>
    );
  // Work on a file that is gone (claude-203): its text, Copy, and Save as new, Save as a proposal or Discard.
  if (c.missing || c.missingDiscarded)
    return (
      <MissingWork
        missing={c.missing}
        discarded={c.missingDiscarded}
        busy={c.busy}
        error={c.error}
        onSaveNew={(path) => {
          changePublishPath(path);
          c.adoptMissing("new", path);
        }}
        onProposal={() => c.adoptMissing("proposal")}
        onDiscard={c.discardMissing}
        onResume={() => {
          const r = c.resumable;
          if (!r) return;
          void c.takeResumable().then((ok) => {
            if (ok) onResume(r.draftId);
          });
        }}
        {...(inPlace
          ? { onBack: inPlace.onExit }
          : { projectHref: browserRoutePath({ kind: "browse", projectSlug, folder: "" }) })}
      />
    );
  if (!d)
    return (
      <section className="authoring-denied">
        <h2>Diagram Editor</h2>
        <p role={c.error ? "alert" : "status"}>{c.error ?? "Opening diagram…"}</p>
      </section>
    );
  const commit = (kind: "relabel-node" | "relabel-edge", id: string, label: string) => {
    if (canEdit) void edit({ kind, id, label });
  };
  const direction =
    Object.entries(DIRECTIONS).find(([, key]) => key === (graph?.direction ?? "tb"))?.[0] ?? "Top to bottom";
  // Sequence participants stand left to right in declaration order; moving one is a reorder of its declaration.
  const participants = canvas.status === "sequence-ready" ? canvas.sequenceLayout.participants : [];
  const participantIds = participants.map((p) => p.id);
  /** What the person sees an element called: its label, never its internal id when it has one. */
  const nameOf = nameNow;
  const clearSelection = () => {
    setSelected(null);
    setPicked({ nodes: [], edges: [] });
    setConnectMenu(false);
    setPart(null);
  };
  const sequenceNotes = canvas.status === "sequence-ready" ? canvas.sequenceLayout.notes : [],
    sequenceFragments = canvas.status === "sequence-ready" ? canvas.sequenceLayout.fragments : [];
  const pickedNote = part?.kind === "note" ? sequenceNotes.find((note) => note.id === part.id) : undefined,
    pickedFragment = part?.kind === "fragment" ? sequenceFragments.find((f) => f.id === part.id) : undefined;
  const deletePart = () => {
    if (!canEdit || !part) return;
    void edit(
      part.kind === "note" ? { kind: "delete-note", id: part.id } : { kind: "unwrap-fragment", id: part.id },
    ).then((done) => {
      if (done) setPart(null);
    });
  };
  const moveSelected = (delta: -1 | 1) => {
    if (!canEdit || selected?.kind !== "node") return;
    const index = participantIds.indexOf(selected.id);
    if (index === -1) return;
    const to = index + delta;
    if (to < 0 || to >= participantIds.length) return;
    const before = delta < 0 ? participantIds[to]! : (participantIds[to + 1] ?? null);
    void edit({ kind: "move-node", id: selected.id, before });
  };
  // Sequence messages read top to bottom; moving one reorders its line, reversing swaps its ends.
  const messageOrder =
    canvas.status === "sequence-ready" ? [...canvas.sequenceLayout.messages].sort((a, b) => a.y - b.y) : [];
  const selectedMessage = selected?.kind === "edge" ? messageOrder.find((m) => m.id === selected.id) : undefined;
  const moveMessage = (delta: -1 | 1) => {
    if (!canEdit || !selectedMessage) return;
    const index = messageOrder.indexOf(selectedMessage),
      to = index + delta;
    if (to < 0 || to >= messageOrder.length) return;
    void moveEdge(selectedMessage.id, delta < 0 ? messageOrder[to]!.id : (messageOrder[to + 1]?.id ?? null));
  };
  const reverseMessage = () => {
    if (canEdit && selectedMessage && selectedMessage.from !== selectedMessage.to)
      void edit({ kind: "change-arrow", id: selectedMessage.id, arrow: "reverse" });
  };
  /** A shape's connections; a participant's messages, last first (deleting one renumbers those after it). */
  const connectionsOf = (id: string): { id: string }[] =>
    sequence
      ? messageOrder
          .filter((m) => m.from === id || m.to === id)
          .sort((a, b) => (msgIndex(b.id) ?? 0) - (msgIndex(a.id) ?? 0))
      : (graph?.edges ?? []).filter((edge) => edge.source === id || edge.target === id);
  const isMarker = (id: string) => {
    const kind = stateKindOf(id);
    return kind === "initial" || kind === "final";
  };
  /** Several picked (a marquee): their connections, then them, as one step. Boundaries and composites stay (they hold others). */
  const deleteMany = () => {
    if (!canEdit) return;
    const groups = new Set(graph?.groups.map((group) => group.id) ?? []);
    const nodes = picked.nodes.filter((id) => !groups.has(id)),
      edges = new Set(picked.edges);
    for (const id of nodes) for (const link of connectionsOf(id)) edges.add(link.id);
    const steps: FlowchartEdit[] = [
      ...[...edges].map((id) => ({ kind: "delete-edge" as const, id })),
      ...nodes.filter((id) => !isMarker(id)).map((id) => ({ kind: "delete-node" as const, id })),
    ];
    if (!steps.length) return;
    const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
    const said = `Deleted ${[nodes.length ? count(nodes.length, "shape") : "", edges.size ? count(edges.size, "connection") : ""].filter(Boolean).join(" and ")}`;
    void c.editChain(steps, {}, said).then((done) => {
      if (!done) return;
      setLastAction({ text: said });
      clearSelection();
      restoreFocus(null, [...nodes, ...edges]);
    });
  };
  const deleteSelected = () => {
    if (!selected || !canEdit) return;
    if (graphMany) {
      deleteMany();
      return;
    }
    const { kind, id } = selected;
    const detail = kind === "node" ? { name: nameOf(id), count: connectionsOf(id).length } : {};
    // A shape (or participant) that still has connections can't be deleted on its own: say so (and offer the cascade) without asking the service.
    if (kind === "node" && detail.count) {
      const refusal = {
        ...describeRefusal("edit_delete_referenced_node", detail),
        code: "edit_delete_referenced_node",
      };
      say(refusal.message, { refusal });
      return;
    }
    // Focus goes to the nearest remaining shape (F35), or the drawing when none is left.
    const next = nearestShape(id, kind);
    void edit({ kind: kind === "node" ? "delete-node" : "delete-edge", id }, detail).then((result) => {
      if (!result) return;
      const gone = msgIndex(id);
      if (sequence && kind === "edge" && gone !== null) {
        remapMessages((n) => (n === gone ? null : n > gone ? n - 1 : n));
        setSelected(null);
      } else clearSelection();
      restoreFocus(next, [id]);
    });
  };
  /** The refusal's own next step: delete a shape's connections, then the shape. */
  const deleteWithConnections = async (id: string) => {
    // One step through the service: every connection, then the shape; a refusal anywhere (a state left undrawn) shows it and changes nothing.
    if (!canEdit) return;
    const links = connectionsOf(id),
      name = nameOf(id);
    // A start or end marker exists only through its transitions: those go, and it goes with them.
    const steps: FlowchartEdit[] = [
      ...links.map((link) => ({ kind: "delete-edge" as const, id: link.id })),
      ...(stateModel && isMarker(id) ? [] : [{ kind: "delete-node" as const, id }]),
    ];
    const said = `Deleted ${quoted(name)}${links.length ? ` and its ${links.length === 1 ? "connection" : `${links.length} connections`}` : ""}`;
    const next = nearestShape(id, "node");
    const done = await c.editChain(steps, { name, count: links.length }, said);
    if (done) {
      setLastAction({ text: said });
      clearSelection();
      restoreFocus(next, [id, ...links.map((link) => link.id)]);
    }
  };
  /*
   * Pasted Mermaid whose edges have no IDs, or whose nodes are only named: the compiler names the fix (`add-edge-ids`),
   * applied to the current (failing) source as one step. Its count comes from the result: each fix writes one `id@`.
   */
  const fixable = (c.previewBusy ? [] : (c.preview?.diagnostics ?? [])).filter(fixOf);
  const unnamed = fixable.filter((item) => codeOf(item) === "undeclared_node").length,
    missingIds = fixable.length - unnamed;
  const missingCapped = (c.preview?.diagnostics ?? []).some((item) => codeOf(item) === "too_many_diagnostics");
  const addEdgeIds = async () => {
    if (!canEdit) return;
    const before = d.source;
    const said = (edges: string) =>
      unnamed > 0 ? `Added IDs to ${edges} and labels to ${shapes(unnamed)}` : `Added IDs to ${edges}`;
    const done = await c.edit(
      { kind: "add-edge-ids" },
      {},
      said(missingCapped ? "the connections" : connections(missingIds)),
    );
    if (!done) return;
    const added = (done.source.match(/@/gu)?.length ?? 0) - (before.match(/@/gu)?.length ?? 0);
    letGo();
    setLastAction({ text: added > 0 || unnamed > 0 ? said(connections(added)) : "Every connection already has an ID" });
  };
  const undo = () => {
    const said = c.undo();
    if (said !== null) setLastAction({ text: said ? `Undone: ${said}` : "Undone", undone: true });
    if (sequence) clearSelection();
  };
  const redo = () => {
    const said = c.redo();
    if (said !== null) setLastAction({ text: said ? `Redone: ${said}` : "Redone" });
    if (sequence) clearSelection();
  };
  const pickFamily = (next: Family) => {
    if (next === family) return;
    if (hasContent(d.source)) {
      setSwitchTo(next);
      switchDialog.current?.showModal();
      return;
    }
    c.updateSource(FAMILIES[next].starter);
  };
  const confirmSwitch = () => {
    const next = switchTo;
    switchDialog.current?.close();
    setSwitchTo(null);
    if (next) {
      setSelected(null);
      c.updateSource(FAMILIES[next].starter);
    }
  };
  const stateKindOf = (id: string) => {
    const figure = graph?.nodes.find((node) => node.id === id)?.figure;
    return figure?.type === "state" ? figure.kind : "state";
  };
  const applyPart = (part: Part) => {
    if (!canvasEditable || !family) return;
    if (!canEdit || c.isBusy()) {
      pendingPart.current = part;
      return;
    }
    // Picking a part is editing: a canvas left in Hand (pan) mode goes back to Select, so the part can be placed, named and connected.
    selectMode.current?.();
    letGo();
    if (part.kind === "node") {
      void addNode(part);
      return;
    }
    if (part.kind === "connection") {
      setConnectionKey(part.key);
      // With a message selected, picking another arrow type changes that message.
      if ("message" in part.create && selected?.kind === "edge" && sequence)
        void edit({ kind: "retarget-edge", id: selected.id, message: part.create.message });
      return;
    }
    if (part.kind === "note") {
      const over = picked.nodes.slice(-2);
      if (over.length === 0) {
        setInteractionError("Select a participant first (Shift-click a second one for a note over both).");
        return;
      }
      const afterY = selected?.kind === "edge" ? (messageOrder.find((m) => m.id === selected.id)?.y ?? null) : null;
      void edit({
        kind: "add-note",
        participants: over,
        position: "over",
        text: "Note",
        ...(selected?.kind === "edge" ? { after: selected.id } : {}),
      }).then((done) => {
        if (done) expectedNote.current = { participants: over, afterY };
      });
      return;
    }
    if (part.kind === "wrap") {
      if (picked.edges.length === 0) {
        setInteractionError(
          `Select the messages to wrap first (Shift-click to pick several in a row), then ${part.label}.`,
        );
        return;
      }
      void edit({ kind: "wrap-edges", ids: picked.edges, fragment: part.fragment, label: part.defaultLabel });
      return;
    }
    if (part.kind === "marker") {
      // Start and End connect a real state; never the start or end marker itself, or a choice/fork/join.
      if (selected?.kind !== "node" || stateKindOf(selected.id) !== "state") {
        setInteractionError(`Select a state first: ${part.label} connects it to the diagram’s ${part.which}.`);
        return;
      }
      void edit({
        kind: "connect",
        source: part.which === "start" ? "[*]" : selected.id,
        target: part.which === "start" ? selected.id : "[*]",
      });
      return;
    }
    if (part.kind === "snippet" && family !== "flowchart" && family !== "c4") {
      c.updateSource(insertPart(family, part.key, d.source));
      setSourceShown(true);
    }
  };
  const fileConflict = conflict && creating,
    reopenHref = reopenOriginal(d.opened?.target ?? null);
  // A save whose answer was lost (claude-11): checked at once, then said plainly; Save again sends that same save.
  const lostSay =
    c.lost?.state === "checking"
      ? "Archer did not answer · checking whether your change was saved…"
      : c.lost?.state === "not-found"
        ? c.lost.checked
          ? "Not known whether your change reached Archer: it still had no record of it when last checked. Save again sends this same save; it is never saved twice"
          : "Not known yet whether your change reached Archer: it has no record of it so far, and checks again. Save again sends this same save; it is never saved twice"
        : c.lost?.state === "unknown"
          ? "Not known whether your change was saved: Archer did not answer. It is kept in this browser; it is never saved twice"
          : null;
  const saveAgain = c.lost?.state === "not-found";
  const status = c.held
    ? "Saved in this browser · will save when back online"
    : lostSay !== null
      ? lostSay
      : d.pending || c.unfinished
        ? uncertain
          ? "The save’s outcome is uncertain. Check the original before resolving it."
          : "A response is unresolved. Check its status before saving again."
        : conflict && !creating
          ? "The original changed while you edited. Your working copy is kept."
          : d.receipt?.outcome === "discarded"
            ? "Saved draft discarded. Your working copy is kept."
            : d.receipt?.review?.state === "admission_pending"
              ? "Saved. Agent review admission is pending."
              : d.receipt?.outcome === "saved" && d.receipt.draft && !c.dirty
                ? d.opened
                  ? "Saved as a private proposal · the file is unchanged"
                  : "Saved as a private draft · nothing is written to the repository"
                : c.restored && c.dirty
                  ? "Restored your unsaved changes from this browser"
                  : c.dirty
                    ? "Working copy · unsaved changes · nothing in the repository changes until you Save"
                    : creating
                      ? "New diagram · nothing is written to the repository until you Save"
                      : "Working copy · no changes yet";
  const pathProblem = creating ? publishPathProblem(publishPath) : null;
  // Warnings and notes never block Save: only errors are counted.
  const errorCount = (c.preview?.diagnostics ?? []).filter((item) => severityOf(item) === "error").length;
  // Why Save can't run right now, said next to it (title + description), never a silent grey button.
  const saveBlocked = saveAgain
    ? null
    : !canWrite
      ? unresolved || c.unfinished
        ? "Check the unresolved save first."
        : editOff
          ? c.access?.authorized === true && c.access.edit.reason === "account"
            ? "Editing is off in your Archer settings for this project."
            : "Editing is off for this project (edit = false in archer.toml)."
          : phone
            ? "Saving needs a desktop screen."
            : "Editing is not available."
      : conflict && !creating
        ? "The original changed while you edited: keep your work as a proposal, or copy your Mermaid."
        : d.opened?.writable === false
          ? "This diagram changed underneath; reopen the current original before saving."
          : (pathProblem ??
            (c.previewBusy
              ? "Checking the Mermaid…"
              : !valid && !c.previewUnreachable
                ? errorCount
                  ? `Fix ${errorCount === 1 ? "the problem" : `${errorCount} problems`} in the Mermaid to save.`
                  : "Fix the Mermaid to save."
                : null));
  const saveDisabled = saveBlocked !== null;
  // The page bar holds Cancel and Save; "Editing" sits beside the title (App), Source at the drawing's foot.
  const sourceToggle = sourceOnly ? null : (
    <button
      type="button"
      className="archer-reader-source authoring-preview-source"
      aria-pressed={sourceShown}
      aria-label="Mermaid source"
      title={sourceShown ? "Hide the Mermaid source" : "Show the Mermaid source"}
      onClick={() => setSourceShown((v) => !v)}
    >
      <Icon>
        <path d="m8 7-5 5 5 5M16 7l5 5-5 5" />
      </Icon>
      <span>Source</span>
    </button>
  );
  const toolbar = (
    <div className="authoring-toolbar" data-archer-editor-tools="">
      <button
        type="button"
        disabled={c.busy || (unresolved && !saveAgain)}
        onClick={() => {
          if (c.dirty || c.held || saveAgain) discardDialog.current?.showModal();
          else discard();
        }}
      >
        Cancel
      </button>
      <button
        type="button"
        className="authoring-primary"
        title={saveBlocked ?? undefined}
        aria-describedby={saveBlocked ? "authoring-save-blocked" : undefined}
        disabled={saveDisabled || (saveAgain && c.busy)}
        onClick={() => (saveAgain ? c.retry() : c.apply(creating ? publishPath.trim() : ""))}
      >
        {saveAgain ? "Save again" : "Save"}
      </button>
      {saveBlocked ? (
        <span id="authoring-save-blocked" className="authoring-sr">
          {saveBlocked}
        </span>
      ) : null}
    </div>
  );
  // Sequence: Connect to… lists the other participants (a new message to one of them).
  // State: the states and composites in the same scope (a transition can't cross one); never a start or end marker (Start and End add those).
  const scopeOf = (id: string) =>
    graph?.nodes.find((node) => node.id === id)?.groupId ?? graph?.groups.find((group) => group.id === id)?.parentId;
  const connectTargets =
    selected?.kind !== "node"
      ? []
      : sequence
        ? participants.filter((p) => p.id !== selected.id).map((p) => ({ id: p.id, label: p.label || p.id }))
        : stateModel
          ? [
              ...(graph?.nodes ?? []).filter(
                (node) => node.id !== selected.id && !isMarker(node.id) && node.groupId === scopeOf(selected.id),
              ),
              ...(graph?.groups ?? []).filter(
                (group) =>
                  group.element === true && group.id !== selected.id && group.parentId === scopeOf(selected.id),
              ),
            ].map((node) => ({ id: node.id, label: node.label || node.id }))
          : (graph?.nodes ?? [])
              .filter((node) => node.id !== selected.id)
              .map((node) => ({ id: node.id, label: node.label || node.id }));
  const canConnectFrom = selected?.kind === "node" && !(stateModel && stateKindOf(selected.id) === "final");
  const connectButton = { current: null as HTMLButtonElement | null };
  const connectWhenReady = (from: string, to: string) => {
    if (canEdit && !c.isBusy()) {
      void connect(from, to, true);
      return;
    }
    pendingConnect.current = [from, to];
  };
  const closeConnectMenu = () => {
    setConnectMenu(false);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".authoring-connect-to>button")?.focus());
  };
  // Editing gets its own cluster, drawn like the canvas's zoom cluster but kept apart from it. Its tools follow the
  // source's family, known at once, not the compiled preview, which lands a moment after the editor is shown: the
  // cluster has its final width from the first frame, so Structure and properties does not jump 152 px under the
  // pointer (O209). Until the preview lands (or while the Mermaid does not compile) the family's tools are disabled.
  const editTools = structured || family !== null,
    flowTools = flow || family === "flowchart",
    sequenceTools = participantIds.length > 0 || family === "sequence";
  const editCluster = phone ? null : (
    <div
      className="archer-canvas-controls authoring-edit-cluster"
      role="toolbar"
      aria-label="Editing tools"
      data-archer-editor-tools=""
      {...editRoving}
    >
      <button type="button" aria-label="Undo" title="Undo (Ctrl/⌘+Z)" disabled={!canEdit || !c.canUndo} onClick={undo}>
        <Icon>
          <path d="M9 7 4 12l5 5M4 12h10a5 5 0 0 1 0 10h-2" />
        </Icon>
      </button>
      <button
        type="button"
        aria-label="Redo"
        title="Redo (Shift+Ctrl/⌘+Z)"
        disabled={!canEdit || !c.canRedo}
        onClick={redo}
      >
        <Icon>
          <path d="m15 7 5 5-5 5M20 12H10a5 5 0 0 0 0 10h2" />
        </Icon>
      </button>
      {editTools ? (
        <button
          type="button"
          aria-label="Delete selected"
          title="Delete the selected shape or connection (Delete)"
          disabled={!structured || !canEdit || !selected}
          onClick={deleteSelected}
        >
          <Icon>
            <path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" />
          </Icon>
        </button>
      ) : null}
      {editTools ? (
        <span className="authoring-connect-to">
          <button
            ref={(element) => {
              connectButton.current = element;
            }}
            type="button"
            aria-label="Connect to…"
            title="Connect the selected element to another (the keyboard way to draw a connection)"
            aria-haspopup="menu"
            aria-expanded={connectMenu}
            disabled={!structured || !canvasEditable || !canConnectFrom}
            onClick={() => setConnectMenu((open) => !open)}
          >
            <Icon>
              <circle cx="6" cy="12" r="2.5" />
              <path d="M8.5 12H19m-4-4 4 4-4 4" />
            </Icon>
          </button>
          {connectMenu && selected?.kind === "node" ? (
            <div
              className="authoring-connect-menu"
              role="menu"
              aria-label={`Connect ${nameOf(selected.id)} to`}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  closeConnectMenu();
                  return;
                }
                if (event.key === "Tab") {
                  setConnectMenu(false);
                  return;
                }
                // Arrow keys, Home and End move between the menu's items, as in any menu.
                const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
                if (!items.length) return;
                const at = items.indexOf(document.activeElement as HTMLButtonElement);
                const next =
                  event.key === "ArrowDown"
                    ? (at + 1) % items.length
                    : event.key === "ArrowUp"
                      ? (at - 1 + items.length) % items.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? items.length - 1
                          : -1;
                if (next >= 0) {
                  event.preventDefault();
                  items[next]!.focus();
                }
              }}
            >
              <p className="authoring-connect-menu-title">{connectionPart()?.label ?? "Connect"} to…</p>
              {connectTargets.map((node, index) => (
                <button
                  key={node.id}
                  type="button"
                  role="menuitem"
                  // biome-ignore lint/a11y/noAutofocus: the APG menu pattern moves focus to the first item when a menu opens; this menu mounts only on that request.
                  autoFocus={index === 0}
                  onClick={() => {
                    const from = selected.id;
                    closeConnectMenu();
                    connectWhenReady(from, node.id);
                  }}
                >
                  {node.label}
                </button>
              ))}
              {connectTargets.length === 0 ? <p className="authoring-secondary">Add another element first.</p> : null}
            </div>
          ) : null}
        </span>
      ) : null}
      {sequenceTools ? (
        <>
          <button
            type="button"
            aria-label="Move left"
            title="Move the selected participant left (Alt+←)"
            disabled={!canEdit || selected?.kind !== "node" || participantIds.indexOf(selected.id) <= 0}
            onClick={() => moveSelected(-1)}
          >
            <Icon>
              <path d="M14 6l-6 6 6 6" />
            </Icon>
          </button>
          <button
            type="button"
            aria-label="Move right"
            title="Move the selected participant right (Alt+→)"
            disabled={
              !canEdit ||
              selected?.kind !== "node" ||
              participantIds.indexOf(selected.id) === -1 ||
              participantIds.indexOf(selected.id) >= participantIds.length - 1
            }
            onClick={() => moveSelected(1)}
          >
            <Icon>
              <path d="M10 6l6 6-6 6" />
            </Icon>
          </button>
        </>
      ) : null}
      {messageOrder.length > 0 || family === "sequence" ? (
        <>
          <button
            type="button"
            aria-label="Move message up"
            title="Move the selected message up (Alt+↑)"
            disabled={!canEdit || !selectedMessage || messageOrder.indexOf(selectedMessage) <= 0}
            onClick={() => moveMessage(-1)}
          >
            <Icon>
              <path d="M6 14l6-6 6 6" />
            </Icon>
          </button>
          <button
            type="button"
            aria-label="Move message down"
            title="Move the selected message down (Alt+↓)"
            disabled={!canEdit || !selectedMessage || messageOrder.indexOf(selectedMessage) >= messageOrder.length - 1}
            onClick={() => moveMessage(1)}
          >
            <Icon>
              <path d="M6 10l6 6 6-6" />
            </Icon>
          </button>
          <button
            type="button"
            aria-label="Reverse message"
            title="Reverse the selected message’s direction"
            disabled={!canEdit || !selectedMessage || selectedMessage.from === selectedMessage.to}
            onClick={reverseMessage}
          >
            <Icon>
              <path d="M4 9h14l-3-3M20 15H6l3 3" />
            </Icon>
          </button>
        </>
      ) : null}
      <span className="authoring-edit-cluster-rule" aria-hidden="true" />
      {flowTools ? (
        <button
          type="button"
          aria-label="Move selected"
          title="Move the selected shape: press, then click where it should go (or Alt+arrow keys; Shift for bigger steps)"
          aria-pressed={moving !== null}
          disabled={!flow || !canEdit || selected?.kind !== "node" || placeable(selected.id) === null}
          onClick={() => setMoving((current) => (current === null && selected?.kind === "node" ? selected.id : null))}
        >
          <Icon>
            <path d="M12 3v18M3 12h18M12 3l-3 3m3-3 3 3M12 21l-3-3m3 3 3-3M3 12l3-3m-3 3 3 3M21 12l-3-3m3 3-3 3" />
          </Icon>
        </button>
      ) : null}
      {flowTools ? (
        <button
          type="button"
          aria-label="Reset layout"
          title="Return moved shapes to automatic layout"
          disabled={!flow || !canEdit || Object.keys(d.positions ?? {}).length === 0}
          onClick={() => {
            c.setPositions({}, true, true, "Reset the layout");
            setLastAction({ text: "Reset the layout" });
          }}
        >
          <Icon>
            <path d="M5 8a8 8 0 1 1-1 8M5 3v5h5" />
          </Icon>
        </button>
      ) : null}
      <button
        type="button"
        aria-label="Structure and properties"
        title="Structure, properties and drafts"
        aria-pressed={panelShown}
        onClick={() => setPanelShown((value) => !value)}
      >
        <Icon>
          <rect x="3" y="4" width="18" height="16" rx="1" />
          <path d="M10 4v16" />
        </Icon>
      </button>
    </div>
  );
  const parts = family ? FAMILIES[family].parts : [];
  // A single connection kind has nothing to switch between: "Connect" fits over its one button, where the
  // longer heading left an empty slot beside it.
  const groupName = (group: readonly Part[]) =>
    group.some((part) => part.kind === "connection")
      ? group.length > 1
        ? "Connect with (stays on)"
        : "Connect"
      : group.some((part) => part.kind === "wrap")
        ? "Wrap selection"
        : group.some((part) => part.kind === "note")
          ? "Note"
          : group.every((part) => part.kind === "group")
            ? ""
            : group.every((part) => part.kind === "snippet")
              ? "Insert"
              : "Add";
  applyPartRef.current = applyPart;
  const partsBar =
    family && !phone ? (
      <div
        className="authoring-parts"
        role="toolbar"
        aria-label={`${FAMILIES[family].label} parts`}
        aria-busy={canvasEditable && !canEdit}
        data-archer-editor-tools=""
        {...partsRoving}
      >
        {parts.map((group, index) => {
          const label = groupName(group);
          return (
            <div
              className="authoring-parts-group"
              // biome-ignore lint/suspicious/noArrayIndexKey: the part groups are a fixed table per diagram family; a group has no id but its position.
              key={index}
              role="group"
              aria-label={label || "More"}
            >
              {label ? (
                <span className="authoring-parts-label" aria-hidden="true">
                  {label}
                </span>
              ) : null}
              {group.map((part) => {
                const pressed = part.kind === "connection" ? connectionPart()?.key === part.key : undefined;
                // An empty diagram of a structured type takes its first element even before it compiles.
                const startsEmpty = part.kind === "node" && FAMILIES[family].structured && !hasContent(d.source);
                const unavailable =
                  part.kind === "group"
                    ? part.unavailable
                    : part.kind === "connection" && !structured
                      ? "Add two elements first, then connect them."
                      : part.kind !== "snippet" && !structured && !startsEmpty
                        ? "Fix the Mermaid first: the preview has to compile."
                        : null;
                const title =
                  part.kind === "note"
                    ? `${part.label} — ${part.syntax}. Select a participant (Shift-click a second), then click.`
                    : part.kind === "wrap"
                      ? `${part.label} — ${part.syntax}. Select messages (Shift-click several in a row), then click.`
                      : part.kind === "marker"
                        ? `${part.label} — ${part.syntax}. Select a state, then click.`
                        : part.kind === "connection"
                          ? `${part.label} — ${part.syntax}. Drag from one element’s edge to another to connect.`
                          : part.kind === "group"
                            ? `${part.label} — ${part.unavailable}`
                            : part.kind === "node"
                              ? `${part.label} — ${part.syntax}. Adds it to the diagram.`
                              : `${part.label} — adds ${part.syntax} to the source`;
                return (
                  <button
                    key={part.key}
                    type="button"
                    className="authoring-part"
                    aria-pressed={pressed}
                    aria-disabled={unavailable ? true : undefined}
                    title={title}
                    disabled={!canvasEditable && !unavailable}
                    onClick={() => {
                      if (unavailable) {
                        setInteractionError(unavailable);
                        return;
                      }
                      applyPart(part);
                    }}
                  >
                    <PartGlyph family={family} part={part} />
                    <span>{part.label}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    ) : null;
  canvasEvents.current = {
    node: (id, additive) => {
      letGo();
      setMoving(null);
      if (sequence) pick("node", id, additive === true);
      else pickGraph("node", id, additive === true);
    },
    edge: (id, additive) => {
      letGo();
      setMoving(null);
      if (sequence) pick("edge", id, additive === true);
      else pickGraph("edge", id, additive === true);
    },
    pane: () => {
      clearSelection();
      letGo();
    },
    marqueeStart: (additive) => {
      marqueeBase.current = additive ? picked : { nodes: [], edges: [] };
    },
    marqueeChange: marqueeCovers,
  };
  const dismissHint = (dismissed: Family) => {
    setHintsDismissed((list) => [...list, dismissed]);
    try {
      localStorage.setItem(HINT_KEY + dismissed, "1");
    } catch {
      /* blocked storage: dismissed for this visit */
    }
  };
  // Not over the empty-canvas hint: that one already says how to start.
  const coachFamily =
    family &&
    structured &&
    !phone &&
    canvasView !== null &&
    !stale &&
    !(creating && !hasContent(d.source)) &&
    !hintsDismissed.includes(family) &&
    !hintDismissedStored(family)
      ? family
      : null;
  keysRef.current = (event) => {
    if (event.key === "Escape" && moving !== null) {
      event.preventDefault();
      setMoving(null);
      return;
    }
    if (event.key === "Escape") {
      if (connectMenu) {
        closeConnectMenu();
        return;
      }
      if (selected || part || picked.nodes.length || picked.edges.length) {
        event.preventDefault();
        clearSelection();
      }
      return;
    }
    if (!canEdit) {
      const mod = event.ctrlKey || event.metaKey,
        key = event.key.toLowerCase();
      const shortcut =
        (mod && (key === "z" || key === "y")) ||
        (!mod && (event.key === "Delete" || event.key === "Backspace") && (selected !== null || part !== null)) ||
        (event.altKey && event.key.startsWith("Arrow"));
      if (shortcut && canvasEditable) {
        event.preventDefault();
        pendingKey.current = {
          key: event.key,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          preventDefault: () => {},
        };
      }
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && part && !selected) {
      event.preventDefault();
      deletePart();
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && selected) {
      event.preventDefault();
      deleteSelected();
    }
    if (
      event.altKey &&
      (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
      participantIds.length > 0 &&
      selected?.kind === "node"
    ) {
      event.preventDefault();
      moveSelected(event.key === "ArrowLeft" ? -1 : 1);
    }
    // A graph shape: Alt+arrow nudges it (plain arrows go from shape to shape; Ctrl/⌘ belong to the browser).
    if (
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      event.key.startsWith("Arrow") &&
      flow &&
      selected?.kind === "node" &&
      editingNode === null
    ) {
      const step = event.shiftKey ? 50 : 10,
        dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0,
        dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
      if (dx || dy) {
        event.preventDefault();
        nudge(selected.id, dx, dy, Date.now());
      }
    }
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown") && selectedMessage) {
      event.preventDefault();
      moveMessage(event.key === "ArrowUp" ? -1 : 1);
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
    }
  };
  const refusal = notice?.refusal ?? (notice?.from === "hook" ? c.refusal : null);
  const runRefusalAction = (kind: string) => {
    dismissNotice();
    if (kind === "delete-connections" && selected?.kind === "node") void deleteWithConnections(selected.id);
    else if (kind === "open-source") setSourceShown(true);
    else if (kind === "reload") location.reload();
    else if (kind === "undo") undo();
    else if (kind === "rename") document.querySelector<HTMLInputElement>(".authoring-path-input input")?.focus();
  };
  const runnable = new Set(["delete-connections", "open-source", "reload", "undo", "rename"]);
  const quiet = notice?.severity !== "error";
  const feedback =
    notice && !phone ? (
      <div
        className={`authoring-feedback authoring-feedback-${notice.severity}${notice.severity === "error" ? " authoring-error" : ""}`}
        role={(notice.from === "interaction" && !notice.refusal) || quiet ? "status" : "alert"}
      >
        <span title={refusal?.details}>{notice.text}</span>
        {(refusal?.actions ?? [])
          .filter((action) => runnable.has(action.kind))
          .map((action) => (
            <button key={action.kind} type="button" onClick={() => runRefusalAction(action.kind)}>
              {action.label}
            </button>
          ))}
        {notice.from === "presentation" && c.completed && !c.completed.layoutSaved ? (
          <button type="button" onClick={leaveAfterSave}>
            Back to reading
          </button>
        ) : null}
        {refusal?.details ? (
          <details className="authoring-feedback-details">
            <summary>Details</summary>
            <code>{refusal.details}</code>
          </details>
        ) : null}
        <button type="button" className="authoring-dismiss" aria-label="Dismiss message" onClick={dismissNotice}>
          Dismiss
        </button>
      </div>
    ) : null;
  const copyMine = () => {
    void navigator.clipboard?.writeText(d.source).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      },
      () => {},
    );
  };
  const outline =
    structured && !flow ? (
      <>
        <h2>Structure</h2>
        <p className="authoring-secondary">
          {sequence
            ? "Drag from one lifeline to another to add a message; drag a header to reorder participants; select a message to change its ends, type or place."
            : family === "state"
              ? "Add states from the parts bar; drag from one state to another for a transition; select a state, then Start or End."
              : family === "er"
                ? "Add entities from the parts bar; drag from one entity to another to relate them; double-click to rename."
                : "Add elements from the parts bar; drag from one element’s edge to another to relate them; double-click to rename."}
        </p>
        {sequence ? (
          <>
            <h3>Participants</h3>
            {participants.map((p) => (
              <div
                key={p.id}
                className={`authoring-item${selected?.kind === "node" && selected.id === p.id ? " selected" : ""}`}
              >
                <button
                  type="button"
                  className="authoring-select"
                  aria-pressed={selected?.id === p.id}
                  onClick={() => pick("node", p.id, false)}
                >
                  {p.label || p.id}
                </button>
              </div>
            ))}
            <h3>Messages</h3>
            {messageOrder.length === 0 ? (
              <p className="authoring-secondary">No messages yet.</p>
            ) : (
              messageOrder.map((m) => (
                <div key={m.id} className={`authoring-item${selected?.id === m.id ? " selected" : ""}`}>
                  <button
                    type="button"
                    className="authoring-endpoints"
                    aria-pressed={selected?.id === m.id}
                    onClick={() => pick("edge", m.id, false)}
                  >
                    {nameOf(m.from)} → {nameOf(m.to)}
                    {m.label ? `: ${m.label}` : ""}
                  </button>
                </div>
              ))
            )}
          </>
        ) : graph ? (
          <>
            <h3>{family === "er" ? "Entities" : family === "state" ? "States" : "Elements"}</h3>
            {graph.nodes.map((node) => (
              <div
                key={node.id}
                className={`authoring-item${selected?.kind === "node" && selected.id === node.id ? " selected" : ""}`}
              >
                <button
                  type="button"
                  className="authoring-select"
                  aria-pressed={selected?.id === node.id}
                  onClick={() => setSelected({ kind: "node", id: node.id })}
                >
                  {node.label || node.id}
                </button>
              </div>
            ))}
            <h3>{family === "state" ? "Transitions" : "Relationships"}</h3>
            {graph.edges.length === 0 ? (
              <p className="authoring-secondary">None yet.</p>
            ) : (
              graph.edges.map((edge) => (
                <div key={edge.id} className="authoring-connection">
                  <button
                    type="button"
                    className="authoring-endpoints"
                    aria-pressed={selected?.id === edge.id}
                    onClick={() => setSelected({ kind: "edge", id: edge.id })}
                  >
                    {nameOf(edge.source)} → {nameOf(edge.target)}
                    {edge.label ? `: ${edge.label}` : ""}
                  </button>
                </div>
              ))
            )}
          </>
        ) : null}
      </>
    ) : null;
  const selectedEdge =
    !sequence && selected?.kind === "edge" ? graph?.edges.find((edge) => edge.id === selected.id) : undefined;
  const editor = (
    <section ref={workspaceElement} className="authoring-workspace" aria-label="Diagram Editor">
      {phone ? (
        <p className="authoring-phone">Review only on this screen. Open on a desktop to draw, edit and save.</p>
      ) : toolbarHost ? (
        createPortal(toolbar, toolbarHost)
      ) : (
        toolbar
      )}
      <div className="authoring-statusline" role="status" aria-live="polite">
        {moving !== null ? (
          <>
            <span className="authoring-last-action">Click where {quoted(nameNow(moving))} should go. Esc cancels.</span>
            <span aria-hidden="true">·</span>
          </>
        ) : lastAction && !c.busy ? (
          <>
            <span className="authoring-last-action">{lastAction.text}</span>
            {lastAction.undone ? (
              c.canRedo ? (
                <button type="button" className="authoring-link-button" onClick={redo}>
                  Redo
                </button>
              ) : null
            ) : c.canUndo ? (
              <button type="button" className="authoring-link-button" onClick={undo}>
                Undo
              </button>
            ) : null}
            <span aria-hidden="true">·</span>
          </>
        ) : null}
        <span>{c.busy ? (c.writeQueued ? "Working… your save runs when this finishes." : "Working…") : status}</span>
        {c.restored && c.dirty && !c.busy ? (
          <>
            {" "}
            <button type="button" className="authoring-link-button" onClick={() => discardDialog.current?.showModal()}>
              Discard them
            </button>
          </>
        ) : null}
        {c.elsewhere && !c.busy ? (
          <span>
            {" "}
            · Unsaved changes to this diagram are open in another tab. They stay there; this tab edits its own copy.
          </span>
        ) : null}
        {c.resumable && !c.dirty && !c.busy ? (
          <span>
            {" "}
            · {resumableText(c.resumable)}{" "}
            <button
              type="button"
              className="authoring-link-button"
              onClick={() => {
                const r = c.resumable!;
                void c.takeResumable().then((ok) => {
                  if (ok) onResume(r.draftId);
                });
              }}
            >
              Resume them
            </button>{" "}
            <button type="button" className="authoring-link-button" onClick={c.dismissResumable}>
              Start fresh
            </button>
            {c.copies.length > 1 ? (
              <>
                {" "}
                ·{" "}
                <button
                  type="button"
                  className="authoring-link-button"
                  aria-expanded={showCopies}
                  onClick={() => setShowCopies((v) => !v)}
                >
                  {c.copies.length - 1} other unsaved {c.copies.length - 1 === 1 ? "copy" : "copies"}
                </button>
              </>
            ) : null}
          </span>
        ) : null}
        {c.moved && !c.dirty && !c.busy ? (
          <span>
            {" "}
            · You have unsaved changes made to {c.moved.fromPath}, which is no longer there, from this same diagram.{" "}
            <button type="button" className="authoring-link-button" onClick={c.takeMoved}>
              Bring them here
            </button>{" "}
            <button type="button" className="authoring-link-button" onClick={c.dismissMoved}>
              Not now
            </button>
          </span>
        ) : null}
        {c.storageFailed ? <span> Browser recovery is unavailable. Copy your source before closing.</span> : null}
      </div>
      {showCopies && c.resumable && c.copies.length > 1 && !c.dirty ? (
        <OtherCopies
          copies={c.copies}
          busy={c.busy}
          onResume={(copy) => {
            void c.takeCopy(copy).then((ok) => {
              if (ok) {
                setShowCopies(false);
                onResume(copy.draftId);
              }
            });
          }}
          onDiscard={(copy) => {
            void c.discardCopy(copy);
          }}
        />
      ) : null}
      {creating && !phone ? (
        <div className="authoring-new-row">
          <label>
            Type
            <select
              value={family ?? "flowchart"}
              disabled={!canEdit}
              onChange={(e) => pickFamily(e.target.value as Family)}
            >
              {FAMILY_ORDER.map((key) => (
                <option key={key} value={key}>
                  {FAMILIES[key].label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Name
            <input
              className="authoring-name-input"
              value={newName}
              readOnly={publishing}
              maxLength={100}
              placeholder="Checkout flow"
              onChange={(e) => {
                const name = e.target.value;
                setNewName(name);
                if (!pathEdited.current) {
                  changePublishPath(`diagrams/${slugOf(name) || "untitled"}.mmd`, name);
                } else keepSaveAs(publishPath, name);
                if (!pathEdited.current) {
                  if (fileConflict || c.error) c.clearConflict();
                }
              }}
            />
          </label>
          <label>
            Save as
            <span className="authoring-path-input">
              <input
                value={publishPath}
                readOnly={publishing}
                onChange={(e) => {
                  pathEdited.current = true;
                  changePublishPath(e.target.value);
                  if (fileConflict || c.error) c.clearConflict();
                }}
                required
                maxLength={1024}
                spellCheck={false}
                aria-invalid={pathProblem !== null && publishPath.trim() !== ""}
                aria-describedby="authoring-save-as-help"
              />
            </span>
          </label>
          <span id="authoring-save-as-help" className="authoring-secondary">
            {pathProblem && publishPath.trim() !== ""
              ? pathProblem
              : "Inside the project’s Archer folder. Its folder must already exist."}
          </span>
        </div>
      ) : null}
      {bannerText !== null ? (
        <div className="authoring-error authoring-conflict" role={bannerRole ?? "alert"}>
          <span>{bannerText}</span>{" "}
          <button type="button" disabled={!canWrite} onClick={c.save}>
            Save as a proposal privately
          </button>{" "}
          <button type="button" onClick={copyMine}>
            {copied ? "Copied" : "Copy my Mermaid"}
          </button>{" "}
          <a href={reopenHref ?? "#"}>Reopen the current original</a>{" "}
          <span className="authoring-secondary">(starts again from the new version; copy your work first)</span>
        </div>
      ) : null}
      <div className={`authoring-body${!panelShown && !phone ? " authoring-panel-collapsed" : ""}`}>
        <aside className="authoring-panel" aria-label="Structure and properties">
          {flow && graph ? (
            <>
              <h2>Structure</h2>
              <div className="authoring-direction">
                <InlineValue
                  label="Direction"
                  value={direction}
                  choices={Object.keys(DIRECTIONS)}
                  disabled={!canEdit}
                  onCommit={(value) => {
                    const key = DIRECTIONS[value as keyof typeof DIRECTIONS];
                    if (key) void edit({ kind: "direction", direction: key });
                  }}
                />
              </div>
              <h3>Nodes</h3>
              {graph.nodes.map((node) => (
                <div
                  key={node.id}
                  className={`authoring-item${selected?.kind === "node" && selected.id === node.id ? " selected" : ""}`}
                >
                  <div className="authoring-row">
                    <InlineValue
                      label={`${node.label || node.id} label`}
                      value={node.label}
                      disabled={!canEdit}
                      onSelect={() => setSelected({ kind: "node", id: node.id })}
                      selected={selected?.id === node.id}
                      onCommit={(label) => commit("relabel-node", node.id, label)}
                    />
                  </div>
                  {selected?.kind === "node" && selected.id === node.id ? (
                    <div className="authoring-properties">
                      <span>Shape</span>
                      <InlineValue
                        label={`${node.label || node.id} shape`}
                        value={node.shape ?? "rectangle"}
                        choices={SHAPES}
                        disabled={!canEdit}
                        onCommit={(shape) => void edit({ kind: "change-shape", id: node.id, shape })}
                      />
                      {phone ? null : (
                        <button
                          type="button"
                          className="authoring-delete"
                          disabled={!canEdit}
                          onClick={() =>
                            void edit(
                              { kind: "delete-node", id: node.id },
                              { name: nameOf(node.id), count: connectionsOf(node.id).length },
                            )
                          }
                        >
                          Delete node
                        </button>
                      )}
                    </div>
                  ) : null}
                </div>
              ))}
              <h3>Connections</h3>
              {graph.edges.length === 0 ? (
                <p className="authoring-secondary">No connections yet.</p>
              ) : (
                graph.edges.map((edge) => (
                  <div className="authoring-connection" key={edge.id}>
                    <button
                      type="button"
                      className="authoring-endpoints"
                      onClick={() => setSelected({ kind: "edge", id: edge.id })}
                    >
                      {nameOf(edge.source)} → {nameOf(edge.target)}
                    </button>
                    <div className="authoring-row">
                      <InlineValue
                        label={`${nameOf(edge.source)} to ${nameOf(edge.target)} connection label`}
                        value={edge.label ?? ""}
                        disabled={!canEdit}
                        onCommit={(label) => commit("relabel-edge", edge.id, label)}
                      />
                    </div>
                    {selected?.kind === "edge" && selected.id === edge.id && !phone ? (
                      <button
                        type="button"
                        className="authoring-delete"
                        disabled={!canEdit}
                        onClick={() => void edit({ kind: "delete-edge", id: edge.id })}
                      >
                        Delete connection
                      </button>
                    ) : null}
                  </div>
                ))
              )}
            </>
          ) : (
            (outline ?? (
              <>
                <h2>{sourceOnly ? "Source Editing" : "Diagram"}</h2>
                <p className="authoring-secondary">
                  {sourceOnly
                    ? "This type is edited as Mermaid source; the parts bar adds valid snippets. Its type and stable identities are kept."
                    : "Write Mermaid source to see its preview."}
                </p>
              </>
            ))
          )}
          {phone ? null : (
            <details>
              <summary>Review intent</summary>
              <label className="authoring-sr" htmlFor="authoring-intent">
                What should the agent review?
              </label>
              <textarea
                id="authoring-intent"
                rows={3}
                value={d.intent}
                disabled={!canEdit}
                maxLength={2048}
                onChange={(e) => c.setIntent(e.target.value)}
              />
              <p className="authoring-secondary">
                Save follows the project’s feedback settings. It does not wake an agent.
              </p>
            </details>
          )}
          <details>
            <summary>Draft and proposal tools</summary>
            <p className="authoring-path">{d.opened?.path ?? "Unpublished draft"}</p>
            {phone ? null : (
              <div className="authoring-secondary-actions">
                <button type="button" disabled={!canWrite} onClick={c.save}>
                  {d.opened ? "Save proposal privately" : "Save draft privately"}
                </button>
                {d.receipt?.review?.state === "tracked_held" ? (
                  <button type="button" disabled={!canWrite || d.source !== d.savedSource} onClick={c.sendOperation}>
                    Send saved changes
                  </button>
                ) : null}
                {d.draftRevision && d.receipt?.review?.mode === "manual" ? (
                  <button type="button" disabled={!canWrite || d.source !== d.savedSource} onClick={c.send}>
                    Send saved revision
                  </button>
                ) : null}
              </div>
            )}
            {c.access.drafts.filter((draft) => draft.state === "open").length === 0 ? (
              <p className="authoring-secondary">No saved drafts.</p>
            ) : (
              c.access.drafts
                .filter((draft) => draft.state === "open")
                .map((draft) => (
                  <p key={draft.draftId}>
                    <a
                      href={
                        editorHref(
                          projectSlug,
                          (draft.origin as typeof draft.origin & { target?: Parameters<typeof editorHref>[1] })
                            .target ?? null,
                          draft.draftId,
                          "draft",
                        ) ?? "#"
                      }
                    >
                      {draft.origin.path ?? "Untitled draft"} · revision {draft.draftRevision}
                    </a>
                    {draft.origin.diverged ? (
                      <span className="authoring-secondary"> · based on an earlier version of the file</span>
                    ) : null}
                  </p>
                ))
            )}
            {d.draftRevision && !phone ? (
              <button type="button" disabled={!canWrite} onClick={c.discard}>
                Discard saved draft
              </button>
            ) : null}
          </details>
        </aside>
        <div className="authoring-canvas-column">
          <div
            ref={previewElement}
            tabIndex={-1}
            role="group"
            aria-label="Drawing"
            data-archer-editor-entry=""
            className={`authoring-preview${stale ? " authoring-preview-stale" : ""}`}
            aria-busy={c.previewBusy}
          >
            {creating && !hasContent(d.source) && !phone ? (
              <div className="authoring-empty-hint">
                <strong>Start with a part from the bar above</strong>
                <span>{FAMILIES[family ?? "flowchart"].emptyHint}</span>
              </div>
            ) : null}
            {coachFamily ? (
              <p className="authoring-coach" role="note">
                <span>{FAMILIES[coachFamily].howTo}</span>{" "}
                <button type="button" className="authoring-link-button" onClick={() => dismissHint(coachFamily)}>
                  Got it
                </button>
              </p>
            ) : null}
            {stale && canvasView ? (
              <p className="authoring-stale-note" role="status">
                {c.previewUnreachable
                  ? "Archer is not answering, so the drawing shows your last checked version. The Mermaid is checked when it is saved."
                  : "The Mermaid has a problem; showing the last valid drawing."}
              </p>
            ) : null}
            {__ARCHER_DEBUG__ && canvasView ? <DevProfiler id="canvas">{canvasView}</DevProfiler> : canvasView}
            {/* The reading page's diagram key, for what is drawn now (the last valid drawing while the Mermaid has a problem). */}
            {canvasView && laidOut?.ok && !phone ? <DiagramKey key={laidOut.view.viewId} model={laidOut} /> : null}
            {c.previewBusy && !stale ? (
              <p className="authoring-checking" role="status">
                Checking preview…
              </p>
            ) : null}
            {phone ? null : sourceToggle}
            {feedback}
          </div>
          {sequence && selectedMessage && !phone ? (
            <MessagePanel
              message={selectedMessage}
              participants={participants}
              order={messageOrder}
              disabled={!canEdit}
              previewRef={previewElement}
              onChange={(change) => void edit(change)}
              onMove={(id, before) => void moveEdge(id, before)}
              onDelete={deleteSelected}
            />
          ) : null}
          {sequence && (pickedNote || pickedFragment) && !phone ? (
            <PartPanel
              key={part!.id}
              note={pickedNote}
              fragment={pickedFragment}
              focus={part!.focus}
              disabled={!canEdit}
              previewRef={previewElement}
              onText={(text) => {
                if (pickedNote && canEdit) void edit({ kind: "relabel-note", id: pickedNote.id, text });
              }}
              onDelete={deletePart}
            />
          ) : null}
          {selectedEdge && !phone ? (
            <ConnectionPanel
              edge={selectedEdge}
              nodes={graph?.nodes ?? []}
              er={er}
              arrows={flow}
              disabled={!canEdit}
              previewRef={previewElement}
              onChange={(change) =>
                void edit(change).then((done) => {
                  // Outside flowcharts a connection is named by its ends: reattached, it is still the one selected, under its new name.
                  if (
                    !done ||
                    change.kind !== "retarget-edge" ||
                    selectedEdge.id !== `${selectedEdge.source}--${selectedEdge.target}`
                  )
                    return;
                  const id = `${change.source ?? selectedEdge.source}--${change.target ?? selectedEdge.target}`;
                  setSelected({ kind: "edge", id });
                  setPicked({ nodes: [], edges: [id] });
                })
              }
              onDelete={deleteSelected}
            />
          ) : null}
          {!phone ? (
            <div className="authoring-tools-row">
              {editCluster}
              {partsBar}
            </div>
          ) : null}
          <div className="authoring-below">
            {editOff ? (
              <p className="authoring-off" role="status">
                {c.access?.authorized === true && c.access.edit.reason === "account"
                  ? "Editing is off in your Archer settings for this project."
                  : "Editing is off for this project (edit = false in archer.toml)."}{" "}
                You can read and copy the Mermaid; agents can still change it.
              </p>
            ) : null}
            {missingIds + unnamed > 0 && !phone ? (
              <AddIdsFix
                missing={missingIds}
                unnamed={unnamed}
                capped={missingCapped}
                canFix={canEdit}
                onAddIds={() => void addEdgeIds()}
              />
            ) : null}
            {sourceShown || sourceOnly || (c.preview?.envelope === null && !c.previewBusy) ? (
              <div className="authoring-source">
                <div className="authoring-source-bar">
                  <span id="authoring-source-label">
                    Mermaid source · type here, or edit on the canvas; both stay in step
                  </span>
                  <button type="button" className="authoring-copy" onClick={copyMine}>
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                {SourceEditor ? (
                  <SourceEditor
                    id="authoring-source"
                    ariaLabel="Mermaid source"
                    ariaDescribedBy="authoring-source-help"
                    value={d.source}
                    readOnly={!canEdit}
                    diagnostics={c.preview?.diagnostics}
                    onChange={(value) => {
                      setLastAction(null);
                      c.updateSource(value);
                    }}
                    onFix={(fix) => {
                      if (fix.operation === "add-edge-ids") void addEdgeIds();
                    }}
                    className="authoring-source-editor"
                  />
                ) : (
                  <textarea
                    id="authoring-source"
                    aria-label="Mermaid source"
                    aria-describedby="authoring-source-help"
                    spellCheck={false}
                    value={d.source}
                    readOnly={!canEdit}
                    onChange={(e) => {
                      setLastAction(null);
                      c.updateSource(e.target.value);
                    }}
                  />
                )}
                <p id="authoring-source-help" className="authoring-secondary">
                  Invalid intermediate text stays recoverable. Saving requires valid Mermaid.
                </p>
              </div>
            ) : null}
            {c.preview?.diagnostics.length ? (
              <Diagnostics diagnostics={c.preview.diagnostics} nameOf={nameOf} errorsBlock={!valid} />
            ) : null}
          </div>
        </div>
      </div>
      {(unresolved || c.unfinished || d.receipt?.review) && !phone ? (
        <div className="authoring-status">
          {d.receipt?.review?.state === "tracked" ? (
            <span>Saved changes await agent review. </span>
          ) : d.receipt?.review?.state === "tracked_held" ? (
            <span>Saved changes are held until sent for review. </span>
          ) : null}
          {d.receipt?.review?.state === "queued" ? <span>Review queued; no agent read is implied. </span> : null}
          {c.lost ? (
            c.lost.state === "unknown" ? (
              <div className="authoring-recovery-actions">
                <button type="button" disabled={c.busy} onClick={() => void c.probe()}>
                  Check again
                </button>
              </div>
            ) : null
          ) : unresolved || c.unfinished ? (
            <div className="authoring-recovery-actions">
              <button type="button" disabled={c.busy} onClick={() => void c.probe()}>
                Check status
              </button>
              {uncertain && operation?.current ? (
                <>
                  <button type="button" disabled={c.busy} onClick={() => c.resolve("confirm_candidate")}>
                    Confirm observed candidate
                  </button>
                  <button type="button" disabled={c.busy} onClick={() => c.resolve("abandon")}>
                    Abandon uncertain operation
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={c.busy || !c.canRetry || operation?.state === "intent"}
                  onClick={c.retry}
                >
                  Retry same request
                </button>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
      {phone && notice ? (
        <p
          className={
            notice.severity === "error"
              ? "authoring-error"
              : `authoring-phone-notice authoring-feedback-${notice.severity}`
          }
          role={notice.severity === "error" ? "alert" : "status"}
        >
          {notice.text}
        </p>
      ) : null}
      <dialog ref={switchDialog} role="alertdialog" aria-labelledby={switchTitle} onClose={() => setSwitchTo(null)}>
        <h2 id={switchTitle}>Switch to {switchTo ? FAMILIES[switchTo].label : ""}?</h2>
        <p>Changing the diagram type clears what you’ve drawn. Nothing has been saved yet, and Undo brings it back.</p>
        <div>
          <button type="button" onClick={() => switchDialog.current?.close()}>
            Keep {family ? FAMILIES[family].label : ""}
          </button>
          <button type="button" className="authoring-danger" onClick={confirmSwitch}>
            Clear and switch
          </button>
        </div>
      </dialog>
      <dialog
        ref={discardDialog}
        role="alertdialog"
        aria-labelledby={discardTitle}
        onClose={() => {
          pendingLeave.current = null;
        }}
      >
        <h2 id={discardTitle}>Discard your changes?</h2>
        <p>
          {c.lost?.state === "not-found"
            ? "Archer has no record of your last save so far; if it still arrives, the file will hold it. Your other unsaved edits will be lost."
            : creating
              ? "This new diagram hasn’t been saved."
              : "Nothing in the repository has changed; your unsaved edits will be lost."}
        </p>
        <div>
          <button type="button" onClick={() => discardDialog.current?.close()}>
            Keep editing
          </button>
          <button
            type="button"
            className="authoring-danger"
            onClick={() => {
              const proceed = pendingLeave.current;
              discardDialog.current?.close();
              pendingLeave.current = proceed;
              discard();
            }}
          >
            Discard
          </button>
        </div>
      </dialog>
    </section>
  );
  return __ARCHER_DEBUG__ ? <DevProfiler id="editor">{editor}</DevProfiler> : editor;
}
/** One diagnostic, in the person's words: an element's label instead of its internal id. */
function diagnosticText(value: unknown, nameOf: (id: string) => string = (id) => id): string {
  if (typeof value === "object" && value !== null) {
    const d = value as { message?: unknown; code?: unknown; span?: { start?: { line?: unknown; column?: unknown } } };
    const text =
      typeof d.message === "string"
        ? d.message.replace(
            /\b(node|state|participant|entity|element) '([^']+)'/gu,
            (_m, _kind: string, id: string) => `“${nameOf(id)}”`,
          )
        : typeof d.code === "string"
          ? d.code
          : "Mermaid validation failed.";
    return `${typeof d.span?.start?.line === "number" ? `Line ${d.span.start.line}: ` : ""}${text}`;
  }
  return "Mermaid validation failed.";
}
const codeOf = (value: unknown) =>
  typeof value === "object" && value !== null && typeof (value as { code?: unknown }).code === "string"
    ? (value as { code: string }).code
    : null;
/** A diagnostic whose fix a tool applies with no judgement: `add-edge-ids`. */
const fixOf = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  (value as { fix?: { operation?: unknown } }).fix?.operation === "add-edge-ids";
const connections = (n: number) => (n === 1 ? "1 connection" : `${n} connections`);
const shapes = (n: number) => (n === 1 ? "1 shape" : `${n} shapes`);
const severityOf = (value: unknown) =>
  typeof value === "object" && value !== null && typeof (value as { severity?: unknown }).severity === "string"
    ? (value as { severity: string }).severity
    : "error";
/**
 * The compiler's diagnostics under the canvas. Problems that block Save stay in view; notes that don't (a shape not
 * connected yet, an ignored directive) are folded away and never red: a shape just added isn't an error.
 */
/** Pasted Mermaid whose connections have no IDs: the compiler's own fix, as one primary action right under the canvas. */
function AddIdsFix({
  missing,
  unnamed,
  capped,
  canFix,
  onAddIds,
}: {
  missing: number;
  unnamed: number;
  capped: boolean;
  canFix: boolean;
  onAddIds: () => void;
}): JSX.Element {
  const edges = capped
    ? "Some connections have no ID"
    : missing > 0
      ? `${connections(missing)} ${missing === 1 ? "has" : "have"} no ID`
      : "";
  const nodes = unnamed > 0 ? `${shapes(unnamed)} ${unnamed === 1 ? "has" : "have"} no label` : "";
  const said = [edges, nodes].filter(Boolean).join(" and ");
  return (
    <div className="authoring-fix" role="status">
      <span>
        <strong>{said.charAt(0).toUpperCase() + said.slice(1)}.</strong> The editor needs an ID on each connection and a
        label on each shape. Add IDs writes a readable ID on every connection that lacks one, labels each shape the
        Mermaid only names with its ID, and changes nothing else.
      </span>
      <button type="button" className="authoring-primary" disabled={!canFix} onClick={onAddIds}>
        Add IDs
      </button>
    </div>
  );
}
function Diagnostics({
  diagnostics,
  nameOf,
  errorsBlock,
}: {
  diagnostics: readonly unknown[];
  nameOf: (id: string) => string;
  errorsBlock: boolean;
}): JSX.Element {
  const shown = diagnostics.slice(0, 100);
  const blocking = errorsBlock ? shown.filter((d) => severityOf(d) === "error") : [];
  // Warnings first: they say what the drawing ignores (a repeated line); notes after.
  const notes = shown
    .filter((d) => !blocking.includes(d))
    .sort((a, b) => Number(severityOf(b) === "warning") - Number(severityOf(a) === "warning"));
  return (
    <>
      {blocking.length ? (
        <ul className="authoring-diagnostics" aria-label="Mermaid problems">
          {blocking.map((d, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: a read-only list re-rendered as a whole; its items hold no state.
              key={i}
            >
              {diagnosticText(d, nameOf)}
            </li>
          ))}
        </ul>
      ) : null}
      {notes.length ? (
        <details className="authoring-diagnostics-notes">
          <summary>
            {notes.length === 1 ? "1 note about this Mermaid" : `${notes.length} notes about this Mermaid`}
          </summary>
          <ul aria-label="Mermaid notes">
            {notes.map((d, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: a read-only list re-rendered as a whole; its items hold no state.
                key={i}
              >
                {diagnosticText(d, nameOf)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

type SequenceMessage = {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: "sync" | "reply" | "async";
  readonly label?: string | undefined;
  readonly bidirectional?: boolean | undefined;
};
/**
 * A flowchart connection's or a sequence message's arrowheads: one at the target, one at each end, or the ends
 * swapped (heads kept). A choice already made sends nothing; an async message has no two-way arrow in Mermaid.
 */
function ArrowControl({
  twoWay,
  selfLoop,
  asyncMessage = false,
  disabled,
  onChange,
}: {
  twoWay: boolean;
  selfLoop: boolean;
  asyncMessage?: boolean;
  disabled: boolean;
  onChange: (arrow: ArrowChange) => void;
}): JSX.Element {
  const reason = useId();
  return (
    <fieldset className="authoring-arrow" disabled={disabled}>
      <legend>Arrow</legend>
      <div className="authoring-arrow-choices">
        <button
          type="button"
          aria-pressed={!twoWay}
          title="One arrowhead, at the target"
          onClick={() => {
            if (twoWay) onChange("one-way");
          }}
        >
          One-way
        </button>
        <button
          type="button"
          aria-pressed={twoWay}
          disabled={asyncMessage && !twoWay}
          aria-describedby={asyncMessage ? reason : undefined}
          title={asyncMessage ? undefined : "An arrowhead at each end"}
          onClick={() => {
            if (!twoWay) onChange("two-way");
          }}
        >
          Two-way
        </button>
        <button
          type="button"
          disabled={selfLoop}
          title={selfLoop ? "It starts and ends at the same place: nothing to reverse" : "Swap its two ends"}
          onClick={() => onChange("reverse")}
        >
          Reverse
        </button>
      </div>
      {asyncMessage ? (
        <p id={reason} className="authoring-secondary">
          An async message has one arrowhead only; make it a Message or Reply for two.
        </p>
      ) : null}
    </fieldset>
  );
}
/** The selected message, as controls: its ends, its type and its place in the order. The keyboard way to do what dragging does. */
function MessagePanel({
  message,
  participants,
  order,
  disabled,
  previewRef,
  onChange,
  onMove,
  onDelete,
}: {
  message: SequenceMessage;
  participants: readonly { id: string; label: string }[];
  order: readonly SequenceMessage[];
  disabled: boolean;
  previewRef: { current: HTMLElement | null };
  onChange: (edit: Parameters<AuthoringClient["edit"]>[1]) => void;
  onMove: (id: string, before: string | null) => void;
  onDelete: () => void;
}): JSX.Element {
  const index = order.findIndex((m) => m.id === message.id),
    name = (id: string) => participants.find((p) => p.id === id)?.label || id;
  const moveTo = (position: number) => {
    const to = Math.max(0, Math.min(order.length - 1, position));
    if (to === index) return;
    const others = order.filter((m) => m.id !== message.id);
    onMove(message.id, others[to]?.id ?? null);
  };
  // The position is typed, then committed on Enter or leaving the field: typing "12" is one move, not two.
  const [position, setPosition] = useState(String(index + 1));
  // Enter commits, and so does leaving the field: one typed value is one move. The field is disabled while the move runs,
  // which blurs it, and the message may take a new id when it lands; neither re-arms the commit, only typing does.
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (disabled) return;
    setPosition(String(index + 1));
  }, [index, message.id, disabled]);
  const commitPosition = () => {
    if (sent.current !== null) return;
    const n = Number(position);
    if (Number.isInteger(n) && n >= 1 && n !== index + 1) {
      sent.current = position;
      moveTo(n - 1);
    } else setPosition(String(index + 1));
  };
  // The panel stands in the corner of the canvas that hides least: never the canvas controls, the selected message's ends if it can.
  const panel = useRef<HTMLElement>(null);
  const place = usePanelPlacement(
    panel,
    previewRef,
    `[data-seq-message="${CSS.escape(message.id)}"], g.archer-seq-message[data-seq-id="${CSS.escape(message.id)}"]`,
  );
  return (
    <section ref={panel} className="authoring-message-panel" aria-label="Selected message" style={place}>
      <h2>Message{message.label ? <span> · {message.label}</span> : null}</h2>
      <label>
        From
        <select
          value={message.from}
          disabled={disabled}
          onChange={(e) => {
            if (e.target.value !== message.from)
              onChange({ kind: "retarget-edge", id: message.id, source: e.target.value });
          }}
        >
          {participants.map((p) => (
            <option key={p.id} value={p.id}>
              {name(p.id)}
            </option>
          ))}
        </select>
      </label>
      <label>
        To
        <select
          value={message.to}
          disabled={disabled}
          onChange={(e) => {
            if (e.target.value !== message.to)
              onChange({ kind: "retarget-edge", id: message.id, target: e.target.value });
          }}
        >
          {participants.map((p) => (
            <option key={p.id} value={p.id}>
              {name(p.id)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Type
        <select
          value={message.kind}
          disabled={disabled}
          onChange={(e) => {
            if (e.target.value !== message.kind)
              onChange({ kind: "retarget-edge", id: message.id, message: e.target.value as SequenceMessage["kind"] });
          }}
        >
          <option value="sync">Message</option>
          <option value="reply">Reply</option>
          <option value="async">Async</option>
        </select>
      </label>
      <div className="authoring-message-position">
        <span>Position</span>
        <button
          type="button"
          aria-label="Earlier"
          title="Move earlier (Alt+↑)"
          disabled={disabled || index <= 0}
          onClick={() => moveTo(index - 1)}
        >
          ↑
        </button>
        <input
          type="number"
          aria-label="Position in the sequence"
          min={1}
          max={order.length}
          value={position}
          disabled={disabled}
          onChange={(e) => {
            sent.current = null;
            setPosition(e.target.value);
          }}
          onBlur={commitPosition}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitPosition();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setPosition(String(index + 1));
            }
          }}
        />
        <span>of {order.length}</span>
        <button
          type="button"
          aria-label="Later"
          title="Move later (Alt+↓)"
          disabled={disabled || index >= order.length - 1}
          onClick={() => moveTo(index + 1)}
        >
          ↓
        </button>
      </div>
      <ArrowControl
        twoWay={message.bidirectional === true}
        selfLoop={message.from === message.to}
        asyncMessage={message.kind === "async"}
        disabled={disabled}
        onChange={(arrow) => onChange({ kind: "change-arrow", id: message.id, arrow })}
      />
      <div className="authoring-message-actions">
        <button type="button" className="authoring-danger" disabled={disabled} onClick={onDelete}>
          Delete
        </button>
      </div>
    </section>
  );
}

/** A picked sequence note (its text, delete) or block (remove it, keeping its messages). */
function PartPanel({
  note,
  fragment,
  focus,
  disabled,
  previewRef,
  onText,
  onDelete,
}: {
  note?: { id: string; text: string } | undefined;
  fragment?: { id: string; kind: string; label: string } | undefined;
  focus: number;
  disabled: boolean;
  previewRef: { current: HTMLElement | null };
  onText: (text: string) => void;
  onDelete: () => void;
}): JSX.Element {
  const panel = useRef<HTMLElement>(null),
    picked = note?.id ?? fragment?.id;
  const place = usePanelPlacement(panel, previewRef, picked ? `[data-seq-id="${CSS.escape(picked)}"]` : null);
  const [text, setText] = useState(note?.text ?? "");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setText(note?.text ?? ""), [note?.text]);
  useEffect(() => {
    if (focus > 0) {
      field.current?.focus();
      field.current?.select();
    }
  }, [focus]);
  // Enter commits, and the blur when the field is disabled mid-edit must not commit the same text again.
  const sent = useRef<string | null>(null);
  useEffect(() => {
    sent.current = null;
  }, [note?.text]);
  const commit = () => {
    const value = text.trim();
    if (sent.current === value) return;
    if (note && value !== "" && value !== note.text) {
      sent.current = value;
      onText(value);
    } else setText(note?.text ?? "");
  };
  return (
    <section
      ref={panel}
      className="authoring-message-panel"
      aria-label={note ? "Selected note" : "Selected block"}
      style={place}
    >
      {note ? (
        <>
          <h2>Note</h2>
          <label>
            Text
            <textarea
              ref={field}
              rows={3}
              value={text}
              disabled={disabled}
              maxLength={1024}
              onChange={(e) => setText(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  commit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setText(note.text);
                }
              }}
            />
          </label>
          <div className="authoring-message-actions">
            <button type="button" className="authoring-danger" disabled={disabled} onClick={onDelete}>
              Delete note
            </button>
          </div>
        </>
      ) : fragment ? (
        <>
          <h2>
            {fragment.kind} block{fragment.label ? <span> · {fragment.label}</span> : null}
          </h2>
          <p className="authoring-secondary">Its condition is edited in the Mermaid source for now.</p>
          <div className="authoring-message-actions">
            <button type="button" disabled={disabled} onClick={onDelete}>
              Remove block, keep messages
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}

const ER_CARDINALITIES = {
  "one-to-many": ["exactly-one", "zero-or-more", "One to many"],
  "one-to-one": ["exactly-one", "exactly-one", "One to one"],
  "many-to-many": ["zero-or-more", "zero-or-more", "Many to many"],
  "zero-or-one-to-many": ["zero-or-one", "zero-or-more", "Zero or one to many"],
} as const;
type GraphEdge = {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly label?: string | undefined;
  readonly figure?: unknown;
  readonly bidirectional?: boolean | undefined;
};
/**
 * The selected connection on a flowchart, C4, ER or state diagram, as controls: its two ends (and an ER
 * relationship's cardinality). The keyboard way to reattach an arrow, which otherwise takes a drag.
 */
function ConnectionPanel({
  edge,
  nodes,
  er,
  arrows,
  disabled,
  previewRef,
  onChange,
  onDelete,
}: {
  edge: GraphEdge;
  nodes: readonly { id: string; label: string }[];
  er: boolean;
  arrows: boolean;
  disabled: boolean;
  previewRef: { current: HTMLElement | null };
  onChange: (edit: Parameters<AuthoringClient["edit"]>[1]) => void;
  onDelete: () => void;
}): JSX.Element {
  // In the corner of the canvas that covers the fewest shapes (the drop targets for its ends) and never the canvas controls.
  const panel = useRef<HTMLElement>(null);
  const place = usePanelPlacement(
    panel,
    previewRef,
    [edge.id, edge.source, edge.target].map((id) => `[data-id="${CSS.escape(id)}"]`).join(", "),
  );
  const name = (id: string) => nodes.find((n) => n.id === id)?.label || id;
  const figure = edge.figure as { type?: string; source?: string; target?: string } | undefined;
  const cardinality =
    figure?.type === "cardinality"
      ? (Object.entries(ER_CARDINALITIES).find(([, v]) => v[0] === figure.source && v[1] === figure.target)?.[0] ??
        "other")
      : null;
  return (
    <section ref={panel} className="authoring-message-panel" aria-label="Selected connection" style={place}>
      <h2>Connection{edge.label ? <span> · {edge.label}</span> : null}</h2>
      <label>
        From
        <select
          value={edge.source}
          disabled={disabled}
          onChange={(e) => {
            if (e.target.value !== edge.source)
              onChange({ kind: "retarget-edge", id: edge.id, source: e.target.value });
          }}
        >
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {name(n.id)}
            </option>
          ))}
        </select>
      </label>
      <label>
        To
        <select
          value={edge.target}
          disabled={disabled}
          onChange={(e) => {
            if (e.target.value !== edge.target)
              onChange({ kind: "retarget-edge", id: edge.id, target: e.target.value });
          }}
        >
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {name(n.id)}
            </option>
          ))}
        </select>
      </label>
      {er && cardinality !== null ? (
        <label>
          Cardinality
          <select
            value={cardinality}
            disabled={disabled}
            onChange={(e) => {
              if (e.target.value !== "other" && e.target.value !== cardinality)
                onChange({ kind: "retarget-edge", id: edge.id, cardinality: e.target.value });
            }}
          >
            {Object.entries(ER_CARDINALITIES).map(([key, v]) => (
              <option key={key} value={key}>
                {v[2]}
              </option>
            ))}
            {cardinality === "other" ? <option value="other">As written in the source</option> : null}
          </select>
        </label>
      ) : null}
      {arrows ? (
        <ArrowControl
          twoWay={edge.bidirectional === true}
          selfLoop={edge.source === edge.target}
          disabled={disabled}
          onChange={(arrow) => onChange({ kind: "change-arrow", id: edge.id, arrow })}
        />
      ) : null}
      <div className="authoring-message-actions">
        <button type="button" className="authoring-danger" disabled={disabled} onClick={onDelete}>
          Delete
        </button>
      </div>
    </section>
  );
}
