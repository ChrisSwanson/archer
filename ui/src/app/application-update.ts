/**
 * The page after an upgrade (ADR 0032). `archer restart` hands the address to a new service; the page
 * reconnects to it, and its `api/connection` answer names a different `applicationVersion` from the
 * one this page was loaded with. The page is then out of date: it reloads itself when nothing would be
 * lost, and otherwise shows one quiet cue ("Archer was updated · Reload") for the person to take.
 *
 * One owner for the whole page: every HTTP connection reports here, the App Shell renders the cue.
 * A plain reload keeps the address (path, query such as `?follow`, hash); the main scroll position is
 * kept in session storage for the page that loads.
 */
import { isTypingTarget } from "./shortcuts";

/** How long the keyboard must be quiet in a focused field before the page counts the person as not typing. */
export const TYPING_QUIET_MS = 2000;
const SCROLL_KEY = "archer:update-scroll:";
/** The page's own scroll containers, by page: a note or source document, the browser, the editor. */
const SCROLL_ROOTS = [".primary-note-reader", ".archer-browser-content", ".authoring-workspace"] as const;
const RESTORE_TRIES = 50;
const RESTORE_EVERY_MS = 100;

export type ReloadSafety = {
  /** An editor holds unsaved changes (`holdForUnsavedWork`). */
  readonly unsavedWork: boolean;
  /** A comment or label input is open, or a reply has draft text, or a dialog is open (`openDraft`). */
  readonly draftOpen: boolean;
  /** A text field has focus and was typed in within `TYPING_QUIET_MS` (or not yet watched). */
  readonly typing: boolean;
};
/** `reload` now; `wait` and ask again once typing pauses; `cue`: leave it to the person. */
export type ReloadDecision = "reload" | "wait" | "cue";

export function reloadDecision(safety: ReloadSafety): ReloadDecision {
  if (safety.unsavedWork || safety.draftOpen) return "cue";
  return safety.typing ? "wait" : "reload";
}

/** Whether the page shows work a reload would throw away: an open composer or label field, typed text, a dialog. */
export function openDraft(root: ParentNode): boolean {
  if (
    root.querySelector(
      ".archer-composer, .archer-node-label-input, .authoring-inline-text, dialog[open], [aria-modal='true']",
    ) !== null
  )
    return true;
  // Any text the person has typed and not yet saved: every textarea, and text fields outside search.
  for (const field of root.querySelectorAll<HTMLTextAreaElement>("textarea")) {
    if (field.value.trim() !== "" && !field.readOnly && !field.disabled) return true;
  }
  for (const field of root.querySelectorAll<HTMLInputElement>(
    "input:not([type]), input[type=text], input[type=url], input[type=email]",
  )) {
    if (field.value.trim() !== "" && !field.readOnly && !field.disabled && field.closest("[role=search]") === null)
      return true;
  }
  return false;
}

/** The version the service that served this page named in its head (`archer-application-version`), if any. */
function servedVersion(): string | undefined {
  try {
    const content = document.querySelector('meta[name="archer-application-version"]')?.getAttribute("content");
    return content === null || content === undefined || content === "" ? undefined : content;
  } catch {
    return undefined;
  } // no document, or a partial one
}

let first: string | undefined;
let updated = false;
/** Why the cue shows: a new version (`update`), or a layout worker that could not start (`layout`). */
export type ReloadCue = false | "update" | "layout";
let cue: ReloadCue = false;
let holds = 0;
let lastKeyAt: number | undefined;
let recheck: ReturnType<typeof setTimeout> | undefined;
let watchingKeys = false;
let restored = false;
let reloadPage: () => void = () => window.location.reload();
const listeners = new Set<(cue: ReloadCue) => void>();

/**
 * An editor with unsaved changes: the page will not reload itself while held. Returns the release.
 * Uses the editor's own dirty state (the same that arms its `beforeunload` prompt).
 */
export function holdForUnsavedWork(): () => void {
  holds += 1;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      holds -= 1;
    }
  };
}

/** Each negotiated `applicationVersion`; the first is the version this page was loaded with. */
export function observeApplicationVersion(version: string): void {
  // The page's own version: as served (a page loaded just before a hand-over negotiates first with the
  // replacement), else the first one negotiated.
  first ??= servedVersion() ?? version;
  if (updated || version === first) return;
  updated = true;
  decide();
}

function onKey(): void {
  lastKeyAt = Date.now();
  if (recheck !== undefined) clearTimeout(recheck);
  recheck = setTimeout(decide, TYPING_QUIET_MS);
}

