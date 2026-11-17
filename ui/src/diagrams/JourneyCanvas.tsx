/**
 * A user journey, on a canvas of its own: no graph layout, because a journey
 * is not a graph. Sections are columns read left to right, each holding its
 * tasks in order; every task shows its score as five pips AND as words
 * ("3/5"), so a score never rests on colour, and names its actors.
 *
 * It is interactive as the other canvases are, through the same handlers:
 * sections and tasks are the journey's elements (`journeyElements`) and are
 * selected as NODES, so the selection reaches the agent in the record a
 * graph's does; the agent's emphasis draws on them through the shared
 * emphasis surface; comment threads mark them; and the keyboard has one tab
 * stop, roving over a grid where a column is a section -- its heading, then
 * its tasks -- and the arrows move down a section or across to the next.
 *
 * Plain HTML in a scrolling board rather than a pannable drawing: text is
 * the whole of a journey, and the browser lays text out, wraps it, scrolls it
 * and reflows it at phone width better than any camera would.
 */
import { JOURNEY_MAX_SCORE, journeyBoardWidth, journeyScore } from "../export/journey-metrics";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { EMPHASIS_MEMBER_CLASS, emphasisMembership, type Emphasis } from "../emphasis/contract";
import { useEmphasisSurface } from "../emphasis/surface";
import type { ProjectedJourney, ProjectedJourneyTask } from "./projection";
import type { CommentedElements, DiagramSelection } from "./xflow-adapter";
import { PinRow } from "./CommentPins";
import { CanvasTools } from "./CanvasTools";
import { SourceToolButton } from "./SourceTool";

/** What the host's presentation is framing: everything else is dimmed. */
export type JourneyFocus = { readonly nodeIds?: readonly string[] };

const MAX_SCORE = JOURNEY_MAX_SCORE;
export { JOURNEY_COLUMN_MAX_PX, JOURNEY_GAP_PX, journeyBoardWidth } from "../export/journey-metrics";
const COMMENTED_SUFFIX = ", has comments";

