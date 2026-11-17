type Position = { scrollTop: number; row: string | null; search: boolean; collapsedProjects?: string[] };
function projectNames(value: unknown): string[] {
  return Array.isArray(value) && value.length <= 64
    ? value.filter((name): name is string => typeof name === "string" && name.length <= 240)
    : [];
}
export function restoredCollapsedProjects(): ReadonlySet<string> {
  return new Set(projectNames(window.history.state?.archerBrowserPosition?.collapsedProjects));
}
/** Store only browser-local position, never semantic/project state. */
export function saveBrowserPosition(): void {
  const panel = document.querySelector<HTMLElement>(".archer-contents-panel");
  if (!panel) return;
  const active = document.activeElement;
  const row =
    active instanceof Element
      ? (active.closest<HTMLElement>("[data-browser-row],[data-browser-folder]")?.dataset.browserRow ??
        active.closest<HTMLElement>("[data-browser-folder]")?.dataset.browserFolder ??
        null)
      : null;
  const groups = [...panel.querySelectorAll<HTMLElement>("[data-browser-project]")].slice(0, 64);
  const position: Position = {
    scrollTop: panel.scrollTop,
    row,
    search: active instanceof HTMLInputElement && active.type === "search",
    collapsedProjects: groups
      .filter((group) => group.dataset.projectCollapsed === "true")
      .map((group) => group.dataset.browserProject!),
  };
  const state = window.history.state;
  window.history.replaceState(
    { ...(typeof state === "object" && state !== null ? state : {}), archerBrowserPosition: position },
    "",
  );
}
export function restoreBrowserPosition(): boolean {
  const value = window.history.state?.archerBrowserPosition as Position | undefined;
  if (
    !value ||
    !Number.isFinite(value.scrollTop) ||
    value.scrollTop < 0 ||
    value.scrollTop > 10000000 ||
    (value.row !== null && (typeof value.row !== "string" || value.row.length > 8192))
  )
    return true;
  const panel = document.querySelector<HTMLElement>(".archer-contents-panel");
  if (!panel) return false;
  panel.scrollTop = value.scrollTop;
  if (value.row !== null) {
    const row = [...panel.querySelectorAll<HTMLElement>("[data-browser-row],[data-browser-folder]")].find(
      (element) => (element.dataset.browserRow ?? element.dataset.browserFolder) === value.row,
    );
    const button =
      row?.querySelector<HTMLElement>("[data-tree-primary]") ?? row?.querySelector<HTMLElement>("button,a");
    if (!button) return false;
    button.focus({ preventScroll: true });
  } else if (value.search)
    panel.querySelector<HTMLInputElement>('input[type="search"]')?.focus({ preventScroll: true });
  return true;
}
