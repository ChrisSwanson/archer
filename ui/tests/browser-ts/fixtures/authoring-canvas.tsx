/** Component fixture: actual canvas gestures, no workspace or source-save substitute. */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { DiagramCanvas, type CanvasAuthoring } from "../../../src/diagrams/DiagramCanvas";
import type { LayoutResult } from "../../../src/layout/elk-adapter";
import "../../../src/styles.css";

const params = new URLSearchParams(location.search),
  grouped = params.has("grouped");
const layout: LayoutResult = {
  width: 640,
  height: 360,
  direction: "lr",
  notation: "flowchart",
  groups: grouped ? [{ id: "g", label: "Group", parentId: undefined, x: 0, y: 0, width: 620, height: 340 }] : [],
  nodes: ["a", "b"].map((id, i) => ({
    id,
    label: id === "a" ? "Client" : "Server",
    x: 80 + i * 280,
    y: 100 + i * 80,
    width: 140,
    height: 80,
    shape: "rectangle",
    classes: [],
    groupId: grouped ? "g" : undefined,
  })),
  edges: [
    {
      id: "e1",
      source: "a",
      target: "b",
      label: "uses",
      points: [
        { x: 220, y: 140 },
        { x: 290, y: 140 },
        { x: 290, y: 220 },
        { x: 360, y: 220 },
      ],
      labelAnchor: undefined,
    },
  ],
};
const frozen = JSON.stringify(layout);

function Fixture() {
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [events, setEvents] = useState<unknown[]>([]),
    [placing, setPlacing] = useState(false),
    [editing, setEditing] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ nodeIds: string[]; edgeIds: string[] }>({ nodeIds: [], edgeIds: [] });
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing !== null) input.current?.focus();
  }, [editing]);
  const append = (event: unknown) => setEvents((previous) => [...previous, event]);
  const authoring: CanvasAuthoring = {
    disabled: params.has("disabled"),
    positions,
    onNodeMove: (id, position) => {
      setPositions((previous) => ({ ...previous, [id]: position }));
      append({ kind: "move", id, position });
    },
    onConnect: (source, target) => append({ kind: "connect", source, target }),
    onNodeLabelEdit: (id) => {
      setEditing(`node:${id}`);
      append({ kind: "node-label", id });
    },
    onEdgeLabelEdit: (id) => {
      setEditing(`edge:${id}`);
      append({ kind: "edge-label", id });
    },
    ...(placing ? { onPanePlace: (position) => append({ kind: "place", position }) } : {}),
  };
  return (
    <div style={{ width: "100vw", height: "100vh", display: "grid", gridTemplateRows: "minmax(0, 1fr) 104px" }}>
      <div style={{ minHeight: 0 }}>
        <DiagramCanvas
          state={{ status: "ready", layout }}
          authoring={params.has("reader") ? undefined : authoring}
          selection={selection}
          onNodeClick={(id) => setSelection({ nodeIds: [id], edgeIds: [] })}
          onEdgeClick={(id) => setSelection({ nodeIds: [], edgeIds: [id] })}
        />
      </div>
      {/* Test telemetry has its own row: it must never intercept canvas gestures. */}
      <div
        style={{ minWidth: 0, overflow: "auto", overflowWrap: "anywhere", background: "var(--surface)", padding: 8 }}
      >
        <button type="button" onClick={() => setPlacing((value) => !value)}>
          Place box
        </button>
        {editing !== null ? <input ref={input} aria-label="Edit label" defaultValue={editing} /> : null}
        <output data-testid="events">{JSON.stringify(events)}</output>
        <output data-testid="layout-intact">{String(JSON.stringify(layout) === frozen)}</output>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
