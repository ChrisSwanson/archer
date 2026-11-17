/**
 * The user's way into the theme system.
 *
 * One button exposing three states. A click flips to the opposite of whatever
 * is showing; a shift-click drops the override and goes back to following the
 * OS. A three-way cycle was rejected: "system" is not discoverable as a cycle
 * stop, and someone who wants light should not have to pass through it.
 *
 * Shift-click is not discoverable either, so the accessible name says so --
 * and says when the OS is already being followed, because shift-click does
 * nothing then.
 *
 * Self-contained on purpose: it renders a single button, takes no props, and
 * knows nothing about the surrounding chrome, so moving it into an app bar
 * later is a one-line change at the mount site.
 */
import type { JSX, MouseEvent } from "react";
import { useTheme } from "../theme/theme";

/**
 * The icon shows what you GET, not what you have: a sun on a dark page means
 * clicking brings the light one. It is decoration -- the button carries the
 * accessible name, so a screen reader announces the action once instead of
 * describing a shape.
 */
function SunIcon(): JSX.Element {
  return (
    // On the icon scale's padded 24-unit box: the rays end 8 units out, so the sun draws as large as
    // the bell beside it, not edge to edge.
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" data-icon="sun">
      <circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M12 4v1.5M12 18.5V20M20 12h-1.5M5.5 12H4M17.66 6.34l-1.06 1.06M7.4 16.6l-1.06 1.06M17.66 17.66l-1.06-1.06M7.4 7.4 6.34 6.34"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon(): JSX.Element {
  return (
    // The same crescent, centred on the padded 24-unit box at the sun's size.
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" data-icon="moon">
      <path
        transform="translate(12 12) scale(1.3) translate(-7.4 -8.6)"
        d="M13.2 9.7A5.6 5.6 0 0 1 6.3 2.8a5.6 5.6 0 1 0 6.9 6.9Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ThemeToggle(): JSX.Element {
  const { preference, resolved, setPreference } = useTheme();

  const next = resolved === "dark" ? "light" : "dark";
  const following = preference === "system";
  const label = following
    ? `Switch to ${next} mode (currently following your system)`
    : `Switch to ${next} mode · shift-click to follow your system`;

  function onClick(event: MouseEvent<HTMLButtonElement>): void {
    setPreference(event.shiftKey ? "system" : next);
  }

  return (
    <button type="button" className="archer-theme-toggle" onClick={onClick} title={label} aria-label={label}>
      {resolved === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