/** "Me", "Me and Cat", "Me, Cat and Boss". */
function listed(names: readonly string[]): string {
  if (names.length === 0) return "no actors";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The score clamped to the scale, whatever the wire says. */
const scoreOf = (task: ProjectedJourneyTask): number => journeyScore(task.score);

/** The grid the keyboard walks: one column per section, its heading first. */
function columnsOf(journey: ProjectedJourney): readonly (readonly string[])[] {
  return journey.sections.map((section) => [section.id, ...section.tasks.map((task) => task.id)]);
}

function locate(columns: readonly (readonly string[])[], id: string): { column: number; row: number } | null {
  for (const [column, ids] of columns.entries()) {
    const row = ids.indexOf(id);
    if (row !== -1) return { column, row };
  }
  return null;
}

/** Where an arrow key moves from `id`; `null` when there is nowhere that way. */
export function journeyStep(columns: readonly (readonly string[])[], id: string, key: string): string | null {
  const at = locate(columns, id);
  if (at === null) return columns[0]?.[0] ?? null;
  const here = columns[at.column];
  switch (key) {
    case "ArrowDown":
      return here[at.row + 1] ?? null;
    case "ArrowUp":
      return here[at.row - 1] ?? null;
    case "ArrowRight":
    case "ArrowLeft": {
      const next = columns[at.column + (key === "ArrowRight" ? 1 : -1)];
      // The same row in the next section, or its last one if it is shorter.
      return next === undefined ? null : (next[Math.min(at.row, next.length - 1)] ?? null);
    }
    default:
      return null;
  }
}

export function JourneyCanvas(props: {
  journey: ProjectedJourney;
  focus?: JourneyFocus;
  selection?: DiagramSelection;
  emphasis?: Emphasis | null;
  commented?: CommentedElements;
  onNodeClick?: (nodeId: string, additive: boolean) => void;
  onPaneClick?: () => void;
  tools?: ReactNode;
  /** Extra buttons in the canvas control cluster (the editor's undo, redo, delete). */
  controls?: ReactNode;
}): JSX.Element {
  const { journey, onNodeClick, onPaneClick } = props;
  const columns = useMemo(() => columnsOf(journey), [journey]);
  const boardRef = useRef<HTMLDivElement>(null);
  const nameOf = useMemo(() => {
    const names = new Map(
      journey.sections.flatMap((section) => [
        [section.id, section.label] as const,
        ...section.tasks.map((task) => [task.id, task.label] as const),
      ]),
    );
    return (id: string) => names.get(id) ?? id;
  }, [journey]);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [ringOn, setRingOn] = useState(false);

  // One tab stop: where the reader last was, or the first section.
  const stopId = focusedId !== null && locate(columns, focusedId) !== null ? focusedId : (columns[0]?.[0] ?? null);
  const selected = useMemo(() => new Set(props.selection?.nodeIds ?? []), [props.selection]);
  const framed = useMemo(() => new Set(props.focus?.nodeIds ?? []), [props.focus]);

  const focusOn = useCallback((id: string): void => {
    for (const element of boardRef.current?.querySelectorAll<HTMLElement>("[data-journey-id]") ?? []) {
      // Matched in JS: an id is author-supplied and could break a selector.
      if (element.dataset.journeyId === id) {
        element.focus();
        return;
      }
    }
  }, []);

  // The legend's member list takes the reader to a card: focus moves to it,
  // and the browser scrolls it into view.
  const onReveal = useCallback(
    (id: string): void => {
      setFocusedId(id);
      focusOn(id);
    },
    [focusOn],
  );
  const surface = useEmphasisSurface(props.emphasis, "journey", { nameOf, onReveal });
  const { assignments, isolated } = surface.render;

  const idOf = (target: EventTarget | null): string | null =>
    target instanceof Element ? (target.closest<HTMLElement>("[data-journey-id]")?.dataset.journeyId ?? null) : null;

  const handleClick = useCallback(
    (event: MouseEvent<HTMLDivElement>): void => {
      const id = idOf(event.target);
      if (id === null) {
        onPaneClick?.();
        return;
      }
      onNodeClick?.(id, event.shiftKey);
    },
    [onNodeClick, onPaneClick],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      const id = idOf(event.target);
      if (id === null || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.startsWith("Arrow")) {
        event.preventDefault();
        const next = journeyStep(columns, id, event.key);
        if (next !== null) {
          setFocusedId(next);
          focusOn(next);
        }
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onNodeClick?.(id, event.shiftKey);
      }
    },
    [columns, focusOn, onNodeClick],
  );

  const handleFocus = useCallback((event: FocusEvent<HTMLDivElement>): void => {
    const id = idOf(event.target);
    if (id === null) return;
    setFocusedId(id);
    setRingOn(true);
  }, []);

  const handleBlur = useCallback((event: FocusEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget)) setRingOn(false);
  }, []);

  /** The classes and the name every element of the journey wears. */
  const element = (id: string, kind: string, name: string): Record<string, unknown> => {
    const assignment = assignments.nodes.get(id);
    const commented = props.commented?.nodeIds.has(id) === true;
    const dimmed = framed.size > 0 && !framed.has(id) && assignment === undefined;
    const classes = [
      "archer-journey-el",
      kind,
      ...(assignment?.classes ?? []),
      ...(isolated?.nodes.has(id) ? [EMPHASIS_MEMBER_CLASS] : []),
      ...(selected.has(id) ? ["selected"] : []),
      ...(ringOn && id === stopId ? ["archer-kbd-focus"] : []),
      ...(commented ? ["archer-commented"] : []),
      ...(dimmed ? ["archer-journey-dimmed"] : []),
    ];
    return {
      className: classes.join(" "),
      "data-journey-id": id,
      role: "button",
      tabIndex: id === stopId ? 0 : -1,
      "aria-pressed": selected.has(id),
      "aria-label": name + emphasisMembership(assignment) + (commented ? COMMENTED_SUFFIX : ""),
    };
  };

  // A card's pins: one per thread on it (`CommentPins.tsx`).
  const mark = (id: string) => <PinRow pins={props.commented?.nodePins?.get(id)} />;

  // The board and its heading are centred at the width their columns need.
  const composed: CSSProperties = { maxWidth: journeyBoardWidth(journey.sections.length) };

  return (
    <div className={`${surface.className} archer-journey-surface`}>
      <div className="archer-journey" role="group" aria-label="User journey canvas">
        {journey.heading === undefined && journey.actors.length === 0 ? null : (
          <div className="archer-journey-head" style={composed}>
            {journey.heading === undefined ? null : <p className="archer-journey-title">{journey.heading}</p>}
            {journey.actors.length === 0 ? null : (
              <ul className="archer-journey-actors-key" aria-label="Actors">
                {journey.actors.map((actor) => (
                  <li key={actor}>
                    <span className="archer-journey-actor">{actor}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: the canvas surface handles pointer and key events for the composite drawing inside it, whose parts are focusable (UI_UX.md: every drag has a keyboard path). */}
        <div
          className="archer-journey-board"
          style={composed}
          ref={boardRef}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          onBlur={handleBlur}
        >
          {journey.sections.map((section) => (
            <div className="archer-journey-section" key={section.id}>
              <div
                {...element(
                  section.id,
                  "archer-journey-section-head",
                  `${section.label}, section of ${section.tasks.length} ${section.tasks.length === 1 ? "task" : "tasks"}`,
                )}
              >
                <span className="archer-journey-section-label">{section.label}</span>
                <span className="archer-journey-section-count" aria-hidden="true">
                  {section.tasks.length} {section.tasks.length === 1 ? "task" : "tasks"}
                </span>
                {mark(section.id)}
              </div>
              <ol className="archer-journey-tasks">
                {section.tasks.map((task) => {
                  const score = scoreOf(task);
                  return (
                    <li key={task.id}>
                      <div
                        {...element(
                          task.id,
                          `archer-journey-task archer-journey-score-${score}`,
                          `${task.label}, score ${score} of ${MAX_SCORE}, ${listed(task.actors)}`,
                        )}
                      >
                        <span className="archer-journey-task-label">{task.label}</span>
                        <span className="archer-journey-score" aria-hidden="true">
                          <span className="archer-journey-pips">
                            {Array.from({ length: MAX_SCORE }, (_, index) => (
                              <span
                                // biome-ignore lint/suspicious/noArrayIndexKey: the position is the identity here (fixed-length or ordered parts drawn from one layout), and the items hold no state.
                                key={index}
                                className={`archer-journey-pip${index < score ? " archer-journey-pip-filled" : ""}`}
                              />
                            ))}
                          </span>
                          <span className="archer-journey-score-text">
                            {score}/{MAX_SCORE}
                          </span>
                        </span>
                        <span className="archer-journey-task-actors" aria-hidden="true">
                          {task.actors.length === 0 ? (
                            // The card's third row either way, so a task
                            // nobody is named for does not look cut short.
                            <span className="archer-journey-no-actors">No actors</span>
                          ) : (
                            task.actors.map((actor) => (
                              <span className="archer-journey-actor" key={actor}>
                                {actor}
                              </span>
                            ))
                          )}
                        </span>
                        {mark(task.id)}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          ))}
        </div>
      </div>
      {/* The journey draws no zoom cluster; Source and Graph tools are its one cluster, in the same corner as
          the other canvases' (round 1, #3: two clusters in one corner put Graph tools over Source). */}
      <div className="archer-canvas-controls archer-journey-controls" role="group" aria-label="Canvas controls">
        <SourceToolButton />
        <CanvasTools className="archer-journey-tools">{props.tools}</CanvasTools>
      </div>
      {surface.legend}
    </div>
  );
}
