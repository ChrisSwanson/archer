import { isDiagramAddress } from "../../../shared/note-diagrams.mts";

// Stable IDs: the view-local names a Mermaid author gives nodes, edges,
// groups and participants, and that selection and emphasis anchor to.

/** A string known to match {@link STABLE_ID_PATTERN}. */
export type StableId = string;

export const MAX_ID_CHARS = 128;

/** The schema's grammar for every ID: `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`. */
export const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isStableId(value: string): value is StableId {
  return STABLE_ID_PATTERN.test(value);
}

/**
 * A view id (ADR 0012): a stable ID, which names a `.mmd` or archer.toml
 * view, or a diagram address, `<note path>#<name>`, which names a mermaid
 * block in a note. Element ids stay stable IDs: use `isStableId` for them.
 */
export function isViewId(value: string): boolean {
  return isStableId(value) || isDiagramAddress(value);
}
