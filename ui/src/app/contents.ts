/**
 * A note as the project's pages list it: its summary, the diagrams it is
 * about, and its dates and description (`file-facts.ts`).
 */
import type { NoteSummary } from "../comments/contract";
import type { FileFacts } from "./file-facts";
import type { ThreadCounts } from "./inventory";

/** A note, with the diagrams it is about. */
export type ContentsNote = NoteSummary &
  FileFacts & { readonly viewIds: readonly string[]; readonly threads?: ThreadCounts };
