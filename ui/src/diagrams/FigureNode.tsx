/**
 * A node of one of the newer diagram types, drawn as its figure says
 * (`figures.ts`): a state as UML draws it, an entity as a table, a C4 element
 * with its type line, an architecture service with its icon.
 *
 * As with a flowchart node, the box, its fill, its border and all three rings
 * belong to React Flow's wrapper element (`.archer-node` and its state
 * classes), so selection, the keyboard and the agent's emphasis look the same
 * on every figure; this component draws only what is inside the box, and
 * what hangs beside it (a state's note).
 */
import { useContext, useMemo, type JSX } from "react";
import { AuthoringHandles } from "./authoring-handles";
import { InlineLabelInput } from "./InlineLabelInput";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  ER_COLUMN_GAP_PX,
  ER_KEY_FONT_PX,
  ER_KEY_GAP_PX,
  ER_KEY_PAD_X,
  ER_PAD_X,
  ER_ROW_FONT_PX,
  ER_ROW_PX,
  figureBox,
  STATE_MARK_FONT_PX,
  NOTE_FONT_PX,
  NOTE_LINE_PX,
  NOTE_PAD_X,
  NOTE_PAD_Y,
  type FigureBox,
} from "../layout/figure-metrics";
import type { LayoutNote } from "../layout/elk-adapter";
import {
  C4_PERSON_GLYPH_PX,
  C4_TEXT_FONT_PX,
  C4_TEXT_LINE_PX,
  C4_TYPE_FONT_PX,
  C4_TYPE_LINE_PX,
  SERVICE_ICON_PX,
} from "../layout/figure-metrics";
import { ArchitectureGlyph, PersonGlyph } from "./FigureGlyphs";
import type { DiagramNodeData } from "./xflow-adapter";
import { PinRow } from "./CommentPins";

/** What a node's connection handles call it: its label as read aloud, else its id (ux:A11Y-5). */
export function handleName(label: string | undefined, id: string): string {
  return label?.replace(/\s*\n\s*/g, " ").trim() || id;
}

/** The dashed tie from a state to its note, and the sheet itself. */
function StateNote(props: { note: LayoutNote; width: number; height: number }): JSX.Element {
  const { note } = props;
  // From the middle of the state's side to the middle of the note's.
  const leftOf = note.x + note.width <= 0;
  const from = { x: leftOf ? 0 : props.width, y: props.height / 2 };
  const to = { x: leftOf ? note.x + note.width : note.x, y: note.y + note.height / 2 };
  return (
    <>
      <svg className="archer-state-note-tie" width={1} height={1} aria-hidden="true" focusable="false">
        <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
      </svg>
      <span
        className={`archer-state-note archer-state-note-${note.position}`}
        style={{
          left: note.x,
          top: note.y,
          width: note.width,
          height: note.height,
          padding: `${NOTE_PAD_Y}px ${NOTE_PAD_X}px`,
          fontSize: NOTE_FONT_PX,
          lineHeight: `${NOTE_LINE_PX}px`,
        }}
        // The state's accessible name already carries the note.
        aria-hidden="true"
      >
        {note.lines.map((line, index) => (
          <span
            className="archer-state-note-row"
            // biome-ignore lint/suspicious/noArrayIndexKey: the wrapped lines of one label, re-derived together; a line has no identity or state beyond its position.
            key={index}
          >
            {line}
          </span>
        ))}
      </span>
    </>
  );
}

/**
 * An entity: its name in a title band, then a row per attribute -- type,
 * name, keys as small worded chips, comment -- in the column widths the
 * layout sized the box from.
 */
