/**
 * Where a search result matched, field by field (phase3-front-door.md, "Match
 * fields"): "Node · Lexer", "Path · pipeline.mmd", "Note · …excerpt…".
 *
 * Shared by the Projects & files results and the overview's cards. What can be
 * jumped to -- an element of the diagram, a note, a comment thread -- is a
 * button that opens it; the title, path and source are said, not linked, since
 * the result's own row already opens the file. Nothing is drawn for a service
 * that sends no match fields.
 */
import type { JSX } from "react";
import type { MatchField, MatchSummary, SearchMatch } from "./search";

const FIELD_LABEL: Readonly<Record<MatchField, string>> = {
  title: "Title",
  path: "Path",
  node: "Node",
  participant: "Participant",
  edge: "Edge",
  message: "Message",
  group: "Group",
  source: "Source",
  note: "Note",
  comment: "Comment",
};

/** "Node · Lexer": the field in plain words, then what matched. */
export function matchLabel(match: SearchMatch): string {
  return `${FIELD_LABEL[match.field]} · ${match.text}`;
}

/** Whether a match names something the page can open: an element, a note or a thread. */
export function canJump(match: SearchMatch): boolean {
  return (
    match.elementId !== undefined ||
    match.notePath !== undefined ||
    match.threadId !== undefined ||
    match.field === "note"
  );
}

export function SearchMatches(props: {
  readonly summary: MatchSummary | undefined;
  readonly onOpen: (match: SearchMatch) => void;
  /** The list's name; one per result, so name the result. */
  readonly label?: string;
  /** Inside a grid that roves its one tab stop: the matches are reached by the arrow keys, not Tab. */
  readonly roving?: boolean;
}): JSX.Element | null {
  const { summary, onOpen } = props;
  if (summary === undefined || summary.matches.length === 0) return null;
  return (
    <ul className="archer-search-matches" aria-label={props.label ?? "Matches"}>
      {summary.matches.map((match, index) => {
        const body = (
          <>
            <span className="archer-search-match-field">{FIELD_LABEL[match.field]}</span>
            {" · "}
            <span className="archer-search-match-text">{match.text}</span>
          </>
        );
        return (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: a read-only list re-rendered as a whole; its items hold no state.
            key={`${index}:${match.field}:${match.text}`}
            className="archer-search-match"
            data-field={match.field}
          >
            {canJump(match) ? (
              <button
                type="button"
                className="archer-search-match-jump"
                {...(props.roving === true ? { tabIndex: -1, "data-tree-cell": "" } : {})}
                onClick={() => onOpen(match)}
              >
                {body}
              </button>
            ) : (
              <span className="archer-search-match-plain">{body}</span>
            )}
          </li>
        );
      })}
      {summary.more > 0 ? (
        <li className="archer-search-match archer-search-match-more">and {summary.more} more</li>
      ) : null}
    </ul>
  );
}
