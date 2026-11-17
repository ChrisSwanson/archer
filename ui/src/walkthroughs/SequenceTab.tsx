/**
 * The Sequence tab (ADR 0034 §6): the walkthrough's messages drawn as a sequence diagram, the
 * current one lit with the moving arrows, the walked ones quiet, the rest faded, and under it the
 * current step's card. A press on a message goes to its step.
 *
 * Not `SequenceCanvas`: it owns a camera, a wheel that pans, a legend and a pointer mode, none of
 * which fits a panel where the wheel steps and the current message scrolls into view, and its layout
 * spaces lifelines 200 apart, which scrolls a 420 px panel. This draws the same model compactly
 * (`layoutWalkSequence`) with the canvas's classes, arrowheads, emphasis and moving arrows, so the
 * lit message is the diagram's own look.
 */
import { useEffect, useMemo, useRef, type JSX, type KeyboardEvent } from "react";
import { Arrowhead } from "../diagrams/SequencePrimitives";
import { assignEmphasis, type EmphasisAssignment } from "../emphasis/contract";
import { EmphasisChevrons } from "../emphasis/EmphasisChevrons";
import { prefersReducedMotion } from "../emphasis/reduced-motion";
import type { Walk } from "./contract";
import type { StepBadge } from "../comments/walk-anchors";
import { StepItem, type Go } from "./WalkthroughPanel";
import { stepStates } from "./walk-player";
import { ROW, SELF, layoutWalkSequence, sequenceEmphasis, type WalkSeqRow } from "./walk-sequence";

/** The drawing is shrunk to the panel down to this much of its size, then scrolls sideways. */
const FIT = 0.85;
const routeId = (id: string): string => `walk-seq-route-${id}`;

function Message({
  row,
  name,
  state,
  mark,
  onGo,
}: {
  readonly row: WalkSeqRow;
  readonly name: string;
  readonly state: string;
  readonly mark: EmphasisAssignment | undefined;
  readonly onGo: (to: Go) => void;
}): JSX.Element {
  const { fromX, toX, y, step } = row;
  const self = row.from === row.to;
  const dir = toX >= fromX ? 1 : -1;
  const x1 = fromX + dir * 2;
  const x2 = self ? fromX : toX - dir * 3;
  const mid = (fromX + toX) / 2;
  const plateW = row.label.length * 6.9 + 10;
  const route = self ? `M ${fromX} ${y} H ${fromX + SELF} V ${y + 12} H ${fromX}` : `M ${x1} ${y} H ${x2}`;
  const points = self
    ? [
        { x: fromX, y },
        { x: fromX + SELF, y },
        { x: fromX + SELF, y: y + 12 },
        { x: fromX, y: y + 12 },
      ]
    : [
        { x: x1, y },
        { x: x2, y },
      ];
  const flow = mark !== undefined && mark.style === "flow";
  // Enter steps here; Space is left to the panel, where it plays or pauses.
  const press = (event: KeyboardEvent): void => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    onGo(step);
  };
  return (
    <g
      className={["archer-seq-message", ...(mark?.classes ?? [])].join(" ")}
      role="button"
      tabIndex={0}
      aria-label={name}
      data-state={state}
      data-step={step}
      data-step-no={step}
      {...(state === "active" ? { "aria-current": "step" as const } : {})}
      onClick={() => onGo(step)}
      onKeyDown={press}
    >
      <rect
        className="archer-seq-hit"
        x={Math.min(fromX, toX) - 6}
        y={y - 24}
        width={Math.abs(toX - fromX) + 12 + (self ? SELF + plateW : 0)}
        height={ROW - 2}
        rx={6}
      />
      {flow ? (
        // biome-ignore lint/a11y/noAriaHiddenOnFocusable: a decorative SVG part with no tabindex, never focusable; biome misreads SVG elements as focusable.
        <path className="archer-seq-emph-route" id={routeId(row.id)} d={route} fill="none" aria-hidden="true" />
      ) : null}
      <g className="archer-seq-message-stroke">
        <path d={route} fill="none" strokeWidth={1.5} />
        <Arrowhead tipX={self ? fromX : x2} y={self ? y + 12 : y} direction={self ? -1 : dir} open={false} />
      </g>
      {row.label === "" ? null : self ? (
        <text x={fromX + SELF + 6} y={y + 10} fontSize={12}>
          {row.label}
        </text>
      ) : (
        <text x={mid} y={y - 8} textAnchor="middle" fontSize={12}>
          {row.label}
        </text>
      )}
      {flow && mark.speed !== null ? (
        <EmphasisChevrons
          edgeId={row.id}
          pathId={routeId(row.id)}
          speed={mark.speed}
          hop={0}
          hops={1}
          route={points}
          avoid={{ x: mid - plateW / 2, y: y - 20, width: plateW, height: 16 }}
        />
      ) : null}
    </g>
  );
}