function EntityTable(props: { id: string; label: string; box: FigureBox }): JSX.Element {
  const { table, lines } = props.box;
  const authoring = useContext(AuthoringHandles);
  if (table === undefined) return <LabelRows id={props.id} label={props.label} lines={lines} />;
  const { columns } = table;
  // An empty column takes no room and no gap: the gap is carried by each
  // column that has something after it, which is how the layout counted it.
  const widths = [columns.type, columns.name, columns.keys, columns.comment];
  const last = widths.reduce((found, width, index) => (width > 0 ? index : found), -1);
  const template = widths
    .map((width, index) => `${width > 0 && index < last ? width + ER_COLUMN_GAP_PX : width}px`)
    .join(" ");
  return (
    <span className="archer-er-table">
      <span className="archer-er-title" style={{ height: table.titleHeight }}>
        {authoring.editingNodeId === props.id ? (
          <InlineLabelInput
            label={`${props.id} name`}
            value={props.label}
            onCommit={(text) => authoring.onNodeLabelCommit?.(props.id, text)}
            onClose={() => authoring.onNodeLabelClose?.()}
          />
        ) : (
          lines.join(" ")
        )}
      </span>
      {table.rows.map((row, index) => (
        <span
          className="archer-er-row"
          // biome-ignore lint/suspicious/noArrayIndexKey: the position is the identity here (fixed-length or ordered parts drawn from one layout), and the items hold no state.
          key={index}
          style={{
            gridTemplateColumns: template,
            height: ER_ROW_PX,
            padding: `0 ${ER_PAD_X}px`,
            fontSize: ER_ROW_FONT_PX,
            lineHeight: `${ER_ROW_PX}px`,
          }}
        >
          <span className="archer-er-type" data-column="type">
            {row.type}
          </span>
          <span className="archer-er-name" data-column="name">
            {row.name}
          </span>
          <span className="archer-er-keys" data-column="keys" style={{ gap: ER_KEY_GAP_PX }}>
            {row.keys.map((key) => (
              <span
                key={key}
                className={`archer-er-key archer-er-key-${key}`}
                style={{ fontSize: ER_KEY_FONT_PX, padding: `0 ${ER_KEY_PAD_X}px` }}
              >
                {key}
              </span>
            ))}
          </span>
          <span className="archer-er-comment" data-column="comment">
            {row.shownComment}
          </span>
        </span>
      ))}
    </span>
  );
}

function FigureBody(props: { id: string; data: DiagramNodeData; box: FigureBox }): JSX.Element | null {
  const { figure } = props.data;
  if (figure === undefined) return null;
  switch (figure.type) {
    case "entity":
      return <EntityTable id={props.id} label={props.data.label} box={props.box} />;
    case "c4":
      // Storage caps close their cylinders, clear of the centred text.
      return (
        <>
          {figure.shape === "database" ? <DatabaseCap /> : null}
          {props.box.c4?.queue === true ? <QueueCap /> : null}
          <C4Lines id={props.id} box={props.box} label={props.data.label} />
        </>
      );
    case "service":
      return (
        <span className="archer-node-text archer-service-text">
          {figure.icon === undefined ? null : <ArchitectureGlyph icon={figure.icon} size={SERVICE_ICON_PX} />}
          {props.box.lines.map((line, index) => (
            <span
              className="archer-node-label-row"
              // biome-ignore lint/suspicious/noArrayIndexKey: the wrapped lines of one label, re-derived together; a line has no identity or state beyond its position.
              key={index}
            >
              {line}
            </span>
          ))}
        </span>
      );
    case "junction":
      return null;
    case "state":
      if (figure.kind === "initial") return <StateMark which="start" side={sideOf(props.data.direction)} />;
      if (figure.kind === "final")
        return (
          <>
            <span className="archer-state-final-dot" aria-hidden="true" />
            <StateMark which="end" side={sideOf(props.data.direction)} />
          </>
        );
      if (figure.kind === "choice") return <span className="archer-node-diamond" aria-hidden="true" />;
      if (figure.kind !== "state") return null;
      return <LabelRows id={props.id} label={props.data.label} lines={props.box.lines} />;
    default:
      return <LabelRows lines={props.box.lines} />;
  }
}

/** Where a pseudo-state's word goes: clear of the wires, which leave along the flow. */
function sideOf(direction: DiagramNodeData["direction"]): "below" | "right" {
  return direction === "tb" || direction === "bt" ? "right" : "below";
}

const MARK_TITLES = {
  start: "Start: the machine begins here",
  end: "End: the machine finishes here",
} as const;

/**
 * The word beside a start or end mark, and its tooltip. A bare dot and a
 * ringed dot are UML's, and read as rendering glitches to anyone who does not
 * know it. The word is for the eye; the node's own accessible name already
 * says "initial state" or "final state", so it is hidden from the reader.
 */
function StateMark(props: { readonly which: "start" | "end"; readonly side: "below" | "right" }): JSX.Element {
  return (
    <>
      <span className="archer-state-mark-hover" title={MARK_TITLES[props.which]} />
      <span
        className="archer-state-mark-label"
        data-side={props.side}
        aria-hidden="true"
        style={{ fontSize: STATE_MARK_FONT_PX }}
      >
        {props.which}
      </span>
    </>
  );
}

