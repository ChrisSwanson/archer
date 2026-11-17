/**
 * What the colours on the canvas mean (ADR 0030): a normal chart legend.
 *
 * One row per group, in the agent's priority order: a swatch in the group's
 * hue, its title, and one line saying why it matters. The whole row is a
 * button. On is a filled swatch with a check; off is a hollow swatch and muted
 * text. A tap toggles, with no modifier keys, so a phone can do everything a
 * desktop can.
 *
 * A One / All control appears when there are two or more groups. All is
 * offered only when no two groups share a part; when they do, one line names
 * the shared parts and the groups show one at a time.
 *
 * Below the rows, the Key: any line pattern visible in this view and what its
 * author said it means. Archer never supplies a meaning of its own.
 *
 * In a diagram stage it is the side panel's Highlights section (0.6.4, D5; `app/diagram-panel.tsx`), with
 * a ✕ that puts the highlights away; a canvas outside a stage draws it in place. Every agent-authored
 * string is rendered as text by React, never as markup.
 */
import { useContext, useId, useState, type JSX } from "react";
import { DockSheetClose } from "../app/stage-dock";
import {
  groupSlot,
  HIGHLIGHTS,
  paletteClass,
  type Emphasis,
  type EmphasisGroup,
  type EmphasisNotation,
} from "./contract";
import { useGroupNumbers } from "./group-numbers";
import type { LegendMode } from "./legend-state";
import { useFlowAnimationPreference } from "./reduced-motion";

/** Which kind of element a member is, in the wire's spelling. */
export type MemberChannel = "nodes" | "edges";

/** One line pattern in the Key: what it looks like and what its author says it means. */
export type LegendKeyRow = {
  readonly pattern: "dotted" | "dashed" | "dashdot" | "thick";
  /** The author's words, or `null` when the source states none. */
  readonly meaning: string | null;
};

export type EmphasisLegendProps = {
  readonly emphasis: Emphasis;
  /** What the canvas beside this calls its ids. Defaults to a graph's. */
  readonly notation?: EmphasisNotation;
  readonly mode: LegendMode;
  /** The group ids the reader has on. */
  readonly on: readonly string[];
  /** Whether All may be chosen: no two groups share a part. */
  readonly allowAll: boolean;
  /** What two or more groups share, by name, when they do. */
  readonly shared: readonly string[];
  readonly keyRows?: readonly LegendKeyRow[];
  /** What the reader calls a member. Defaults to its id. */
  readonly nameOf?: (id: string, channel: MemberChannel) => string;
  /** Take the reader to a member on the canvas. Without it, members are listed as text. */
  readonly onReveal?: (id: string, channel: MemberChannel) => void;
  readonly onToggle: (groupId: string) => void;
  readonly onMode: (mode: LegendMode) => void;
  /** Put the highlights away (back to Explore): the side panel's ✕. */
  readonly onHide?: () => void;
};

/** "Highlight 1: payment": what a group is called where its colour cannot say it. */
export function groupHeading(group: EmphasisGroup, index: number): string {
  return `Highlight ${groupSlot(group, index)}: ${group.label}`;
}

/**
 * Each group's members by name (WCAG 1.4.1): the text equivalent of the
 * colours, collapsed behind one button so the legend stays a legend. A member
 * is a button that takes the reader to it on the canvas.
 */
