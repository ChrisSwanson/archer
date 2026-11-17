/**
 * A diagram's walkthroughs as a list to choose from: current ones first, then "Archived", greyed. Shared by
 * the side panel's Explore section (eager, so the list is there with the drawing) and the walkthrough
 * panel's picker (lazy).
 */
import type { JSX } from "react";
import type { Walk } from "./contract";
import { dayLabel, plural } from "./walk-stale";

/** Archived, or an archived one playing on its old version: it stays in the Archived group while it plays. */
export const archivedOne = (w: Walk): boolean => w.status === "archived" || w.old === true;
export const live = (walks: readonly Walk[]): readonly Walk[] => walks.filter((w) => !archivedOne(w));

/**
 * The version of the diagram a walkthrough was written for, in one form wherever it is said: "this version"; once the
 * diagram has moved on (or it is archived), "the 13 Nov version", or "an earlier version" with no day. "written for 13
 * Nov" beside "written for this version" read as two kinds of thing (rendered review, 2026-11-13).
 */
export function writtenFor(walk: Walk, revision: string | undefined): string {
  const earlier = archivedOne(walk) || (revision !== undefined && walk.modelRevision !== revision);
  if (!earlier) return "written for this version";
  const day = walk.writtenAt === undefined ? "" : dayLabel(walk.writtenAt);
  return day === "" ? "written for an earlier version" : `written for the ${day} version`;
}
export const Ood = ({ n }: { readonly n: number }): JSX.Element | null =>
  n === 0 ? null : (
    <>
      {" "}
      · <span className="archer-walk-warn">{n} out of date</span>
    </>
  );

/** `Heading` names the groups, under the section's own `h2`. */
export function WalkList({
  walks,
  chosen,
  revision,
  onSelect,
  heading: Heading = "h3",
}: {
  readonly walks: readonly Walk[];
  readonly chosen: string | null;
  readonly revision?: string | undefined;
  readonly onSelect: (id: string) => void;
  readonly heading?: "h2" | "h3";
}): JSX.Element {
  const archived = walks.filter(archivedOne);
  const item = (w: Walk): JSX.Element => (
    <button
      key={w.id}
      type="button"
      className={`archer-walk-item${archivedOne(w) ? " archived" : ""}`}
      aria-current={chosen === null ? undefined : w.id === chosen}
      onClick={() => onSelect(w.id)}
    >
      <span className="archer-walk-item-title">{w.title}</span>
      <span className="archer-walk-item-sub">
        {plural(w.steps.length, "step")}
        {archivedOne(w) ? (
          ` · archived${w.writtenAt === undefined || dayLabel(w.writtenAt) === "" ? "" : ` · ${writtenFor(w, revision)}`}`
        ) : w.outOfDate.length > 0 ? (
          <Ood n={w.outOfDate.length} />
        ) : revision !== undefined && w.modelRevision !== revision ? (
          ` · ${writtenFor(w, revision)}`
        ) : (
          ""
        )}
      </span>
    </button>
  );
  return (
    <>
      <Heading>On This Diagram</Heading>
      {live(walks).map(item)}
      {archived.length > 0 ? <Heading>Archived</Heading> : null}
      {archived.map(item)}
    </>
  );
}
