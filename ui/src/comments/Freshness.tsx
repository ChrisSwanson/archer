/**
 * How fresh a note -- and every diagram in it -- is: the last commit that
 * touched the note file (docs/proposals/notes-with-embedded-diagrams.md).
 *
 * Quiet by design: a relative date in the dim voice, with the exact date and
 * the commit's hash on hover (its title) and on focus (the same words,
 * spoken, and shown by the stylesheet beside the focus ring). Uncommitted
 * changes are said in words beside the last commit, never as a colour.
 */
import type { JSX } from "react";
import type { NoteFreshness } from "./contract";
import { relativeTime } from "./state";

export function freshnessText(
  freshness: NoteFreshness,
  now: number,
): { readonly text: string; readonly title: string } {
  switch (freshness.status) {
    case "committed": {
      const at = Date.parse(freshness.committedAt);
      const exact = Number.isFinite(at)
        ? new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
        : freshness.committedAt;
      return {
        text: `Committed ${relativeTime(at, now)}${freshness.uncommitted ? " · uncommitted changes" : ""}`,
        title: `Last commit ${freshness.commit}, ${exact}${freshness.uncommitted ? "; changed since" : ""}`,
      };
    }
    case "never-committed":
      return { text: "Never committed", title: "This note has never been committed to Git" };
    case "not-in-git":
      return {
        text: "Not in Git",
        title: "This project is not in a Git repository, so the note has no commit history",
      };
    default:
      return { text: "Commit history unavailable", title: "Git could not be asked about this note" };
  }
}

export function Freshness(props: { readonly freshness: NoteFreshness; readonly now: number }): JSX.Element {
  const { text, title } = freshnessText(props.freshness, props.now);
  return (
    <span
      className="archer-freshness"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a focus-only metadata span (UI_UX.md, targets), so its title, the full commit detail, reaches the keyboard.
      tabIndex={0}
      title={title}
      data-uncommitted={props.freshness.status === "committed" && props.freshness.uncommitted ? "true" : undefined}
    >
      <span>{text}</span>
      <span className="archer-visually-hidden">: {title}</span>
    </span>
  );
}
