import { sourceMetadata } from "../expand/source-metadata";
import { canonicalFileHref } from "./page-address";
import { runtime, type RuntimeExamples } from "./runtime.ts";
import type { InPlaceEditing } from "../authoring/AuthoringWorkspace";
import { EDITOR_ENTRY_SELECTOR, inPlaceHref } from "../authoring/in-place-href";
import { deferredComponent, whenIdle } from "./deferred-component";
import { NewMenu } from "./NewMenu";
import { useRuntimeControls } from "./use-runtime-controls";
import "./ReaderTools.css";
import { SourcePanel, forgetDiagramAnswers } from "./SourcePanel";
import { useAuthoringAllowed } from "../authoring/AuthoringEntry";
import { AuthoringEntry } from "../authoring/AuthoringEntry";
import { saveBrowserPosition } from "./browser-position";
import { SourceDocumentPage } from "./SourceDocumentPage";
import { DevProfiler } from "../telemetry/dev-hooks";
import { GlobalProjectsPage } from "./GlobalProjectsPage";
import { IN_APP_NAVIGATION } from "./in-app-navigation";
import { browserNavigationState } from "./browser-navigation";
import {
  browserRoutePath,
  projectResourceBase,
  readLocationRoute,
  rowRoute,
  type BrowserRoute,
} from "./browser-routes";
import { readFileRoute, type FileRouteTarget } from "./file-route";
import { projectFileAddress } from "./project-file-link";
import { figureLoader, paintFigure } from "../comments/note-figures";
import { Freshness } from "../comments/Freshness";
import type { NoteFreshness } from "../comments/contract";
import { parseDiagramAddress } from "../../../shared/note-diagrams.mjs";
import { ExportControls } from "../export/ExportControls";
import { Staleness } from "../accuracy/Staleness";
import { readAppliedTheme } from "../theme/theme";
import { galleryOrder, prefetchServiceThumbnails, THUMBNAIL_PREFETCH_LIMIT } from "./document-previews";
import { windowFirstScreen } from "./project-views/first-screen";
import { RevisionCompare } from "../accuracy/RevisionCompare";
import { callAccuracyOperation } from "../accuracy/client";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type JSX,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  hasDrawing as stageHasDrawing,
  isPresentationCommand,
  projectedModel,
  selectableIds,
  selectEverything,
  selectionDetails,
  useDrawnSelection,
  useStage,
  useStageGestures,
  useStageView,
  useStageLayout,
} from "./diagram-stage";
import { invalidateCommentActivity } from "./comment-activity";
import { DiagramCanvas, type CanvasState } from "../diagrams/DiagramCanvas";
import { FitDrawing, fitOpens, holdFit, useFitQueue } from "../diagrams/canvas-shortcuts";
import { keyOfDrawing } from "../diagrams/DiagramKey";
import { DiagramSidePanel } from "./diagram-panel";
import { SourceToolContext, SourceToolbar, type SourceTool } from "../diagrams/SourceTool";
import { StageDockContext, StageDockStrip } from "./stage-dock";
import { ChatBubble } from "../chat/ChatBubble";
import { chatContext } from "../chat/chat-context";
import { CHAT_SECTION, CHAT_SEND_KEYS } from "../chat/chat-help";
import { projectEnvelope } from "../diagrams/projection";
import type { PresentationCommand } from "../presentation/controller";
import { recoveredSelection, type SelectionState } from "../selection/state";
import { buildSelectionContext } from "../selection/bridge";
import { connectBridge, type Bridge, type BridgeMessage } from "./host-bridge";
import type { DiagramView } from "./inventory";
import { pageNotice, type ConnectionStatus, type InventoryStatus } from "./page-state";
import { PageNotice, StaleConnectionNotice } from "./PageNotice";
import { ReaderViewNotice } from "./ReaderViewNotice";
import { CAPTION_ID, Caption, captionText } from "./Caption";
import { CompileNotice } from "./CompileNotice";
import { CompileNoticeContext } from "../diagrams/notice-context";
import {
  applyCompileStatus,
  failureFor,
  forgetSavedFailure,
  sourceIsMissing,
  type CompileFailure,
} from "./compile-status";
import { DEFAULT_TYPEFACE } from "../layout/text-measure";
import type { NavigationPlace } from "./WorkspaceNavigation";
import { WebShell } from "./WebShell";
import { useShellHelp } from "./shell-help";
import {
  browserFetch,
  directoryProjectUrl,
  loadProjectCatalog,
  projectSlugFromPath,
  rememberedProjectCatalog,
  watchProjectCatalog,
} from "./project-directory";
import { fetchThumbnailsAhead } from "./thumbnail-fetch-ahead";
import { ProjectSettingsDialog } from "./ProjectSettings";
import { announceProjectCatalogChanged } from "./project-lifecycle";
import { activeProjectForNavigation, projectNavigationPlace } from "./sidebar-project-activity";
import { SearchPage } from "./SearchPage";
import { EMPTY_SEARCH, type FileRow, type SearchState } from "./file-index";
import { useRecents, type RecentItem } from "./recents";
import { NoteReader } from "../comments/NoteReader";

import { DataflowChips } from "./DataflowChips";
import { parseEmphasisSnapshot, type EmphasisSnapshot } from "../emphasis/contract";
import { activeEmphasis, emphasisReducer, initialEmphasisState } from "../emphasis/state";
import {
  commentingSection,
  WALKTHROUGH_SECTION,
  DIAGRAMS_SECTION,
  SEARCH_SECTION,
  type HelpView,
  type Section,
} from "./HelpOverlay";
import {
  isTextEntry,
  isTypingTarget,
  KEYMAP,
  matchesShortcut,
  readerShortcutCapabilities,
  shortcutRow,
  useWindowKeydown,
} from "./shortcuts";
import { NO_CAPABILITIES, PROJECT_TARGET, type Anchor, type Capabilities, type TargetRef } from "../comments/contract";
import { onTarget, targetParts } from "../comments/target";
import { createReviewEvents } from "../comments/events";
import { httpCommentsTransport } from "../comments/transport";
import { useReview, viewTarget } from "../comments/useReview";
import { commentPins } from "../comments/state";
import {
  browserDraftStorage,
  commentDraftScope,
  draftBeingWritten,
  draftToOpen,
  editDraftKey,
  latestEditDraft,
  latestReplyDraft,
  replyDraftKey,
} from "../comments/comment-draft";
import { selectedNotePassage } from "../comments/NoteItem";
import { REVIEW_PANEL_ID, ReviewPanel, type ComposeRequest, type ThreadRequest } from "../comments/ReviewPanel";
import {
  anchorAt,
  anchorIds,
  anchorMissing,
  diagramChoices,
  commentScopes,
  isSequenceNoteAnchor,
  selectionAnchor,
} from "../comments/canvas-anchors";
import { contextOf, defaultAnchor, keptAnchor, stepAnchor, walkChoices } from "../comments/walk-anchors";
import { WalkCommentsContext, type WalkComments } from "../comments/walk-comments";
import { PIN_THREAD_ATTRIBUTE } from "../diagrams/CommentPins";
import { REDUCED_MOTION_QUERY, useMediaQuery } from "./media";
import { projectNameFromPath } from "./project-name";
import { searchWords, type SearchMatch } from "./search";
import { useContentsNotes } from "./contents-notes";
import type { ViewChange } from "./change";
import { ChangeNotice, PresenceLine } from "./DiagramHeader";
import { presenceLine } from "./presence";
import { claimOwnSave, ownSaveOf, savedByYou, useOwnSavesVersion } from "./own-saves";
import { ChangePulse } from "../diagrams/ChangePulse";
import { useNow } from "./now";
import { Breadcrumb } from "./Breadcrumb";
import { FolderPage } from "./FolderPage";
import { folderOf, folderTrail } from "./folders";
import {
  addressKey,
  readLocationAddress,
  sameAddress,
  searchAddressed,
  searchPageHref,
  withPageAddress,
  type PageAddress,
  type ProjectFiles,
} from "./page-address";
import { addressNamesGraph } from "./layout-warmup";
import { startBackgroundLayout } from "../layout/elk-worker-transport";
import { readThreadAddress, withThreadAddress } from "./thread-address";
import { drawnIds, nestEmphasis, type NestMode } from "../nesting/nest-page";
import { useWalkthroughs } from "../walkthroughs/use-walkthroughs";
import { agentWalkOf, useWalkSteering, type AgentWalk } from "../walkthroughs/use-walk-steering";
import { useWalkFollow, type WalkNest } from "../walkthroughs/use-walk-camera";
import { useRevealTargets } from "../nesting/reveal-open";
import { useDiagramModes, type ModeHighlights, type ModeWalkthrough } from "./diagram-mode";
import { ClosedNote, FollowButton } from "../walkthroughs/FollowButton";
import { NestModeButton } from "../nesting/NestModeButton";
import { useLatestCallback } from "./latest-callback";
import {
  presentedOf,
  useExpand,
  type ExpandHost,
  type MenuTarget,
  type PresentedExploration,
} from "../expand/use-expand";
import { framePartOf, type FrameSelection } from "../../../shared/explorations.mts";
import { FrameActionsContext, type FrameActions } from "../expand/frame-chrome";
import { KEYBOARD_FOCUS_CLASS } from "../diagrams/xflow-adapter";
import { focusWhenShown, navigationOrigin, usePendingFocus, weakly } from "./focus-when-shown";

const EMPTY_IDS: readonly string[] = [];
/** The chat's example conversations in this project, for a runtime with no service (`runtime.examples`). */
function exampleChat(examples: RuntimeExamples, slug: string) {
  return { note: examples.chatNote, messages: (target: TargetRef) => examples.chat(slug, target) };
}

/**
 * What a search match points at, as an anchor the page already knows how to
 * show: a node, participant or group is selected as a node; an edge or message
 * as an edge. `null` for a match that names no element.
 */
function searchMatchAnchor(match: SearchMatch): Anchor | null {
  if (match.elementId === undefined) return null;
  switch (match.field) {
    case "node":
    case "participant":
    case "group":
      return { kind: "node", id: match.elementId, label: match.text };
    case "edge":
    case "message":
      return { kind: "edge", id: match.elementId, label: match.text };
    default:
      return null;
  }
}

/** The revision an envelope states, read without projecting the whole model. */
function revisionOf(envelope: unknown): string | undefined {
  if (typeof envelope !== "object" || envelope === null) {
    return undefined;
  }
  const revision = (envelope as Record<string, unknown>).revision;
  return typeof revision === "string" ? revision : undefined;
}

/**
 * What every reader stamp starts with: `reader:<viewId>` (ADR 0011). The
 * server checks the same spelling (`reader_presentation_id`).
 */
export const READER_PRESENTATION_PREFIX = "reader:";

/**
 * The presentation a tab the reader picked is drawn under.
 *
 * Not an agent presentation, and it says so: a selection made on this view is
 * published stamped with this id, which tells the server to hold it to the
 * view's own current model instead of to whatever the agent is presenting.
 * Because it can never equal an agent's id, the agent presenting anything is
 * always a page turn.
 */
/** Whether the page's address is a place a drawing opens on: a diagram, the editor, the agent's stage, a file that is a diagram. */
function routeOpensDrawing(route: BrowserRoute | null): boolean {
  if (route === null) return true; // not a project address this page knows: assume it may draw.
  if (route.kind === "view" || route.kind === "edit" || route.kind === "follow") return true;
  return route.kind === "file" && (route.path.endsWith(".mmd") || route.fragment !== undefined);
}

function readerPresentation(viewId: string): PresentationCommand {
  return { presentationId: `${READER_PRESENTATION_PREFIX}${viewId}`, viewId };
}

type PresentMessage = Extract<BridgeMessage, { type: "present" }>;

/** The view an envelope is of, read without projecting the whole model. */
function viewIdOf(envelope: unknown): string | undefined {
  if (typeof envelope !== "object" || envelope === null) {
    return undefined;
  }
  const view = (envelope as Record<string, unknown>).view;
  const id = typeof view === "object" && view !== null ? (view as Record<string, unknown>).id : undefined;
  return typeof id === "string" ? id : undefined;
}

/** Which view, under which presentation, an agent's snapshot presents. */
/**
 * The editor's own keys (`AuthoringWorkspace`), shown in the cheat sheet while editing. The moving rows are
 * only where they work: a flowchart's shapes take Alt+arrow and Move (round 1, C-01), a sequence's participants
 * and messages take Alt+arrow; anything else, or a family not known yet, shows neither.
 */
export function editingSection(family: "flowchart" | "sequence" | "other" | null): Section {
  return {
    section: "Editing",
    keys: [
      ["Ctrl/⌘ Z", "Undo"],
      ["Shift Ctrl/⌘ Z or Ctrl Y", "Redo"],
      ["Delete", "Delete the selected shape or connection"],
      ["Enter or double-click", "Rename the selected shape or connection"],
      ["Escape", "Clear the selection; cancel a drag or a Move in progress"],
      ...(family === "flowchart"
        ? ([
            ["Alt ← ↑ → ↓", "Move the selected shape 10 px"],
            ["Shift Alt ← ↑ → ↓", "Move the selected shape 50 px"],
            ["Move selected", "Then click where the selected shape should go", "control"],
          ] as const)
        : []),
      ...(family === "sequence"
        ? ([
            ["Alt ← / →", "Move the selected participant"],
            ["Alt ↑ / ↓", "Move the selected message"],
          ] as const)
        : []),
      ["Space + drag, middle-drag", "Pan the drawing"],
    ],
  };
}

function agentTarget(message: PresentMessage): { viewId: string; presentationId: string } | null {
  if (isPresentationCommand(message.presentation)) {
    return { viewId: message.presentation.viewId, presentationId: message.presentation.presentationId };
  }
  const viewId = viewIdOf(message.envelope);
  return viewId === undefined ? null : { viewId, presentationId: viewId };
}

// The editor is evaluated on first use, not at start (perf #3): an editing address loads it at once,
// a reading page when idle. (SearchPage stays eager: the projects page draws it first thing.)
// The open walkthrough's panel section, with its stylesheet, loads when first shown (ADR 0034 §6).
const LazyWalkthroughSurface = deferredComponent(() =>
  import("../walkthroughs/WalkthroughSlot").then((module) => module.WalkthroughSurface),
);
const LazyWalkthroughStage = deferredComponent(() =>
  import("../walkthroughs/OldVersionStage").then((module) => module.WalkthroughStage),
);
const LazyWalkthroughTransport = deferredComponent(() =>
  import("../walkthroughs/WalkthroughSlot").then((module) => module.WalkthroughTransport),
);
const LazyAuthoringWorkspace = deferredComponent(() =>
  import("../authoring/AuthoringWorkspace").then((module) => module.AuthoringWorkspace),
);
const AuthoringWorkspace = LazyAuthoringWorkspace.Component;
if (
  typeof window !== "undefined" &&
  (readLocationRoute(window.location.pathname)?.kind === "edit" ||
    new URLSearchParams(window.location.search).has("edit"))
) {
  void LazyAuthoringWorkspace.preload();
}

/**
 * Whether the address the page is opening names a place of its own (a list, a folder, a note, a diagram, the editor)
 * rather than following the agent; false once the page has opened it (`consumed`).
 */
function routeNamesPlace(consumed: boolean, presented: string | null): boolean {
  if (readLocationRoute(window.location.pathname)?.kind === "edit") return true;
  if (consumed) return false;
  const address = readLocationAddress();
  // An address naming the presented view itself is a place the presentation already shows.
  return address !== null && !(address.kind === "view" && address.viewId === presented);
}

/** The longest the reading drawing stands in for an editor that has not drawn yet. */
const HANDOVER_LIMIT_MS = 2500;
/** How long a touch is held before it opens the element's menu (Android's own long press is ~500 ms). */
const LONG_PRESS_MS = 550;
// How long a diagram's address may keep its stage unpainted while the page learns which view it is and what the
// agent presents (`routeSettling`): past it the stage shows whatever it has.
const ROUTE_SETTLE_LIMIT_MS = 1500;
// The address is a project's own page (its root folder), where the project page shows its title section.
const projectRootAddress = (): boolean => {
  const route = readLocationRoute(window.location.pathname);
  return route?.kind === "browse" && route.folder === "";
};

/** Focus into the editor once it is up (round 1, F31/F41): its drawing, the group named "Drawing" (`EDITOR_ENTRY_SELECTOR`). */
const focusEditorWhenShown = (): (() => void) => focusWhenShown(EDITOR_ENTRY_SELECTOR);

/**
 * Once the page is settled and idle, the current project's first screen of thumbnails is fetched
 * ahead (`thumbnail-fetch-ahead.ts`), so its Diagrams tab opens on them; never on a phone.
 */
function useThumbnailFetchAhead(): void {
  useEffect(() => {
    return watchProjectCatalog(browserFetch, (projects) =>
      fetchThumbnailsAhead(projects, {
        baseUrl: window.location.href,
        theme: readAppliedTheme(),
        currentSlug: projectSlugFromPath(window.location.pathname),
      }),
    );
  }, []);
}

/** Is the address the service-level overview (`/projects/`), which `GlobalProjectsPage` shows, not a project's page? */
const onOverview = (): boolean =>
  readLocationRoute(window.location.pathname, window.location.search, window.location.hash)?.kind === "projects";
/**
 * The overview and a project's page are two roots of one page (claude-503): the overview opens a project in place
 * (`openInApp`), and Back or Forward between them switches the root here, without loading the page again. Only a
 * change between the overview and a project is taken; every other entry is the shown root's own. The capturing
 * listener runs before the leaving root's own `popstate` listeners, and stops them: an address of the other root is
 * not theirs to follow.
 */
function useOverviewSwitch(): void {
  const [, setShown] = useState(onOverview);
  useEffect(() => {
    let shown = onOverview();
    const follow = (event: Event): void => {
      const now = onOverview();
      if (now === shown) return;
      shown = now;
      if (event.type === "popstate") event.stopImmediatePropagation();
      setShown(now);
    };
    window.addEventListener("popstate", follow, true);
    window.addEventListener(IN_APP_NAVIGATION, follow);
    return () => {
      window.removeEventListener("popstate", follow, true);
      window.removeEventListener(IN_APP_NAVIGATION, follow);
    };
  }, []);
}

/**
 * The browser-served page: the project, its files and the diagram stage, in the shared App Shell. An MCP
 * host loads the MCP shell (`McpApp.tsx`) instead; the page's entry (`main.tsx`) picks one.
 */
/** A frame pin's stand-in thread id: the part's canvas id follows; its threads are read when it is opened. */
const FRAME_PIN = "frame-pin:";
export function App(): JSX.Element {
  useThumbnailFetchAhead();
  useOverviewSwitch();
  const route = readLocationRoute(window.location.pathname, window.location.search, window.location.hash);
  if (route?.kind === "document") return <SourceDocumentPage projectSlug={route.projectSlug} path={route.path} />;
  if (route?.kind === "file")
    return <FileRouteGate projectSlug={route.projectSlug} path={route.path} fragment={route.fragment} />;
  return route?.kind === "projects" ? <GlobalProjectsPage /> : <ProjectApp />;
}

/** A file address opens the project page for an Archer-folder file, else the document page (`file-route.ts`). */
function FileRouteGate({
  projectSlug,
  path,
  fragment,
}: {
  readonly projectSlug: string;
  readonly path: string;
  readonly fragment: string | undefined;
}): JSX.Element {
  const [target, setTarget] = useState<FileRouteTarget | null>(null);
  useEffect(() => {
    let live = true;
    setTarget(null);
    void readFileRoute(window.location.href, projectSlug, path, fragment, startBackgroundLayout).then((next) => {
      if (!live) return;
      if (typeof next === "string") {
        setTarget(next);
        return;
      }
      // An Archer-folder file by its project path: this document takes its canonical address and opens
      // the project page there, instead of loading the page a second time (perf #3).
      window.history.replaceState(window.history.state, "", canonicalFileHref(window.location.href, next.canonical));
      setTarget("archer");
    });
    return () => {
      live = false;
    };
  }, [projectSlug, path, fragment]);
  if (target === "document") return <SourceDocumentPage projectSlug={projectSlug} path={path} missing="moved" />;
  if (target === "archer") return <ProjectApp />;
  return (
    <p role="status" className="archer-route-pending">
      Opening {path.split("/").at(-1) ?? path}…
    </p>
  );
}

