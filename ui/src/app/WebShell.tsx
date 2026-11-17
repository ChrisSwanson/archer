import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { ReviewToggle } from "../comments/ReviewToggle";
import ArcherSettings from "./ArcherSettings";
import { ServiceSettingsAction } from "./ServiceSettingsAction";
import { WorkspaceNotifications } from "./workspace-notifications";
import { FileUpdatesPopup } from "./FileUpdatesPopup";
import { ApplicationUpdateCue } from "./ApplicationUpdateCue";
import { HelpOverlay, HelpProvider, type HelpController, type HelpView, type Section } from "./HelpOverlay";
import { useShellShortcuts } from "./shell-help";
import { ThemeToggle } from "./ThemeToggle";
import { WorkspaceNavigation } from "./WorkspaceNavigation";

type InstanceSettings = { readonly kind: "instance"; readonly supported: boolean };
type ProjectNotifications =
  | { readonly kind: "project-review"; readonly toggle: ComponentProps<typeof ReviewToggle> }
  | { readonly kind: "unsupported"; readonly reason: "comments-capability-absent" }
  /** The project's capabilities are not known yet: the bell's place is kept, so the header does not move when it comes (PF-6). */
  | { readonly kind: "pending" };
type WorkspaceActions = {
  readonly notifications: { readonly kind: "workspace" };
  readonly settings: { readonly kind: "discover" };
};

/** Required policy bindings: the shell derives notification scope from route context. */
export const WORKSPACE_ACTIONS: WorkspaceActions = {
  notifications: { kind: "workspace" },
  settings: { kind: "discover" },
};
export type WebShellContext =
  | { readonly kind: "service"; readonly actions: WorkspaceActions }
  | {
      readonly kind: "source";
      readonly slug: string;
      readonly path: string /** "read-only" while a document is shown; `null` where there is none (not found, loading), which is neither. */;
      readonly annotation: "read-only" | null;
      readonly actions: WorkspaceActions;
    }
  | {
      readonly kind: "project";
      readonly slug: string | null;
      readonly actions: {
        readonly notifications: ProjectNotifications;
        readonly settings: InstanceSettings;
      };
    };

export type WebShellProps = {
  readonly context: WebShellContext;
  readonly navigation: Omit<ComponentProps<typeof WorkspaceNavigation>, "drawer" | "onDrawer" | "onHelp" | "settings">;
  readonly identity: {
    readonly title: ReactNode;
    readonly trail?: ReactNode;
    /**
     * Who holds the page's one `h1`: the shell's title (default), or the page content
     * (the project page's title section), when the shell shows only the trail.
     */
    readonly heading?: "shell" | "content";
    /** A short state tag beside the title, such as "Editing"; outside the `h1`, so not part of its name. */
    readonly badge?: ReactNode;
  };
  readonly help: { readonly controller: HelpController; readonly view: HelpView; readonly extra?: readonly Section[] };
  readonly documentBarRef?: Ref<HTMLElement>;
  readonly contents?: boolean;
  /** Page-local tools; shared workspace actions retain their owner and placement. */
  readonly localTools?: ReactNode;
  readonly children: ReactNode;
};

function exhaustive(value: never): never {
  throw new Error(`Unknown web-shell binding: ${String(value)}`);
}
function notifications(context: WebShellContext): ReactNode {
  const binding = context.actions.notifications;
  switch (binding.kind) {
    case "project-review":
      return <ReviewToggle {...binding.toggle} />;
    case "workspace":
      return (
        <WorkspaceNotifications
          key={context.kind === "source" ? `source:${context.slug}` : "service"}
          scope={context.kind === "source" ? { kind: "project", slug: context.slug } : { kind: "service" }}
        />
      );
    case "unsupported":
      return null;
    case "pending":
      return <span className="primary-action-reserve" aria-hidden="true" />;
    default:
      return exhaustive(binding);
  }
}
function settings(binding: WebShellContext["actions"]["settings"]): ReactNode {
  switch (binding.kind) {
    case "instance":
      return <ArcherSettings supported={binding.supported} />;
    case "discover":
      return <ServiceSettingsAction />;
    default:
      return exhaustive(binding);
  }
}

const FOCUSABLE =
  "a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex='-1']), [contenteditable='true']";
