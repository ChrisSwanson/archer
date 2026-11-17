/**
 * The node the graph canvas draws: a shape, an optional kind, and a label.
 *
 * React Flow's built-in node is a top-aligned rectangle and nothing else, so
 * `shape` and `classes` reached the canvas for a long time without either
 * being drawn. This component draws both, and draws the label in the rows the
 * layout sized the box for (`nodeBox`) so it can be centred without the
 * browser re-wrapping it into a height nobody reserved.
 *
 * WHAT IS NOT HERE, deliberately: the box, the fill, the border and all three
 * rings. Those are painted on React Flow's own wrapper element -- the one that
 * carries `.archer-node`, `.selected`, `.archer-kbd-focus` and `.archer-emph`
 * -- and a shape is, for everything but the diamond and the hexagon, just
 * that element's `border-radius`. Keeping the paint there is what lets every
 * existing state rule in `styles.css` apply to every shape unchanged. Those
 * two are the outlines no radius can make, so each gets an element of its own
 * to paint.
 */
import { KindGlyph } from "../export/KindGlyph";
import { memo, useContext, useMemo, type JSX } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { PERSON_GLYPH_PX, hexagonPoints, kindOf, nodeBox, offsetPolygon, outlineOf } from "../layout/graph-metrics";
import type { DiagramNodeData } from "./xflow-adapter";
import { PinRow } from "./CommentPins";
import { FigureNode, handleName } from "./FigureNode";
import { AuthoringHandles } from "./authoring-handles";
import { InlineLabelInput } from "./InlineLabelInput";

/** How far inside the body the keyboard ring stands: the box shapes' 3px inset
 *  shadow, measured to the middle of the stroke. */
const HEXAGON_INSET_PX = 2;

const polygon = (points: readonly { readonly x: number; readonly y: number }[]): string =>
  points.map((point) => `${point.x},${point.y}`).join(" ");

/**
 * The hexagon's outline and its rings, as one SVG the size of the node.
 *
 * Drawn from `hexagonPoints`, the corners the layout carries wires on to, so
 * the wires end on the line that is drawn. What each polygon is for is in the
 * hexagon block of `styles.css`.
 */
function HexagonOutline(props: { width: number; height: number }): JSX.Element {
  const corners = hexagonPoints(props.width, props.height);
  const body = polygon(corners);
  return (
    <svg
      className="archer-node-hexagon"
      width={props.width}
      height={props.height}
      viewBox={`0 0 ${props.width} ${props.height}`}
      aria-hidden="true"
      focusable="false"
    >
      <polygon className="archer-node-hexagon-halo" points={body} />
      <polygon className="archer-node-hexagon-body" points={body} />
      <polygon className="archer-node-hexagon-inset" points={polygon(offsetPolygon(corners, -HEXAGON_INSET_PX))} />
    </svg>
  );
}

/**
 * A flowchart node, or a figure of one of the newer diagram types
 * (`FigureNode`): two components rather than one with a branch inside, so
 * neither calls hooks the other does not.
 */
function GraphNodeComponent(props: NodeProps<Node<DiagramNodeData>>): JSX.Element {
  const drawn = props.data.figure === undefined ? <PlainNode {...props} /> : <FigureNode {...props} />;
  if (props.data.inside === undefined) return drawn;
  // A closed container of the nested view: what is inside, in the row the layout added under the label.
  return (
    <>
      {drawn}
      <span className="archer-nest-inside">{props.data.inside}</span>
    </>
  );
}

function PlainNode(props: NodeProps<Node<DiagramNodeData>>): JSX.Element {
  const authoring = useContext(AuthoringHandles);
  // Handles are re-measured when editing turns on or the direction changes by the canvas, for all nodes at
  // once (`RemeasureHandles` in DiagramCanvas): one store write rather than one per node.
  const ends = (
    {
      lr: [Position.Left, Position.Right],
      rl: [Position.Right, Position.Left],
      tb: [Position.Top, Position.Bottom],
      bt: [Position.Bottom, Position.Top],
    } as const
  )[authoring.direction];
  const { label, shape, classes, typeface } = props.data;
  // The same call, in the same face, that sized this node's box in the layout:
  // the rows drawn are the rows that were reserved (a closed container's narrower, clear of its "+").
  const control = props.data.closed === true;
  const box = useMemo(
    () => nodeBox(label, shape, classes, typeface, control),
    [label, shape, classes, typeface, control],
  );
  const lines = box.lines;
  const kind = kindOf(classes);
  const outline = outlineOf(shape, classes);

  return (
    <>
      {/* React Flow resolves an edge's ends from its nodes' handles and draws
          nothing for a node without them. They are invisible (`styles.css`):
          the wires themselves follow ELK's routes, not these. */}
      <Handle
        type="target"
        position={ends[0]}
        isConnectable={authoring.enabled && props.isConnectable}
        aria-hidden
        aria-label={`Connect into ${handleName(label, props.id)}`}
      />
      {outline === "diamond" ? <span className="archer-node-diamond" aria-hidden="true" /> : null}
      {outline === "hexagon" ? <HexagonOutline width={box.width} height={box.height} /> : null}
      <span className="archer-node-text">
        {kind === undefined || kind === "person" ? null : (
          <span className="archer-node-kind">
            <KindGlyph kind={kind} />
            {kind}
          </span>
        )}
        {authoring.editingNodeId === props.id ? (
          <InlineLabelInput
            label={`${props.id} label`}
            value={label}
            onCommit={(text) => authoring.onNodeLabelCommit?.(props.id, text)}
            onClose={() => authoring.onNodeLabelClose?.()}
          />
        ) : (
          lines.map((line, index) => (
            // Rows are positional and never reorder, so the index is the key. The title's rows come first;
            // the rest are the description, regular weight and a step smaller (`nodeBox`).
            <span
              className={
                index < box.titleRows
                  ? "archer-node-label-row archer-node-title-row"
                  : "archer-node-label-row archer-node-description-row"
              }
              // biome-ignore lint/suspicious/noArrayIndexKey: the wrapped lines of one label, re-derived together; a line has no identity or state beyond its position.
              key={index}
            >
              {/* A person says so with a glyph beside its title, not a "Person" row above it (`nodeBox`). */}
              {index === 0 && kind === "person" ? (
                <span className="archer-node-person-glyph" aria-hidden="true">
                  <KindGlyph kind="person" size={PERSON_GLYPH_PX} />
                </span>
              ) : null}
              {line}
            </span>
          ))
        )}
      </span>
      {/* A comment thread is about this node. Decoration: the node's
          accessible name already says so (`xflow-adapter.ts`). */}
      <PinRow pins={props.data.pins} owner={props.id} dimmed={props.data.dimmed} />
      <Handle
        type="source"
        position={ends[1]}
        isConnectable={authoring.enabled && props.isConnectable}
        aria-hidden
        aria-label={`Connect from ${handleName(label, props.id)}`}
      />
    </>
  );
}

export const GraphNode = memo(GraphNodeComponent);