export function SequenceTab({
  walk,
  step,
  labelOf,
  onGo,
  badges,
}: {
  readonly badges: ReadonlyMap<string, StepBadge>;
  readonly walk: Walk;
  readonly step: number;
  readonly labelOf: (id: string) => string;
  readonly onGo: (to: Go) => void;
}): JSX.Element {
  const layout = useMemo(() => layoutWalkSequence(walk, labelOf), [walk, labelOf]);
  const marks = useMemo(() => assignEmphasis(sequenceEmphasis(walk, step)), [walk, step]);
  const states = stepStates(step, walk.steps.length);
  const wrap = useRef<HTMLDivElement>(null);
  const current = walk.steps[step - 1];
  const names = new Map(layout.participants.map((p) => [p.id, p.label]));

  // The current step's first message comes into view, sideways too when the drawing is wider than the
  // panel. Worked out from the layout: a measured box is mid-flight while an earlier scroll runs, and
  // `scrollIntoView` also moves the panel around it, which cancels the smooth scroll.
  useEffect(() => {
    const box = wrap.current;
    const row = layout.rows.find((r) => r.step === step);
    if (box === null || row === undefined || typeof box.scrollTo !== "function") return;
    const scale = box.scrollWidth / layout.width;
    const from = (Math.min(row.fromX, row.toX) - 36) * scale;
    const to = (Math.max(row.fromX, row.toX) + 36) * scale;
    const y = row.y * scale;
    const left =
      from >= box.scrollLeft && to <= box.scrollLeft + box.clientWidth
        ? box.scrollLeft
        : Math.max(0, (from + to) / 2 - box.clientWidth / 2);
    const top =
      y < 60 * scale
        ? 0
        : y - 30 < box.scrollTop
          ? Math.max(0, y - 30)
          : y + 26 > box.scrollTop + box.clientHeight
            ? y + 26 - box.clientHeight
            : box.scrollTop;
    if (Math.abs(left - box.scrollLeft) > 1 || Math.abs(top - box.scrollTop) > 1)
      box.scrollTo({ left, top, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [step, layout]);

  return (
    <>
      <div ref={wrap} className="archer-walk-seq-wrap">
        <svg
          className="archer-seq-svg archer-walk-seq"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          style={{ minWidth: Math.round(layout.width * FIT) }}
          role="group"
          aria-label={`Sequence of ${walk.title}`}
        >
          {layout.participants.map((p) => (
            <line
              key={p.id}
              className="archer-seq-lifeline"
              x1={p.x}
              y1={44}
              x2={p.x}
              y2={layout.height - 6}
              strokeWidth={1}
              strokeDasharray="4 4"
            />
          ))}
          {layout.participants.map((p) => (
            <g key={p.id} className={["archer-seq-participant", ...(marks.nodes.get(p.id)?.classes ?? [])].join(" ")}>
              <rect
                className="archer-seq-participant-box"
                x={p.x - 35}
                y={4}
                width={70}
                height={40}
                rx={6}
                strokeWidth={1.5}
              />
              <text textAnchor="middle" fontSize={12} fontWeight={600}>
                {p.lines.map((line, i) => (
                  <tspan
                    // biome-ignore lint/suspicious/noArrayIndexKey: the wrapped lines of one label, re-derived together; a line has no identity or state beyond its position.
                    key={i}
                    x={p.x}
                    y={p.lines.length === 1 ? 29 : 21 + i * 14}
                  >
                    {line}
                  </tspan>
                ))}
              </text>
            </g>
          ))}
          {layout.rows.map((row) => {
            const stale = walk.steps[row.step - 1]!.status === "out-of-date";
            const at = states[row.step - 1];
            const state = stale ? "stale" : at === "done" ? "done" : at === "active" ? "active" : "future";
            return (
              <g key={row.id}>
                {row.first ? (
                  // biome-ignore lint/a11y/noAriaHiddenOnFocusable: a decorative SVG part with no tabindex, never focusable; biome misreads SVG elements as focusable.
                  <text className="archer-walk-seq-num" x={8} y={row.y + 4} data-state={state} aria-hidden="true">
                    {row.step}
                  </text>
                ) : null}
                <Message
                  row={row}
                  state={state}
                  mark={marks.edges.get(row.id)}
                  onGo={onGo}
                  name={`Step ${row.step}: ${names.get(row.from)} to ${names.get(row.to)}${row.label === "" ? "" : `: ${row.label}`}${stale ? ". Out of date." : ""}`}
                />
              </g>
            );
          })}
        </svg>
      </div>
      {current === undefined ? null : (
        <ol className="archer-walk-steps archer-walk-seq-card" aria-label="Current step">
          <StepItem
            step={current}
            index={step - 1}
            state={walk.status === "archived" ? "future" : "active"}
            labelOf={labelOf}
            onGo={onGo}
            {...(badges.has(current.id) ? { badge: badges.get(current.id)! } : {})}
          />
        </ol>
      )}
    </>
  );
}
