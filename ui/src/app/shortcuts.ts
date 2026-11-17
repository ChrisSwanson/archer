/**
 * The shared guards every keyboard binding in the app is subject to.
 *
 * Bindings are registered on `window` rather than on a focused element,
 * because the canvas is the page: there is no single element that reliably
 * holds focus while the user is reading a diagram, and requiring one would
 * make every shortcut depend on where the last click landed.
 *
 * That reach is exactly why the guards below are not optional. A binding on
 * `window` sees keystrokes meant for a text field, and a page that steals `?`
 * from someone typing a question is worse than a page with no shortcuts.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { browserStateKey } from "../runtime/address.ts";

const CHARACTER_KEYS_SETTING = "archer.shortcuts.characters";
const CHARACTER_KEYS_CHANGED = "archer-character-shortcuts-changed";
let memoryCharacters: boolean | undefined;

/** Browser-local, shared by every project and the embedded shell. No service setting or write. */
export function characterShortcutsEnabled(): boolean {
  if (memoryCharacters !== undefined) return memoryCharacters;
  try {
    return localStorage.getItem(browserStateKey(CHARACTER_KEYS_SETTING)) !== "off";
  } catch {
    return true;
  }
}

export function setCharacterShortcutsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(browserStateKey(CHARACTER_KEYS_SETTING), enabled ? "on" : "off");
    memoryCharacters = undefined;
  } catch {
    memoryCharacters = enabled;
  }
  window.dispatchEvent(new Event(CHARACTER_KEYS_CHANGED));
}

function subscribeCharacterShortcuts(changed: () => void): () => void {
  const storage = (event: StorageEvent): void => {
    if (event.key === browserStateKey(CHARACTER_KEYS_SETTING) || event.key === null) {
      memoryCharacters = undefined;
      changed();
    }
  };
  window.addEventListener(CHARACTER_KEYS_CHANGED, changed);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(CHARACTER_KEYS_CHANGED, changed);
    window.removeEventListener("storage", storage);
  };
}

export function useCharacterShortcuts(): boolean {
  return useSyncExternalStore(subscribeCharacterShortcuts, characterShortcutsEnabled);
}

/** The character bindings' spelling and Help text have one owner. */
export const KEYMAP = {
  help: { keys: ["?"], label: "?", meaning: "This list" },
  search: {
    keys: ["/"],
    label: "/",
    meaning: "Search projects and files: names, descriptions, diagrams, notes and comments",
  },
  go: { keys: ["g", "G"], label: "G", meaning: "Go to the search page, ready to type" },
  previous: { keys: ["["], label: "[", meaning: "Previous diagram" },
  next: { keys: ["]"], label: "]", meaning: "Next diagram" },
  comment: {
    keys: ["c", "C"],
    label: "C",
    meaning: "Comment on the selection; otherwise open diagram chat",
  },
  follow: { keys: ["f", "F"], label: "F", meaning: "Follow the steps with the camera, or stop following" },
  fit: { keys: ["1"], label: "1", meaning: "Fit the whole diagram to the view" },
} as const;
export type Shortcut = keyof typeof KEYMAP;

export function shortcutRow(id: Shortcut, meaning: string = KEYMAP[id].meaning): readonly [string, string] {
  return [KEYMAP[id].label, meaning];
}

export function matchesShortcut(event: KeyboardEvent, id: Shortcut, enabled = true): boolean {
  if (
    !enabled ||
    !characterShortcutsEnabled() ||
    event.defaultPrevented ||
    event.isComposing ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey
  )
    return false;
  if (id === "help" && event.key === "/" && event.shiftKey) return true;
  if (id === "search" && event.shiftKey) return false;
  return (KEYMAP[id].keys as readonly string[]).includes(event.key);
}

/** The same capability object gates page dispatch and the optional Help rows. */
export function readerShortcutCapabilities(options: {
  editing: boolean;
  views: number;
  comments: boolean;
  note: boolean;
  contents: boolean;
  reviewView: boolean;
  projectChat: boolean;
  chat: boolean;
  walk: boolean;
  camera: boolean;
}): Readonly<Record<"previous" | "next" | "comment" | "follow", boolean>> {
  const reading = !options.editing;
  return {
    previous: reading && options.views > 1,
    next: reading && options.views > 1,
    comment:
      reading &&
      options.comments &&
      (options.note || (options.projectChat && options.chat) || (options.reviewView && !options.contents)),
    follow: reading && options.walk && options.camera,
  };
}

/**
 * Whether the keystroke belongs to something the user is typing into.
 *
 * `isContentEditable` matters as much as the tag check: a rich-text host is a
 * plain `div` and would otherwise look like the page background.
 *
 * A `<select>` counts: type-ahead picks an option by its first letters, so a
 * key pressed while one has focus is an answer to it, not a page shortcut.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable === true)
  );
}

/** Where keys type text: a typing target other than an input that takes no text (a slider, a checkbox, a button). */
export function isTextEntry(target: EventTarget | null): boolean {
  return isTypingTarget(target) && !(target instanceof HTMLInputElement && NO_TEXT.has(target.type));
}
const NO_TEXT = new Set(["range", "checkbox", "radio", "button", "submit", "reset", "color", "file", "image"]);

/**
 * Registers a window-level `keydown` handler for the life of the component.
 *
 * The handler is held in a ref so that a fresh closure on every render does
 * not re-subscribe: these handlers close over app state that changes on every
 * click, and re-binding the listener each time would be pure churn on the hot
 * path.
 */
export function useWindowKeydown(handler: (event: KeyboardEvent) => void): void {
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey && !characterShortcutsEnabled())
        return;
      handlerRef.current(event);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
}
