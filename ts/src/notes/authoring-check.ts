// What a note an agent just wrote still needs before its diagram is presented: a pinned name
// (`%% archer-id:` first inside the fence, so the address survives heading edits) and the front
// matter every agent-written note carries (`author: agent`, `description:`). Said by read_diagram
// and validate_diagram, the two calls of the create flow, because small agents missed both
// (docs/evaluations/eval-baseline.md). Only for the agent's own note (author: agent) or a note
// never committed: the person's notes are theirs, and Archer does not ask agents to restructure them.
import { archerIdOf } from "../../../shared/note-diagrams.mts";
import { splitFrontMatter } from "../project/inventory.ts";
import type { Freshness } from "./freshness.ts";

export interface AuthoringCheckInput {
  /** The whole note, front matter included. */
  readonly noteText: string;
  readonly notePath: string;
  /** The diagram's name: pinned or derived from its heading. */
  readonly name: string;
  /** The Mermaid source being read or checked: the fence's body. */
  readonly source: string;
  /** Archer reads a valid `%% archer-id:` for it (the file's, or the source's to be written). */
  readonly pinned: boolean;
  readonly freshness: Freshness;
}

const ID_LINE = /^\s*%%\s*archer-id\s*:\s*(\S+)/m;

/** Sentences naming what to fix; empty when nothing is missing or the note is not the agent's to fix. */
export function authoringCheck({ noteText, notePath, name, source, pinned, freshness }: AuthoringCheckInput): string[] {
  const { fields } = splitFrontMatter(noteText);
  const own = fields.author === "agent";
  if (!own && freshness.status !== "never-committed") return [];
  const repairs: string[] = [];
  if (!pinned) {
    // A marker after the header is no pin (archerIdOf reads only the lines before it).
    const marker = archerIdOf(source.replace(/\r\n?/g, "\n")) === null ? ID_LINE.exec(source)?.[1] : undefined;
    repairs.push(
      marker !== undefined
        ? `its \`%% archer-id: ${marker}\` line comes after the Mermaid header, where Archer does not read it: move it to the first line inside the fence (the diagram is then ${notePath}#${marker}; read it there)`
        : `pin its name with \`%% archer-id: ${name}\` as the first line inside the fence (the name now comes from the heading and changes with it)`,
    );
  }
  const missing = [own ? null : "`author: agent`", fields.description ? null : "`description:` (one sentence)"].filter(
    (x) => x !== null,
  );
  if (missing.length > 0) repairs.push(`its front matter needs ${missing.join(" and ")}`);
  if (repairs.length === 0) return [];
  // The person's notes are theirs: in a note that is only new, every repair waits on the agent having written it.
  if (!own) return [`If you wrote this new note, ${repairs.join("; ")}; leave a person's note as it is.`];
  return repairs.map((r) => `${r[0]!.toUpperCase()}${r.slice(1)}.`);
}
