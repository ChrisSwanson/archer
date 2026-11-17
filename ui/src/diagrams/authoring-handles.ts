import { createContext } from "react";
import type { GraphDirection } from "./projection";

/** Presentation-only connection affordances; absent for reader and MCP canvases. */
export interface AuthoringHandleContext {
  enabled: boolean;
  direction: GraphDirection;
  onEdgeLabelEdit?: (id: string) => void;
  /** The node whose label is being typed, in the node itself. */
  editingNodeId?: string | null;
  onNodeLabelCommit?: (id: string, label: string) => void;
  onNodeLabelClose?: () => void;
  /** The connection whose label is being typed, on the connection itself. */
  editingEdgeId?: string | null;
  onEdgeLabelCommit?: (id: string, label: string) => void;
  onEdgeLabelClose?: () => void;
}
export const AuthoringHandles = createContext<AuthoringHandleContext>({ enabled: false, direction: "tb" });
