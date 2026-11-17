import { useEffect, useState, type JSX, type ReactNode } from "react";
import "./ProjectLifecycle.css";

export function InactiveProjects(props: {
  readonly count: number;
  readonly matchingFiles: number;
  readonly revealMatches: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  const [opened, setOpened] = useState(false);
  const forced = props.revealMatches && props.matchingFiles > 0;
  useEffect(() => {
    if (forced) setOpened(true);
  }, [forced]);
  const open = forced || opened;
  return (
    <details
      className="archer-inactive-projects"
      aria-label={`Inactive projects (${props.count})`}
      open={open}
      onToggle={(event) => {
        if (!forced) setOpened(event.currentTarget.open);
      }}
    >
      <summary>
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path
            d={open ? "M3 4.5 6 7.5 9 4.5" : "M4.5 3 7.5 6 4.5 9"}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span>Inactive projects</span>
        <span className="archer-inactive-count">{props.count}</span>
        {forced ? (
          <span className="archer-inactive-matches">
            {props.matchingFiles} matching {props.matchingFiles === 1 ? "file" : "files"}
          </span>
        ) : null}
      </summary>
      <p className="archer-inactive-help">
        These projects remain attached and their files stay searchable. To detach one, ask your agent or use the Archer
        CLI.
      </p>
      {props.children}
    </details>
  );
}
