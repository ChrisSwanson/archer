/**
 * A group that is a model element: a composite state, a C4 boundary, an
 * architecture group (`FRAME_NODE_TYPE` in `xflow-adapter.ts`).
 *
 * Drawn as a flowchart subgraph is -- a frame, with its name in a band across
 * its top -- and painted by the stylesheet from the wrapper's classes, so
 * selection, the keyboard ring and the agent's emphasis are the wrapper's, as
 * they are on a node. It differs from a subgraph in two ways: it has handles,
 * because a transition can start or end on a composite state and an
 * architecture edge on the boundary of a group; and its name says what kind
 * of frame it is.
 */
import { memo, type CSSProperties, type JSX } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { BOUNDARY_WORD } from "./figures";
import type { DiagramGroupData } from "./xflow-adapter";
import { PinRow } from "./CommentPins";
import { ArchitectureGlyph } from "./FigureGlyphs";
import { FRAME_CAPTION_INSET } from "../layout/captions";

/**
 * Where a frame's caption is drawn: where the layout placed it, in the band
 * ELK kept inside the frame and clear of every wire and arrowhead
 * (`layout/captions.ts`). It used to hang above the frame, outside anything
 * ELK knew about, and wires ran through it.
 */
export function captionStyle(at: DiagramGroupData["captionAt"]): CSSProperties {
  const place = at ?? FRAME_CAPTION_INSET;
  return { left: place.x, top: place.y };
}

function FrameNodeComponent(props: NodeProps<Node<DiagramGroupData>>): JSX.Element {
  const { label, figure, pins, captionAt, dimmed } = props.data;
  return (
    <>
      {/* React Flow resolves an edge's ends from its nodes' handles. */}
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <span className="archer-frame-caption" style={captionStyle(captionAt)}>
        {figure?.type === "zone" && figure.icon !== undefined ? <ArchitectureGlyph icon={figure.icon} /> : null}
        <span className="archer-frame-name">{label}</span>
        {figure?.type === "boundary" ? <span className="archer-frame-kind">[{BOUNDARY_WORD[figure.kind]}]</span> : null}
      </span>
      <PinRow pins={pins} inside owner={props.id} dimmed={dimmed} />
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </>
  );
}

export const FrameNode = memo(FrameNodeComponent);
