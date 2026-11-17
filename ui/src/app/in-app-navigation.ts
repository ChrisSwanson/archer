/**
 * Going from the overview to a project's page without loading the page again (claude-503): the address is pushed and
 * the page's root (App.tsx `useOverviewSwitch`) shows the project's page for it. Offline, the person stays in Archer,
 * with its own connection notice, instead of the browser's error page.
 */
export const IN_APP_NAVIGATION = "archer:in-app-navigation";

export function openInApp(href: string): void {
  const url = new URL(href, window.location.href);
  if (url.origin !== window.location.origin) {
    window.location.assign(url.href);
    return;
  }
  window.history.pushState(null, "", url.pathname + url.search + url.hash);
  window.dispatchEvent(new Event(IN_APP_NAVIGATION));
  window.scrollTo(0, 0);
}