function decide(): void {
  recheck = undefined;
  if (typeof document === "undefined") return;
  const focused = isTypingTarget(document.activeElement);
  // Typing in a field when the update lands: assume a keystroke just now, and watch for more.
  if (focused && lastKeyAt === undefined) lastKeyAt = Date.now();
  const typing = focused && lastKeyAt !== undefined && Date.now() - lastKeyAt < TYPING_QUIET_MS;
  const decision = reloadDecision({ unsavedWork: holds > 0, draftOpen: openDraft(document), typing });
  if (decision === "wait") {
    if (!watchingKeys) {
      watchingKeys = true;
      window.addEventListener("keydown", onKey, true);
    }
    recheck = setTimeout(decide, lastKeyAt! + TYPING_QUIET_MS - Date.now());
    return;
  }
  stopWatchingKeys();
  if (decision === "reload") reloadApplication();
  else showCue();
}

function stopWatchingKeys(): void {
  if (watchingKeys) window.removeEventListener("keydown", onKey, true);
  watchingKeys = false;
}

function showCue(reason: "update" | "layout" = "update"): void {
  // A new version explains a failed start too; it is never replaced by the vaguer reason.
  if (cue === "update") return;
  cue = reason;
  for (const listener of listeners) listener(reason);
}

/**
 * The layout worker failed before it ever ran (its file did not load, a policy refused it, or it threw at
 * once): the same cue, with that reason. Only a reload can bring a fresh worker; the page never reloads
 * itself for it, since nothing says a reload would be safe or would help.
 */
export function cueLayoutStartFailure(): void {
  showCue("layout");
}

/** A layout worker answered after all (one made later, say): a cue for a failed start goes away. */
export function clearLayoutStartFailure(): void {
  if (cue !== "layout") return;
  cue = false;
  for (const listener of listeners) listener(false);
}

/** Reload the page in place, keeping its scroll position for the page that loads. */
export function reloadApplication(): void {
  saveScroll();
  reloadPage();
}

export function subscribeApplicationUpdate(listener: (cue: ReloadCue) => void): () => void {
  listeners.add(listener);
  listener(cue);
  return () => {
    listeners.delete(listener);
  };
}

type SavedScroll = {
  readonly window: number;
  readonly roots: readonly { readonly selector: string; readonly top: number }[];
};

function saveScroll(): void {
  try {
    const roots = SCROLL_ROOTS.flatMap((selector) => {
      const element = document.querySelector(selector);
      return element !== null && element.scrollTop > 0 ? [{ selector, top: element.scrollTop }] : [];
    });
    const saved: SavedScroll = { window: window.scrollY, roots };
    sessionStorage.setItem(SCROLL_KEY + window.location.href, JSON.stringify(saved));
  } catch {
    /* blocked storage: the reload still happens, at the top */
  }
}

/**
 * Once per page load: put back the scroll position saved just before an update reload of this same
 * address. Content arrives after the first render, so it tries for a few seconds until each container
 * is tall enough.
 */
export function restoreScrollAfterUpdate(): void {
  if (restored) return;
  restored = true;
  let saved: SavedScroll;
  try {
    const key = SCROLL_KEY + window.location.href;
    const raw = sessionStorage.getItem(key);
    if (raw === null) return;
    sessionStorage.removeItem(key);
    saved = JSON.parse(raw) as SavedScroll;
  } catch {
    return;
  }
  if (typeof saved !== "object" || saved === null || !Array.isArray(saved.roots)) return;
  let pending = saved.roots.filter(
    (root) => typeof root?.top === "number" && (SCROLL_ROOTS as readonly string[]).includes(root.selector),
  );
  const top = typeof saved.window === "number" ? saved.window : 0;
  let tries = 0;
  const attempt = (): void => {
    tries += 1;
    pending = pending.filter(({ selector, top: wanted }) => {
      const element = document.querySelector(selector);
      if (element === null) return true;
      element.scrollTop = wanted;
      return element.scrollTop < wanted - 1 && tries < RESTORE_TRIES;
    });
    if (top > 0 && window.scrollY < top - 1) window.scrollTo(0, top);
    if ((pending.length > 0 || (top > 0 && window.scrollY < top - 1)) && tries < RESTORE_TRIES)
      setTimeout(attempt, RESTORE_EVERY_MS);
  };
  attempt();
}

/** Tests: forget the page's version, cue, holds and watchers; `reload` replaces `location.reload()`. */
export function resetApplicationUpdate(options: { readonly reload?: () => void } = {}): void {
  first = undefined;
  updated = false;
  cue = false;
  holds = 0;
  lastKeyAt = undefined;
  restored = false;
  if (recheck !== undefined) clearTimeout(recheck);
  recheck = undefined;
  if (typeof window !== "undefined") stopWatchingKeys();
  watchingKeys = false;
  reloadPage = options.reload ?? (() => window.location.reload());
  for (const listener of listeners) listener(false);
}