function ProjectApp(): JSX.Element {
  const trackFocus = usePendingFocus();
  const editingRoute = readLocationRoute(window.location.pathname)?.kind === "edit";
  // The address the page loaded with, until it opens it (the project link below) or the reader goes elsewhere.
  const projectLinkConsumed = useRef(false);
  // Editing in place: `?edit` on a diagram's reading address.
  const [editRequested, setEditRequested] = useState(
    () => !editingRoute && new URLSearchParams(window.location.search).has("edit"),
  );
  // `?source`: show the diagram's raw Mermaid, on the reading page and in the editor alike.
  const [sourceOpen, setSourceOpen] = useState(() => new URLSearchParams(window.location.search).has("source"));
  const toggleSource = useCallback(() => {
    setSourceOpen((open) => {
      const query = new URLSearchParams(window.location.search);
      if (open) query.delete("source");
      else query.set("source", "");
      const rest = query.toString().replace(/(^|&)(source|edit)=(?=&|$)/gu, "$1$2");
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`,
      );
      return !open;
    });
  }, []);
  useEffect(() => {
    const follow = () => {
      const q = new URLSearchParams(window.location.search);
      // Back out of an editor with unsaved edits: stay, and ask first (the guard proceeds at once when nothing changed).
      const guard = leaveGuardRef.current,
        editing = editHrefRef.current;
      if (!q.has("edit") && guard !== null && editing !== null) {
        const leaving = window.location.href;
        let pushed = false,
          proceeded = false;
        guard(() => {
          proceeded = true;
          if (pushed) window.history.replaceState(null, "", leaving);
          setEditRequested(false);
          setSourceOpen(q.has("source"));
        });
        // Still asking: put the editor's address back while the question is open.
        if (!proceeded) {
          pushed = true;
          window.history.pushState(null, "", editing);
        }
        return;
      }
      setEditRequested(q.has("edit"));
      setSourceOpen(q.has("source"));
    };
    window.addEventListener("popstate", follow);
    return () => window.removeEventListener("popstate", follow);
  }, []);
  const [editorToolsHost, setEditorToolsHost] = useState<HTMLDivElement | null>(null);
  // What is presented, what is selected and what is drawn for it: the stage both shells share (`diagram-stage.ts`).
  const diagramStage = useStage();
  const {
    presentation,
    dispatchSelection,
    selection,
    canvasState,
    drawnKeyModel,
    drawnNest,
    presentationRef,
    projectedRef,
    displayedViewIdRef,
    nestRef,
  } = diagramStage;
  // What the agent has pointed at, and which of those the canvas is drawing.
  // A separate channel from focus and from selection: focus is the host's
  // published framing, selection is the user's, emphasis is the agent talking.
  const [emphasis, dispatchEmphasis] = useReducer(emphasisReducer, undefined, initialEmphasisState);
  // The stage's dock strip, where a phone's legend and key go (`stage-dock.tsx`).
  const [dockHost, setDockHost] = useState<HTMLElement | null>(null);
  const stageDock = useMemo(() => ({ host: dockHost }), [dockHost]);
  // What is registered, which is a different question from what is presented:
  // a diagram can exist and never have been presented, and the tab strip is
  // how it is reached. Empty in the MCP shell, which asks for no inventory.
  const [views, setViews] = useState<readonly DiagramView[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The project page's title section holds the page's h1; the shell's title is then text.
  // Null until the project page first says: a project's own address leads with the title section from the first
  // frame, so the header does not show the shell's two-line title for a frame and then lose a line (PF-6).
  const [titleSection, setTitleSection] = useState<boolean | null>(null);
  const settingsGearRef = useRef<HTMLButtonElement>(null);
  // What is known about the registry, which is not the same as what is in it:
  // "not asked yet" and "asked and it is empty" are different facts, and the
  // MCP shell can never leave "unknown" because it has no inventory to read.
  const [inventoryStatus, setInventoryStatus] = useState<InventoryStatus>("unknown");
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const connectionRef = useRef<ConnectionStatus>("connecting");
  // Whether the host has said anything at all yet. Without it, the moment
  // before the first answer is indistinguishable from an empty registry.
  const [heardFromHost, setHeardFromHost] = useState(false);
  // Whether a diagram's address has finished opening its stage (`routeSettling`); latched.
  const [routeSettled, setRouteSettled] = useState(false);
  // Whether the one request that says what is presented came back unusable.
  // Without it a failed bootstrap is indistinguishable from a slow one, and the
  // page says "Loading..." for an answer that will never arrive.
  const [bootstrapFailed, setBootstrapFailed] = useState(false);
  // Which registered views do not compile right now (ADR 0010). A fact about
  // the FILES, kept apart from the drawing: the canvas goes on showing the
  // last version that compiled, and this is what lets the page say so.
  const [compileFailures, setCompileFailures] = useState<readonly CompileFailure[]>([]);
  // The view whose tab the reader picked when that view has never compiled:
  // there is no envelope to fetch, so nothing is presented, and the page says
  // so in place of a drawing (`pageNotice`, "never-compiled"). Held until
  // something IS presented -- that view once it compiles, or anything else.
  const [pickedUndrawnViewId, setPickedUndrawnViewId] = useState<string | null>(null);
  // The view the reader asked for that has not landed yet: until it does, the drawing still up is the one being
  // left, and nothing more is read for it (`viewOnStage`).
  const [requestedViewId, setRequestedViewId] = useState<string | null>(null);
  // The view on screen because the READER picked its tab, or null while what
  // is on screen is the agent's presentation. The same fact as
  // `presentationOriginRef` below, held as state as well because an effect
  // depends on it: a picked view is kept current by this page, not the server.
  const [browsedViewId, setBrowsedViewId] = useState<string | null>(null);
  // What the AGENT is presenting, which is a separate fact from what is on
  // screen once the reader has picked a tab (ADR 0011). Kept current while the
  // reader is elsewhere, so the page can say the two differ and go back.
  const [agentPresentation, setAgentPresentation] = useState<{
    readonly viewId: string;
    readonly presentationId: string;
  } | null>(null);
  // Advanced to publish the selection again without it having changed: see
  // `handleAgentPresent`.
  const [republish, setRepublish] = useState(0);
  // Whether the `?` cheat sheet is up. It owns the keyboard while it is: see
  // the Esc layering below, and `shortcutsEnabled` on the canvas.
  const help = useShellHelp();
  const { open: helpOpen } = help;
  // Whether the reader asked for the project overview from a diagram. With nothing presented or picked it shows
  // regardless (`contentsShown` below); this is the reader going back to it.
  const [contentsOpen, setContentsOpen] = useState(false);
  // The folder the reader walked to from the breadcrumb (`FolderPage.tsx`),
  // folder-relative, or a null path for a `?folder=` that names no folder
  // (`folder-link.ts`). Going anywhere else leaves it, as it leaves the overview.
  const [browsedFolder, setBrowsedFolder] = useState<{ readonly path: string | null } | null>(null);
  // The search page and what it shows (`SearchPage.tsx`, `?q=`), or null when it is not open.
  const [searchState, setSearchState] = useState<SearchState | null>(null);
  /** The query of the search on screen, for a match opened from it (read when it is opened, J3-F1; set below). */
  const searchQueryRef = useRef("");
  const [projectExpansion, setProjectExpansion] = useState<{ readonly slug: string | null } | undefined>(undefined);
  const [selectedNotePath, setSelectedNotePath] = useState<string | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Set when the reader asks for the search page by key or from the sidebar: its box takes the focus once it is up.
  const focusSearchRef = useRef(false);
  // When this page saw the agent present what it is presenting, for the
  // presence line. Absent for a presentation made before the page opened:
  // the presentation carries no time, and "just now" would be a guess.
  const [presentedAt, setPresentedAt] = useState<{ readonly presentationId: string; readonly at: number } | null>(null);
  // What the agent last presented, as far as the walkthrough panel is concerned (steering, ADR 0034 §6).
  const [agentWalk, setAgentWalk] = useState<AgentWalk | null>(null);
  // The agent's presentation as Expand reads it: its exploration stamp, if it presented with `expand` (ADR 0036 §14).
  const [agentExploration, setAgentExploration] = useState<PresentedExploration | null>(null);
  // Whether this page has heard anything from the host yet, readable by a handler.
  const heardRef = useRef(false);
  // The agent's latest change to each view, kept until the reader dismisses
  // it (`change` event, phase 3): on the view on screen, and on a view with
  // comment threads, which the reader will want to see changed when they go
  // back to it.
  const [changes, setChanges] = useState<ReadonlyMap<string, ViewChange>>(new Map());
  // The pulse over the changed elements: which view, which round ("Show
  // changes" starts another), and whether it is waiting for the redrawn model.
  const [pulse, setPulse] = useState<{
    readonly viewId: string;
    readonly round: number;
    readonly waiting: boolean;
    readonly revision?: string;
  } | null>(null);
  const pulsedRef = useRef<Set<string>>(new Set());
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  // A phone-width window: the switcher is the navigation and no tab strip is
  // rendered in the project directory.
  // The face the page draws in (Fira Sans, embedded). Layout sizes every box from
  // its text without a browser, so it has to be told which face that is.
  const typeface = DEFAULT_TYPEFACE;
  // What the service supports beyond the drawing (`api/bootstrap`'s
  // `capabilities`). Until it says (or when its bootstrap cannot be read), the
  // page offers none of it.
  const [capabilities, setCapabilities] = useState<Capabilities>(NO_CAPABILITIES);
  // Until the service says, the header keeps the bell's place (PF-6).
  const [capabilitiesKnown, setCapabilitiesKnown] = useState(false);
  // archer.toml `nested_view = false` draws every diagram as written (ADR 0029).
  const nestedViewAllowed = capabilities.nestedView !== false;
  // Search discovery reads aggregate activity once per project. Comment SSE
  // and reconnects advance this key so replies and resolves refresh it even
  // when inventory counts happen not to change.
  const [commentActivityRefresh, setCommentActivityRefresh] = useState(0);
  // The side panel, and the comment being written in it.
  const [reviewOpen, setReviewOpen] = useState(false);
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [accuracyOpen, setAccuracyOpen] = useState(false);
  const toolLauncherRef = useRef<HTMLButtonElement | null>(null);
  // The review sidebar hangs below the document bar, whose height changes as
  // its contents wrap; publish where the bar ends so the sidebar follows it.
  const observeDocumentBar = useCallback((bar: HTMLElement | null) => {
    if (bar === null || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const publish = () => root.style.setProperty("--primary-bar-bottom", `${bar.getBoundingClientRect().bottom}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(bar);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--primary-bar-bottom");
    };
  }, []);
  const restoreToolFocus = () => {
    const launcher = toolLauncherRef.current?.isConnected
      ? toolLauncherRef.current
      : document.querySelector<HTMLButtonElement>(".archer-canvas-tools-trigger");
    launcher?.focus();
  };
  const closeComparison = () => {
    if (comparisonOpen) {
      setComparisonOpen(false);
      restoreToolFocus();
    }
  };
  const closeExport = () => {
    if (exportOpen) {
      setExportOpen(false);
      restoreToolFocus();
    }
  };
  const closeAccuracy = () => {
    if (accuracyOpen) {
      setAccuracyOpen(false);
      restoreToolFocus();
    }
  };
  const [compose, setCompose] = useState<ComposeRequest | null>(null);
  const [threadRequest, setThreadRequest] = useState<ThreadRequest | null>(null);
  const reviewEvents = useMemo(createReviewEvents, []);
  const commentsTransport = useMemo(
    () => httpCommentsTransport(undefined, () => runtime.writable(connectionRef.current)),
    [],
  );
  // A note's mermaid fences, drawn in place by the export painter (slice B of
  // docs/proposals/notes-with-embedded-diagrams.md); fetched once per body revision.
  /** Where the reader was in a note when they opened one of its diagrams, to go back to (ADR 0012). */
  const [noteReturn, setNoteReturn] = useState<{
    readonly path: string;
    readonly address: string;
    readonly scrollTop: number;
  } | null>(null);
  const [headerFreshness, setHeaderFreshness] = useState<NoteFreshness | null>(null);
  const noteFigures = useMemo(() => {
    const fetchDiagram = commentsTransport.embeddedDiagram?.bind(commentsTransport);
    return fetchDiagram === undefined ? undefined : { load: figureLoader(fetchDiagram, paintFigure), now: Date.now };
  }, [commentsTransport]);
  const reviewToggleRef = useRef<HTMLButtonElement>(null);
  const reviewLauncherRef = useRef<HTMLButtonElement | null>(null);

  const bridgeRef = useRef<Bridge | null>(null);
  // Read by `handleSelectTab`, which must not be rebuilt -- and the bridge
  // with it -- every time a file fails to compile.
  const compileFailuresRef = useRef<readonly CompileFailure[]>(compileFailures);
  // Advances on every navigation, whoever asked for it. A tab fetch that
  // resolves after a later navigation has already landed is stale and drops
  // itself rather than yanking the canvas back.
  const navigationRef = useRef(0);
  const readerInteractedRef = useRef(false);
  /*
   * How the next change of place is written to the page's address (THE
   * PAGE'S ADDRESS, below): "push" when the reader went somewhere, "replace"
   * when the agent presented or the history itself moved, null until either
   * has happened -- the address the page loaded with stands until then.
   */
  const addressIntentRef = useRef<"push" | "replace" | null>(null);
  const browserTypingRef = useRef(false);
  const browserInteractionRef = useRef<"query" | "scope" | "filter">("filter");
  /** The reader going somewhere in the project: every one is a history entry. */
  // The view being edited in place (null when not editing), and an agent presentation held until editing ends.
  const editingViewRef = useRef<string | null>(null);
  const deferredPresentRef = useRef<PresentMessage | null>(null);
  // The editor's leave guard: asks before unsaved edits are left behind (`InPlaceEditing.guard`).
  const leaveGuardRef = useRef<((proceed: () => void) => void) | null>(null);
  const editHrefRef = useRef<string | null>(null);
  const [missingView, setMissingView] = useState<string | null>(null);
  // In-app navigation to a diagram or note: its h1 takes the focus once it is up (round 1, F10/F14), as a document load
  // would put the reader at the top of the page. Set by `openView` and `openNote`; the effect is below the inventory.
  // The control the navigation started from is held weakly, never in state: an Element in state stays in every later
  // render's closures, so each page left kept the one before it alive (G6, PF-3).
  const [headingWanted, setHeadingWanted] = useState<{
    readonly kind: "view" | "note";
    readonly id: string;
    readonly n: number;
  } | null>(null);
  const headingFromRef = useRef<WeakRef<Element> | null>(null);
  const readerNavigates = useCallback(() => {
    // A Fit pressed for the place being left is not for the next one; a diagram opened names itself (`handleSelectTab`).
    fitOpens(null);
    setMissingView(null);
    saveBrowserPosition();
    readerInteractedRef.current = true;
    browserTypingRef.current = false;
    addressIntentRef.current = "push";
  }, []);
  // Who put the current view on screen: the agent presenting it, or the
  // reader picking its tab ("local"). Both publish what is selected; they
  // stamp it differently -- see the selection effect below.
  const presentationOriginRef = useRef<"agent" | "local">("agent");
  // The agent's latest snapshot, whether or not it is what is on screen: what
  // "back to the agent's view" draws.
  const agentMessageRef = useRef<PresentMessage | null>(null);
  // `pickedUndrawnViewId`, readable by a handler: a reader looking at "this
  // diagram has not compiled yet" is on a tab of their own too.
  const pickedUndrawnRef = useRef<string | null>(null);
  // Set when the reader goes back to the agent's presentation, so that the
  // empty selection it starts with is published: it is how the server learns
  // they are no longer on the other view.
  const announceTurnRef = useRef(false);
  // The selection restored from the server when the page opened: it holds it already, so it is not published back.
  const restoredSelectionRef = useRef<SelectionState | null>(null);
  // Whether the view of the reader's own on screen is one they turned to (a click, a key, Back), not the one the
  // page's address opened: only a turn announces where they are.
  const readerTurnedRef = useRef(false);
  const pageOpeningRef = useRef(false);
  // Every view id this page has ever seen in a listing. See `handleInventory`.
  const registeredEverRef = useRef<Set<string>>(new Set());
  // The latest listing, readable by a handler in the same turn it arrived in:
  // a reconcile hands over the registry and the presentation together, and
  // `handleClear` has to know what is registered NOW, not as of the last paint.
  const viewsRef = useRef<readonly DiagramView[]>([]);
  // What the page knows of its files, to read and write file addresses (`page-address.ts`).
  const pageFilesRef = useRef<ProjectFiles>({ views: [] });

  useEffect(() => {
    compileFailuresRef.current = compileFailures;
  }, [compileFailures]);

  useEffect(() => {
    pickedUndrawnRef.current = pickedUndrawnViewId;
  }, [pickedUndrawnViewId]);

  const { present, reset } = diagramStage;
  const handlePresent = useCallback(
    (msg: Extract<BridgeMessage, { type: "present" }>) => {
      // Any presentation, from the agent or from a tab click, supersedes a tab
      // fetch that is still in flight -- including one whose envelope turns out
      // to be unprojectable, because the error it puts on screen is also newer
      // than the pending click.
      navigationRef.current += 1;
      // ...and a tab that had nothing to draw: the page is showing this now.
      setPickedUndrawnViewId(null);
      setRequestedViewId(null);
      present(msg);
    },
    [present],
  );

  /**
   * The host says NOTHING IS PRESENTED. It is said by the bootstrap route, so
   * it arrives when the page opens and whenever its stream comes back.
   *
   * It retires the agent's presentation, and that is not always what is on
   * screen (ADR 0011). Two drawings are left alone:
   *
   *   - a view the reader picked. It was never the agent's presentation, so
   *     the agent's presentation ending says nothing about it.
   *   - a view that has left the registry. The page already replaces it with
   *     "This diagram is no longer registered." (`pageNotice`), which is what
   *     a page that watched the removal happen says; resetting here would
   *     swap that for "No diagrams yet." on a page that only missed the event.
   */
  const handleClear = useCallback(() => {
    setHeardFromHost(true);
    heardRef.current = true;
    agentMessageRef.current = null;
    setAgentPresentation(null);
    setAgentExploration(null);
    const shown = presentationRef.current;
    if (shown !== null) {
      const readerPicked = presentationOriginRef.current === "local";
      const retired =
        registeredEverRef.current.has(shown.viewId) && !viewsRef.current.some((view) => view.id === shown.viewId);
      if (readerPicked || retired) {
        return;
      }
    }
    presentationOriginRef.current = "agent";
    setBrowsedViewId(null);
    setPickedUndrawnViewId(null);
    reset();
  }, [reset]);

  const thumbnailsPrefetchedRef = useRef(false);
  const handleInventory = useCallback((next: DiagramView[]) => {
    // The project browser's Diagrams tab draws a card per diagram: its thumbnails are asked for now,
    // alongside the render that places them, not after it (perf #7). The compile status arrives in the
    // same reconcile, just after this listing: the ask waits that one tick so failing diagrams are skipped.
    if (
      !thumbnailsPrefetchedRef.current &&
      readLocationRoute(window.location.pathname)?.kind === "browse" &&
      new URLSearchParams(window.location.search).get("tab") === "diagrams"
    ) {
      thumbnailsPrefetchedRef.current = true;
      const slug = projectSlugFromPath(window.location.pathname);
      // In the gallery's order, the first screen of cards at high priority: they are asked for before the cards exist.
      if (slug !== null)
        queueMicrotask(() =>
          prefetchServiceThumbnails(
            galleryOrder(next, slug, window.location.search),
            new Set(compileFailuresRef.current.map((entry) => entry.viewId)),
            slug,
            window.location.href,
            readAppliedTheme(),
            THUMBNAIL_PREFETCH_LIMIT,
            windowFirstScreen(),
          ),
        );
    }
    // The addressed view is a graph: its layout worker starts with the view's own read, not once it is drawn.
    if (addressNamesGraph(next)) startBackgroundLayout();
    viewsRef.current = next;
    setViews(next);
    setInventoryStatus("loaded");
    // Remembered across updates: telling the user a view is GONE means having
    // seen it there in the first place. Without this, a view registered and
    // presented in the gap before our listing came back would be reported as
    // unregistered purely because we asked too early.
    for (const view of next) {
      registeredEverRef.current.add(view.id);
    }
  }, []);

  const handleInventoryError = useCallback(() => {
    setInventoryStatus("failed");
  }, []);

  const handleBootstrapError = useCallback(() => {
    setBootstrapFailed(true);
  }, []);

  const everConnectedRef = useRef(false);
  const connectionTroubleRef = useRef(false);
  const handleConnection = useCallback(
    (status: Exclude<ConnectionStatus, "connecting">) => {
      connectionRef.current = status;
      setConnection(status);
      // The stream replays nothing: what changed while it was down is read again.
      // The first connection that came up clean is not a reconnect: the page has just read everything.
      if (status === "static-ready") return;
      if (status !== "connected") {
        connectionTroubleRef.current = true;
        return;
      }
      const first = !everConnectedRef.current;
      everConnectedRef.current = true;
      if (first && !connectionTroubleRef.current) return;
      invalidateCommentActivity();
      reviewEvents.emit({ type: "reconnect" });
      setCommentActivityRefresh((value) => value + 1);
    },
    [reviewEvents],
  );

  const handleCapabilities = useCallback((next: Capabilities) => {
    setCapabilitiesKnown(true);
    setCapabilities((held) =>
      held.comments === next.comments &&
      held.notes === next.notes &&
      held.noteEmphasis === next.noteEmphasis &&
      held.instanceSettings === next.instanceSettings &&
      held.nestedView === next.nestedView
        ? held
        : next,
    );
  }, []);

  const handleComments = useCallback(
    (changed: { readonly target: TargetRef }) => {
      invalidateCommentActivity();
      reviewEvents.emit({ type: "comments", target: changed.target });
      setCommentActivityRefresh((value) => value + 1);
    },
    [reviewEvents],
  );

  const handleWalkthroughs = useCallback(
    (changed: { readonly viewId: string }) => reviewEvents.emit({ type: "walkthroughs", viewId: changed.viewId }),
    [reviewEvents],
  );

  const handleNotes = useCallback(
    (changed: { readonly viewId?: string; readonly notePath?: string }) => {
      if (changed.notePath !== undefined) {
        reviewEvents.emit({ type: "note-emphasis", notePath: changed.notePath });
        return;
      }
      reviewEvents.emit(changed.viewId === undefined ? { type: "notes" } : { type: "notes", viewId: changed.viewId });
    },
    [reviewEvents],
  );

  /*
   * The agent changed a view (phase 3). Kept for the view on screen, and for
   * a view with comment threads -- the reader's own words are on it, so they
   * will want to see what moved when they go back. An editor's save is the
   * reader's own doing, and the presence line says "Edited" for it.
   */
  const handleChange = useCallback((change: ViewChange) => {
    if (change.by !== "agent") return;
    const onScreen = presentationRef.current?.viewId === change.viewId || pickedUndrawnRef.current === change.viewId;
    const threads = viewsRef.current.find((view) => view.id === change.viewId)?.threads;
    const discussed = threads !== undefined && Object.values(threads).some((count) => count > 0);
    if (!onScreen && !discussed) return;
    setChanges((held) => new Map(held).set(change.viewId, change));
  }, []);

  // Stable, and read at the moment the bridge reconciles: see `viewOnScreen`.
  const viewOnStageRef = useRef<string | null>(null);
  const viewOnScreen = useCallback(() => viewOnStageRef.current, []);

  const handleEmphasis = useCallback((snapshot: EmphasisSnapshot) => {
    dispatchEmphasis({ type: "publish", snapshot });
  }, []);

  const handleCompileStatus = useCallback((failures: CompileFailure[]) => {
    // Ahead of the render that the state change makes: the thumbnail prefetch reads it in between.
    compileFailuresRef.current = failures;
    setCompileFailures((held) => applyCompileStatus(held, failures));
  }, []);

  /**
   * Puts the agent's presentation back on screen: the indicator's button, and
   * the tab of the view the agent is presenting.
   *
   * Drawn from the snapshot this page holds, which every `presentation` event
   * and every reconcile keeps current while the reader is elsewhere, so it is
   * the agent's view as it is now and costs no request.
   */
  const handleReturnToAgent = useCallback(() => {
    readerNavigates();
    setSelectedNotePath(null);
    const message = agentMessageRef.current;
    if (message === null) {
      return;
    }
    presentationOriginRef.current = "agent";
    setBrowsedViewId(null);
    // The reader has moved, and the server learns where from the selection
    // this turn starts with -- an empty one, on the agent's presentation.
    announceTurnRef.current = true;
    handlePresent(message);
  }, [handlePresent, readerNavigates]);

  /**
   * Picking a tab is USER NAVIGATION, not an agent presentation change.
   *
   * It reads the view and draws it in this browser. The presentation stays
   * the agent's to set: a second writer would make it mean two things at once
   * -- "what the agent asked for" and "what this tab is showing" -- which are
   * not the same claim and do not always agree. So the two are kept as two
   * facts (ADR 0011). What the reader selects on the tab they picked IS
   * published, stamped with this view and `reader:<viewId>` in place of an
   * agent presentation id, and the agent is told both: what it is presenting,
   * and what the reader is looking at and has selected.
   *
   * The tab of the view the agent is presenting is not a different place: it
   * is the agent's presentation, so picking it goes back to that (or, when it
   * is already on screen, does nothing).
   */
  const handleSelectTab = useCallback(
    (viewId: string) => {
      readerInteractedRef.current = true;
      const turned = !pageOpeningRef.current;
      const bridge = bridgeRef.current;
      if (bridge === null) {
        return;
      }
      const agent = agentMessageRef.current === null ? null : agentTarget(agentMessageRef.current);
      if (agent !== null && agent.viewId === viewId) {
        fitOpens(viewId);
        // Supersedes a tab fetch still in flight, like any other navigation.
        navigationRef.current += 1;
        setRequestedViewId(null);
        if (presentationOriginRef.current === "local" || pickedUndrawnRef.current !== null) {
          handleReturnToAgent();
        } else if (presentationRef.current?.viewId !== viewId && agentMessageRef.current !== null) {
          // The standing presentation an address held back (`routeNamesPlace`) because it named a place: this one is it.
          presentationOriginRef.current = "agent";
          setBrowsedViewId(null);
          handlePresent(agentMessageRef.current);
        }
        return;
      }
      const requested = ++navigationRef.current;
      // A view that has never compiled has no envelope, so asking for one is a
      // 404 and a click that appears to do nothing. The page says what is true
      // of it instead; why is in the compile notice (ADR 0010).
      if (failureFor(compileFailuresRef.current, viewId)?.lastValidRevision === null) {
        // ...and nothing is drawn, so a Fit pressed now has nothing to wait for (R6-claude-07).
        fitOpens(null);
        setRequestedViewId(null);
        setPickedUndrawnViewId(viewId);
        return;
      }
      // A Fit pressed from now until it is drawn is this diagram's (V7-1), and only its.
      fitOpens(viewId);
      setRequestedViewId(viewId);
      void bridge
        .fetchView(viewId)
        .then((envelope) => {
          // A late answer to a superseded click -- a second tab, or an agent
          // presentation that arrived meanwhile -- must not overwrite what is
          // now on screen.
          if (navigationRef.current !== requested) {
            return;
          }
          presentationOriginRef.current = "local";
          readerTurnedRef.current = turned;
          setBrowsedViewId(viewId);
          handlePresent({
            type: "present",
            envelope,
            presentation: readerPresentation(viewId),
            diagnostics: [],
          });
        })
        .catch((error: unknown) => {
          // A view that is gone or unreachable is not a reason to blank the
          // canvas: what is drawn is still a true picture of what it claims.
          console.error(`[archer] loading view ${viewId} failed`, error);
          // It is not coming: a Fit pressed for it is dropped, and the drawing still up takes the next one.
          if (navigationRef.current === requested) {
            fitOpens(presentationRef.current?.viewId ?? null);
            setRequestedViewId(null);
          }
          // If this was the read that follows a never-compiled view compiling,
          // stop saying it has not: the page falls back to what it has.
          setPickedUndrawnViewId((held) => (held === viewId ? null : held));
        });
    },
    [handlePresent, handleReturnToAgent],
  );

  /**
   * The reader going to a diagram: a tab, the switcher, `[` and `]`, a card on
   * the contents page. Leaves the contents page, which `handleSelectTab` alone
   * does not -- it also redraws a picked view that has just compiled, and that
   * is no reason to take the reader off the contents page.
   */
  const showView = useCallback(
    (viewId: string) => {
      setContentsOpen(false);
      setBrowsedFolder(null);
      setSearchState(null);
      setSelectedNotePath(null);
      setQueuedAnchor(null);
      handleSelectTab(viewId);
    },
    [handleSelectTab],
  );
  const openView = useCallback(
    (viewId: string) => {
      readerNavigates();
      showView(viewId);
      headingFromRef.current = weakly(navigationOrigin());
      setHeadingWanted((was) => ({ kind: "view", id: viewId, n: (was?.n ?? 0) + 1 }));
    },
    [readerNavigates, showView],
  );
  /** The search match a note was opened from, while that note is open (J3-F1). */
  const [noteSearchMatch, setNoteSearchMatch] = useState<{
    path: string;
    key: number;
    snippet: string;
    words: readonly string[];
  } | null>(null);
  const noteSearchKey = useRef(0);
  /** The reader opening a note: Projects & files, the contents, a link, a search match, a comment. */
  const openNote = useCallback(
    (path: string) => {
      readerNavigates();
      setNoteSearchMatch(null);
      headingFromRef.current = weakly(navigationOrigin());
      setHeadingWanted((was) => ({ kind: "note", id: path, n: (was?.n ?? 0) + 1 }));
      setSelectedNotePath(path);
      setContentsOpen(false);
      setBrowsedFolder(null);
      setSearchState(null);
    },
    [readerNavigates],
  );
  /** Opens a diagram drawn in a note, remembering where the reader was in the note (ADR 0012). */
  const openEmbedded = useCallback(
    (address: string, scrollTop: number) => {
      if (selectedNotePath !== null) setNoteReturn({ path: selectedNotePath, address, scrollTop });
      openView(address);
    },
    [openView, selectedNotePath],
  );
  /** The breadcrumb's note segment: back to the note, where the reader was. */
  const showNoteAgain = useCallback((path: string) => {
    setNoteReturn((held) => (held !== null && held.path === path ? held : null));
    setSelectedNotePath(path);
    setContentsOpen(false);
    setBrowsedFolder(null);
    setSearchState(null);
  }, []);
  const backToNote = useCallback(
    (path: string) => {
      readerNavigates();
      showNoteAgain(path);
    },
    [readerNavigates, showNoteAgain],
  );

  /**
   * Everything the host pushes is the agent speaking.
   *
   * THE AGENT PRESENTING TAKES THE PAGE, from a tab the reader picked too:
   * `present_diagram` is the agent saying "look at this", and a page that
   * stayed elsewhere would leave it talking about a drawing nobody can see.
   * The server retires a selection held on the other view for the same reason.
   *
   * A LIVE RELOAD OF THE AGENT'S VIEW DOES NOT. The server pushes the same
   * presentation at a new revision whenever that view's file is saved, and
   * nobody said "look at this": a reader on another tab stays there, and the
   * snapshot is kept for when they go back. The server drops the stored
   * selection whenever the presented view's revision moves, whichever view the
   * selection was on, so the reader's is published again.
   */
  const handleAgentPresent = useCallback(
    (msg: PresentMessage) => {
      // An agent presenting another view while a diagram is being edited waits until editing ends: the editor keeps its
      // target, and nothing navigates out from under unsaved work. A live reload of the edited view itself goes through.
      const editingView = editingViewRef.current;
      if (editingView !== null) {
        const presented = agentTarget(msg);
        if (presented === null || presented.viewId !== editingView) {
          deferredPresentRef.current = msg;
          return;
        }
      }
      if (!msg.initial) setMissingView(null);
      setHeardFromHost(true);
      const previous = agentMessageRef.current;
      const target = agentTarget(msg);
      agentMessageRef.current = msg;
      // A new presentation, seen as it was made: the first thing a page hears
      // is the standing state, made at a time it was not told.
      const heardBefore = heardRef.current;
      heardRef.current = true;
      const before = previous === null ? null : agentTarget(previous);
      const explored = presentedOf(msg.presentation);
      setAgentExploration((held) =>
        held !== null &&
        explored !== null &&
        held.presentationId === explored.presentationId &&
        held.stamp?.generation === explored.stamp?.generation
          ? held
          : explored,
      );
      if (
        target !== null &&
        (before === null || before.presentationId !== target.presentationId || before.viewId !== target.viewId)
      ) {
        setPresentedAt(heardBefore ? { presentationId: target.presentationId, at: Date.now() } : null);
        setAgentWalk(agentWalkOf(msg.presentation, heardBefore && msg.initial !== true ? Date.now() : null));
      }
      setAgentPresentation((held) =>
        held !== null &&
        target !== null &&
        held.viewId === target.viewId &&
        held.presentationId === target.presentationId
          ? held
          : target,
      );

      // The standing presentation is not what a page asked for by its address takes the stage for: a list, a note, a
      // diagram or the editor named by the route opens instead, and the route's own identity settles first (G1, PF-1).
      // Only a follow address (the project with no place named) shows it.
      if (
        msg.initial &&
        (readerInteractedRef.current || routeNamesPlace(projectLinkConsumed.current, target?.viewId ?? null))
      )
        return;

      const readerElsewhere = presentationOriginRef.current === "local" || pickedUndrawnRef.current !== null;
      const isLiveReload =
        before !== null &&
        target !== null &&
        before.viewId === target.viewId &&
        before.presentationId === target.presentationId &&
        revisionOf(previous?.envelope) !== revisionOf(msg.envelope);
      if (readerElsewhere && isLiveReload) {
        // Only a selection on a view of the reader's own is published again. On
        // the never-compiled notice the selection in hand is still the agent
        // view's, stamped with the revision that has just been replaced.
        if (presentationOriginRef.current === "local") {
          setRepublish((count) => count + 1);
        }
        return;
      }

      // ...from the contents page too, except for a live reload of what the
      // agent was already presenting: nobody said "look at this".
      if (!isLiveReload) {
        setSelectedNotePath(null);
        setContentsOpen(false);
        setBrowsedFolder(null);
        setSearchState(null);
        // The agent presenting after the page opened moves the address with it,
        // in place: the reader went nowhere, so Back is not to step through it.
        // What it was presenting when the page opened leaves the address alone.
        if (heardBefore) addressIntentRef.current = "replace";
      }
      presentationOriginRef.current = "agent";
      setBrowsedViewId(null);
      handlePresent(msg);
    },
    [handlePresent],
  );
  const agentPresentRef = useRef(handleAgentPresent);
  agentPresentRef.current = handleAgentPresent;

  /**
   * A view the reader picked is kept current by RE-READING it.
   *
   * The server pushes a redraw for one view: the one it is presenting. A view
   * the reader picked is read by a GET, and nothing on the stream says when
   * its file changes afterwards -- a valid edit to a view that is not
   * presented sends this page no event at all (measured; only a compile
   * FAILURE and its recovery do). So the reader went on looking at the drawing
   * as it was when they clicked, with nothing to say it was old (release
   * review 2026-10-01, I14).
   *
   * The stream's inventory names each view's model revision, and every change
   * to it is an event. When the revision it names for the picked view differs
   * from the one drawn, the page reads the view again (the GET the tab click
   * made, with its ETag) while the page is visible; nothing asks on a timer. A
   * view that has never compiled names no revision and has nothing to draw;
   * its first compile is announced like any other change. It is redrawn only
   * when the revision it states has moved, as the same view at a new revision -- the redraw a presented
   * view gets from a pushed live reload, which keeps the reader's camera and
   * whatever in their selection still exists.
   *
   * Still a read. The presentation stays the agent's, and the moment the agent
   * presents anything this stops (`browsedViewId` goes null) and a late answer
   * is dropped (`navigationRef`). A selection the reader holds here is
   * re-stamped with the new revision and published again by the selection
   * effect, since the server holds a selection to the view's current model.
   *
   * A failed read is silent and keeps the drawing: logging one a second would
   * bury the console, and the two things a failure can mean each have their
   * own notice already -- the connection strip, and the page notice for a
   * view that is no longer registered (which also stops the reading).
   */
  const browsedIsRegistered = browsedViewId !== null && views.some((view) => view.id === browsedViewId);
  // The revision the stream's inventory states for the picked view; it keys the read below.
  const browsedInventoryRevision =
    browsedViewId === null ? undefined : views.find((view) => view.id === browsedViewId)?.modelRevision;
  const editingInPlace = editingRoute || editRequested;
  useEffect(() => {
    // Not while editing: the editor holds its own copy and the save is what changes the view.
    if (browsedViewId === null || !browsedIsRegistered || editingInPlace) {
      return;
    }
    const viewId = browsedViewId;
    let stopped = false;
    let reading = false;
    let retryTimer: number | undefined;
    const read = (): Promise<void> | undefined => {
      const bridge = bridgeRef.current;
      if (bridge === null || reading || document.hidden) {
        return undefined;
      }
      reading = true;
      const asked = navigationRef.current;
      // A re-read: with the ETag of the last read, an unchanged view answers 304 and `null` (nothing parsed or redrawn).
      return (bridge.refreshView?.(viewId) ?? bridge.fetchView(viewId))
        .then((envelope) => {
          if (envelope === null || stopped || navigationRef.current !== asked) {
            return;
          }
          const drawn = presentationRef.current;
          if (drawn === null || drawn.viewId !== viewId || revisionOf(envelope) === drawn.revision) {
            return;
          }
          handlePresent({
            type: "present",
            envelope,
            presentation: readerPresentation(viewId),
            diagnostics: [],
          });
        })
        .catch(() => {
          // See above: the drawing stays, and other notices say why. Ask once more.
          if (!stopped) retryTimer = window.setTimeout(read, 2000);
        })
        .finally(() => {
          reading = false;
        });
    };
    // The stream's inventory names the view's revision. When it differs from what is drawn, read once; when it
    // does not (or there is none yet: the view has never compiled), nothing asks.
    const drawnNow = presentationRef.current;
    if (
      browsedInventoryRevision !== undefined &&
      (drawnNow === null || drawnNow.viewId !== viewId || drawnNow.revision !== browsedInventoryRevision)
    )
      read();
    // A tab brought back to the front catches up at once, not a second later.
    const shown = (): void => {
      void read();
    };
    document.addEventListener("visibilitychange", shown);
    return () => {
      stopped = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [browsedViewId, browsedIsRegistered, browsedInventoryRevision, editingInPlace, handlePresent]);

  // A remembered reader selection for another place than the page's address (round 1, L-app): held until the
  // address is open, and used then only when the address is that same view.
  const deferredRecoveryRef = useRef<{ selection: unknown; envelope: unknown } | null>(null);
  const applyRecovery = useCallback(
    (snapshot: { selection: unknown; envelope: unknown }) => {
      const raw = snapshot.selection;
      if (
        typeof raw !== "object" ||
        raw === null ||
        !("presentationId" in raw) ||
        typeof raw.presentationId !== "string"
      )
        return;
      const projection = projectEnvelope(snapshot.envelope);
      if (!projection.ok) return;
      const projected = projectedModel(projection);
      const viewId = projection.view.viewId;
      const reader = raw.presentationId === `reader:${viewId}`;
      const agent = agentMessageRef.current === null ? null : agentTarget(agentMessageRef.current);
      if (
        !reader &&
        (agent === null ||
          agent.presentationId !== raw.presentationId ||
          agent.viewId !== viewId ||
          revisionOf(agentMessageRef.current?.envelope) !== projection.view.revision)
      )
        return;
      const restored = recoveredSelection(
        raw,
        { viewId, revision: projection.view.revision, presentationId: raw.presentationId },
        selectableIds(projected),
      );
      if (restored === null) return;
      if (reader) {
        presentationOriginRef.current = "local";
        setBrowsedViewId(viewId);
        setContentsOpen(false);
        setBrowsedFolder(null);
        setSearchState(null);
        handlePresent({
          type: "present",
          envelope: snapshot.envelope,
          presentation: readerPresentation(viewId),
          diagnostics: [],
        });
      }
      restoredSelectionRef.current = restored;
      dispatchSelection({ type: "restore", state: restored });
    },
    [handlePresent],
  );
  const handleRecovery = useCallback(
    (snapshot: { selection: unknown; envelope: unknown }) => {
      if (readerInteractedRef.current) return;
      // The page's address names a place (a diagram, a note, a folder): the project's remembered view is another
      // reader's last page, so it is never drawn first (nor its emphasis, walkthroughs or threads read). The address
      // effect applies it if the address turns out to be that view.
      const address = readLocationAddress({ views: viewsRef.current, notes: [] });
      if (address !== null) {
        const raw = snapshot.selection;
        const remembered = typeof raw === "object" && raw !== null && "viewId" in raw ? raw.viewId : undefined;
        if (address.kind !== "view" || address.viewId !== remembered) {
          deferredRecoveryRef.current = snapshot;
          return;
        }
      }
      applyRecovery(snapshot);
    },
    [applyRecovery],
  );

  // Connect to the host bridge once on mount.
  useEffect(() => {
    const bridge = connectBridge({
      onPresent: handleAgentPresent,
      onRecovery: handleRecovery,
      onClear: handleClear,
      onInventory: handleInventory,
      onInventoryError: handleInventoryError,
      onBootstrapError: handleBootstrapError,
      onConnection: handleConnection,
      onEmphasis: handleEmphasis,
      onCompileStatus: handleCompileStatus,
      onCapabilities: handleCapabilities,
      onComments: handleComments,
      onNotes: handleNotes,
      onWalkthroughs: handleWalkthroughs,
      onDocuments: () => setCommentActivityRefresh((value) => value + 1),
      onChange: handleChange,
      viewOnScreen,
    });
    bridgeRef.current = bridge;
    return () => {
      bridge.disconnect();
      bridgeRef.current = null;
    };
  }, [
    handleAgentPresent,
    handleRecovery,
    handleClear,
    handleInventory,
    handleInventoryError,
    handleBootstrapError,
    handleConnection,
    handleEmphasis,
    handleCompileStatus,
    handleCapabilities,
    handleComments,
    handleNotes,
    handleWalkthroughs,
    handleChange,
    viewOnScreen,
  ]);

  const reviewCapabilities = capabilities;
  const { notes: contentsNotes, loaded: contentsNotesLoaded } = useContentsNotes(
    useMemo(() => views.map((view) => view.id), [views]),
    reviewCapabilities.notes,
    reviewEvents,
  );
  const pendingAddress =
    !projectLinkConsumed.current && !readerInteractedRef.current ? readLocationAddress({ views, notes: [] }) : null;
  // A note on screen, or the note the address names while the page opens it (until the listing shows it is not
  // there): the agent's presented view is not on screen, so nothing is read for it (known failure O7).
  const noteOpening =
    pendingAddress?.kind === "note" &&
    reviewCapabilities.notes &&
    (!contentsNotesLoaded || contentsNotes.some((note) => note.path === pendingAddress.path));
  const noteOnScreen = selectedNotePath !== null || noteOpening;

  // Compute (or reuse) layout whenever the presentation state changes; not behind the editor's own route.
  useStageLayout(diagramStage, typeface, nestedViewAllowed, !editingRoute);

  /**
   * Publish the reader's selection, on whichever view they have on screen.
   *
   * It is stamped with the view it was made on and that view's revision, and
   * with what it was made under: the agent's presentation id, or
   * `reader:<viewId>` on a tab the reader picked (ADR 0011). The server holds
   * each to its own model, so the agent is never told a selection is on a
   * diagram it is not on.
   *
   * WHERE THE READER IS travels the same way. Turning to a tab of their own,
   * or back to the agent's presentation, publishes the EMPTY selection that
   * turn starts with: it replaces what they had selected on the view they
   * left, which would otherwise go on looking current, and its stamp is how
   * the server knows which view they are on. A page turn the agent caused
   * publishes nothing, because the server already retired the selection when
   * it presented.
   *
   * NOTHING IS PUBLISHED BECAUSE THE PAGE OPENED (ruling 2026-11-03):
   * opening on a view's address is not the reader turning to it, and a
   * selection restored from the server is one it already holds. Until the
   * person selects or turns, an agent's presentation context has no selection.
   */
  useEffect(() => {
    if (selection === null || selection === restoredSelectionRef.current) {
      return;
    }
    const onReaderView = presentationOriginRef.current === "local" && readerTurnedRef.current;
    const announcing = announceTurnRef.current;
    if (selection.selectionRevision === 0 && !onReaderView && !announcing) {
      return;
    }
    const projected = projectedRef.current;
    if (projected === null || projected.view.viewId !== selection.viewId) {
      return;
    }
    announceTurnRef.current = false;

    // One published shape for both canvases. A sequence view's participants
    // are its nodes and its messages are its edges (`sequence-selection.ts`),
    // so the host receives a `SelectionContext` it already knows how to store.
    const { nodeDetails, edgeDetails } = selectionDetails(projected);
    const context = buildSelectionContext(selection, nodeDetails, edgeDetails);
    bridgeRef.current?.setSelection(context);
  }, [selection, republish]);

  // A press on an element: on a walkthrough's path it jumps to the step, off it leaves (D4; set where the mode is held).
  const modePressRef = useRef<
    (ids: { readonly nodeIds: readonly string[]; readonly edgeIds: readonly string[] }, selects: boolean) => void
  >(() => undefined);
  const {
    handleMarqueeChange,
    handleNodeClick,
    handleEdgeClick,
    handleElementPress,
    handleMarqueeStart,
    handleMarqueeEnd,
    handleClearSelection,
    handleNestMode,
    openContainers,
    canvasNesting,
  } = useStageGestures(diagramStage, {
    typeface,
    onPress: (ids, selects) => {
      modePressRef.current(ids, selects);
    },
    onInteract: () => {
      readerInteractedRef.current = true;
    },
  });

  // Picking a chip is the user choosing which of the agent's stored claims to
  // look at. It publishes nothing: the list stays the agent's.
  const handleSelectEmphasis = useCallback((id: string) => {
    dispatchEmphasis({ type: "select", id });
  }, []);

  const hasSelection =
    selection !== null && (selection.selectedNodeIds.length > 0 || selection.selectedEdgeIds.length > 0);

  // What the page can honestly say right now. A notice REPLACES the canvas:
  // the states it names are all states in which showing a canvas would assert
  // something untrue, including an unregistered view whose last render is
  // still in hand.
  //
  // Computed HERE, above the key bindings, because it is part of their
  // contract: see the guard in the handler below.
  const pickedUndrawn = pickedUndrawnViewId === null ? undefined : failureFor(compileFailures, pickedUndrawnViewId);
  // Still nothing to draw for the view the reader picked.
  const pickedStillUndrawn = pickedUndrawn !== undefined && pickedUndrawn.lastValidRevision === null;
  const hasDrawing = stageHasDrawing(canvasState);
  const notice = pageNotice({
    mode: "web",
    connection,
    heardFromHost,
    bootstrapFailed,
    inventory: inventoryStatus,
    views,
    presentedViewId: presentation === null ? null : presentation.viewId,
    hasDrawing,
    hasCanvasError: canvasState.status === "error",
    presentedWasRegistered: presentation !== null && registeredEverRef.current.has(presentation.viewId),
    // Until the view is drawn, not merely until it compiles: between the two
    // is a fetch, and dropping the notice for that moment would flash the
    // previous view under the tab the reader just picked.
    pickedViewNeverCompiled: pickedUndrawnViewId !== null,
  });

  /*
   * THE CONTENTS PAGE (phase3-front-door.md) is what the web shell shows when
   * nothing is presented or picked -- in place of "Select a diagram to view."
   * and "No diagrams yet.", which it says better -- and when the reader asks
   * for it from a diagram. Still no diagram is picked on the reader's behalf:
   * it lists them. Never over a notice that a drawing would be false under
   * (lost, loading, unreadable), which say what is true instead.
   */
  // Not while a diagram the page asked for is on its way (requestedViewId): "nothing presented" is no longer true (PF-6).
  const contentsNotice =
    notice !== null && (notice.kind === "none-presented" || notice.kind === "no-diagrams") && requestedViewId === null;
  const searchShown = selectedNotePath === null && searchState !== null;
  const folderShown = selectedNotePath === null && !searchShown && browsedFolder !== null;
  // The address names a listed view the page is about to open: the overview is not shown for a frame first (PF-6:
  // its title section came and went, and the header and the drawing's row moved with it).
  const addressOpensView =
    pendingAddress?.kind === "file" ||
    (pendingAddress?.kind === "view" && views.some((view) => view.id === pendingAddress.viewId)) ||
    // A note's address, likewise, until the listing shows the note is not there (the overview flashed for a frame).
    (pendingAddress?.kind === "note" && (!capabilitiesKnown || noteOpening));
  const overviewShown =
    selectedNotePath === null &&
    !folderShown &&
    !searchShown &&
    !addressOpensView &&
    (contentsNotice ||
      (contentsOpen &&
        inventoryStatus === "loaded" &&
        // The reader asked for the project page: what the drawing would be (still loading, failed) is no reason to refuse it.
        (notice === null ||
          notice.kind === "unregistered" ||
          notice.kind === "never-compiled" ||
          notice.kind === "loading" ||
          notice.kind === "presentation-failed")));
  // A page of the project rather than a drawing: the overview, a folder of it, or the search page.
  const contentsShown = overviewShown || folderShown || searchShown;
  // A server that speaks phase 3 says which group each view is in.
  const phase3 = views.some((view) => view.group !== undefined);
  const goToContents = useCallback(() => {
    readerNavigates();
    const slug = projectSlugFromPath(window.location.pathname);
    setContentsOpen(slug === null);
    setBrowsedFolder(null);
    setSearchState(slug === null ? null : browserNavigationState(slug, null, searchState ?? EMPTY_SEARCH));
    setSelectedNotePath(null);
  }, [readerNavigates, searchState]);
  const goToFolder = useCallback(
    (path: string) => {
      readerNavigates();
      setSelectedNotePath(null);
      setSearchState(
        browserNavigationState(projectSlugFromPath(window.location.pathname), path, searchState ?? EMPTY_SEARCH),
      );
      setBrowsedFolder(null);
    },
    [readerNavigates, searchState],
  );
  /** The reader going to the search page; `focus` puts the caret in its box. */
  const goToSearch = useCallback(
    (state?: SearchState, focus = true) => {
      // The project page is already the file browser. Asking to search there
      // puts the caret in its existing field without resetting its scope.
      if (state === undefined && (overviewShown || searchShown) && searchInputRef.current !== null) {
        if (focus) searchInputRef.current.focus();
        return;
      }
      readerNavigates();
      setSelectedNotePath(null);
      setContentsOpen(false);
      setBrowsedFolder(null);
      setSearchState(state ?? EMPTY_SEARCH);
      focusSearchRef.current = focus;
      if (focus) searchInputRef.current?.focus();
    },
    [readerNavigates, overviewShown, searchShown],
  );
  /** A change made on the search page: the same entry, written in place. */
  const changeSearch = useCallback(
    (state: SearchState) => {
      const route = readLocationRoute(window.location.pathname);
      if (
        route !== null &&
        route.kind !== "projects" &&
        route.kind !== "follow" &&
        (state.projects.length !== 1 || state.projects[0] !== route.projectSlug)
      ) {
        saveBrowserPosition();
        window.location.assign(searchPageHref(window.location.href, state));
        return;
      }
      const replacing = browserInteractionRef.current === "query" && browserTypingRef.current;
      readerNavigates();
      browserTypingRef.current = browserInteractionRef.current === "query";
      addressIntentRef.current = replacing ? "replace" : "push";
      setContentsOpen(false);
      setSearchState(state);
    },
    [readerNavigates],
  );
  /*
   * THE PAGE'S ADDRESS (`page-address.ts`) says where the page is -- a
   * diagram (`?view=`, a note's diagram by its address), a note (`?note=`), a
   * folder (`?folder=`), the overview (`?overview=1`) -- so a reload or a
   * shared link opens it. One rule writes it, whatever the page went there
   * from (Projects & files, the contents, a folder, the breadcrumb, a tab or
   * `[`/`]`, a search match, a link or a diagram in a note, a comment):
   *
   * - the READER going somewhere is a new history entry (`pushState`), so
   *   Back and Forward walk the places they went;
   * - the AGENT presenting replaces the entry (`replaceState`): the page
   *   follows it, but the reader went nowhere, and Back is not theirs to spend
   *   on it;
   * - Back and Forward show the place the entry names (`popstate` below), and
   *   write nothing of their own.
   *
   * The address follows what is ON SCREEN, so a diagram still loading is
   * written when it lands, and one that never does is never claimed; a step
   * on the way (the drawing left behind for a moment) is overwritten by where
   * the page lands, in the same entry. Until something navigates, the address
   * the page loaded with stands: a bare one keeps following the agent, and
   * one naming a place is read by the project link below.
   */
  const shownViewId = pickedUndrawnViewId ?? (presentation === null ? null : presentation.viewId);
  const shownAddress: PageAddress | null =
    searchShown && searchState !== null
      ? { kind: "search", state: searchState }
      : folderShown
        ? browsedFolder?.path == null
          ? null
          : { kind: "folder", path: browsedFolder.path }
        : selectedNotePath !== null
          ? { kind: "note", path: selectedNotePath }
          : // The overview the reader asked for (`contentsOpen`), not the one shown
            // while nothing is presented or a diagram they opened is still loading.
            overviewShown
            ? contentsOpen
              ? { kind: "overview" }
              : null
            : shownViewId === null
              ? null
              : { kind: "view", viewId: shownViewId };
  const shownAddressKey = addressKey(shownAddress);
  const shownAddressRef = useRef(shownAddress);
  shownAddressRef.current = shownAddress;
  useEffect(() => {
    if (editingRoute) return;
    const shown = shownAddressRef.current;
    const intent = addressIntentRef.current;
    if (shown === null || intent === null || sameAddress(shown, readLocationAddress(pageFilesRef.current))) return;
    const href = withPageAddress(window.location.href, shown, pageFilesRef.current);
    if (intent === "push") {
      window.history.pushState(null, "", href);
      // Where this navigation goes next -- the diagram landing -- is the same entry.
      addressIntentRef.current = "replace";
    } else window.history.replaceState(null, "", href);
  }, [shownAddressKey]);
  const followHistoryRef = useRef<() => void>(() => {});
  /** Back or Forward named a file before the project's listing was in (O192): followed once it is. */
  const historyWaitsRef = useRef(false);
  const inventoryStatusRef = useRef(inventoryStatus);
  inventoryStatusRef.current = inventoryStatus;
  followHistoryRef.current = () => {
    // A file the listing is still loading for cannot be named yet (O192, codex-1303): the entry is followed when the
    // listing is in (below), rather than given up on, which left the project home on screen at the diagram's address.
    historyWaitsRef.current = false;
    if (inventoryStatusRef.current !== "loaded" && readLocationAddress(pageFilesRef.current)?.kind === "file") {
      historyWaitsRef.current = true;
      return;
    }
    // A Fit queued where the person was is not for where Back or Forward goes; a diagram there names itself (O59).
    fitOpens(null);
    setHistoryRevision((revision) => revision + 1);
    browserTypingRef.current = false;
    readerInteractedRef.current = true;
    const address = readLocationAddress(pageFilesRef.current);
    if (address === null) {
      // The entry the page opened on, bare: what the agent presents.
      setSelectedNotePath(null);
      setContentsOpen(false);
      setBrowsedFolder(null);
      setSearchState(null);
      if (presentationOriginRef.current === "local" || pickedUndrawnRef.current !== null) handleReturnToAgent();
      addressIntentRef.current = null;
      return;
    }
    if (address.kind === "view") showView(address.viewId);
    else if (address.kind === "note") showNoteAgain(address.path);
    else if (address.kind === "folder") {
      setSelectedNotePath(null);
      setContentsOpen(false);
      setSearchState(
        address.path === null
          ? null
          : browserNavigationState(projectSlugFromPath(window.location.pathname), address.path, EMPTY_SEARCH),
      );
      setBrowsedFolder(address.path === null ? { path: null } : null);
    } else if (address.kind === "search") {
      setSelectedNotePath(null);
      setContentsOpen(false);
      setBrowsedFolder(null);
      setSearchState(address.state);
    }
    // A file the page cannot name (moved, or its listing not loaded): nothing to show in its place.
    else if (address.kind === "file") return;
    else {
      setSelectedNotePath(null);
      setBrowsedFolder(null);
      setSearchState(null);
      setContentsOpen(true);
    }
    addressIntentRef.current = "replace";
  };
  useEffect(() => {
    const followed = (): void => followHistoryRef.current();
    window.addEventListener("popstate", followed);
    return () => window.removeEventListener("popstate", followed);
  }, []);
  useEffect(() => {
    if (inventoryStatus === "loaded" && historyWaitsRef.current) followHistoryRef.current();
  }, [inventoryStatus]);
  // The search page's box takes the focus when the reader asked for the page.
  useEffect(() => {
    if (!searchShown || !focusSearchRef.current) return;
    focusSearchRef.current = false;
    searchInputRef.current?.focus();
  }, [searchShown]);
  // "2 min ago" moves on by itself, on a page with something to date.
  const now = useNow(phase3);

  /*
   * THE CHANGE PULSE. The view on screen, with an agent's change the reader
   * has not been shown, pulses once -- when the change arrives with the view
   * on screen, or when the reader opens a view changed while they were away.
   * It waits for the drawing to hold the changed model: the `change` event and
   * the redraw arrive separately, and a pulse on the old drawing would point
   * at elements that are not there yet.
   */
  const onScreenViewId =
    contentsShown || notice !== null || !hasDrawing
      ? null
      : (pickedUndrawnViewId ?? (presentation === null ? null : presentation.viewId));
  const onScreenChange = onScreenViewId === null ? undefined : changes.get(onScreenViewId);
  useEffect(() => {
    if (onScreenChange === undefined) return;
    const key = `${onScreenChange.viewId}@${onScreenChange.at}`;
    if (pulsedRef.current.has(key)) return;
    pulsedRef.current.add(key);
    setPulse((held) => ({
      viewId: onScreenChange.viewId,
      round: (held?.round ?? 0) + 1,
      waiting: true,
      ...(presentationRef.current?.revision === undefined ? {} : { revision: presentationRef.current.revision }),
    }));
  }, [onScreenChange]);
  const drawnRevision = presentation?.revision;
  useEffect(() => {
    if (pulse === null || !pulse.waiting || onScreenChange === undefined || pulse.viewId !== onScreenChange.viewId)
      return;
    const model = projectedRef.current;
    const { nodeIds, edgeIds } = model === null ? { nodeIds: [], edgeIds: [] } : selectableIds(model);
    const known = new Set([...nodeIds, ...edgeIds]);
    const redrawn = drawnRevision !== pulse.revision || onScreenChange.added.every((id) => known.has(id));
    const start = (): void =>
      setPulse((held) => (held === null || held.round !== pulse.round ? held : { ...held, waiting: false }));
    if (redrawn) {
      start();
      return;
    }
    // A change whose ids this page cannot place (a group, a fragment) is shown
    // all the same, once the redraw has had its moment.
    const timer = window.setTimeout(start, 1500);
    return () => window.clearTimeout(timer);
  }, [pulse, onScreenChange, drawnRevision, canvasState]);
  const showChanges = useCallback(() => {
    setPulse((held) => (held === null ? held : { ...held, round: held.round + 1, waiting: false }));
  }, []);
  const dismissChange = useCallback((viewId: string) => {
    setChanges((held) => {
      const next = new Map(held);
      next.delete(viewId);
      return next;
    });
  }, []);

  /*
   * COMMENTS AND NOTES (`comments/`, ticket 08 and 09): only for what the
   * server says it supports.
   *
   * About the view on screen, whoever put it there -- the agent's
   * presentation or a tab the reader picked -- and also about a picked view
   * that has never compiled: there is no drawing to point into, but the
   * diagram as a whole can still be talked about.
   */
  const reviewEnabled = reviewCapabilities.comments || reviewCapabilities.notes;
  const reviewCandidate = pickedUndrawnViewId ?? (presentation === null ? null : presentation.viewId);
  // The page's own address names a diagram it has not opened yet (it does once the listing is in): until then the
  // agent's presentation on screen is not what the reader came for, and its threads and notes are not read only to
  // be replaced a moment later (perf #10). Nor while a note is on screen or opening (`noteOnScreen`).
  const addressWaits =
    pendingAddress !== null &&
    (pendingAddress.kind === "file"
      ? inventoryStatus !== "loaded"
      : pendingAddress.kind === "view" &&
        pendingAddress.viewId !== reviewCandidate &&
        (inventoryStatus !== "loaded" || views.some((view) => view.id === pendingAddress.viewId)));
  // Until the page applies its address, the project browser already shows the scope the address names (its
  // project), not every project: nothing is asked about projects it will not show (perf #7).
  // A page addressed to a file (a diagram or note, or the editor) scopes it to this project too, while the
  // file loads and after it.
  const fileRouteKind = readLocationRoute(window.location.pathname)?.kind;
  const addressSearchState =
    pendingAddress?.kind === "search"
      ? pendingAddress.state
      : fileRouteKind === "file" || fileRouteKind === "view" || fileRouteKind === "note" || fileRouteKind === "edit"
        ? browserNavigationState(projectSlugFromPath(window.location.pathname), null, EMPTY_SEARCH)
        : null;
  /*
   * THE VIEW ON STAGE: the one whose drawing (or never-compiled notice) is on screen. Every per-view read and effect
   * -- its emphasis, threads, notes, walkthroughs, and the stream's re-read of them -- is for it alone (G1, PF-1).
   * None on the project's lists, a folder or search page, a note or the note the address is opening (known failure
   * O7), a missing view's notice, the new-draft editor, while the page's own address names a place it has not
   * opened yet, or while a view the reader asked for is on its way (the drawing still up is the one being left). A presentation held behind any of those is not on screen, so nothing is read for it.
   */
  const leaving = requestedViewId !== null && requestedViewId !== reviewCandidate;
  const viewOnStage =
    contentsShown || noteOnScreen || missingView !== null || editingRoute || addressWaits || leaving
      ? null
      : reviewCandidate;
  const reviewViewId =
    reviewEnabled && viewOnStage !== null && views.some((view) => view.id === viewOnStage) ? viewOnStage : null;
  /**
   * Emphasis follows the view, and is read fresh for each one.
   *
   * The stream carries DELTAS and sends nothing on connect, so a page that
   * joins after the agent published would show no emphasis until the agent
   * happened to publish again. Nothing carries over from the previous view
   * either: an emphasis names ids in the diagram it was published against, and
   * those ids mean nothing in another one.
   *
   * This is the read for a view the page has just turned to. The list of the
   * view ALREADY on screen is read again by the bridge whenever its stream
   * opens (`viewOnScreen`), since an emphasis set or cleared while the stream
   * was down is announced to nobody. Both are for the drawing on stage only
   * (`viewOnStage`), never for a presentation held behind a list or a note.
   */
  const presentedViewId = viewOnStage !== null && viewOnStage === presentation?.viewId ? viewOnStage : null;
  viewOnStageRef.current = presentedViewId;
  useEffect(() => {
    dispatchEmphasis({ type: "view_change", viewId: presentedViewId });
    if (presentedViewId === null) return;
    // The address names this view and one of its emphases (`?emphasis=`, the link present_diagram returns): that one.
    const addressed = readLocationAddress(pageFilesRef.current);
    const prefer =
      addressed?.kind === "view" && addressed.viewId === presentedViewId
        ? (new URLSearchParams(window.location.search).get("emphasis") ?? undefined)
        : undefined;
    let cancelled = false;
    void bridgeRef.current
      ?.fetchEmphasis(presentedViewId)
      .then((payload) => {
        // `null`: an event for this view arrived while the read was out, and is newer.
        const snapshot = parseEmphasisSnapshot(payload);
        if (cancelled || snapshot === undefined) {
          return;
        }
        dispatchEmphasis({ type: "publish", snapshot, ...(prefer === undefined ? {} : { prefer }) });
      })
      .catch((error: unknown) => {
        // Cancelled: the page turned away or left the project, whose bridge aborted the read (O211). Not a failure.
        if (cancelled) return;
        // Emphasis is an addition to the diagram, not a precondition for it.
        console.error(`[archer] loading emphasis for ${presentedViewId} failed`, error);
      });
    return () => {
      cancelled = true;
    };
  }, [presentedViewId]);

  const viewTitle = useCallback((viewId: string) => viewsRef.current.find((v) => v.id === viewId)?.title ?? viewId, []);
  pageFilesRef.current = { views, notes: contentsNotes };
  useEffect(() => {
    if (inventoryStatus !== "loaded" || projectLinkConsumed.current || bridgeRef.current === null) return;
    if (readerInteractedRef.current) {
      projectLinkConsumed.current = true;
      return;
    }
    const legacy = readLocationAddress(pageFilesRef.current);
    let initial = legacy;
    // A legacy query destination on the clean follow address is replaced by its canonical address,
    // and the page opens what that address names (`?overview=1` is the project browser there).
    if (
      legacy !== null &&
      readLocationRoute(window.location.pathname, window.location.search)?.kind === "follow" &&
      (legacy.kind !== "view" || views.some((candidate) => candidate.id === legacy.viewId)) &&
      (legacy.kind !== "note" || contentsNotes.some((candidate) => candidate.path === legacy.path)) &&
      (legacy.kind !== "folder" || legacy.path !== null)
    ) {
      const placed = withPageAddress(window.location.href, legacy, pageFilesRef.current),
        thread = readThreadAddress(window.location.search);
      // The thread a legacy link opens rides along to the canonical address.
      const canonical = thread === null ? placed : (withThreadAddress(placed, thread) ?? placed);
      // A place in another project (or all of them) is that page's to open, not this one's to rename.
      if (projectSlugFromPath(new URL(canonical).pathname) !== projectSlugFromPath(window.location.pathname)) {
        projectLinkConsumed.current = true;
        window.location.replace(canonical);
        return;
      }
      window.history.replaceState(window.history.state, "", canonical);
      initial = readLocationAddress(pageFilesRef.current);
    }
    const query = new URLSearchParams(window.location.search);
    const view = initial?.kind === "view" ? initial.viewId : query.get("view"),
      note = initial?.kind === "note" ? initial.path : query.get("note");
    const remembered = deferredRecoveryRef.current;
    deferredRecoveryRef.current = null;
    if (view !== null) {
      projectLinkConsumed.current = true;
      // The remembered selection comes back only on its own view (a reload of the same diagram).
      if (remembered !== null && !readerInteractedRef.current) {
        const raw = remembered.selection;
        if (typeof raw === "object" && raw !== null && "viewId" in raw && raw.viewId === view)
          applyRecovery(remembered);
      }
      // The drawing's place, not the overview, while it loads (PF-6).
      if (views.some((candidate) => candidate.id === view)) {
        setContentsOpen(false);
        pageOpeningRef.current = true;
        try {
          showView(view);
        } finally {
          pageOpeningRef.current = false;
        }
      }
      // A link naming no diagram says so, instead of leaving another diagram (and its Edit button) on screen.
      else if (!view.includes("#")) setMissingView(view);
    } else if (note !== null) {
      if (!contentsNotes.some((candidate) => candidate.path === note)) return;
      projectLinkConsumed.current = true;
      readerInteractedRef.current = true;
      setSelectedNotePath(note);
      setContentsOpen(false);
      setBrowsedFolder(null);
      setSearchState(null);
    } else if (initial?.kind === "folder") {
      projectLinkConsumed.current = true;
      readerInteractedRef.current = true;
      setSelectedNotePath(null);
      setContentsOpen(false);
      setSearchState(
        initial.path === null
          ? null
          : browserNavigationState(projectSlugFromPath(window.location.pathname), initial.path, EMPTY_SEARCH),
      );
      setBrowsedFolder(initial.path === null ? { path: null } : null);
    } else if (initial?.kind === "search") {
      projectLinkConsumed.current = true;
      readerInteractedRef.current = true;
      setSelectedNotePath(null);
      setContentsOpen(false);
      setBrowsedFolder(null);
      setSearchState(initial.state);
    } else if (query.get("overview") === "1") {
      projectLinkConsumed.current = true;
      readerInteractedRef.current = true;
      setContentsOpen(true);
      setBrowsedFolder(null);
      setSearchState(null);
      setSelectedNotePath(null);
    } else projectLinkConsumed.current = true;
  }, [inventoryStatus, views, contentsNotes, showView, applyRecovery]);
  /*
   * RECENT FILES AND PROJECTS (`recents.ts`): whatever the page shows -- a
   * diagram, a note, the project page -- is remembered, newest first, for the
   * sidebar. Per viewer, in this browser.
   */
  const recents = useRecents();
  const rememberRecent = recents.remember;
  const placeSlug = projectSlugFromPath(window.location.pathname) ?? "";
  const placeName = capabilities.projectName ?? projectNameFromPath(window.location.pathname) ?? "This project";
  const navigationPlace: NavigationPlace = projectNavigationPlace(shownAddress, placeSlug, projectExpansion?.slug);
  const rememberedCatalog = rememberedProjectCatalog(browserFetch);
  const visitedProjectName =
    navigationPlace === null || navigationPlace.slug === placeSlug
      ? placeName
      : rememberedCatalog?.status === "ready"
        ? (rememberedCatalog.projects.find((project) => project.slug === navigationPlace.slug)?.name ??
          navigationPlace.slug)
        : navigationPlace.slug;
  const placeTitle =
    navigationPlace === null
      ? null
      : navigationPlace.kind === "view"
        ? (views.find((view) => view.id === navigationPlace.id)?.title ?? null)
        : navigationPlace.kind === "note"
          ? (contentsNotes.find((note) => note.path === navigationPlace.id)?.title ?? null)
          : visitedProjectName;
  const placeKey =
    navigationPlace === null || placeTitle === null
      ? ""
      : `${navigationPlace.slug}\0${navigationPlace.kind}\0${navigationPlace.id}\0${placeTitle}`;
  useEffect(() => {
    if (navigationPlace === null || placeTitle === null) return;
    rememberRecent({
      slug: navigationPlace.slug,
      projectName: visitedProjectName,
      kind: navigationPlace.kind,
      id: navigationPlace.id,
      title: placeTitle,
    });
    // Named by `placeKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeKey, rememberRecent]);
  // The project's own conversation is tracked too, so the agent's reply reaches the open chat as it does a diagram's.
  const reviewTargets = useMemo(
    () => [
      ...views.map((view) => viewTarget(view.id)),
      ...contentsNotes.map((note) => `note:${note.path}` as TargetRef),
      PROJECT_TARGET,
    ],
    [views, contentsNotes],
  );
  const projectTitle = capabilities.projectName ?? projectNameFromPath(window.location.pathname) ?? "This project";
  const reviewTargetTitle = useCallback(
    (target: TargetRef): string =>
      onTarget(target, {
        view: ({ viewId }) => viewTitle(viewId),
        note: ({ path }) => contentsNotes.find((note) => note.path === path)?.title ?? path,
        project: () => projectTitle,
      }),
    [contentsNotes, viewTitle, projectTitle],
  );
  const review = useReview({
    projectIdentity: projectSlugFromPath(window.location.pathname),
    transport: commentsTransport,
    capabilities: reviewCapabilities,
    viewId: reviewViewId,
    events: reviewEvents,
    viewTitle,
    projectTitle,
    targets: reviewCapabilities.comments ? reviewTargets : [],
  });
  const reviewViewThreads = reviewViewId === null ? undefined : review.threads.get(viewTarget(reviewViewId));
  // The threads' pins. Memoised like `canvasSelection`: the canvas memoises its nodes on it.
  const commented = useMemo(
    () =>
      reviewViewThreads === undefined || reviewViewThreads.length === 0 ? undefined : commentPins(reviewViewThreads),
    [reviewViewThreads],
  );
  // What the drawing on screen is, for anchoring: the model the canvas drew.
  const drawn =
    hasDrawing && notice === null && projectedRef.current !== null && projectedRef.current.view.viewId === reviewViewId
      ? projectedRef.current
      : null;
  const selectedNodeIds = selection?.selectedNodeIds ?? EMPTY_IDS;
  const selectedEdgeIds = selection?.selectedEdgeIds ?? EMPTY_IDS;
  const choices = useMemo(
    () => diagramChoices(drawn, selectedNodeIds, selectedEdgeIds),
    [drawn, selectedNodeIds, selectedEdgeIds],
  );
  const composeKeyRef = useRef(0);
  const openComposer = useCallback((target: TargetRef, anchor: Anchor) => {
    composeKeyRef.current += 1;
    setCompose({ key: composeKeyRef.current, target, anchor });
  }, []);
  const closeComposer = useCallback(() => setCompose(null), []);
  // A composer for a view that has left the screen is about nothing on it.
  useEffect(() => {
    setCompose((held) =>
      held !== null &&
      targetParts(held.target).kind === "view" &&
      held.target !== (reviewViewId === null ? null : viewTarget(reviewViewId))
        ? null
        : held,
    );
  }, [reviewViewId]);
  // A comment left unsent on this document (a reload, a reopened tab, an earlier Escape) comes back in its composer,
  // said as restored, once per document per page (comment-draft.ts; user-flows G1, review flows-r1 claude-01).
  const offeredCommentDrafts = useRef(new Set<TargetRef>());
  const offeredReplyDrafts = useRef(new Set<TargetRef>());
  const draftTarget: TargetRef | null =
    !reviewCapabilities.comments || editingRoute
      ? null
      : selectedNotePath !== null
        ? `note:${selectedNotePath}`
        : reviewViewId !== null && drawn !== null
          ? viewTarget(reviewViewId)
          : null;
  useEffect(() => {
    if (draftTarget === null || compose !== null || offeredCommentDrafts.current.has(draftTarget)) return;
    // This tab's own draft first (claude-404): its comment, else its reply or edit (opened below), else another tab's comment.
    const held = draftToOpen(browserDraftStorage(), commentDraftScope(), draftTarget, review.threads.get(draftTarget));
    if (held === "wait") return;
    offeredCommentDrafts.current.add(draftTarget);
    if (held !== null && held.kind === "comment") {
      // The new comment comes back first; a kept reply on this document waits until the next visit.
      offeredReplyDrafts.current.add(draftTarget);
      openComposer(draftTarget, held.anchor);
    }
  }, [draftTarget, compose, openComposer, review.threads]);
  // A restored comment's element the agent has since renamed or removed: the composer says so (claude-205).
  const composeAnchorGone = useMemo(
    () =>
      compose !== null && reviewViewId !== null && compose.target === viewTarget(reviewViewId) && drawn !== null
        ? (anchor: Anchor) => anchorMissing(drawn, anchor)
        : undefined,
    [compose, reviewViewId, drawn],
  );
  const composeRevision =
    compose !== null && reviewViewId !== null && compose.target === viewTarget(reviewViewId)
      ? (drawn?.view.revision ?? views.find((view) => view.id === reviewViewId)?.modelRevision ?? null)
      : null;
  // Where a comment says it was seen (ADR 0034 §9; set where the walkthroughs are read, below): the step on show while a
  // walkthrough is open, and nothing selected is about the walkthrough; just after a click off its path, that step, for
  // a comment about what the click left selected. Every way a comment starts (C, right-click, New comment) goes through it.
  const placeAnchorRef = useRef<(anchor: Anchor) => Anchor>((anchor) => anchor);
  const commentOnSelection = useLatestCallback(() => {
    if (reviewViewId === null) return;
    // One part of a frame Expand added: the comment is its source's (ADR 0036 A10).
    const only =
      selectedNodeIds.length + selectedEdgeIds.length === 1 ? (selectedNodeIds[0] ?? selectedEdgeIds[0]!) : null;
    const part = only === null ? null : (expandRef.current?.partOf(only) ?? null);
    if (part !== null && only !== null) {
      composeKeyRef.current += 1;
      setCompose({
        key: composeKeyRef.current,
        target: viewTarget(part.source),
        anchor: { kind: part.kind, id: part.id, label: part.label },
        placeAt: only,
      });
      return;
    }
    const anchor =
      drawn === null ? ({ kind: "view" } as const) : selectionAnchor(drawn, selectedNodeIds, selectedEdgeIds);
    openComposer(viewTarget(reviewViewId), placeAnchorRef.current(anchor));
  });
  // THE CHAT BUBBLE (ADR 0034 §10, slice 10). `C` with nothing selected asks it open instead of starting a
  // whole-document composer. This block, the `openChat` calls in the `C` handler, `chatHost` and the
  // `<ChatBubble>` mount are all of its routing in this file.
  // The project, a folder of it and search have no document: the bubble is the project's conversation there.
  // A runtime with no service offers it with example conversations instead (`runtime.examples`, read-only).
  const chatOffered = runtime.features.chat || runtime.examples !== undefined;
  const projectChat = chatOffered && contentsShown && projectSlugFromPath(window.location.pathname) !== null;
  const chatShown =
    chatOffered &&
    !editingRoute &&
    reviewCapabilities.comments &&
    (projectChat || (!contentsShown && (selectedNotePath !== null || reviewViewId !== null)));
  const [chatAsk, setChatAsk] = useState(0);
  const [chatHost, setChatHost] = useState<HTMLElement | null>(null);
  const openChat = useCallback(() => setChatAsk((n) => n + 1), []);
  // The project conversation asked for by name (a review panel entry, the bell's link, a search match): the
  // chat opens on it, on a document's page too.
  const [projectChatAsk, setProjectChatAsk] = useState(0);
  const openProjectChat = useCallback(() => setProjectChatAsk((n) => n + 1), []);
  // One conversation surface at a time: opening the chat dismisses the floating discussion, and a discussion
  // coming up (a pin, a composer, a step's badge) closes the chat. Esc on the page closes the chat first.
  const [chatClose, setChatClose] = useState(0);
  const [discussionDismiss, setDiscussionDismiss] = useState(0);
  const chatOpenRef = useRef(false);
  const chatDrafts = useRef(new Map<string, string>());
  const onChatOpenChange = useCallback((open: boolean) => {
    chatOpenRef.current = open;
    if (open) setDiscussionDismiss((n) => n + 1);
  }, []);
  const closeChat = useCallback(() => setChatClose((n) => n + 1), []);
  const requestedAnchorTarget = useRef<TargetRef | null>(null);
  const [queuedAnchor, setQueuedAnchor] = useState<{ viewId: string; anchor: Anchor } | null>(null);
  // Sequence blocks and notes have separate comment controls, outside published selection.
  const showSequenceBlock = useCallback((id: string) => {
    document
      .querySelector<SVGElement>(
        `.archer-seq-block-header[data-seq-id="${CSS.escape(id)}"], .archer-seq-note-comment-target[data-seq-id="${CSS.escape(id)}"]`,
      )
      ?.focus({ preventScroll: true });
  }, []);
  const handleShowAnchor = useCallback(
    (anchor: Anchor) => {
      const target = requestedAnchorTarget.current;
      requestedAnchorTarget.current = null;
      const parts = target === null ? null : targetParts(target);
      // A note's anchor is shown by the note; the project conversation has nothing to show on a drawing.
      if (parts?.kind === "note" || parts?.kind === "project") return;
      if (
        parts?.kind === "view" &&
        (displayedViewIdRef.current !== parts.viewId || projectedRef.current?.view.viewId !== parts.viewId)
      ) {
        setQueuedAnchor({ viewId: parts.viewId, anchor });
        return;
      }
      const model = projectedRef.current;
      if (model === null || displayedViewIdRef.current !== model.view.viewId) return;
      if ((anchor.kind === "group" || isSequenceNoteAnchor(model, anchor)) && model.type === "sequence") {
        showSequenceBlock(anchor.id);
        return;
      }
      const ids = anchorIds(anchor, model);
      if (ids === null) return;
      const { nodeIds, edgeIds } = selectableIds(model);
      dispatchSelection({
        type: "select",
        nodeIds: ids.nodeIds.filter((id) => nodeIds.includes(id)),
        edgeIds: ids.edgeIds.filter((id) => edgeIds.includes(id)),
      });
    },
    [showSequenceBlock],
  );
  useEffect(() => {
    if (
      queuedAnchor === null ||
      displayedViewIdRef.current !== queuedAnchor.viewId ||
      projectedRef.current?.view.viewId !== queuedAnchor.viewId
    )
      return;
    if (
      (queuedAnchor.anchor.kind === "group" || isSequenceNoteAnchor(projectedRef.current, queuedAnchor.anchor)) &&
      projectedRef.current.type === "sequence"
    ) {
      showSequenceBlock(queuedAnchor.anchor.id);
      setQueuedAnchor(null);
      return;
    }
    const ids = anchorIds(queuedAnchor.anchor, projectedRef.current);
    const known = selectableIds(projectedRef.current);
    if (ids !== null)
      dispatchSelection({
        type: "select",
        nodeIds: ids.nodeIds.filter((id) => known.nodeIds.includes(id)),
        edgeIds: ids.edgeIds.filter((id) => known.edgeIds.includes(id)),
      });
    setQueuedAnchor(null);
  }, [queuedAnchor, canvasState, presentation, showSequenceBlock]);
  /*
   * A PIN PRESSED on the drawing opens its thread: the drawer opens (from the
   * rail, or over the stage on a phone), the thread is focused and marked, and
   * what it is about is selected, as its heading's own button would. Taken in
   * the capture phase and stopped there, so the canvas under the pin -- a
   * node's click, an edge's, the pane's -- never also sees the press and
   * selects only the one element under the pointer.
   */
  const threadRequestKey = useRef(0);
  const requestThread = useCallback((threadId: string) => {
    threadRequestKey.current += 1;
    setCompose(null);
    setThreadRequest({ key: threadRequestKey.current, threadId });
  }, []);
  // A frame's pin (ADR 0036 §14, ticket 14): its threads are its source view's, read when the pin is opened.
  const [framePinOpen, setFramePinOpen] = useState<{
    readonly source: string;
    readonly id: string;
    readonly key: number;
  } | null>(null);
  const openThread = useLatestCallback((threadId: string, fromPin = false) => {
    if (threadId.startsWith(FRAME_PIN)) {
      const part = expandRef.current?.partOf(threadId.slice(FRAME_PIN.length)) ?? null;
      if (part === null) return;
      review.actions.load?.(viewTarget(part.source));
      setFramePinOpen({ source: part.source, id: part.id, key: Date.now() });
      return;
    }
    const thread = reviewViewThreads?.find((t) => t.id === threadId);
    if (thread === undefined) return;
    requestThread(threadId);
    // A pressed sequence pin is already visible. Focusing its comment-only header here
    // would discard the invoking pin before the discussion takes focus.
    const commentOnly =
      drawn?.type === "sequence" && (thread.anchor.kind === "group" || isSequenceNoteAnchor(drawn, thread.anchor));
    if (thread.orphaned !== true && !(fromPin && commentOnly)) handleShowAnchor(thread.anchor);
  });
  // A reply left unsent on this document (a reload, a reopened tab, leaving it), or an unsaved edit of one of the
  // person's comments, opens its thread again, the text in its box said as restored, once per document per page
  // (comment-draft.ts; user-flows G1, O93). The later of the two is the one opened.
  const draftThreads = draftTarget === null ? undefined : review.threads.get(draftTarget);
  useEffect(() => {
    if (
      draftTarget === null ||
      draftThreads === undefined ||
      compose !== null ||
      offeredReplyDrafts.current.has(draftTarget)
    )
      return;
    offeredReplyDrafts.current.add(draftTarget);
    const scope = commentDraftScope();
    const reply = latestReplyDraft(
      browserDraftStorage(),
      scope,
      draftTarget,
      draftThreads.map((thread) => thread.id),
    );
    const edit = latestEditDraft(browserDraftStorage(), scope, draftTarget, draftThreads);
    const held =
      reply !== null && (edit === null || reply.savedAt >= edit.savedAt)
        ? { threadId: reply.threadId, key: replyDraftKey(scope, draftTarget, reply.threadId) }
        : edit === null
          ? null
          : { threadId: edit.threadId, key: editDraftKey(scope, draftTarget, edit.threadId, edit.commentId) };
    // Not one whose box is on the page and being typed in (a reply typed in the review while the diagram loads):
    // opening its thread took the focus from it (O174). Whether it is being written is asked of its editor, not of
    // when it was saved: the project page mounts again inside one document (Back past Projects and Forward), and a
    // clock can be set back, so a kept draft can postdate this page's load (O179).
    if (held === null || draftBeingWritten(held.key)) return;
    if (targetParts(draftTarget).kind === "view") openThread(held.threadId);
    else requestThread(held.threadId);
  }, [draftTarget, draftThreads, compose, openThread, requestThread]);
  const consumedThreadAddress = useRef<string | null>(null);
  useEffect(() => {
    const threadId = readThreadAddress(window.location.search);
    const address = readLocationAddress(pageFilesRef.current);
    // The project's own page with a thread of its conversation (the bell's link): the chat opens on it.
    if (threadId !== null && projectChat) {
      if (review.threads.get(PROJECT_TARGET)?.some((candidate) => candidate.id === threadId) !== true) return;
      const key = `${window.location.pathname}\0${window.location.search}`;
      if (consumedThreadAddress.current === key) return;
      consumedThreadAddress.current = key;
      openProjectChat();
      return;
    }
    if (threadId === null || (address?.kind !== "note" && address?.kind !== "view")) {
      consumedThreadAddress.current = null;
      return;
    }
    const target: TargetRef | null =
      address.kind === "note"
        ? selectedNotePath === address.path
          ? `note:${address.path}`
          : null
        : selectedNotePath === null && reviewViewId === address.viewId
          ? viewTarget(address.viewId)
          : null;
    if (target === null) return;
    const thread = review.threads
      .get(target)
      ?.find((candidate) => candidate.id === threadId && candidate.target === target);
    if (thread === undefined) return;
    const key = `${window.location.pathname}\0${window.location.search}`;
    if (consumedThreadAddress.current === key) return;
    consumedThreadAddress.current = key;
    if (address.kind === "note") requestThread(threadId);
    else openThread(threadId);
  }, [
    selectedNotePath,
    reviewViewId,
    review.threads,
    requestThread,
    openThread,
    historyRevision,
    projectChat,
    openProjectChat,
  ]);
  /*
   * A SEARCH MATCH opened (`SearchMatches`, from the overview's cards or the
   * Projects & files results): an element of a diagram opens the diagram with
   * that element selected, the way a comment's anchor is shown (queued until
   * the drawing is on screen); a note opens the note; a comment opens its
   * thread on the diagram or note it is on. A group that is not itself
   * selectable (a flowchart subgraph, a sequence fragment) opens the diagram.
   */
  const openSearchMatch = useCallback(
    (target: TargetRef, match: SearchMatch) => {
      const parts = targetParts(target);
      if (parts.kind === "project") {
        openProjectChat();
        return;
      }
      const notePath = parts.kind === "note" ? parts.path : match.field === "note" ? match.notePath : undefined;
      if (notePath !== undefined) {
        openNote(notePath);
        // A match in the note's text opens at, and marks, the passage it quotes (J3-F1); a title or path match opens the note.
        if (match.field === "note") {
          noteSearchKey.current += 1;
          setNoteSearchMatch({
            path: notePath,
            key: noteSearchKey.current,
            snippet: match.text,
            words: searchWords(searchQueryRef.current),
          });
        }
      } else {
        requestedAnchorTarget.current = target;
        if (parts.kind === "view") openView(parts.viewId);
      }
      if (match.threadId !== undefined) {
        threadRequestKey.current += 1;
        setCompose(null);
        setThreadRequest({ key: threadRequestKey.current, threadId: match.threadId });
        return;
      }
      const anchor = searchMatchAnchor(match);
      if (notePath === undefined && anchor !== null) handleShowAnchor(anchor);
      else requestedAnchorTarget.current = null;
    },
    [openView, openNote, handleShowAnchor, openProjectChat],
  );
  const handleStageClickCapture = useCallback(
    (event: ReactMouseEvent) => {
      const pin = event.target instanceof Element ? event.target.closest(`[${PIN_THREAD_ATTRIBUTE}]`) : null;
      if (pin === null) return;
      event.stopPropagation();
      event.preventDefault();
      openThread(pin.getAttribute(PIN_THREAD_ATTRIBUTE) ?? "", true);
    },
    [openThread],
  );
  /*
   * THE ELEMENT'S MENU (ADR 0036 A9; slice 7): right-click, the context-menu key, Shift+F10 or a long press on
   * a box opens Comment / Expand (`expand/use-expand.tsx`), for readers too. Where Expand has nothing to
   * offer (an edge, a message, a sequence, Walkthrough and Edit), it is as before: the composer about the
   * element, and the element selected so what the comment is about is lit while it is written. Empty canvas
   * keeps the browser's menu.
   */
  const expandRef = useRef<ExpandHost | null>(null);
  const menuAnchorRef = useRef<Anchor | null>(null);
  const commentOnAnchor = useCallback(
    (seen: Anchor) => {
      if (reviewViewId === null) return;
      const anchor = placeAnchorRef.current(seen);
      if (anchor.kind === "node" && anchorIds(anchor, projectedRef.current ?? undefined) !== null)
        dispatchSelection({ type: "select", nodeIds: [anchor.id], edgeIds: [] });
      if (anchor.kind === "edge") dispatchSelection({ type: "select", nodeIds: [], edgeIds: [anchor.id] });
      openComposer(viewTarget(reviewViewId), anchor);
    },
    [reviewViewId, openComposer],
  );
  /** The element's menu at `at` (a canvas element, or the canvas for the keyboard), or false when this is not one. */
  const elementMenu = useCallback(
    (target: EventTarget | null, point: { x: number; y: number } | null): boolean => {
      if (drawn === null || reviewViewId === null || !(target instanceof Element)) return false;
      let at: Element | null = target.closest(
        ".react-flow__node[data-id], .react-flow__edge[data-id], [data-seq-id], [data-journey-id]",
      );
      // The context-menu key and Shift+F10 come from the canvas itself: the menu is the keyboard ring's.
      if (at === null && target.closest(".react-flow") !== null)
        at = target.closest(".react-flow")!.querySelector(`.${KEYBOARD_FOCUS_CLASS}[data-id]`);
      if (at === null) return false;
      const expand = expandRef.current;
      const canvasId = at.getAttribute("data-id");
      const rect = at.getBoundingClientRect();
      const where = point ?? { x: rect.left + Math.min(rect.width, 24), y: rect.bottom + 4 };
      const from = document.activeElement;
      // A part of a frame Expand added (A10): its source's, so a comment on it goes there.
      if (canvasId?.startsWith("group:xf~")) return false;
      const part = canvasId === null || expand === null ? null : expand.partOf(canvasId);
      if (part !== null && canvasId !== null && expand !== null) {
        if (part.kind === "node") dispatchSelection({ type: "select", nodeIds: [canvasId], edgeIds: [] });
        if (expand.open({ canvasId, kind: part.kind, label: part.label, ...where }, from)) return true;
        // Only Comment to offer (an added wire): straight to the composer, about the source's element.
        if (!reviewCapabilities.comments) return false;
        composeKeyRef.current += 1;
        setCompose({
          key: composeKeyRef.current,
          target: viewTarget(part.source),
          anchor: { kind: part.kind, id: part.id, label: part.label },
          placeAt: canvasId,
        });
        return true;
      }
      const seen = anchorAt(at, drawn);
      if (seen === null) return false;
      menuAnchorRef.current = seen;
      if (
        (seen.kind === "node" || seen.kind === "group") &&
        expand !== null &&
        expand.offers(seen.kind) &&
        drawn.type === "graph"
      ) {
        const menuTarget: MenuTarget = {
          canvasId: seen.kind === "group" ? `group:${seen.id}` : seen.id,
          kind: seen.kind,
          label: seen.label,
          ...where,
        };
        if (expand.open(menuTarget, from)) {
          if (seen.kind === "node") dispatchSelection({ type: "select", nodeIds: [seen.id], edgeIds: [] });
          return true;
        }
      }
      if (!reviewCapabilities.comments) return false;
      commentOnAnchor(seen);
      return true;
    },
    [drawn, reviewViewId, reviewCapabilities.comments, commentOnAnchor],
  );
  const handleStageContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      if (longPressRef.current.fired > 0 && performance.now() - longPressRef.current.fired < 1000) {
        event.preventDefault();
        return;
      }
      // A keyboard's menu (the key, Shift+F10) has no pointer: it opens at the element.
      const keyboard = event.button !== 2 && event.clientX === 0 && event.clientY === 0;
      if (elementMenu(event.target, keyboard ? null : { x: event.clientX, y: event.clientY })) event.preventDefault();
    },
    [elementMenu],
  );
  // A long press on a touch screen is the right-click (iOS fires no contextmenu); one press, one menu.
  const longPressRef = useRef<{ timer: number | undefined; x: number; y: number; fired: number }>({
    timer: undefined,
    x: 0,
    y: 0,
    fired: 0,
  });
  // The menu rises while the finger is still down; on a phone it is a sheet that may now lie under that finger.
  // Lifting it is not a press: cancelling that touch's end cancels the click the browser would make where it
  // lifts. On the window and in capture, because the canvas's pan/zoom stops touch events from bubbling.
  const liftRef = useRef<((event: TouchEvent) => void) | null>(null);
  const forgetLift = useCallback(() => {
    if (liftRef.current === null) return;
    window.removeEventListener("touchend", liftRef.current, true);
    window.removeEventListener("touchcancel", liftRef.current, true);
    liftRef.current = null;
  }, []);
  useEffect(() => forgetLift, [forgetLift]);
  const handleStagePointerDown = useCallback(
    (event: ReactPointerEvent) => {
      const held = longPressRef.current;
      window.clearTimeout(held.timer);
      forgetLift();
      if (event.pointerType !== "touch") return;
      const target = event.target;
      held.x = event.clientX;
      held.y = event.clientY;
      held.timer = window.setTimeout(() => {
        if (!elementMenu(target, { x: held.x, y: held.y })) return;
        held.fired = performance.now();
        const lift = (end: TouchEvent) => {
          if (end.type === "touchend" && end.cancelable) end.preventDefault();
          forgetLift();
        };
        liftRef.current = lift;
        window.addEventListener("touchend", lift, { capture: true, passive: false });
        window.addEventListener("touchcancel", lift, { capture: true });
      }, LONG_PRESS_MS);
    },
    [elementMenu, forgetLift],
  );
  const handleStagePointerMove = useCallback((event: ReactPointerEvent) => {
    const held = longPressRef.current;
    if (held.timer !== undefined && Math.hypot(event.clientX - held.x, event.clientY - held.y) > 8) {
      window.clearTimeout(held.timer);
      held.timer = undefined;
    }
  }, []);
  const handleStagePointerEnd = useCallback(() => {
    window.clearTimeout(longPressRef.current.timer);
    longPressRef.current.timer = undefined;
  }, []);
  const handleBlockComment = useCallback(
    (id: string) => {
      // A completed touch long press already opened this block's composer.
      if (longPressRef.current.fired > 0 && performance.now() - longPressRef.current.fired < 1000) return;
      if (!reviewCapabilities.comments || drawn === null) return;
      const header = document.querySelector(
        `.archer-seq-block-header[data-seq-id="${CSS.escape(id)}"], .archer-seq-note-comment-target[data-seq-id="${CSS.escape(id)}"]`,
      );
      const anchor = anchorAt(header, drawn);
      if (anchor?.kind === "group" || anchor?.kind === "node") commentOnAnchor(anchor);
    },
    [drawn, reviewCapabilities.comments, commentOnAnchor],
  );
  const reviewOpenRef = useRef(reviewOpen);
  reviewOpenRef.current = reviewOpen;
  const toggleReview = useCallback(() => {
    const opener = reviewToggleRef.current;
    reviewLauncherRef.current = opener;
    setReviewOpen((open) => !open);
    // Opened from the bell: focus goes in, to the selected Show tab (round 1, F71). The review stays nonmodal.
    if (!reviewOpenRef.current)
      trackFocus(
        focusWhenShown(`#${REVIEW_PANEL_ID} [role="tablist"] [role="tab"][aria-selected="true"]`, { from: opener }),
      );
  }, [trackFocus]);
  const dismissReview = useCallback(() => setReviewOpen(false), []);
  const closeReview = useCallback(() => {
    setReviewOpen(false);
    (reviewLauncherRef.current?.isConnected ? reviewLauncherRef.current : reviewToggleRef.current)?.focus();
  }, []);

  // The picked view compiles now (or has a last valid version after all), so
  // there is an envelope to read: draw it, as the click asked.
  useEffect(() => {
    if (pickedUndrawnViewId === null || pickedStillUndrawn) {
      return;
    }
    handleSelectTab(pickedUndrawnViewId);
  }, [pickedUndrawnViewId, pickedStillUndrawn, handleSelectTab]);

  /**
   * The page-level bindings. Fitting the view is not here -- it needs React
   * Flow's imperative handle, so the canvas mounts that one itself.
   *
   * ESC IS LAYERED, and the order is the point. While the cheat sheet is up,
   * Esc closes it and stops: clearing the selection out from under someone who
   * is dismissing a cheat sheet is the exact bug this ordering prevents, and
   * the shared Help owner consumes Escape before these page-level bindings.
   *
   * Below the overlay, one press does both remaining jobs at once -- dismiss
   * the agent's emphasis and clear the selection -- because that is what the
   * cheat sheet promises under two separate headings, and a user who has both
   * up should not have to guess which one a press will take.
   */
  useWindowKeydown((event) => {
    if (editingRoute || editRequested) return;
    // Artifact panels own dismissal before canvas shortcuts, including inputs.
    if (!contentsShown && !helpOpen && (exportOpen || accuracyOpen) && event.key === "Escape") {
      event.preventDefault();
      closeExport();
      closeAccuracy();
      return;
    }
    if (event.target instanceof Element && event.target.closest(".archer-artifact-panel")) return;
    if (comparisonOpen && !contentsShown && !helpOpen && event.key === "Escape") {
      event.preventDefault();
      closeComparison();
      return;
    }
    if (event.target instanceof Element && event.target.closest(".accuracy-compare")) return;
    // Escape leaves from a slider or a button too (the Step slider under the drawing); only text entry keeps it.
    if (isTypingTarget(event.target) && !(event.key === "Escape" && !isTextEntry(event.target))) {
      return;
    }

    // Shared Help/search keys are handled by useShellShortcuts before page shortcuts.
    const previous = matchesShortcut(event, "previous", pageKeys.previous && !helpOpen);
    const nextDiagram = matchesShortcut(event, "next", pageKeys.next && !helpOpen);
    if (previous || nextDiagram) {
      event.preventDefault();
      const current =
        contentsShown || selectedNotePath !== null
          ? null
          : (pickedUndrawnViewId ?? (presentation === null ? null : presentation.viewId));
      const index = views.findIndex((view) => view.id === current);
      const step = nextDiagram ? 1 : -1;
      const next = index === -1 ? (step === 1 ? 0 : views.length - 1) : (index + step + views.length) % views.length;
      openView(views[next]!.id);
      return;
    }

    if (matchesShortcut(event, "follow", pageKeys.follow && !helpOpen)) {
      event.preventDefault();
      walkFollow.setFollow(!walkFollow.follow);
      return;
    }

    if (matchesShortcut(event, "comment", pageKeys.comment && !helpOpen)) {
      event.preventDefault();
      // A block or note has keyboard focus without entering the published selection.
      // Its scope takes priority over a previously selected child message.
      const focused = drawn?.type === "sequence" ? anchorAt(document.activeElement, drawn) : null;
      if (focused?.kind === "group" || (focused != null && drawn !== null && isSequenceNoteAnchor(drawn, focused))) {
        commentOnAnchor(focused);
        return;
      }
      if (selectedNotePath !== null) {
        // A passage selected in the note is what C comments on, as "Comment on selection" does (round 1, F11).
        const passage = reviewCapabilities.comments ? selectedNotePassage() : null;
        if (passage !== null) {
          document.getSelection()?.removeAllRanges();
          openComposer(`note:${selectedNotePath}`, passage);
        } else if (chatShown && runtime.features.chat) openChat();
        else openComposer(`note:${selectedNotePath}`, { kind: "view" });
        // An example chat (no service) is opened from its bubble: here `C` comments, which the example keeps.
      } else if (
        projectChat ||
        (chatShown && runtime.features.chat && selectedNodeIds.length === 0 && selectedEdgeIds.length === 0)
      ) {
        openChat();
      } else commentOnSelection();
      return;
    }

    if (event.key === "Escape") {
      // The shared Help controller owns dismissal; never clear state underneath it.
      if (helpOpen) return;
      // The chat is the topmost surface: this press closes it and nothing else.
      if (chatOpenRef.current) {
        event.preventDefault();
        closeChat();
        return;
      }
      // Esc with nothing to dismiss stays unhandled, so it keeps whatever
      // meaning the browser or a host window gives it.
      let dismissed = false;
      // Read through `activeEmphasis`, not off `activeId`: an id naming an
      // emphasis the agent no longer stores draws nothing, and the reducer
      // would refuse it -- claiming to have dismissed something would then
      // swallow the keystroke for a no-op.
      // A walkthrough is left from anywhere on the page, its view put back (D3); the agent's emphasis under it is not Esc's.
      // One layer per press: the selection stays for the next one.
      if (modes.mode === "walkthrough") {
        event.preventDefault();
        modes.exit("escape");
        return;
      }
      const drawn = modes.mode === "highlights" ? activeEmphasis(emphasis) : null;
      if (drawn !== null) {
        dispatchEmphasis({ type: "select", id: drawn.id });
        dismissed = true;
      }
      // Only what is on screen can be cleared. Under a notice the canvas is
      // gone, and publishing a cleared selection for it would tell the agent
      // the user did something to a diagram nobody can see.
      if (hasSelection && notice === null && !contentsShown && selectedNotePath === null) {
        handleClearSelection();
        dismissed = true;
      }
      if (dismissed) {
        event.preventDefault();
      }
      return;
    }

    if ((event.key === "a" || event.key === "A") && (event.metaKey || event.ctrlKey)) {
      // Not while the cheat sheet is up: it promises the selection is
      // untouched, and this is a change the user could not watch happen.
      if (helpOpen) {
        return;
      }
      // A notice REPLACES the canvas, so there is nothing on screen to select
      // and nothing the user can be said to have selected.
      if (notice !== null || contentsShown || selectedNotePath !== null) {
        return;
      }
      if (selectEverything(diagramStage)) event.preventDefault();
    }
  });

  // The selection as the canvas draws it (see `useDrawnSelection` for why it is memoised).
  const drawnSelection = useDrawnSelection(selection, drawnNest);
  const activeViewId =
    contentsShown || noteOnScreen
      ? null
      : (pickedUndrawnViewId ?? (presentation === null ? null : presentation.viewId));
  const embeddedAt = activeViewId === null ? null : parseDiagramAddress(activeViewId);
  // The diagram's walkthroughs (ADR 0034). While the panel is open it replaces the agent's emphasis and
  // framing with the step; closing it gives them back.
  const walkthroughs = useWalkthroughs({
    viewId: viewOnStage,
    enabled: !editingRoute && !editRequested,
    events: reviewEvents,
    view: drawnKeyModel?.type === "graph" ? drawnKeyModel.view : null,
  });
  const walkOpen = walkthroughs.state.open;
  // The page's mode (D1): one at a time; entering a walkthrough saves the view, every way out puts it back.
  // Declared before the follow camera, so the view is saved before a step changes it.
  const walkFollowRef = useRef<{ on: boolean; set: (on: boolean) => void }>({ on: true, set: () => undefined });
  const followLink = useMemo(
    () => ({
      get on() {
        return walkFollowRef.current.on;
      },
      set: (on: boolean) => walkFollowRef.current.set(on),
    }),
    [],
  );
  const stageView = useStageView(diagramStage, followLink, editRequested);
  const modeSelection = useMemo(
    () => (selection === null ? null : { nodeIds: selection.selectedNodeIds, edgeIds: selection.selectedEdgeIds }),
    [selection],
  );
  const modeWalk = useMemo<ModeWalkthrough>(
    () => ({
      open: walkOpen,
      at:
        walkOpen && walkthroughs.walk !== null
          ? { walkthrough: walkthroughs.walk.id, step: walkthroughs.state.step }
          : null,
      context: walkOpen ? contextOf(walkthroughs.walk, walkthroughs.state.step) : null,
      show: walkthroughs.show,
      select: walkthroughs.select,
      close: () => walkthroughs.dispatch({ type: "close" }),
      press: walkthroughs.press,
    }),
    [
      walkOpen,
      walkthroughs.walk,
      walkthroughs.state.step,
      walkthroughs.show,
      walkthroughs.select,
      walkthroughs.dispatch,
      walkthroughs.press,
    ],
  );
  const activeEmphasisId = activeEmphasis(emphasis)?.id ?? null;
  // What the active emphasis draws: the same snapshot heard again is the same text.
  const activeEmphasisRevision = useMemo(() => {
    const up = activeEmphasis(emphasis);
    return up === null ? null : JSON.stringify(up);
  }, [emphasis]);
  const newestEmphasisId = emphasis.emphases.at(-1)?.id ?? null;
  const modeHighlights = useMemo<ModeHighlights>(
    () => ({
      activeId: activeEmphasisId,
      revision: activeEmphasisRevision,
      show: () => {
        if (newestEmphasisId !== null) dispatchEmphasis({ type: "select", id: newestEmphasisId });
      },
      hide: () => {
        if (activeEmphasisId !== null) dispatchEmphasis({ type: "select", id: activeEmphasisId });
      },
    }),
    [activeEmphasisId, activeEmphasisRevision, newestEmphasisId],
  );
  // Pressing Edit removes the button that had focus: focus goes to the editor's drawing, not the page body (smoke-c#12:a).
  const focusEditorRef = useRef(false);
  // Set when Edit is pressed on a drawing on screen: only then is there a drawing to keep up while the editor draws
  // (an address opened at ?edit has none, and showing one first would only swap it out).
  const handoverArmed = useRef(false);
  const startInPlace = useCallback(() => {
    focusEditorRef.current = true;
    handoverArmed.current = true;
    window.history.pushState(null, "", inPlaceHref(null));
    setEditRequested(true);
  }, []);
  const closeReviewForWalk = useCallback(() => setReviewOpen(false), []);
  const modes = useDiagramModes({
    walkthrough: modeWalk,
    highlights: modeHighlights,
    edit: { on: editingRoute || editRequested, start: startInPlace },
    view: stageView,
    selection: modeSelection,
    onEnterWalkthrough: closeReviewForWalk,
  });
  const startEdit = useCallback(() => modes.enter("edit"), [modes.enter]);
  modePressRef.current = modes.press;
  // Comments on walkthroughs (ADR 0034 §9): what the panel and the cards share, and the composer's picker.
  const walkNow = walkOpen ? walkthroughs.walk : null;
  const walkStep = walkthroughs.state.step;
  const kept = modes.leftFrom;
  placeAnchorRef.current = (anchor) =>
    walkNow !== null ? defaultAnchor(anchor, walkNow, walkStep) : keptAnchor(anchor, kept);
  const pickerChoices = useMemo(
    () =>
      walkNow !== null
        ? walkChoices(choices, walkNow, walkStep)
        : kept === null
          ? choices
          : choices.map((choice) => ({ ...choice, anchor: keptAnchor(choice.anchor, kept) })),
    [choices, walkNow, walkStep, kept],
  );
  const walkComments = useMemo<WalkComments | null>(() => {
    if (!reviewCapabilities.comments || reviewViewId === null || walkthroughs.walks.length === 0) return null;
    return {
      target: viewTarget(reviewViewId),
      walks: walkthroughs.walks,
      threads: reviewViewThreads ?? [],
      comment: (walk, step) => openComposer(viewTarget(reviewViewId), stepAnchor(walk, step)),
      openThread,
      openStep: (id, stepId) => {
        setReviewOpen(false);
        const at = walkthroughs.walks.find((w) => w.id === id)?.steps.findIndex((st) => st.id === stepId) ?? -1;
        walkthroughs.select(id, at < 0 ? undefined : at + 1);
      },
    };
  }, [
    reviewCapabilities.comments,
    reviewViewId,
    walkthroughs.walks,
    walkthroughs.select,
    reviewViewThreads,
    openComposer,
    openThread,
  ]);
  const walkPresented = useWalkSteering({
    walkthroughs,
    viewId: activeViewId,
    agent: agentWalk,
    enabled: !editingRoute && !editRequested,
  });
  const walkNest = useMemo<WalkNest>(
    () => ({
      drawn: drawnNest,
      current: () => nestRef.current.open,
      set: openContainers,
      saved: () => modes.saved()?.open ?? null,
    }),
    [drawnNest, openContainers, modes.saved],
  );
  const walkFollow = useWalkFollow({
    walkthroughs,
    full: drawnKeyModel?.type === "graph" ? drawnKeyModel.view : null,
    nest: walkNest,
  });
  // The agent's emphasis and a presented focus open the containers that hold them, once each (J11-F1).
  const revealIds = useMemo(() => {
    const up = activeEmphasis(emphasis);
    const nodeIds = [...(up?.groups.flatMap((group) => group.nodes) ?? []), ...(presentation?.focus.nodeIds ?? [])];
    const edgeIds = [...(up?.groups.flatMap((group) => group.edges) ?? []), ...(presentation?.focus.edgeIds ?? [])];
    return { nodeIds, edgeIds };
  }, [emphasis, presentation?.focus]);
  const revealKey =
    activeViewId === null || revealIds.nodeIds.length + revealIds.edgeIds.length === 0
      ? null
      : `${activeViewId}|${JSON.stringify(revealIds)}`;
  useRevealTargets({ key: revealKey, ids: revealIds, enabled: !walkOpen && !editingInPlace, nest: walkNest });
  walkFollowRef.current = { on: walkFollow.follow, set: walkFollow.setFollow };
  const pageKeys = readerShortcutCapabilities({
    editing: editingInPlace,
    views: views.length,
    comments: reviewCapabilities.comments,
    note: selectedNotePath !== null,
    contents: contentsShown,
    reviewView: reviewViewId !== null,
    projectChat,
    chat: chatShown,
    walk: walkOpen,
    camera: walkFollow.camera !== undefined,
  });
  // Expand (ADR 0036 §11–§13): what this page added to the view, drawn in place of the base layout.
  const expandBase =
    drawnNest?.nested.view ??
    (drawnKeyModel?.type === "graph" && drawnKeyModel.view.viewId === activeViewId ? drawnKeyModel.view : null);
  const inventoryKey = useMemo(() => views.map((v) => `${v.id}@${v.modelRevision ?? ""}`).join("\n"), [views]);
  const modelRevisions = useMemo(() => new Map(views.map((v) => [v.id, v.modelRevision ?? ""])), [views]);
  const revisionOfView = useCallback((viewId: string) => modelRevisions.get(viewId), [modelRevisions]);
  // `?expand=` (O10): read when the view opens, as `?open=` is; the graph never writes it.
  const expandParam = new URLSearchParams(window.location.search).get("expand");
  const expandLink = useMemo(
    () =>
      activeViewId === null || expandParam === null || !/^[A-Za-z0-9_-]{1,4096}$/.test(expandParam)
        ? null
        : { viewId: activeViewId, expand: expandParam },
    [activeViewId, expandParam],
  );
  const onSourceComments = useCallback(
    (listener: (target: string) => void) =>
      reviewEvents.subscribe((event) => {
        if (event.type === "comments") listener(event.target);
      }),
    [reviewEvents],
  );
  const frameSelection = useMemo<readonly FrameSelection[]>(
    () =>
      [
        ...selectedNodeIds.flatMap((id) => {
          const part = framePartOf(id);
          return part === null ? [] : [{ source: part.source, kind: "node" as const, id: part.id }];
        }),
        ...selectedEdgeIds.flatMap((id) => {
          const part = framePartOf(id);
          return part === null ? [] : [{ source: part.source, kind: "edge" as const, id: part.id }];
        }),
      ].slice(0, 64),
    [selectedNodeIds, selectedEdgeIds],
  );
  const expand = useExpand({
    viewId: expandBase === null ? null : activeViewId,
    base: expandBase,
    baseLayout: canvasState.status === "ready" ? canvasState.layout : null,
    typeface,
    mode: modes.mode,
    toExplore: () => modes.exit("switch"),
    comments: reviewCapabilities.comments && !editingRoute,
    commentOnBase: () => {
      const seen = menuAnchorRef.current;
      if (seen !== null) commentOnAnchor(seen);
    },
    commentOnSource: (source, part) => {
      composeKeyRef.current += 1;
      setCompose({
        key: composeKeyRef.current,
        target: viewTarget(source),
        anchor: { kind: part.kind, id: part.id, label: part.label },
        placeAt: part.canvasId,
      });
    },
    insideOf: (canvasId) => {
      const node = expandBase?.nodes.find((n) => n.id === canvasId);
      const folded = node?.folded;
      if (folded === undefined || drawnNest === null || canvasNesting === undefined) return null;
      const count = drawnNest.nested.closed.get(folded.groupId)?.count ?? 0;
      return { count, open: () => canvasNesting.onToggle(folded.groupId, true) };
    },
    openView,
    titleOf: viewTitle,
    metadataOf: (source, piece) => sourceMetadata(source, views, piece),
    onDetails: dismissReview,
    inventoryKey,
    revisionOf: revisionOfView,
    revision: activeViewId === null ? null : modelRevisions.get(activeViewId) || null,
    presented: agentExploration,
    link: expandLink,
    onComments: onSourceComments,
    frameSelection,
    follow: (layout, frameGroupIds) => {
      // The frames just added come into view: panned to, and zoomed out only as far as they need (A12).
      const camera = diagramStage.cameraRef.current;
      const ids = new Set(typeof frameGroupIds === "string" ? [frameGroupIds] : frameGroupIds);
      const boxes = layout.groups.filter((g) => ids.has(g.id));
      const x0 = Math.min(...boxes.map((g) => g.x)),
        y0 = Math.min(...boxes.map((g) => g.y));
      const frame =
        boxes.length === 0
          ? undefined
          : {
              x: x0,
              y: y0,
              width: Math.max(...boxes.map((g) => g.x + g.width)) - x0,
              height: Math.max(...boxes.map((g) => g.y + g.height)) - y0,
            };
      const box = document.querySelector(".archer-stage .react-flow")?.getBoundingClientRect();
      if (camera === null || frame === undefined || box === undefined) return;
      const now = camera.get();
      const left = frame.x * now.zoom + now.x,
        top = frame.y * now.zoom + now.y;
      if (
        left >= 0 &&
        top >= 0 &&
        left + frame.width * now.zoom <= box.width &&
        top + frame.height * now.zoom <= box.height
      )
        return;
      const zoom = Math.max(0.25, Math.min(now.zoom, (box.width - 64) / frame.width, (box.height - 64) / frame.height));
      camera.set({
        x: box.width / 2 - (frame.x + frame.width / 2) * zoom,
        y: box.height / 2 - (frame.y + frame.height / 2) * zoom,
        zoom,
      });
    },
  });
  expandRef.current = expand;
  const framePinThreads = framePinOpen === null ? undefined : review.threads.get(viewTarget(framePinOpen.source));
  useEffect(() => {
    if (framePinOpen === null || framePinThreads === undefined) return;
    const thread = framePinThreads.find(
      (t) => t.orphaned !== true && t.status !== "resolved" && "id" in t.anchor && t.anchor.id === framePinOpen.id,
    );
    setFramePinOpen(null);
    if (thread !== undefined) requestThread(thread.id);
  }, [framePinOpen, framePinThreads, requestThread]);
  // The canvas's pins: the base view's threads, and the open threads on frames' parts (counts from the exploration read).
  const drawnCommented = useMemo(() => {
    if (expand.pins.size === 0) return commented;
    const nodePins = new Map(commented?.nodePins ?? []),
      edgePins = new Map(commented?.edgePins ?? []);
    let number = commented?.numbers.size ?? 0;
    for (const [canvasId, pin] of expand.pins)
      (pin.kind === "edge" ? edgePins : nodePins).set(canvasId, [
        { threadId: `${FRAME_PIN}${canvasId}`, number: ++number, state: "sent" },
      ]);
    return {
      groupIds: new Set<string>(),
      groupPins: new Map(),
      numbers: new Map(),
      ...commented,
      nodeIds: new Set(nodePins.keys()),
      edgeIds: new Set(edgePins.keys()),
      nodePins,
      edgePins,
    };
  }, [commented, expand.pins]);
  const frameActions = useMemo<FrameActions>(
    () => ({
      proposed: (source) => expand.frames.some((f) => f.source === source && f.proposed),
      open: openView,
      remove: expand.remove,
    }),
    [expand.frames, expand.remove, openView],
  );
  // What the canvas draws, read off the mode: a walkthrough's step covers the agent's emphasis, which comes back after.
  const walking = modes.mode === "walkthrough";
  const shownEmphasis = walking ? (walkthroughs.render?.emphasis ?? null) : activeEmphasis(emphasis);
  const drawnEmphasis = useMemo(
    () => (drawnNest === null ? shownEmphasis : nestEmphasis(shownEmphasis, drawnNest.nested, drawnNest.full)),
    [drawnNest, shownEmphasis],
  );
  const walkedCanvasState = useMemo<CanvasState>(
    () =>
      walking && canvasState.status === "ready"
        ? { ...canvasState, focus: walkthroughs.render?.focus ?? {} }
        : canvasState,
    [walking, canvasState, walkthroughs.render],
  );
  const nestedCanvasState = useMemo<CanvasState>(
    () =>
      drawnNest === null || walkedCanvasState.status !== "ready"
        ? walkedCanvasState
        : { ...walkedCanvasState, focus: drawnIds(drawnNest.nested, drawnNest.full, walkedCanvasState.focus ?? {}) },
    [drawnNest, walkedCanvasState],
  );
  const grownLayout = expand.layout;
  const drawnCanvasState = useMemo<CanvasState>(
    () =>
      grownLayout === null || nestedCanvasState.status !== "ready"
        ? nestedCanvasState
        : { ...nestedCanvasState, layout: grownLayout },
    [grownLayout, nestedCanvasState],
  );
  const nestModeShown =
    nestedViewAllowed &&
    canvasState.status === "ready" &&
    drawnKeyModel?.type === "graph" &&
    drawnKeyModel.view.groups.length > 0;
  // The switch says what is DRAWN (G15): a press re-lays the view out, and until that drawing is on
  // screen the old one is, so the switch stays with it and says it is busy.
  const drawnNestMode: NestMode = drawnNest === null ? "full" : "nested";
  const nestToggle = nestModeShown ? (
    <NestModeButton mode={drawnNestMode} busy={drawnNestMode !== nestRef.current.mode} onChange={handleNestMode} />
  ) : null;

  // One panel content at a time: walkthroughs and element details close Project Review; opening Review dismisses either.
  const openWalkthroughs = (): void => {
    if (walkOpen) modes.exit("switch");
    else modes.enter("walkthrough");
  };
  const walkCount = walkthroughs.walks.length;
  useEffect(() => {
    if (reviewOpen) {
      walkthroughs.dispatch({ type: "close" });
      expandRef.current?.dismiss();
    }
  }, [reviewOpen]);
  useEffect(
    () =>
      walkCount > 0
        ? whenIdle(() => {
            void LazyWalkthroughSurface.preload();
          })
        : undefined,
    [walkCount],
  );
  const graphTools = (
    <>
      {" "}
      {runtime.features.revisions &&
      capabilities.comments &&
      !contentsShown &&
      activeViewId !== null &&
      embeddedAt === null ? (
        <button
          type="button"
          className="archer-review-toggle archer-compare-toggle"
          aria-label="Compare revisions"
          title="Compare revisions"
          aria-expanded={comparisonOpen}
          aria-controls="archer-comparison-panel"
          onClick={(event) => {
            toolLauncherRef.current =
              event.currentTarget
                .closest(".archer-canvas-tools")
                ?.querySelector<HTMLButtonElement>(".archer-canvas-tools-trigger") ?? null;
            setExportOpen(false);
            setAccuracyOpen(false);
            setComparisonOpen((open) => !open);
          }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M5 2v12M11 2v12M2 5h6M8 11h6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
          <span className="archer-review-toggle-label">Compare</span>
        </button>
      ) : null}
      {runtime.features.revisions && capabilities.comments && !contentsShown && activeViewId !== null ? (
        <>
          {projectedRef.current?.view.viewId === activeViewId ? (
            <button
              type="button"
              className="archer-review-toggle"
              aria-label="Export diagram"
              title="Export diagram"
              aria-expanded={exportOpen}
              aria-controls="archer-export-panel"
              onClick={(event) => {
                toolLauncherRef.current =
                  event.currentTarget
                    .closest(".archer-canvas-tools")
                    ?.querySelector<HTMLButtonElement>(".archer-canvas-tools-trigger") ?? null;
                setComparisonOpen(false);
                setAccuracyOpen(false);
                setExportOpen((open) => !open);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M8 2v8m-3-3 3 3 3-3M3 10v3h10v-3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="archer-review-toggle-label">Export</span>
            </button>
          ) : null}
          {/* Git history is a file's: a diagram embedded in a note has none of its own (ADR 0012). */}
          {embeddedAt === null ? (
            <button
              type="button"
              className="archer-review-toggle"
              aria-label="Check diagram accuracy"
              title="Check diagram accuracy"
              aria-expanded={accuracyOpen}
              aria-controls="archer-accuracy-panel"
              onClick={(event) => {
                toolLauncherRef.current =
                  event.currentTarget
                    .closest(".archer-canvas-tools")
                    ?.querySelector<HTMLButtonElement>(".archer-canvas-tools-trigger") ?? null;
                setComparisonOpen(false);
                setExportOpen(false);
                setAccuracyOpen((open) => !open);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
                <path
                  d="m5 8 2 2 4-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="archer-review-toggle-label">Accuracy</span>
            </button>
          ) : null}
        </>
      ) : null}
      {activeViewId === null ? <p>Open a diagram to compare revisions, export, or check accuracy.</p> : null}
    </>
  );

  // Source stays reachable where the canvas draws no toolbar of its own: a notice in place of the drawing,
  // a drawing still loading, nothing selected, or a failure with nothing valid to show.
  const canvasHasToolbar = hasDrawing;
  const canvas =
    notice !== null ? (
      <>
        <PageNotice notice={notice} />
        <SourceToolbar />
      </>
    ) : (
      <>
        <FrameActionsContext.Provider value={frameActions}>
          <FitDrawing.Provider value={activeViewId ?? undefined}>
            <DiagramCanvas
              key={activeViewId ?? "empty"}
              tools={graphTools}
              primaryShell
              state={drawnCanvasState}
              selection={drawnSelection}
              emphasis={drawnEmphasis}
              {...(canvasNesting === undefined ? {} : { nesting: canvasNesting })}
              {...(nestToggle === null && walkFollow.camera === undefined
                ? {}
                : {
                    controls: (
                      <>
                        {nestToggle}
                        {walkFollow.camera === undefined ? null : (
                          <FollowButton on={walkFollow.follow} onChange={walkFollow.setFollow} />
                        )}
                      </>
                    ),
                  })}
              {...(walkFollow.camera === undefined ? {} : { walkCamera: walkFollow.camera })}
              cameraHandle={diagramStage.cameraRef}
              reserveLegendRoom={emphasis.emphases.length > 0}
              commented={drawnCommented}
              blockComments={reviewCapabilities.comments}
              onNoteComment={handleBlockComment}
              onBlockComment={handleBlockComment}
              hasSelection={hasSelection}
              onNodeClick={handleNodeClick}
              onEdgeClick={handleEdgeClick}
              onElementPress={handleElementPress}
              onPaneClick={handleClearSelection}
              onClearSelection={handleClearSelection}
              onMarqueeStart={handleMarqueeStart}
              onMarqueeEnd={handleMarqueeEnd}
              onMarqueeChange={handleMarqueeChange}
            />
          </FitDrawing.Provider>
        </FrameActionsContext.Provider>
        {expand.menu}
        {canvasHasToolbar ? null : <SourceToolbar tools={graphTools} />}
      </>
    );

  // `canvasState.status`, not `projectedRef.current.type`, decides which rows
  // the sheet shows. The projection says what the presented view IS; the
  // status says which canvas `DiagramCanvas` actually mounts for it, and the
  // cheat sheet is a promise about the gestures on screen. The two disagree
  // exactly when it matters: while a graph layout is still being computed, or
  // when an error banner sits over the last valid GRAPH, the projection may
  // already have moved on while React Flow is still the thing being operated.
  //
  // ...and "graph" is not the answer when there is NO canvas. A notice replaces
  // the diagram outright, and `loading`/`empty`/a bare error render a message
  // in its place -- on any of those the graph list would show nineteen rows
  // that are all false.
  const helpView: HelpView =
    editingInPlace || notice !== null || !hasDrawing || contentsShown || selectedNotePath !== null
      ? "none"
      : canvasState.status === "sequence-ready"
        ? "sequence"
        : canvasState.status === "journey-ready"
          ? "journey"
          : "graph";
  // What else is true of this page, beyond the canvas: moving between
  // diagrams where there is more than one, and commenting where the server
  // takes comments on the diagram showing.
  const helpExtra: Section[] = [SEARCH_SECTION];
  if (pageKeys.previous) helpExtra.push(DIAGRAMS_SECTION);
  if (editingInPlace)
    helpExtra.push(
      editingSection(
        canvasState.status === "sequence-ready"
          ? "sequence"
          : canvasState.status === "ready"
            ? (canvasState.layout.notation ?? "flowchart") === "flowchart"
              ? "flowchart"
              : "other"
            : canvasState.status === "journey-ready"
              ? "other"
              : null,
      ),
    );
  const diagramComments = pageKeys.comment && reviewViewId !== null && !contentsShown && selectedNotePath === null;
  if (diagramComments) helpExtra.push(commentingSection(helpView, walkNow !== null));
  if (!editingInPlace && walkOpen)
    helpExtra.push({
      ...WALKTHROUGH_SECTION,
      keys: WALKTHROUGH_SECTION.keys.filter(([key]) => key !== KEYMAP.follow.label || pageKeys.follow),
    });
  // Help names the chat's keys wherever its bubble is. An example chat (no service) sends nothing, so it has no
  // sending row; there `C` opens it only on a project page, and on a note comments, as the example keeps.
  if (!editingInPlace && chatShown) {
    const live = runtime.features.chat;
    const commentKey = (row: Section["keys"][number]): Section["keys"] => {
      if (live) return !diagramComments && pageKeys.comment ? [row] : [];
      if (projectChat && pageKeys.comment) return [row];
      if (selectedNotePath !== null && pageKeys.comment)
        return [shortcutRow("comment", "Comment on the selected passage, or on the whole note")];
      return [];
    };
    helpExtra.push({
      ...CHAT_SECTION,
      keys: CHAT_SECTION.keys.flatMap((row) =>
        row[0] === KEYMAP.comment.label ? commentKey(row) : !live && row[0] === CHAT_SEND_KEYS ? [] : [row],
      ),
    });
  }
  helpExtra.push({
    section: "Panels",
    keys: [
      [
        "Esc",
        "Close a phone's tools sheet, Help, chat, export or comparison; then Source, once nothing is selected or highlighted",
      ],
      ...(!editingInPlace && reviewCapabilities.comments
        ? [["Arrow keys / ⇧ Arrow keys", "On a floating discussion handle: move it 10 px / 40 px"] as const]
        : []),
    ],
  });

  // Shown next to a diagram that is still up but may no longer be current:
  // while there is no stream, and after one comes back until the page has read
  // the standing state again and applied it.
  const staleStrip =
    (connection === "lost" ||
      connection === "unsynced" ||
      connection === "incompatible" ||
      connection === "access-required") &&
    notice === null ? (
      <StaleConnectionNotice status={connection} />
    ) : null;
  // A note's reader has no canvas, so no canvas notice stands in for the strip: a note whose page has lost its
  // stream says so (and stops once it has read what it missed), as a diagram does (round 1 pass 6, P3.offline).
  const noteStrip =
    connection === "lost" ||
    connection === "unsynced" ||
    connection === "incompatible" ||
    connection === "access-required" ? (
      <StaleConnectionNotice status={connection} subject="note" />
    ) : null;

  /*
   * Shown OVER a drawing whose file no longer compiles (ADR 0010).
   *
   * Only over a drawing. Its sentence is "the drawing shown is the last
   * version that compiled", which is false of a page notice, a loading message
   * or an empty canvas -- and a view with nothing drawn has its tab to say it
   * does not compile.
   *
   * THE DRAWING UNDER IT STAYS INTERACTIVE, and what is selected on it is
   * still published. That is not the stale selection `page-state.ts` and the
   * revision stamp exist to prevent: a selection names the revision of the
   * MODEL it was made on, and while the file is broken the model the server
   * serves -- to this page, to `read_diagram`, as the presentation's own
   * revision -- is still this one. The stamp matches, the server accepts it,
   * and the agent that reads it back is told in the same answer that the
   * file currently fails. Freezing the canvas instead would take away the
   * reader's way of pointing at the thing they want fixed.
   *
   * Keyed by view so that switching views does not carry one view's collapsed
   * state to another; unmounted when the failure clears, so the next failure
   * opens expanded.
   */
  const failure = pickedStillUndrawn
    ? // The one case with no drawing: the reader asked for a view that has
      // never compiled, and the notice says that rather than "last version".
      pickedUndrawn
    : notice === null && hasDrawing && presentation !== null
      ? failureFor(compileFailures, presentation.viewId)
      : undefined;
  // Where a diagram whose file is gone went, when the service found it (flows-r1 S4).
  const movedTo = failure === undefined ? undefined : views.find((view) => view.id === failure.viewId)?.movedTo;
  const moved =
    movedTo === undefined || !views.some((view) => view.id === movedTo.id)
      ? undefined
      : {
          sourcePath: movedTo.sourcePath,
          href: withPageAddress(window.location.href, { kind: "view", viewId: movedTo.id }, pageFilesRef.current),
          open: () => openView(movedTo.id),
        };
  const compileNotice =
    failure === undefined ? null : (
      <CompileNotice key={failure.viewId} failure={failure} {...(moved === undefined ? {} : { moved })} />
    );
  const failingViewIds = useMemo(() => new Set(compileFailures.map((entry) => entry.viewId)), [compileFailures]);

  /*
   * Said, quietly, whenever the reader is looking at a different diagram from
   * the one the agent is presenting (ADR 0011): the agent may be talking about
   * a drawing that is not on this screen, and one click puts it there.
   *
   * Only while both are real: a view the agent presented and that has since
   * left the registry is not somewhere to go back to.
   */
  const readerViewId = pickedUndrawnViewId ?? browsedViewId;
  const agentView = agentPresentation === null ? undefined : views.find((view) => view.id === agentPresentation.viewId);
  const readerView = readerViewId === null ? undefined : views.find((view) => view.id === readerViewId);
  const readerViewNotice =
    agentView !== undefined && readerView !== undefined && agentView.id !== readerView.id ? (
      <ReaderViewNotice agentTitle={agentView.title} readerTitle={readerView.title} onReturn={handleReturnToAgent} />
    ) : null;

  /*
   * The agent's caption for the view it presents (`Caption.tsx`).
   *
   * Read off the presentation ON SCREEN, which is what makes it the caption of
   * what the reader is looking at: a tab the reader picked is drawn under a
   * presentation of its own with no annotation, so the caption the agent wrote
   * about another diagram is not shown over it, and is back when they return.
   * Presenting without one replaces the state, so it goes.
   *
   * Not under a notice: a notice replaces the drawing, and a caption for a
   * drawing that is not there describes nothing.
   */
  const caption = notice === null && presentation !== null ? captionText(presentation.annotation) : null;
  const describedBy = caption === null ? undefined : CAPTION_ID;

  // The key of what is on screen: in the nested view a closed boundary's insides are not drawn.
  const keyModel =
    hasDrawing && notice === null && drawnKeyModel !== null
      ? keyOfDrawing(drawnKeyModel, drawnNest?.nested.view ?? null)
      : null;
  // While an emphasis legend is up on a graph, its Key carries the line meanings (ADR 0030).
  const highlightsUp = modes.mode === "highlights" && (activeEmphasis(emphasis)?.groups.length ?? 0) > 0;
  const legendUp = keyModel?.type === "graph" && highlightsUp;

  // How fresh the note of an embedded diagram on screen is, for the header
  // (ADR 0012); read again when the diagram changes.
  const shownEmbedded =
    contentsShown || selectedNotePath !== null
      ? null
      : (pickedUndrawnViewId ?? (presentation === null ? null : presentation.viewId));
  const shownEmbeddedView = views.find((view) => view.id === shownEmbedded);
  const shownEmbeddedChange = shownEmbeddedView?.lastChange?.at ?? null;
  // The revision the page knows: a read the Source panel made of it a moment ago answers this too.
  const shownEmbeddedRevision = shownEmbeddedView?.modelRevision;
  useEffect(() => {
    const fetchDiagram = commentsTransport.embeddedDiagram?.bind(commentsTransport);
    if (shownEmbedded === null || parseDiagramAddress(shownEmbedded) === null || fetchDiagram === undefined) {
      setHeaderFreshness(null);
      return;
    }
    let live = true;
    void fetchDiagram(shownEmbedded, shownEmbeddedRevision).then(
      (diagram) => {
        if (live) setHeaderFreshness(diagram.freshness);
      },
      () => {
        if (live) setHeaderFreshness(null);
      },
    );
    return () => {
      live = false;
    };
  }, [shownEmbedded, shownEmbeddedChange, shownEmbeddedRevision, commentsTransport]);
  // The pages' lists hold every diagram, a block in a note as much as a file (note diagrams ticket, decision 4).
  const fileViews = views;
  // Compare and accuracy read a file's Git history, which an embedded diagram has not.
  const shownIsEmbedded = shownEmbedded !== null && parseDiagramAddress(shownEmbedded) !== null;
  useEffect(() => {
    if (!shownIsEmbedded) return;
    setComparisonOpen(false);
    setAccuracyOpen(false);
  }, [shownIsEmbedded]);

  // The browser-served page: it owns its whole window, so it supplies the
  // title bar the host would otherwise have given it. The toggle moves into
  // the bar, and is still the single mounted owner of the theme.
  // On the contents page no tab is the one on screen.
  // Highlights and Walkthroughs are the side panel's (0.6.4, D5): its Explore section lists both, and the
  // mode decides which surface is up.
  const highlightCount = emphasis.emphases.length;
  const panelView = views.find((view) => view.id === activeViewId);
  const highlightsOn = modes.mode === "highlights";
  // Showing: the newest the agent stored (leaving a walkthrough). Hiding: the one up, which stays in the list.
  const pressHighlights = (): void => {
    if (highlightsOn) modes.exit("switch");
    else modes.enter("highlights");
  };
  const reviewLabel =
    reviewCapabilities.comments && reviewCapabilities.notes
      ? "Notes and comments"
      : reviewCapabilities.comments
        ? "Comments"
        : "Notes";

  /*
   * The diagram's header line (phase 3): who put it here, and what the agent
   * just changed. Only over a drawing.
   */
  const onScreenView = onScreenViewId === null ? undefined : views.find((view) => view.id === onScreenViewId);
  const agentOnScreen =
    browsedViewId === null &&
    pickedUndrawnViewId === null &&
    presentation !== null &&
    !presentation.presentationId.startsWith(READER_PRESENTATION_PREFIX);
  // The person's own last save of the view on screen (claude-206): "Saved" for that revision, and no other.
  const ownSavesVersion = useOwnSavesVersion();
  const ownSlug = projectSlugFromPath(window.location.pathname);
  const ownSave = useMemo(
    () => (ownSlug === null || onScreenViewId === null ? null : ownSaveOf(ownSlug, onScreenViewId)),
    [ownSlug, onScreenViewId, ownSavesVersion],
  );
  const ownRevision =
    onScreenView !== undefined && ownSave !== null && ownSave.claimed === undefined && savedByYou(ownSave, onScreenView)
      ? onScreenView.modelRevision
      : undefined;
  useEffect(() => {
    if (ownSlug !== null && onScreenViewId !== null && ownRevision !== undefined)
      claimOwnSave(ownSlug, onScreenViewId, ownRevision);
  }, [ownSlug, onScreenViewId, ownRevision]);
  // A registered diagram whose file was deleted (claude-204): the notice over the drawing says so; the header neither
  // dates a change nor offers Edit, which needs the file.
  const onScreenFailure = failureFor(compileFailures, onScreenViewId);
  const fileGone = onScreenFailure !== undefined && sourceIsMissing(onScreenFailure);
  const presence =
    runtime.features.diskChanges && phase3 && onScreenViewId !== null && !fileGone
      ? presenceLine({
          origin: agentOnScreen ? "agent" : "reader",
          ...(onScreenView === undefined ? {} : { view: onScreenView }),
          ownSave,
          editing: editingInPlace,
          ...(presentedAt !== null &&
          presentation !== null &&
          presentedAt.presentationId === presentation.presentationId
            ? { presentedAt: presentedAt.at }
            : {}),
          caption,
          now,
        })
      : null;
  const changeNotice =
    onScreenChange === undefined ? null : (
      <ChangeNotice
        change={onScreenChange}
        onShow={showChanges}
        onDismiss={() => dismissChange(onScreenChange.viewId)}
      />
    );
  const changePulse =
    onScreenChange !== undefined && pulse !== null && pulse.viewId === onScreenChange.viewId && !pulse.waiting ? (
      <ChangePulse
        ids={[...onScreenChange.added, ...onScreenChange.changed]}
        round={pulse.round}
        reducedMotion={reducedMotion}
      />
    ) : null;
  /** A row of the project, folder or search page: a file here opens in place; one in another project, at its page. */
  const openRow = (row: FileRow): void => {
    saveBrowserPosition();
    if (row.sourceDocumentPath !== undefined) {
      saveBrowserPosition();
      const path = browserRoutePath(rowRoute(row));
      if (path) window.location.assign(path);
      return;
    }
    if (!row.current) {
      const url = directoryProjectUrl(
        window.location.href,
        row.slug,
        row.kind === "diagram"
          ? { view: row.id, ...(row.path.endsWith(".mmd") ? { sourcePath: row.path } : {}) }
          : { note: row.id },
      );
      if (url !== null) window.location.assign(url);
      return;
    }
    if (row.kind === "note") openNote(row.id);
    else openView(row.id);
  };
  searchQueryRef.current = (searchState ?? addressSearchState)?.query ?? "";
  const openRowMatch = (row: FileRow, match: SearchMatch): void => {
    if (row.sourceDocumentPath !== undefined) {
      openRow(row);
      return;
    }
    if (row.current && !row.target.startsWith("source:")) openSearchMatch(row.target as TargetRef, match);
    else openRow(row);
  };
  const currentSlug = projectSlugFromPath(window.location.pathname);
  // A note link's catalog request (`openNoteLink`): only the latest, and only while the person is still where they
  // clicked it. Opening anything else, a newer link, or leaving the page cancels it, so a late answer cannot navigate.
  const noteLinkRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    noteLinkRequest.current?.abort();
    noteLinkRequest.current = null;
  }, [activeViewId, selectedNotePath, currentSlug]);
  useEffect(() => () => noteLinkRequest.current?.abort(), []);
  useRuntimeControls({
    runtime,
    projectSlug: currentSlug,
    viewId: viewOnStage,
    ready:
      walkthroughs.ready &&
      (canvasState.status === "ready" ||
        canvasState.status === "sequence-ready" ||
        canvasState.status === "journey-ready"),
    openView,
    enterWalk: () => modes.enter("walkthrough"),
    walkthroughs,
  });
  // Project settings opens from the title section's gear, on a project's own page in the web page only.
  const settingsBase = currentSlug !== null ? projectResourceBase(window.location.href, currentSlug) : null;
  const contentsPage =
    overviewShown || searchShown ? (
      <section
        className="archer-contents archer-project-browser"
        aria-label={searchState?.folder ? searchState.folder.split("/").at(-1) : "Project files"}
        data-browser-region=""
        tabIndex={-1}
      >
        <SearchPage
          positionReady={sameAddress(shownAddress, readLocationAddress(pageFilesRef.current))}
          state={searchState ?? addressSearchState ?? EMPTY_SEARCH}
          onChange={changeSearch}
          onInteraction={(intent) => {
            browserInteractionRef.current = intent;
          }}
          onQueryEnd={() => {
            browserTypingRef.current = false;
          }}
          onOpenProject={(slug) => {
            saveBrowserPosition();
            if (slug !== currentSlug) {
              const url = directoryProjectUrl(window.location.href, slug, { overview: true });
              if (url) window.location.assign(url);
            } else {
              readerNavigates();
              setSearchState(browserNavigationState(slug, null, searchState ?? EMPTY_SEARCH));
              setContentsOpen(false);
              setSelectedNotePath(null);
            }
          }}
          currentSlug={currentSlug}
          currentName={capabilities.projectName ?? projectNameFromPath(window.location.pathname) ?? "This project"}
          views={fileViews}
          notes={contentsNotes}
          filesSettling={
            inventoryStatus === "unknown" ||
            !(capabilitiesKnown || bootstrapFailed) ||
            (reviewCapabilities.notes && !contentsNotesLoaded)
          }
          failingViewIds={failingViewIds}
          presentedViewId={agentPresentation?.viewId ?? null}
          serverSearch={runtime.features.serverSearch}
          baseUrl={window.location.href}
          now={now}
          onOpen={openRow}
          onOpenMatch={openRowMatch}
          inputRef={searchInputRef}
          commentActivityRefresh={commentActivityRefresh}
          projectExpansion={projectExpansion}
          onTitleSection={setTitleSection}
          {...(currentSlug && runtime.features.authoring
            ? {
                diagramActions: (
                  <NewMenu
                    projectSlug={currentSlug}
                    projectName={
                      capabilities.projectName ?? projectNameFromPath(window.location.pathname) ?? currentSlug
                    }
                  />
                ),
              }
            : {})}
          {...(settingsBase === null || !runtime.features.projectSettings
            ? {}
            : { onOpenSettings: () => setSettingsOpen(true), settingsButtonRef: settingsGearRef })}
        />
        {settingsBase === null || currentSlug === null ? null : (
          <ProjectSettingsDialog
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            baseUrl={settingsBase}
            fetchImpl={browserFetch}
            projectName={placeName}
            diagramCount={fileViews.length}
            noteCount={contentsNotes.length}
            notesHref={searchPageHref(window.location.href, { ...EMPTY_SEARCH, projects: [currentSlug], tab: "notes" })}
            opener={settingsGearRef}
            onSaved={(saved) => {
              // The title section and the sidebar read the catalog; the shell header reads the capabilities.
              setCapabilities((held) =>
                held.projectName === saved.general.name ? held : { ...held, projectName: saved.general.name },
              );
              void loadProjectCatalog(browserFetch).then(() => announceProjectCatalogChanged());
            }}
          />
        )}
      </section>
    ) : folderShown ? (
      <FolderPage
        path={browsedFolder?.path ?? null}
        views={fileViews}
        notes={contentsNotes}
        failingViewIds={failingViewIds}
        presentedViewId={agentPresentation?.viewId ?? null}
        now={now}
        onOpenFolder={goToFolder}
        onOpen={openRow}
        onSearch={(folder) => goToSearch({ ...EMPTY_SEARCH, folder })}
      />
    ) : null;
  /** A walkthrough's related note (J10-F1): a link only to a note this project lists, at its own address. */
  const walkNoteLink = (path: string): { title: string; href: string; onOpen: () => void } | null => {
    const note = contentsNotes.find((candidate) => candidate.path === path.replace(/^\.\//, ""));
    const href =
      note === undefined || currentSlug === null
        ? null
        : browserRoutePath({ kind: "note", projectSlug: currentSlug, path: note.path });
    return note === undefined || href === null ? null : { title: note.title, href, onOpen: () => openNote(note.path) };
  };
  const openNoteLink = (href: string, path: string): boolean | Promise<boolean> => {
    // An external reference opens in a new tab and an anchor stays put: neither replaces a file this tab is opening.
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) return false;
    noteLinkRequest.current?.abort();
    noteLinkRequest.current = null;
    let target: string;
    try {
      target = decodeURIComponent(
        new URL(href, `https://archer.invalid/${path.split("/").map(encodeURIComponent).join("/")}`).pathname.slice(1),
      );
    } catch {
      return false;
    }
    const view = views.find(
      (view) => view.registration !== "embedded" && view.sourcePath?.replace(/^\.\//, "") === target,
    );
    if (view) {
      openView(view.id);
      return true;
    }
    const note = contentsNotes.find((note) => note.path === target);
    if (note) {
      openNote(note.path);
      return true;
    }
    // Another file of the project (the notice beside the README): its own page, when the document catalog lists it.
    if (currentSlug === null || !/\.(?:md|mmd)$/iu.test(target)) return false;
    const request = new AbortController();
    noteLinkRequest.current = request;
    return projectFileAddress(currentSlug, path, href, request.signal).then((address) => {
      // Cancelled: the person has moved on, and the reader no longer listens for this answer.
      if (request.signal.aborted || noteLinkRequest.current !== request) return true;
      noteLinkRequest.current = null;
      if (address === null) return false;
      window.location.assign(address);
      return true;
    });
  };
  // The breadcrumb walks the open item's path in the Archer folder; the
  // folder's root is the project itself, so it has no segment of its own.
  const activeView = views.find((view) => view.id === activeViewId);
  // A diagram embedded in a note (ADR 0012): its address names its note and
  // name, so the breadcrumb holds even once it has left the inventory.
  const selectedNote =
    selectedNotePath === null ? undefined : contentsNotes.find((note) => note.path === selectedNotePath);
  const scopedBrowser =
    searchShown &&
    searchState !== null &&
    (searchState.projects.length === 1 || (currentSlug === null && searchState.folder !== null));
  const browserFolder = scopedBrowser ? (searchState?.folder ?? "") : "";
  const browsedTrail = folderShown
    ? folderTrail(browsedFolder?.path ?? "")
    : scopedBrowser
      ? folderTrail(browserFolder)
      : [];
  const breadcrumbTrail =
    folderShown || scopedBrowser
      ? browsedTrail.slice(0, -1)
      : folderTrail(folderOf(selectedNotePath ?? embeddedAt?.notePath ?? activeView?.sourcePath));
  const breadcrumbCurrent = folderShown
    ? browsedFolder?.path === null
      ? "Unknown folder"
      : (browsedTrail.at(-1)?.name ?? "Archer folder")
    : selectedNotePath !== null
      ? (selectedNote?.title ?? selectedNotePath)
      : searchShown
        ? scopedBrowser
          ? (browsedTrail.at(-1)?.name ?? null)
          : "Search"
        : overviewShown
          ? null
          : embeddedAt !== null
            ? embeddedAt.name
            : (activeView?.title ?? null);
  const workspace = capabilities.projectName ?? projectNameFromPath(window.location.pathname);
  // Where a chat message is sent from, told to the agent: the clean route (never a query, which may carry a
  // token) and, on a diagram or note page, the project-relative file. The search page is said as "?search"
  // whatever its address spells (the page writes `?q=`), so the agent-facing label stays stable.
  const chatRoute = readLocationRoute(window.location.pathname);
  const chatWhere = chatShown
    ? chatContext(
        (chatRoute === null ? "/" : (browserRoutePath(chatRoute) ?? "/")) +
          (searchShown && searchAddressed(window.location.search) ? "?search" : ""),
        contentsShown
          ? null
          : (selectedNotePath ??
              (embeddedAt !== null ? embeddedAt.notePath : activeView?.sourcePath?.replace(/^\.\//, ""))),
      )
    : undefined;
  const openRecent = (item: RecentItem): void => {
    if (editingRoute) {
      const path = browserRoutePath(
        item.kind === "project"
          ? { kind: "browse", projectSlug: item.slug, folder: "" }
          : item.kind === "view"
            ? { kind: "view", projectSlug: item.slug, viewId: item.id }
            : { kind: "note", projectSlug: item.slug, path: item.id },
      );
      if (path) window.location.assign(path);
      return;
    }
    saveBrowserPosition();
    if (item.slug !== (currentSlug ?? "")) {
      const url = directoryProjectUrl(
        window.location.href,
        item.slug,
        item.kind === "project" ? { overview: true } : item.kind === "view" ? { view: item.id } : { note: item.id },
      );
      if (url !== null) window.location.assign(url);
    } else if (item.kind === "project") goToContents();
    else if (item.kind === "view") openView(item.id);
    else openNote(item.id);
  };
  const inPlaceTarget = useMemo(
    () =>
      !editRequested ||
      currentSlug === null ||
      activeViewId === null ||
      contentsShown ||
      selectedNotePath !== null ||
      missingView !== null
        ? null
        : embeddedAt !== null
          ? { kind: "embedded" as const, address: `${embeddedAt.notePath}#${embeddedAt.name}` }
          : { kind: "view" as const, viewId: activeViewId },
    [
      editRequested,
      currentSlug,
      activeViewId,
      contentsShown,
      selectedNotePath,
      missingView,
      embeddedAt?.notePath,
      embeddedAt?.name,
    ],
  );
  const leaveInPlace = useCallback(() => {
    const query = new URLSearchParams(window.location.search);
    for (const name of ["edit", "draftId", "checkpoint"]) query.delete(name);
    const rest = query.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`,
    );
    setEditRequested(false);
    editingViewRef.current = null;
    // What the agent presented while editing is shown now.
    const deferred = deferredPresentRef.current;
    deferredPresentRef.current = null;
    if (deferred !== null) setTimeout(() => agentPresentRef.current(deferred), 0);
  }, []);
  // A Save forgets what was read of the diagrams, before the page shows them again and before it hears the new revision.
  // Save, Cancel and Discard take away the control that had focus: it goes back to Edit, the mode's launcher (F36, F37, F40).
  const exitInPlace = useCallback(() => {
    leaveInPlace();
    trackFocus(focusWhenShown(".archer-diagram-edit .archer-reader-edit"));
  }, [leaveInPlace, trackFocus]);
  // The editor saved this view's file (O157: Save as a new diagram here over a missing file, too): the reading page it
  // hands back to does not say the file is gone or fails from what was held before the save. A latest-callback (G6):
  // as a useCallback on inPlaceTarget it chained each render to the one before through goToSearch (O185).
  const savedInPlace = useLatestCallback(() => {
    const viewId = inPlaceTarget?.kind === "view" ? inPlaceTarget.viewId : null;
    compileFailuresRef.current = forgetSavedFailure(compileFailuresRef.current, viewId);
    setCompileFailures((held) => forgetSavedFailure(held, viewId));
    forgetDiagramAnswers();
    exitInPlace();
  });
  // Edit hands over without a blank canvas: the reading drawing stays up, in place, while the editor
  // opens its copy and draws it out of sight; the editor takes the stage once it has something to show
  // (or after HANDOVER_LIMIT_MS, so a slow or failed open never leaves the drawing standing in for it).
  const editorKey =
    inPlaceTarget === null
      ? null
      : inPlaceTarget.kind === "view"
        ? `view:${inPlaceTarget.viewId}`
        : `embedded:${inPlaceTarget.address}`;
  const [drawnKey, setDrawnKey] = useState<string | null>(null);
  const handoverPending = editorKey !== null && drawnKey !== editorKey && handoverArmed.current;
  useEffect(() => {
    if (editorKey === null) {
      setDrawnKey(null);
      return;
    }
    if (drawnKey === editorKey) {
      handoverArmed.current = false;
      return;
    }
    if (!handoverArmed.current) return;
    const timer = window.setTimeout(() => setDrawnKey(editorKey), HANDOVER_LIMIT_MS);
    return () => window.clearTimeout(timer);
  }, [editorKey, drawnKey]);
  const editorDrawn = useLatestCallback(() => setDrawnKey(editorKey));
  // A Fit pressed while the editor is drawing out of sight is the editor's, applied once it takes the stage (V7-2);
  // one pressed before any drawing is there waits for it (V7-1).
  useEffect(() => {
    holdFit(handoverPending);
  }, [handoverPending]);
  // Whatever is presented (the reader's diagram landing, or the agent's) is the drawing a Fit is for now.
  useEffect(() => {
    if (presentation !== null) fitOpens(presentation.viewId);
  }, [presentation]);
  // A page loaded on a place that draws nothing (the project page, a folder, a note, a document) queues no Fit.
  useEffect(() => {
    if (!routeOpensDrawing(readLocationRoute(window.location.pathname))) fitOpens(null);
  }, []);
  useEffect(() => () => holdFit(false), []);
  useFitQueue(!helpOpen);
  const inPlace = useMemo<InPlaceEditing | null>(
    () =>
      inPlaceTarget === null
        ? null
        : {
            target: inPlaceTarget,
            onExit: exitInPlace,
            onSaved: savedInPlace,
            guard: leaveGuardRef,
            onFirstDrawing: editorDrawn,
          },
    [inPlaceTarget, exitInPlace, savedInPlace, editorDrawn],
  );
  editingViewRef.current = inPlace === null ? null : activeViewId;
  editHrefRef.current = inPlace === null ? null : window.location.href;
  /** Navigation away from an editor with unsaved edits asks first; `go` runs once the person agrees (or nothing was changed). */
  const guarded =
    <A extends unknown[]>(go: (...args: A) => void) =>
    (...args: A): void => {
      const guard = leaveGuardRef.current;
      if (inPlace === null || guard === null) {
        go(...args);
        return;
      }
      guard(() => {
        leaveInPlace();
        go(...args);
      });
    };
  const editorShown = inPlace !== null && !handoverPending;
  useEffect(() => {
    if (!editorShown || !focusEditorRef.current) return;
    focusEditorRef.current = false;
    return focusEditorWhenShown();
  }, [editorShown]);
  // New → Diagram (and any other link to the editor) is a document load: focus goes into the editor once it is up (F41).
  useEffect(() => (editingRoute ? focusEditorWhenShown() : undefined), [editingRoute]);
  const headingTitles = useRef({ views, notes: contentsNotes });
  headingTitles.current = { views, notes: contentsNotes };
  useEffect(() => {
    if (headingWanted === null) return;
    const from = headingFromRef.current?.deref() ?? null;
    const { views: known, notes } = headingTitles.current;
    const title =
      headingWanted.kind === "view"
        ? known.find((view) => view.id === headingWanted.id)?.title
        : notes.find((note) => note.path === headingWanted.id)?.title;
    // The destination's own heading, not the one of the page it replaces (which may still be up while the note loads).
    return focusWhenShown("h1.primary-document-title, h1.primary-note-title", {
      from,
      accept: (h1) => title === undefined || h1.textContent?.trim() === title,
    });
  }, [headingWanted]);
  const canAuthor = useAuthoringAllowed(currentSlug ?? "");
  // Where this reader may edit, the editor loads when the page is idle, so Edit opens it at once.
  useEffect(
    () =>
      !canAuthor
        ? undefined
        : whenIdle(() => {
            void LazyAuthoringWorkspace.preload();
          }),
    [canAuthor],
  );
  const readingDiagram =
    currentSlug !== null &&
    inPlace === null &&
    !editingRoute &&
    activeViewId !== null &&
    !contentsShown &&
    selectedNotePath === null &&
    missingView === null;
  // New in the header of diagram and note pages (D6); the project page has New in its tab row.
  // Edit is at the top right of the diagram (decided 2026-10-28): the end of its header row, so it never covers the
  // drawing or the off-screen cue (round 1, Cl-12).
  const readingNote =
    currentSlug !== null && inPlace === null && !editingRoute && selectedNotePath !== null && !contentsShown;
  const editName = capabilities.projectName ?? projectNameFromPath(window.location.pathname) ?? currentSlug ?? "";
  const readerEdit =
    runtime.features.authoring && (readingDiagram || readingNote) && currentSlug !== null ? (
      <span className="archer-reader-tools">
        <NewMenu projectSlug={currentSlug} projectName={editName} />
      </span>
    ) : null;
  const activeGone = (() => {
    const f = failureFor(compileFailures, activeViewId);
    return f !== undefined && sourceIsMissing(f);
  })();
  const diagramEdit =
    runtime.features.authoring && readingDiagram && currentSlug !== null && !activeGone ? (
      <div className="archer-diagram-edit">
        <AuthoringEntry projectSlug={currentSlug} projectName={editName} onEdit={startEdit} />
      </div>
    ) : null;
  /*
   * A diagram's address, opening: until the page knows which view it is (the listing) and what the agent presents
   * (the bootstrap), the header's line and the "agent is presenting" notice above the stage are not known either, and
   * each pushed a painted "Loading..." down as it came (0.055 of CLS on diagram and flow, PF-6). The stage keeps its
   * place unpainted until then, at most ROUTE_SETTLE_LIMIT_MS, and once shown it is not hidden again.
   */
  const addressNamesDiagram = fileRouteKind === "file" || fileRouteKind === "view";
  const routeKnown = readingDiagram && inventoryStatus !== "unknown" && (heardFromHost || bootstrapFailed);
  const routeSettling =
    addressNamesDiagram &&
    !routeSettled &&
    !editingRoute &&
    inPlace === null &&
    missingView === null &&
    !routeKnown &&
    (notice === null || notice.kind === "loading" || notice.kind === "none-presented");
  useEffect(() => {
    if (routeSettled) return undefined;
    if (!routeSettling) {
      setRouteSettled(true);
      return undefined;
    }
    const timer = window.setTimeout(() => setRouteSettled(true), ROUTE_SETTLE_LIMIT_MS);
    return () => window.clearTimeout(timer);
  }, [routeSettled, routeSettling]);
  const settleAttr = routeSettling ? { "data-route-settling": "" } : {};
  // The in-place editor sits under this row from its first frame, and the presence line waits for the stage's drawing
  // behind it: the row is kept, blank until the line is known, so the line's arrival cannot push the editor down (O176).
  const holdHeaderRow = inPlace !== null;
  const diagramHeader =
    presence === null && changeNotice === null && diagramEdit === null && !holdHeaderRow ? null : (
      <div className="archer-diagram-header">
        {presence !== null ? (
          <PresenceLine presence={presence} />
        ) : holdHeaderRow ? (
          <p className="archer-presence-reserved" aria-hidden="true">
            {"\u00a0"}
          </p>
        ) : null}
        {changeNotice}
        {diagramEdit}
      </div>
    );
  const stageSurface = (
    // biome-ignore lint/a11y/noStaticElementInteractions: the canvas surface handles pointer and key events for the composite drawing inside it, whose parts are focusable (UI_UX.md: every drag has a keyboard path).
    <div
      className={walking ? "archer-stage archer-walking" : "archer-stage"}
      {...settleAttr}
      aria-describedby={describedBy}
      onContextMenu={handleStageContextMenu}
      onPointerDown={handleStagePointerDown}
      onPointerMove={handleStagePointerMove}
      onPointerUp={handleStagePointerEnd}
      onPointerCancel={handleStagePointerEnd}
      onClickCapture={drawnCommented === undefined ? undefined : handleStageClickCapture}
    >
      {/* Before the canvas in the document, so Tab reaches "what is wrong
          with this drawing" before it reaches the drawing. */}
      <StageDockContext.Provider value={stageDock}>
        {/* The side panel (0.6.4, D5): the mode's surface and the Diagram key, right of the drawing; the dock's sheet on a phone. */}
        <DiagramSidePanel
          added={expand.panel}
          details={expand.details}
          modes={modes}
          walks={notice === null && drawnKeyModel?.type === "graph" ? walkthroughs.walks : []}
          revision={panelView?.modelRevision}
          highlightCount={notice === null ? highlightCount : 0}
          walkthrough={
            walkOpen && notice === null ? (
              <WalkCommentsContext.Provider value={walkComments}>
                <LazyWalkthroughSurface.Component
                  walkthroughs={walkthroughs}
                  presented={walkPresented}
                  onClose={() => modes.exit("close")}
                  noteLink={walkNoteLink}
                  {...(panelView?.lastChange === undefined ? {} : { changedAt: panelView?.lastChange.at })}
                  {...(panelView?.modelRevision === undefined ? {} : { revision: panelView?.modelRevision })}
                />
              </WalkCommentsContext.Provider>
            ) : null
          }
          walkLabel={
            walkthroughs.walk === null
              ? "Walkthroughs"
              : `Walkthrough · Step ${walkthroughs.state.step} of ${walkthroughs.walk.steps.length}`
          }
          keyModel={keyModel}
          switcher={{ highlights: pressHighlights, walkthroughs: openWalkthroughs }}
          omitLinePatterns={legendUp}
          phoneBelow={
            walkOpen && walkthroughs.walk !== null ? (
              <LazyWalkthroughTransport.Component walkthroughs={walkthroughs} />
            ) : null
          }
        >
          <div className="archer-diagram-content">
            {compileNotice}
            <CompileNoticeContext.Provider value={compileNotice !== null}>{canvas}</CompileNoticeContext.Provider>
            {walkOpen && walkthroughs.walk !== null && notice === null ? (
              <LazyWalkthroughStage.Component walkthroughs={walkthroughs} />
            ) : null}
            {walkOpen && walkFollow.note !== null ? (
              <ClosedNote label={walkFollow.note.label} onOpen={walkFollow.note.open} />
            ) : null}
          </div>
        </DiagramSidePanel>
      </StageDockContext.Provider>
      {/* On a phone the side panel is a chip here, under the drawing (G1), with the chat's. */}
      <StageDockStrip onHost={setDockHost} />
    </div>
  );
  // Dev-only render-storm regions (`ui.render-storm`): the stage, the review panel, the browser and the page itself,
  // so the coming split of this component has a commit count per region to hold. Stripped from a production build.
  const stage = __ARCHER_DEBUG__ ? <DevProfiler id="stage">{stageSurface}</DevProfiler> : stageSurface;
  // Source lives in the canvas toolbar (decided 2026-10-25), where the diagram it describes is.
  // Close source takes its own button away: focus goes back to Source, which opened it (F48).
  const closeSource = useCallback(() => {
    toggleSource();
    document.querySelector<HTMLElement>(".archer-source-tool")?.focus({ preventScroll: true });
  }, [toggleSource]);
  const sourceTool: SourceTool | null =
    readingDiagram && currentSlug !== null ? { open: sourceOpen, onToggle: toggleSource } : null;
  // The panel re-reads the source when the view's revision moves (the stream's inventory, else what is drawn),
  // not on every re-present of the same one, nor again when the drawing catches up with a save it already read.
  const sourceRevision = activeView?.modelRevision ?? presentation?.revision;
  const sourceVersion = `${activeViewId}@${sourceRevision ?? `g${presentation?.generation ?? 0}`}`;
  const sourceTarget =
    activeViewId === null
      ? null
      : embeddedAt !== null
        ? { kind: "embedded" as const, address: `${embeddedAt.notePath}#${embeddedAt.name}` }
        : { kind: "view" as const, viewId: activeViewId };
  const reviewPanel = (
    <ReviewPanel
      documentKey={
        contentsShown ? "contents" : selectedNotePath !== null ? `note:${selectedNotePath}` : `view:${activeViewId}`
      }
      mode="floating"
      inboxOpen={reviewOpen}
      selectedNotePath={selectedNotePath}
      onOpenTarget={(target) => {
        if (editingRoute && currentSlug) {
          const path = browserRoutePath(
            onTarget<BrowserRoute>(target, {
              view: ({ viewId }) => ({ kind: "view", projectSlug: currentSlug, viewId }),
              note: ({ path }) => ({ kind: "note", projectSlug: currentSlug, path }),
              project: () => ({ kind: "browse", projectSlug: currentSlug, folder: "" }),
            }),
          );
          if (path) window.location.assign(path);
          return;
        }
        onTarget(target, {
          view: ({ viewId }) => {
            requestedAnchorTarget.current = target;
            openView(viewId);
          },
          note: ({ path }) => {
            requestedAnchorTarget.current = target;
            openNote(path);
          },
          project: () => openProjectChat(),
        });
      }}
      model={review}
      open={reviewOpen}
      onClose={closeReview}
      compose={compose}
      onCompose={openComposer}
      onComposeEnd={closeComposer}
      composeRevision={composeRevision}
      commentScopes={commentScopes(drawn)}
      {...(composeAnchorGone === undefined ? {} : { composeAnchorGone })}
      diagramChoices={pickerChoices}
      onShowAnchor={handleShowAnchor}
      threadRequest={threadRequest}
      inlineNoteDiscussions={selectedNotePath !== null && capabilities.comments}
      onOpenInlineNoteThread={requestThread}
      targetTitle={reviewTargetTitle}
      dismissDiscussion={discussionDismiss}
      onDiscussionShown={closeChat}
    />
  );
  const page = (
    <SourceToolContext.Provider value={sourceTool}>
      <WebShell
        localTools={editingRoute || inPlace !== null ? <div ref={setEditorToolsHost} /> : (readerEdit ?? undefined)}
        context={{
          kind: "project",
          slug: currentSlug,
          actions: {
            notifications: reviewEnabled
              ? {
                  kind: "project-review",
                  toggle: {
                    ref: reviewToggleRef,
                    label: reviewLabel,
                    unreadAnswers: review.unreadAnswers,
                    pending: review.pending,
                    open: reviewOpen,
                    controls: REVIEW_PANEL_ID,
                    onToggle: toggleReview,
                  },
                }
              : capabilitiesKnown
                ? { kind: "unsupported", reason: "comments-capability-absent" }
                : { kind: "pending" },
            settings: { kind: "instance", supported: capabilities.instanceSettings },
          },
        }}
        navigation={{
          workspace: workspace ?? "This project",
          currentSlug,
          place: navigationPlace,
          activeProjectSlug: activeProjectForNavigation(navigationPlace, recents.items),
          overviewOpen: overviewShown,
          searchOpen: searchShown,
          recents: recents.items,
          onContents: guarded(() => {
            if (readLocationRoute(window.location.pathname) !== null) {
              saveBrowserPosition();
              window.location.assign(browserRoutePath({ kind: "projects" })!);
              return;
            }
            readerNavigates();
            setProjectExpansion({ slug: null });
            setSelectedNotePath(null);
            setBrowsedFolder(null);
            setSearchState(null);
            setContentsOpen(true);
          }),
          onSearch: guarded(() => {
            if (editingRoute && currentSlug) {
              const path = browserRoutePath({ kind: "browse", projectSlug: currentSlug, folder: "" });
              if (path) window.location.assign(path);
              return;
            }
            searchShown ? searchInputRef.current?.focus() : goToSearch();
          }),
          onOpenProject: guarded((slug: string) => {
            if (editingRoute) {
              const path = browserRoutePath({ kind: "browse", projectSlug: slug, folder: "" });
              if (path) window.location.assign(path);
              return;
            }
            saveBrowserPosition();
            if (currentSlug !== null && slug !== currentSlug) {
              const url = directoryProjectUrl(window.location.href, slug, { overview: true });
              if (url !== null) window.location.assign(url);
              return;
            }
            readerNavigates();
            setContentsOpen(false);
            setBrowsedFolder(null);
            setSelectedNotePath(null);
            setSearchState(browserNavigationState(slug, null, searchState ?? EMPTY_SEARCH));
          }),
          onOpenRecent: guarded(openRecent),
          onDismissReview: dismissReview,
        }}
        identity={{
          title: editingRoute
            ? (new URLSearchParams(window.location.search).get("viewId") ??
              new URLSearchParams(window.location.search).get("address") ??
              "New Diagram")
            : selectedNotePath !== null
              ? (selectedNote?.title ?? selectedNotePath)
              : searchShown
                ? scopedBrowser
                  ? (browsedTrail.at(-1)?.name ?? workspace ?? "Project")
                  : "Search Projects and Files"
                : folderShown
                  ? breadcrumbCurrent
                  : overviewShown
                    ? "Project Overview"
                    : (activeView?.title ?? "Archer"),
          // A note's reader leads with the note's own title (G6), as the project page leads with its title section.
          ...(editingRoute || inPlace !== null
            ? { badge: <span className="authoring-editing-tag">Editing</span> }
            : {}),
          // From the moment the address names the note (before the capabilities say notes are read), so the header does
          // not lose a line when it opens (PF-6).
          heading:
            !editingRoute &&
            (noteOnScreen ||
              (pendingAddress?.kind === "note" && !capabilitiesKnown) ||
              ((titleSection ?? projectRootAddress()) && (contentsPage !== null || titleSection === null)))
              ? "content"
              : "shell",
          trail: editingRoute ? (
            <Breadcrumb
              project={workspace ?? "Project"}
              trail={[]}
              current={null}
              onProjects={() => window.location.assign(browserRoutePath({ kind: "projects" })!)}
              onProject={() =>
                window.location.assign(
                  browserRoutePath({ kind: "browse", projectSlug: currentSlug!, folder: "" }) ?? "/projects/",
                )
              }
              onFolder={() => undefined}
            />
          ) : (
            <>
              <Breadcrumb
                project={workspace ?? "Project"}
                trail={breadcrumbTrail}
                current={breadcrumbCurrent}
                projectCurrent={(() => {
                  const route = readLocationRoute(window.location.pathname);
                  return (
                    route?.kind === "browse" &&
                    route.folder === "" &&
                    (overviewShown || (scopedBrowser && browsedTrail.length === 0))
                  );
                })()}
                onProjects={
                  readLocationRoute(window.location.pathname) === null
                    ? undefined
                    : guarded(() => {
                        saveBrowserPosition();
                        window.location.assign(browserRoutePath({ kind: "projects" })!);
                      })
                }
                onProject={guarded(goToContents)}
                onFolder={guarded(goToFolder)}
                {...(embeddedAt === null || folderShown || searchShown || selectedNotePath !== null
                  ? {}
                  : {
                      note: {
                        name: embeddedAt.notePath.split("/").at(-1) ?? embeddedAt.notePath,
                        path: embeddedAt.notePath,
                      },
                      onNote: guarded(backToNote),
                    })}
              />
              {embeddedAt !== null &&
              !folderShown &&
              !searchShown &&
              selectedNotePath === null &&
              headerFreshness !== null ? (
                <Freshness freshness={headerFreshness} now={Date.now()} />
              ) : null}
            </>
          ),
        }}
        documentBarRef={observeDocumentBar}
        contents={editingRoute ? false : contentsShown}
        help={{ controller: help, view: editingRoute ? "none" : helpView, extra: helpExtra }}
      >
        {editingRoute && currentSlug ? (
          <AuthoringWorkspace
            projectSlug={currentSlug}
            toolbarHost={editorToolsHost}
            connected={runtime.writable(connection)}
          />
        ) : (
          <>
            {contentsPage === null ? null : (
              <>
                {staleStrip}
                {/* What the tabs control while no tab is selected: the tabs'
                  `aria-controls` must name an element that is there. */}
                <div className="archer-contents-panel">
                  {__ARCHER_DEBUG__ ? <DevProfiler id="browser">{contentsPage}</DevProfiler> : contentsPage}
                </div>
              </>
            )}
            {selectedNotePath !== null && (contentsPage === null || staleStrip === null) ? noteStrip : null}
            {selectedNotePath !== null ? (
              <NoteReader
                model={review}
                path={selectedNotePath}
                onOpenLink={openNoteLink}
                searchMatch={noteSearchMatch?.path === selectedNotePath ? noteSearchMatch : null}
                {...(noteFigures === undefined ? {} : { figures: noteFigures })}
                onOpenDiagram={openEmbedded}
                onReturned={() => setNoteReturn(null)}
                {...(noteReturn !== null && noteReturn.path === selectedNotePath ? { returnTo: noteReturn } : {})}
                note={contentsNotes.find((note) => note.path === selectedNotePath)}
                onCompose={openComposer}
                onOpenThread={requestThread}
                incomingThreadRequest={threadRequest}
              />
            ) : contentsPage !== null ? null : (
              <>
                {/* Directly under the tabs: picking a diagram and picking a flow through
              it are one gesture. Absent from the MCP shell, which wears no chrome. */}
                {/* With the header's line beside them: one row on a phone (G1), two rows otherwise. */}
                <div className="archer-diagram-strip">
                  {inPlace !== null ? null : (
                    <DataflowChips
                      emphases={emphasis.emphases}
                      activeId={emphasis.activeId}
                      onSelect={handleSelectEmphasis}
                    />
                  )}
                  {diagramHeader}
                </div>
                {staleStrip}
                {readerViewNotice}
                {changePulse}
                {missingView !== null ? (
                  <section className="archer-route-missing" role="alert">
                    <h2>Diagram Not Found</h2>
                    <p>No diagram named “{missingView}” is in this project. It may have been renamed or deleted.</p>
                    <p>
                      <button type="button" onClick={goToContents}>
                        Go to the project
                      </button>
                    </p>
                  </section>
                ) : null}
                {missingView === null && inPlace !== null && currentSlug !== null ? (
                  <div
                    className={
                      handoverPending ? "archer-editor-slot archer-editor-slot--pending" : "archer-editor-slot"
                    }
                    {...(handoverPending ? { "aria-hidden": true } : {})}
                  >
                    <AuthoringWorkspace
                      key={editorKey ?? undefined}
                      projectSlug={currentSlug}
                      toolbarHost={editorToolsHost}
                      inPlace={inPlace}
                      externalRevision={activeView?.modelRevision}
                      connected={runtime.writable(connection)}
                    />
                  </div>
                ) : null}
                {/* The reading drawing keeps this slot (never remounted by Edit), and stays until the editor has drawn. */}
                {missingView !== null || (inPlace !== null && !handoverPending) ? null : reviewEnabled ||
                  walkCount > 0 ? (
                  // The drawing and the side panel, side by side (the walkthroughs', or the review's below); on a
                  // phone-width window the review panel takes the stage while open (`styles.css`) and the
                  // walkthroughs are a sheet in the stage's dock. A page with neither is as it was.
                  <div className="archer-review-row" data-review-open="false" {...settleAttr}>
                    {stage}
                    {/* The chat's sidebar, beside the walkthrough panel (never over it). */}
                    <div className="archer-chat-host" ref={setChatHost} />
                  </div>
                ) : (
                  stage
                )}
                {readingDiagram && sourceOpen && sourceTarget !== null ? (
                  <SourcePanel
                    target={sourceTarget}
                    version={sourceVersion}
                    {...(sourceRevision === undefined ? {} : { revision: sourceRevision })}
                    onClose={closeSource}
                    {...(canAuthor ? { onEditSource: startEdit } : {})}
                  />
                ) : null}
              </>
            )}
          </>
        )}
        {reviewEnabled ? (
          <WalkCommentsContext.Provider value={walkComments}>
            {__ARCHER_DEBUG__ ? <DevProfiler id="review-panel">{reviewPanel}</DevProfiler> : reviewPanel}
          </WalkCommentsContext.Provider>
        ) : null}
        {chatShown ? (
          <ChatBubble
            key={contentsShown ? "project" : (selectedNotePath ?? reviewViewId ?? "")}
            review={review}
            transport={commentsTransport}
            doc={
              contentsShown
                ? { viewId: null, projectOnly: true }
                : {
                    viewId: reviewViewId,
                    notePath: selectedNotePath,
                    walk:
                      walkOpen && walkthroughs.walk !== null
                        ? { id: walkthroughs.walk.id, title: walkthroughs.walk.title }
                        : null,
                  }
            }
            title={
              contentsShown
                ? (workspace ?? "This project")
                : selectedNotePath !== null
                  ? (contentsNotes.find((note) => note.path === selectedNotePath)?.title ?? selectedNotePath)
                  : viewTitle(reviewViewId ?? "")
            }
            projectTitle={workspace ?? "This project"}
            context={chatWhere}
            sidebarHost={selectedNotePath === null && !contentsShown ? chatHost : null}
            dockHost={dockHost}
            openRequest={chatAsk}
            projectRequest={projectChatAsk}
            closeRequest={chatClose}
            onOpenChange={onChatOpenChange}
            drafts={chatDrafts.current}
            {...(runtime.examples === undefined || currentSlug === null
              ? {}
              : { example: exampleChat(runtime.examples, currentSlug) })}
          />
        ) : null}
        {!editingRoute && comparisonOpen && capabilities.comments && !contentsShown && activeViewId !== null ? (
          <div id="archer-comparison-panel" className="archer-comparison-panel">
            <RevisionCompare viewId={activeViewId} callOperation={callAccuracyOperation} onClose={closeComparison} />
          </div>
        ) : null}
        {!editingRoute &&
        exportOpen &&
        capabilities.comments &&
        !contentsShown &&
        activeViewId !== null &&
        projectedRef.current?.view.viewId === activeViewId ? (
          <div id="archer-export-panel" className="archer-artifact-wrapper">
            <ExportControls
              viewId={activeViewId}
              revision={projectedRef.current.view.revision}
              annotation={caption ?? ""}
              activeEmphasisId={activeEmphasis(emphasis)?.id ?? null}
              theme={readAppliedTheme()}
              callOperation={callAccuracyOperation}
              onClose={closeExport}
            />
          </div>
        ) : null}
        {!editingRoute && accuracyOpen && capabilities.comments && !contentsShown && activeViewId !== null ? (
          <div id="archer-accuracy-panel" className="archer-artifact-wrapper">
            <Staleness viewId={activeViewId} callOperation={callAccuracyOperation} onClose={closeAccuracy} />
          </div>
        ) : null}
        <Caption text={editingRoute || contentsShown ? null : caption} inHeader={presence?.detailIsCaption === true} />
      </WebShell>
    </SourceToolContext.Provider>
  );
  return __ARCHER_DEBUG__ ? <DevProfiler id="project-app">{page}</DevProfiler> : page;
}
