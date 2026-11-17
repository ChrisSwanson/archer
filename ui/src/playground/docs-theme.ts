import { applyTheme, type ResolvedTheme } from "../theme/theme";

/**
 * The landing's live frame wears the docs page's theme, not its own stored preference: the page names its resolved
 * theme in the frame's address and sends each later change (site/.vitepress/theme/live-demo.mts). The scene has no
 * theme switch of its own, so this is the frame's only theme owner.
 */
const MESSAGE = "archer-docs-theme";
const isTheme = (value: unknown): value is ResolvedTheme => value === "light" || value === "dark";

/** Stamps the theme the address names; false (nothing stamped) when it names none, or not exactly one valid one. */
export function startDocsTheme(href: string): boolean {
  const named = new URL(href).searchParams.getAll("theme");
  if (named.length !== 1 || !isTheme(named[0])) return false;
  applyTheme(named[0]);
  return true;
}

/** Follows `{ type, theme }` messages from the parent document on this origin; returns the unsubscribe. */
export function followDocsTheme(win: Window, parent: Window | null = win.parent): () => void {
  const receive = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (
      parent === null ||
      parent === win ||
      event.source !== parent ||
      event.origin !== win.location.origin ||
      typeof data !== "object" ||
      data === null ||
      Object.keys(data).length !== 2 ||
      (data as { type?: unknown }).type !== MESSAGE
    )
      return;
    const theme = (data as { theme?: unknown }).theme;
    if (isTheme(theme)) applyTheme(theme);
  };
  win.addEventListener("message", receive);
  return () => win.removeEventListener("message", receive);
}
