/** Notification entry point; legacy callers retain their pending-draft count. */
import { forwardRef, type JSX } from "react";

export const ReviewToggle = forwardRef<
  HTMLButtonElement,
  {
    readonly label: string;
    readonly pending: number;
    readonly unreadAnswers?: number;
    readonly countDescription?: string;
    readonly open: boolean;
    readonly controls: string;
    readonly onToggle: () => void;
  }
>(function ReviewToggle(props, ref): JSX.Element {
  const count = props.unreadAnswers ?? props.pending;
  const label = props.unreadAnswers === undefined ? props.label : "Notifications";
  const waiting =
    count === 0
      ? ""
      : props.unreadAnswers === undefined
        ? `, ${count} waiting to send`
        : `, ${count} unread agent ${count === 1 ? "answer" : "answers"}`;
  return (
    <button
      ref={ref}
      type="button"
      className={`archer-review-toggle${props.unreadAnswers === undefined ? "" : " archer-notification-toggle"}`}
      aria-expanded={props.open}
      aria-controls={props.controls}
      aria-label={`${label}${waiting}`}
      aria-description={props.countDescription}
      // The compact notification bell keeps its full accessible name and tooltip.
      title={label}
      onClick={props.onToggle}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <path
          d="M3 11.5h10l-1.5-2V6a3.5 3.5 0 0 0-7 0v3.5z M6.5 13a1.5 1.5 0 0 0 3 0"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
      {props.unreadAnswers === undefined ? <span className="archer-review-toggle-label">{label}</span> : null}
      {count === 0 ? null : (
        <span className="archer-review-toggle-count" aria-hidden="true">
          {count}
        </span>
      )}
    </button>
  );
});
