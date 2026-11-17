import { useLayoutEffect, useRef, useState, type JSX } from "react";
import { NOTE_EMPHASIS_SLOT_PALETTES, type NoteEmphasis, type NoteEmphasisRead } from "./contract";
import type { NoteEmphasisState } from "./useNoteEmphasis";
import { isReaderEmphasis } from "./useNoteEmphasis";
import type { LegendFocusBindings } from "../emphasis/useLegendFocus";

const titleOf = (emphasis: NoteEmphasis): string => emphasis.title?.trim() || emphasis.id;

export function NoteEmphasisGroupRow(props: {
  readonly group: NoteEmphasis["groups"][number];
  /** The group's position: its colour (ADR 0030), whatever palette the wire names. */
  readonly index: number;
  readonly orphanCount: number;
  readonly pressed: boolean;
  readonly bindings?: LegendFocusBindings;
}): JSX.Element {
  const { group } = props;
  return (
    <li className={`archer-emph-palette-${NOTE_EMPHASIS_SLOT_PALETTES[props.index] ?? "teal"}`}>
      <button type="button" className="primary-note-emphasis-group" aria-pressed={props.pressed} {...props.bindings}>
        <span className="primary-note-emphasis-dot" aria-hidden="true" />
        <span>
          <strong>{group.label}</strong>
          {group.description ? ` · ${group.description}` : ""}
        </span>
        {props.orphanCount ? <small>{props.orphanCount} unavailable</small> : null}
      </button>
    </li>
  );
}
export function NoteEmphasisLegend(props: {
  readonly state: NoteEmphasisState | undefined;
  readonly activeId: string | null | undefined;
  readonly focusedGroupId?: string | null;
  readonly onSelect: (id: string | null) => void;
  readonly groupBindings?: (groupId: string) => LegendFocusBindings | undefined;
  readonly onClear: (emphasis: NoteEmphasis, read: NoteEmphasisRead) => Promise<boolean>;
}): JSX.Element | null {
  const [confirm, setConfirm] = useState<string | null>(null);
  const legend = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const host = legend.current;
    const reader = host?.closest<HTMLElement>(".primary-note-reader");
    if (host === null || host === undefined || reader === null || reader === undefined) return;
    const publish = (): void => {
      reader.style.setProperty("--note-emphasis-clearance", `${Math.ceil(host.getBoundingClientRect().height + 28)}px`);
    };
    publish();
    if (typeof ResizeObserver === "undefined") return () => reader.style.removeProperty("--note-emphasis-clearance");
    const observer = new ResizeObserver(publish);
    observer.observe(host);
    return () => {
      observer.disconnect();
      reader.style.removeProperty("--note-emphasis-clearance");
    };
  });
  const read = props.state?.status === "ready" || props.state?.status === "loading" ? props.state.read : undefined;
  if (props.state?.status === "error")
    return (
      <p className="primary-note-emphasis-status" role="status">
        {props.state.message}
      </p>
    );
  if (read === undefined)
    return props.state?.status === "loading" ? (
      <p className="primary-note-emphasis-status primary-note-emphasis-status--pending" role="status">
        Loading highlights…
      </p>
    ) : null;
  if (read.snapshot.emphases.length === 0 && props.state?.status === "ready" && props.state.error === undefined)
    return null;
  const active = read.snapshot.emphases.find((emphasis) => emphasis.id === props.activeId);
  const orphanCount = (emphasisId: string, groupId?: string): number =>
    read.orphans.filter(
      (orphan) => orphan.emphasisId === emphasisId && (groupId === undefined || orphan.groupId === groupId),
    ).length;
  return (
    <section
      ref={legend}
      className="primary-note-emphasis-legend primary-note-emphasis-legend--pinned"
      aria-label="Note highlights"
      data-placement="viewport-bottom-right"
    >
      <div className="primary-note-emphasis-head">
        <h2>Highlights</h2>
        <button
          type="button"
          className="archer-review-link"
          aria-pressed={props.activeId === null}
          onClick={() => props.onSelect(null)}
        >
          Hide
        </button>
      </div>
      {props.state?.status === "ready" && props.state.error ? (
        <p className="primary-note-emphasis-status" role="alert">
          {props.state.error}
        </p>
      ) : null}
      <div className="primary-note-emphasis-sets" role="group" aria-label="Named highlight sets">
        {read.snapshot.emphases.map((emphasis) => (
          <button
            key={emphasis.id}
            type="button"
            className="archer-review-button"
            aria-pressed={active?.id === emphasis.id}
            onClick={() => props.onSelect(emphasis.id)}
          >
            {titleOf(emphasis)} <span>{emphasis.author === "agent" ? "Agent" : "You"}</span>
          </button>
        ))}
      </div>
      {active === undefined ? null : (
        <>
          <ul className="primary-note-emphasis-groups">
            {active.groups.map((group, index) => {
              const orphans = orphanCount(active.id, group.id);
              return (
                <NoteEmphasisGroupRow
                  key={group.id}
                  group={group}
                  index={index}
                  orphanCount={orphans}
                  pressed={props.focusedGroupId === group.id}
                  bindings={props.groupBindings?.(group.id)}
                />
              );
            })}
          </ul>
          {!isReaderEmphasis(active) ? null : confirm === active.id ? (
            <div className="primary-note-emphasis-clear" role="group" aria-label={`Clear ${titleOf(active)}?`}>
              <span>Clear this set?</span>
              <button type="button" className="archer-review-link" onClick={() => setConfirm(null)}>
                Keep
              </button>
              <button
                type="button"
                className="archer-review-link archer-review-link--danger"
                onClick={() =>
                  void props.onClear(active, read).then((cleared) => {
                    if (cleared) setConfirm(null);
                  })
                }
              >
                Clear
              </button>
            </div>
          ) : (
            <button type="button" className="archer-review-link" onClick={() => setConfirm(active.id)}>
              Clear {titleOf(active)}
            </button>
          )}
        </>
      )}
    </section>
  );
}