/**
 * The drawing's own nodes, lines and messages, and the nested view's "+" and "−" over its frames: a pan
 * moves them by transform alone, which nothing here watches, so a mark made before a pan goes stale and
 * Tab skips the drawing. The canvas brings a focused one into the clear part of the view itself
 * (`DiagramCanvas.tsx`: `RevealCamera`, `NestToggleReveal`), so they are never ours to mark; a toggle
 * marked under the phone's sheet could not be tabbed to, so would never be brought out. The
 * canvas controls (zoom, Fit and the rest) do not pan and stay in the covered set.
 */
const DRAWING = ".react-flow__renderer, .archer-seq-viewport, .archer-nest-toggles";
/** The review where it lies over the page (not hosted in a panel), and the diagram's tool panels. */
const REVIEW = ".primary-review-inbox";
/** The phone's Chat sheet (ChatPanel.tsx); the desktop's floating chat window is moved aside, not covered by. */
const CHAT_SHEET = ".archer-chat[data-mode='sheet']";
const COVERS = `.primary-floating-discussion, ${REVIEW}, .archer-artifact-wrapper, .archer-comparison-panel, ${CHAT_SHEET}, .archer-diagram-panel[data-overlay], .archer-dock-sheet`;

/**
 * Overlay focus policy (application-shell.md: the shell owns overlay dismissal and focus). The project
 * review, where it is not hosted in a panel, lies over the page beside it: what it covers cannot be seen,
 * so it cannot be tabbed to either (G4, round 1 #2). Each control whose centre lies under it is inert
 * while it does and is given back when it stops; the rest of the page stays usable, since the sidebar
 * is not a dialog. When it closes with focus inside it, focus goes back to the button that opened it.
 * The diagram's Export, accuracy and Compare panels lie over the page the same way and take the same
 * policy (round 1 pass 5, R4-01); their own close returns focus to the tools (App.tsx). So does the phone's
 * Chat sheet, which lies over the canvas controls, the Highlights chip and the Chat button (pass 6,
 * R5-claude-01). Its own close focuses that button while it is still inert, which the browser ignores, so
 * a sheet closed with focus in it gives focus to its button here, once the button is usable again.
 */
