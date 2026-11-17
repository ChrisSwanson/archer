import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HelpController } from "./HelpOverlay";
import { characterShortcutsEnabled, isTypingTarget, KEYMAP, matchesShortcut } from "./shortcuts";

/** One state/keyboard owner for workspace Help; pages retain their domain shortcuts. */
export function useShellHelp(): HelpController {
  const [open, setOpen] = useState(false);
  const [fitOwners, setFitOwners] = useState(0);
  const registerFit = useCallback(() => {
    setFitOwners((count) => count + 1);
    return () => setFitOwners((count) => count - 1);
  }, []);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const hide = useCallback(() => setOpen(false), []);
  return useMemo(
    () => ({ open, toggle, hide, fitAvailable: fitOwners > 0, registerFit }),
    [open, toggle, hide, fitOwners, registerFit],
  );
}

export function useShellShortcuts(help: HelpController, onSearch?: () => void, enabled = true): void {
  const current = useRef({ help, onSearch });
  useEffect(() => {
    current.current = { help, onSearch };
  }, [help, onSearch]);
  useEffect(() => {
    if (!enabled) return;
    const handle = (event: KeyboardEvent): void => {
      const { help, onSearch } = current.current;
      if (event.defaultPrevented) return;
      // A local step-row handler also owns C. The browser-wide off choice must reach it too.
      // Preserve native typing/type-ahead and defaults; only Archer's handlers are stopped.
      if (
        !characterShortcutsEnabled() &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !isTypingTarget(event.target) &&
        Object.values(KEYMAP).some((binding) => (binding.keys as readonly string[]).includes(event.key))
      ) {
        event.stopImmediatePropagation();
        return;
      }
      if (event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      // Local tools and other modals keep their own keys, even on non-input controls.
      if (target?.closest(".archer-artifact-panel, .accuracy-compare, [data-archer-local-keys]")) return;
      const modal = target?.closest('[aria-modal="true"], dialog[open]');
      if (modal && !modal.classList.contains("help-overlay")) return;
      const consume = (): void => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      if (help.open && event.key === "Escape") {
        consume();
        help.hide();
        return;
      }
      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (matchesShortcut(event, "help")) {
        consume();
        help.toggle();
        return;
      }
      if (!help.open && onSearch && (matchesShortcut(event, "search") || matchesShortcut(event, "go"))) {
        consume();
        onSearch();
      }
    };
    // Shared actions precede page handlers; consumed Escape never reaches selection/emphasis.
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, [enabled]);
}