function MemberList(props: {
  readonly groups: readonly EmphasisGroup[];
  readonly nameOf: (id: string, channel: MemberChannel) => string;
  readonly onReveal?: (id: string, channel: MemberChannel) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const id = useId();
  // On a phone the legend is a sheet over the bottom of the drawing: it closes first, so the
  // member it takes the reader to is not under it.
  const closeSheet = useContext(DockSheetClose);
  return (
    <div className="archer-emph-legend-members">
      <button
        type="button"
        className="archer-emph-members-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((was) => !was)}
      >
        <svg className="archer-emph-members-chevron" viewBox="0 0 10 10" width={10} height={10} aria-hidden="true">
          <path d="M3,2 L7,5 L3,8" />
        </svg>
        Members
      </button>
      {/* Always present, so `aria-controls` names an element; filled only while open. */}
      <div id={id} className="archer-emph-members" hidden={!open}>
        {!open
          ? null
          : props.groups.map((group, index) => {
              const heading = groupHeading(group, index);
              const headingId = `${id}-${index}`;
              const members = [
                ...group.nodes.map((member) => [member, "nodes"] as const),
                ...group.edges.map((member) => [member, "edges"] as const),
              ];
              // Never an empty button: a blank name falls back to the id.
              const named = (member: string, channel: MemberChannel): string =>
                props.nameOf(member, channel).trim() || member;
              return (
                <div key={group.id} className={`archer-emph-members-group ${paletteClass(group.palette)}`}>
                  <h3 id={headingId} className="archer-emph-members-head">
                    {heading}
                  </h3>
                  <ul aria-labelledby={headingId}>
                    {members.map(([member, channel]) => (
                      <li key={`${channel}:${member}`}>
                        {props.onReveal === undefined ? (
                          <span>{named(member, channel)}</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              closeSheet?.();
                              props.onReveal?.(member, channel);
                            }}
                          >
                            {named(member, channel)}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
      </div>
    </div>
  );
}

/** How many shared parts the note names before it counts the rest. */
const NAMED_SHARED = 3;

function sharedNote(names: readonly string[]): string {
  const named = names.slice(0, NAMED_SHARED);
  const more = names.length - named.length;
  const list =
    more > 0
      ? `${named.join(", ")} and ${more} more`
      : named.length > 1
        ? `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`
        : named[0];
  return `These share ${list}, so they show one at a time.`;
}

export const KEY_DASHES: Readonly<Record<LegendKeyRow["pattern"], string | null>> = {
  dotted: "2 4",
  dashed: "6 4",
  dashdot: "8 3 2 3",
  thick: null,
};
const PATTERN_WORDS: Readonly<Record<LegendKeyRow["pattern"], string>> = {
  dotted: "Dotted line",
  dashed: "Dashed line",
  dashdot: "Dash-dot line",
  thick: "Thick line",
};

export function KeySample({ pattern }: { readonly pattern: LegendKeyRow["pattern"] }): JSX.Element {
  const dash = KEY_DASHES[pattern];
  return (
    <svg className="archer-emph-key-sample" viewBox="0 0 28 8" width={28} height={8} aria-hidden="true">
      <line
        x1={1}
        y1={4}
        x2={27}
        y2={4}
        strokeWidth={pattern === "thick" ? 4 : 1.5}
        {...(dash === null ? {} : { strokeDasharray: dash })}
      />
    </svg>
  );
}

export function keyRowText(row: LegendKeyRow): string {
  return `${PATTERN_WORDS[row.pattern]}: ${row.meaning ?? "meaning not stated"}`;
}

const CHECK = (
  <svg className="archer-emph-swatch-check" viewBox="0 0 10 10" aria-hidden="true">
    <path d="M2,5.2 L4.2,7.4 L8,2.8" />
  </svg>
);

export function EmphasisLegend(props: EmphasisLegendProps): JSX.Element | null {
  const { emphasis, mode, on, allowAll, shared, keyRows = [] } = props;
  const { preference, setPreference } = useFlowAnimationPreference();
  const numbers = useGroupNumbers();
  if (emphasis.groups.length === 0) return null;
  const several = emphasis.groups.length > 1;

  return (
    // A named `<section>` (a region), not an `<aside>`: it sits inside the stage, which is inside `<main>`,
    // and a complementary landmark may not sit inside another landmark.
    <section className="archer-emph-legend" aria-label={HIGHLIGHTS}>
      <div className="archer-emph-legend-head">
        <h2 className="archer-emph-legend-title">{emphasis.title || HIGHLIGHTS}</h2>
        {several ? (
          <div className="archer-emph-legend-mode" role="group" aria-label="How many at once">
            <button type="button" aria-pressed={mode === "one"} onClick={() => props.onMode("one")}>
              One
            </button>
            <button
              type="button"
              aria-pressed={mode === "all"}
              disabled={!allowAll}
              title={allowAll ? undefined : "These groups share parts, so they show one at a time."}
              onClick={() => props.onMode("all")}
            >
              All
            </button>
          </div>
        ) : null}
        {props.onHide === undefined ? null : (
          <button
            type="button"
            className="archer-panel-close"
            aria-label="Hide highlights"
            title="Hide highlights"
            onClick={props.onHide}
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
      <ul className="archer-emph-legend-rows">
        {emphasis.groups.map((group, index) => {
          const pressed = on.includes(group.id);
          return (
            <li key={group.id} className={`archer-emph-legend-row ${paletteClass(group.palette)}`}>
              <button
                type="button"
                className="archer-emph-legend-body"
                aria-pressed={pressed}
                data-group={group.id}
                onClick={() => props.onToggle(group.id)}
              >
                <span className="archer-emph-swatch" aria-hidden="true">
                  {CHECK}
                </span>
                <span className="archer-emph-legend-label">
                  {numbers.numbered ? (
                    <span className="archer-emph-legend-num" aria-hidden="true">
                      {groupSlot(group, index)}
                    </span>
                  ) : null}
                  {group.label}
                </span>
                {group.description ? <span className="archer-emph-legend-desc">{group.description}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
      {!allowAll && shared.length > 0 ? <p className="archer-emph-legend-note">{sharedNote(shared)}</p> : null}
      {keyRows.length > 0 ? (
        <div className="archer-emph-legend-key" role="group" aria-label="Key">
          <span className="archer-emph-legend-key-head">Key</span>
          {keyRows.map((row) => (
            <div key={row.pattern} className="archer-emph-legend-key-row">
              <KeySample pattern={row.pattern} />
              <span>{keyRowText(row)}</span>
            </div>
          ))}
        </div>
      ) : null}
      <MemberList
        groups={emphasis.groups}
        nameOf={props.nameOf ?? ((id) => id)}
        {...(props.onReveal === undefined ? {} : { onReveal: props.onReveal })}
      />
      <label className="archer-emph-motion-control">
        <span>Group numbers</span>
        <select
          aria-label="Group numbers"
          value={numbers.preference}
          title="Draws each group's number on its parts. Auto turns them on when your system asks for more contrast, or the diagram is drawn in colours."
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value === "auto" || value === "on" || value === "off") numbers.setPreference(value);
          }}
        >
          <option value="auto">Auto</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
      </label>
      {emphasis.groups.some((group) => group.style === "flow") ? (
        <label className="archer-emph-motion-control">
          <span>Flow animation</span>
          <select
            aria-label="Flow animation"
            value={preference}
            title="On unless you change it. Auto follows your browser’s motion setting. Applies to Archer highlights only."
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value === "auto" || value === "on" || value === "off") setPreference(value);
            }}
          >
            <option value="on">On</option>
            <option value="off">Off</option>
            <option value="auto">Auto</option>
          </select>
        </label>
      ) : null}
    </section>
  );
}