function useCoveredInert(root: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const shell = root.current;
    if (shell === null) return;
    let ours = new Set<HTMLElement>();
    /** Covered scrolling regions held still, with the inline `overflow` each had before. */
    const clipped = new Map<HTMLElement, string>();
    const restore = (scroller: HTMLElement, was: string): void => {
      if (was === "") scroller.style.removeProperty("overflow");
      else scroller.style.setProperty("overflow", was);
    };
    const unclip = (): void => {
      for (const [scroller, was] of clipped) restore(scroller, was);
      clipped.clear();
    };
    let open: HTMLElement | null = null;
    let sheet: HTMLElement | null = null;
    let frame = 0;
    const covers = (): HTMLElement[] =>
      [...shell.querySelectorAll<HTMLElement>(COVERS)].filter(
        (panel) =>
          !panel.hidden &&
          (getComputedStyle(panel).position === "fixed" || panel.matches(".archer-diagram-panel[data-overlay]")),
      );
    const update = (): void => {
      frame = 0;
      const all = covers();
      const review = all.find((panel) => panel.matches(REVIEW)) ?? null;
      if (review === null) {
        const was = open;
        open = null;
        // Closed with focus in it: back to the button that opened it, not to the top of the page. A review
        // that moved into the diagram panel is still open, and keeps its focus (round 1 pass 2, F5 f).
        const moved = was?.isConnected && !was.hidden;
        if (
          was !== null &&
          !moved &&
          (document.activeElement === document.body ||
            document.activeElement === null ||
            was.contains(document.activeElement))
        ) {
          shell.querySelector<HTMLElement>(`[aria-controls="${was.id}"]`)?.focus();
        }
      } else open = review;
      const chat = all.find((panel) => panel.matches(CHAT_SHEET)) ?? null;
      const closedChat = chat === null && sheet !== null && !sheet.isConnected ? sheet : null;
      sheet = chat;
      // Once what it covered is usable again (below): focus lost with the sheet goes back to its button.
      const giveBack = (): void => {
        if (closedChat === null || (document.activeElement !== document.body && document.activeElement !== null))
          return;
        shell.querySelector<HTMLElement>(`[aria-controls="${closedChat.id}"]`)?.focus({ preventScroll: true });
      };
      if (all.length === 0) {
        for (const element of ours) element.removeAttribute("inert");
        ours = new Set();
        unclip();
        giveBack();
        return;
      }
      if (typeof document.elementFromPoint !== "function") return;
      /** One of the covers, or something in one. */
      const over = {
        contains: (node: Node | null): boolean => node !== null && all.some((panel) => panel.contains(node)),
      };
      // Inert by someone else (a dialog, a closed drawer): not ours to judge or to give back.
      const foreign = (element: HTMLElement): boolean => {
        for (let at: HTMLElement | null = element; at !== null && at !== shell; at = at.parentElement) {
          if (at.hasAttribute("inert") && !ours.has(at)) return true;
        }
        return false;
      };
      // What the centre of an element's part inside the window meets: under the review, beside it, or off-screen.
      const under = (element: HTMLElement): boolean | null => {
        const box = element.getBoundingClientRect();
        const left = Math.max(box.left, 0),
          right = Math.min(box.right, window.innerWidth);
        const top = Math.max(box.top, 0),
          bottom = Math.min(box.bottom, window.innerHeight);
        if (right <= left || bottom <= top) return null;
        const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
        return hit === null ? null : over.contains(hit);
      };
      const covered = new Set<HTMLElement>();
      const beside: HTMLElement[] = [];
      for (const element of shell.querySelectorAll<HTMLElement>(FOCUSABLE)) {
        if (over.contains(element) || foreign(element) || element.closest(DRAWING) !== null) continue;
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        if (hit !== null && over.contains(hit)) covered.add(element);
        else if (hit !== null) beside.push(element);
      }
      // A scrolling region whose controls are all covered would become a Tab stop of its own (the browser
      // makes a scroller with nothing focusable in it focusable; axe `scrollable-region-focusable`), and
      // its off-screen controls would scroll into view under the review. When what shows of it lies under
      // the review and none of its controls is beside it, it is held (round 1 pass 2, F5 a; pass 3, RS2-02):
      // all of its controls are inert, the off-screen ones too, and it stops scrolling while covered.
      const scrollers = new Set<HTMLElement>();
      for (const element of covered) {
        for (
          let at = element.parentElement;
          at !== null && at !== shell && !all.some((panel) => at!.contains(panel));
          at = at.parentElement
        ) {
          const style = getComputedStyle(at);
          const scrolls =
            (/(auto|scroll)/.test(style.overflowY) && at.scrollHeight > at.clientHeight) ||
            (/(auto|scroll)/.test(style.overflowX) && at.scrollWidth > at.clientWidth);
          if (scrolls || clipped.has(at)) scrollers.add(at);
        }
      }
      // The region itself is not inert: `inert` takes a whole subtree out of the accessibility tree, and
      // nothing inside can opt back in (`aria-hidden="false"` does not undo it), so an inert region took
      // the page's `h1` and its other headings with it, leaving the page without a level-one heading.
      // With its controls inert and `overflow: hidden`, the region is neither a Tab stop nor a scroller
      // (axe and the browser look for `auto` or `scroll`), and its text and headings stay readable.
      const clip = new Set<HTMLElement>();
      for (const scroller of scrollers) {
        if (under(scroller) !== true || beside.some((element) => scroller.contains(element))) continue;
        clip.add(scroller);
        for (const element of scroller.querySelectorAll<HTMLElement>(FOCUSABLE))
          if (!over.contains(element) && !foreign(element) && element.closest(DRAWING) === null) covered.add(element);
      }
      for (const [scroller, was] of clipped)
        if (!clip.has(scroller)) {
          restore(scroller, was);
          clipped.delete(scroller);
        }
      for (const scroller of clip) {
        if (clipped.has(scroller)) continue;
        clipped.set(scroller, scroller.style.getPropertyValue("overflow"));
        scroller.style.setProperty("overflow", "hidden");
      }
      // A column header that is a sort button, its button covered, is covered as a whole: an inert button left in
      // a header that is not inert reads as an empty header (axe `empty-table-header`).
      for (const element of [...covered]) {
        const header = element.parentElement?.closest<HTMLElement>("[role='columnheader']");
        if (
          header &&
          shell.contains(header) &&
          !all.some((panel) => header.contains(panel)) &&
          !beside.some((other) => header.contains(other))
        )
          covered.add(header);
      }
      for (const element of ours) if (!covered.has(element)) element.removeAttribute("inert");
      for (const element of covered) element.setAttribute("inert", "");
      ours = covered;
      giveBack();
    };
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    // Its own `inert` writes are not watched, so marking what is covered does not run it again.
    const observer = new MutationObserver(schedule);
    observer.observe(shell, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["hidden", "data-hosted", "class", "style"],
    });
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    // It slides in: what it covers is known once it has arrived.
    shell.addEventListener("animationend", schedule);
    schedule();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
      shell.removeEventListener("animationend", schedule);
      if (frame !== 0) cancelAnimationFrame(frame);
      for (const element of ours) element.removeAttribute("inert");
      unclip();
    };
  }, [root]);
}

