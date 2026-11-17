// Rust 0.3.0's input bounds, with the same numbers, codes and advice
// (crates/archer-core/src/limits.rs). Each is a refusal; nothing is cut to fit.

import { MAX_ID_CHARS } from "../model/ids.ts";

/** The most bytes of UTF-8 one view's source may hold: 256 KiB. */
export const MAX_SOURCE_BYTES = 256 * 1024;

/** The most characters one label may hold. */
export const MAX_LABEL_CHARS = 512;

/** The deepest subgraphs, or sequence fragments, may nest. */
export const MAX_NESTING_DEPTH = 24;

/**
 * The most characters one statement line may hold, checked before Mermaid
 * reads the source: some of its parsers are superlinear in a line's length
 * (200 000 commas in one C4 call took minutes). Comment lines are not bounded;
 * Mermaid never reads them. Real lines are far shorter (the repo's longest: 210).
 */
export const MAX_LINE_CHARS = 4096;

/**
 * The depth of blocks (subgraphs, fragments, composite states, boundaries)
 * past which the source is refused before Mermaid reads it, whatever the scan
 * would make of the blocks. Well above {@link MAX_NESTING_DEPTH}, which the
 * scan enforces precisely; this one only keeps Mermaid from deep recursion.
 */
export const MAX_SCANNED_DEPTH = 64;

export { MAX_ID_CHARS };

export function sourceTooLargeMessage(bytes: number, limit: number): string {
  return (
    `the diagram source is ${bytes} bytes, and Archer reads at most ${limit} per view. ` +
    "Split the diagram into several views: one per subsystem, or an overview with a view for each part."
  );
}

export function labelTooLongMessage(length: number): string {
  return (
    `this label is ${length} characters, and a label holds at most ${MAX_LABEL_CHARS}. ` +
    "Shorten it to what has to be read on the diagram, and say the rest in the conversation."
  );
}

/** The length of `text` in Unicode scalar values, as the label bound counts it. */
export function characterCount(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

export function lineTooLongMessage(length: number): string {
  return (
    `this line is ${length} characters, and Archer reads statement lines of at most ${MAX_LINE_CHARS}. ` +
    "Write one statement per line, and keep long text in the conversation or a note. Nothing else was checked."
  );
}
