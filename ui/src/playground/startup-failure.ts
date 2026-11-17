import "./startup-failure.css";

/**
 * What the Playground shows when its data or a view's code did not download: the fact, how to recover, and Retry.
 * Plain DOM on purpose: the code that failed to arrive may be React's own chunk. The entry's stylesheet (the
 * page notice) is already loaded. It never takes focus, since the landing runs it inside the docs page's frame.
 */
export const FAILURE_HEADLINE = "This example could not load.";
export const FAILURE_DETAIL = "Part of it did not download. Check your connection, then retry.";

export function showStartupFailure(root: HTMLElement, retry: () => void): void {
  const notice = document.createElement("div");
  notice.className = "archer-notice playground-startup-failure";
  notice.setAttribute("role", "alert");
  const headline = document.createElement("p");
  headline.className = "archer-notice-headline";
  headline.textContent = FAILURE_HEADLINE;
  const detail = document.createElement("p");
  detail.className = "archer-notice-detail";
  detail.textContent = FAILURE_DETAIL;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "archer-review-button";
  button.textContent = "Retry";
  button.addEventListener("click", retry);
  notice.append(headline, detail, button);
  root.replaceChildren(notice);
}