/**
 * The phone's drawer launcher. Its tooltip says what the drawer holds, so a reader looking for Settings or Help
 * finds them behind it (H2 T10/T16: a launcher's name or tooltip carries the task's word; round 1 pass 5, R4-05).
 * The name stays "Menu", the one the focus checkpoints address (F58, F60), and the bar keeps its one icon.
 */
export const MENU_HINT = "Projects, settings and help";
function MenuButton(props: { readonly open: boolean; readonly onOpen: () => void }): ReactNode {
  return (
    <button
      type="button"
      className="primary-drawer-button"
      aria-label="Menu"
      title={MENU_HINT}
      aria-expanded={props.open}
      onClick={props.onOpen}
    >
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
        <path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </button>
  );
}

/** Shared composition owner. Content slots cannot replace workspace actions or keyboard policy. */
export function WebShell(props: WebShellProps): ReactNode {
  const root = useRef<HTMLDivElement>(null);
  const [drawer, setDrawer] = useState(false);
  const restoreHelpFocus = useCallback((previous: HTMLElement | SVGElement | null): void => {
    const menu = root.current?.querySelector<HTMLButtonElement>(".primary-drawer-button");
    if (previous?.closest(".primary-navigation") && menu && getComputedStyle(menu).display !== "none") menu.focus();
    else previous?.focus();
  }, []);
  const onDrawer = useCallback(
    (open: boolean): void => {
      setDrawer(open);
      if (open) return;
      const active = document.activeElement;
      if (
        (active instanceof HTMLElement || active instanceof SVGElement) &&
        root.current?.querySelector(".primary-navigation")?.contains(active)
      ) {
        restoreHelpFocus(active);
      }
    },
    [restoreHelpFocus],
  );
  useShellShortcuts(props.help.controller, props.navigation.onSearch);
  useCoveredInert(root);
  return (
    <HelpProvider value={props.help.controller}>
      <div
        ref={root}
        className="archer-web-shell primary-shell"
        data-shell-scope={props.context.kind}
        data-notifications-binding={props.context.actions.notifications.kind}
        data-notifications-reason={
          "reason" in props.context.actions.notifications ? props.context.actions.notifications.reason : undefined
        }
        data-settings-binding={props.context.actions.settings.kind}
      >
        <WorkspaceNavigation
          {...props.navigation}
          drawer={drawer}
          onDrawer={onDrawer}
          onHelp={props.help.controller.toggle}
          settings={settings(props.context.actions.settings)}
        />
        <header className="primary-document-bar" ref={props.documentBarRef}>
          <MenuButton open={drawer} onOpen={() => onDrawer(true)} />
          <div className="primary-document-identity">
            {props.identity.trail === undefined ? null : (
              <div className="primary-document-trail">{props.identity.trail}</div>
            )}
            {props.identity.heading === "content" ? null : props.identity.badge === undefined ? (
              <h1 className="primary-document-title">{props.identity.title}</h1>
            ) : (
              <div className="primary-document-heading">
                <h1 className="primary-document-title">{props.identity.title}</h1>
                {props.identity.badge}
              </div>
            )}
            {props.context.kind === "source" && props.context.annotation === "read-only" ? (
              <span className="archer-source-readonly">Read-only</span>
            ) : null}
          </div>
          {props.localTools === undefined ? null : (
            <div className="primary-document-local-tools">{props.localTools}</div>
          )}
          <div className="primary-document-actions">
            <ApplicationUpdateCue />
            <FileUpdatesPopup />
            {notifications(props.context)}
            <ThemeToggle />
          </div>
        </header>
        <main className="archer-main" data-contents={props.contents ? "true" : undefined}>
          {props.children}
        </main>
        <HelpOverlay
          open={props.help.controller.open}
          onClose={props.help.controller.hide}
          onRestoreFocus={restoreHelpFocus}
          view={props.help.view}
          extra={props.help.extra}
        />
      </div>
    </HelpProvider>
  );
}