/** A full lid, separate from the body radius, closes the vertical cylinder. */
function DatabaseCap(): JSX.Element {
  return (
    <svg
      className="archer-c4-database-cap"
      viewBox="0 0 100 14"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <ellipse cx="50" cy="7" rx="49.5" ry="6.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** The full end ellipse distinguishes a horizontal cylinder from a capsule. */
function QueueCap(): JSX.Element {
  return (
    <svg
      className="archer-c4-queue-cap"
      viewBox="0 0 32 100"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <ellipse cx="16" cy="50" rx="15" ry="49" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** A C4 element: the person figure, the name, `[Kind: technology]`, and the description. */
function C4Lines(props: { id: string; label: string; box: FigureBox }): JSX.Element {
  const { c4, lines } = props.box;
  const authoring = useContext(AuthoringHandles);
  return (
    <span className="archer-node-text archer-c4-text">
      {c4?.glyph === true ? <PersonGlyph size={C4_PERSON_GLYPH_PX} /> : null}
      {authoring.editingNodeId === props.id ? (
        <InlineLabelInput
          label={`${props.id} name`}
          value={props.label}
          onCommit={(text) => authoring.onNodeLabelCommit?.(props.id, text)}
          onClose={() => authoring.onNodeLabelClose?.()}
        />
      ) : (
        <span className="archer-c4-label">{lines.join(" ")}</span>
      )}
      <span className="archer-c4-type" style={{ fontSize: C4_TYPE_FONT_PX, lineHeight: `${C4_TYPE_LINE_PX}px` }}>
        {c4?.typeLine}
      </span>
      {c4 === undefined || c4.description.length === 0 ? null : (
        <span
          className="archer-c4-description"
          style={{ fontSize: C4_TEXT_FONT_PX, lineHeight: `${C4_TEXT_LINE_PX}px` }}
        >
          {c4.description.map((line, index) => (
            <span
              className="archer-node-label-row"
              // biome-ignore lint/suspicious/noArrayIndexKey: the wrapped lines of one label, re-derived together; a line has no identity or state beyond its position.
              key={index}
            >
              {line}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

function LabelRows(props: { id?: string; label?: string; lines: readonly string[] }): JSX.Element {
  const authoring = useContext(AuthoringHandles);
  if (props.id !== undefined && authoring.editingNodeId === props.id) {
    const id = props.id;
    return (
      <span className="archer-node-text">
        <InlineLabelInput
          label={`${id} label`}
          value={props.label ?? ""}
          onCommit={(text) => authoring.onNodeLabelCommit?.(id, text)}
          onClose={() => authoring.onNodeLabelClose?.()}
        />
      </span>
    );
  }
  return (
    <span className="archer-node-text">
      {props.lines.map((line, index) => (
        <span
          className="archer-node-label-row"
          // biome-ignore lint/suspicious/noArrayIndexKey: the wrapped lines of one label, re-derived together; a line has no identity or state beyond its position.
          key={index}
        >
          {line}
        </span>
      ))}
    </span>
  );
}

export function FigureNode(props: NodeProps<Node<DiagramNodeData>>): JSX.Element {
  const { label, shape, typeface, figure, direction, note } = props.data;
  // C4 elements take connections while editing, as flowchart shapes do; other figures do not yet.
  const authoring = useContext(AuthoringHandles);
  const connectable =
    authoring.enabled &&
    props.isConnectable &&
    (figure?.type === "c4" ||
      figure?.type === "entity" ||
      (figure?.type === "state" && (figure.kind === "state" || figure.kind === "choice")));
  // React Flow measures handles once; the canvas re-measures every node's when editing turns on (`RemeasureHandles`).
  // The same call, in the same face, that sized this node's box in the layout.
  const control = props.data.closed === true;
  const box = useMemo(
    () => (figure === undefined ? null : figureBox(figure, label, shape, direction, typeface, control)),
    [figure, label, shape, direction, typeface, control],
  );
  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={connectable}
        aria-hidden
        aria-label={connectable ? `Connect into ${handleName(label, props.id)}` : undefined}
      />
      {box === null ? null : <FigureBody id={props.id} data={props.data} box={box} />}
      {note === undefined || box === null ? null : <StateNote note={note} width={box.width} height={box.height} />}
      <PinRow pins={props.data.pins} owner={props.id} dimmed={props.data.dimmed} />
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={connectable}
        aria-hidden
        aria-label={connectable ? `Connect from ${handleName(label, props.id)}` : undefined}
      />
    </>
  );
}
