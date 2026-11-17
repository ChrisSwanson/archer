// The user-journey model (a `journey` source).
//
// Mermaid's journey syntax has no IDs, so Archer derives them from names,
// never from positions (an index would change whenever a task is inserted
// above, and a comment would move to the wrong task):
// - a task's ID is its name in lower case, with each run of other characters
//   turned into `-` (`Make tea` is `make-tea`); a letter or digit outside
//   A-Z and 0-9 is spelled as its code point (`u8336`). Two tasks whose names
//   give the same ID are refused: rename one.
// - a section's ID is `section-` and its name made the same way.
// Renaming a task or a section changes its ID, as renaming a state does.
//
// Actors are names, kept in the order they first appear; they are not
// elements of their own.

import type { StableId } from "./ids.ts";

export const MIN_JOURNEY_SCORE = 1;
export const MAX_JOURNEY_SCORE = 5;

export interface JourneyTask {
  id: StableId;
  label: string;
  /** How the task feels, 1 (worst) to 5 (best). */
  score: number;
  actors: string[];
}

export interface JourneySection {
  id: StableId;
  label: string;
  tasks: JourneyTask[];
}

export interface UserJourney {
  type: "user-journey";
  title?: string | null;
  actors: string[];
  sections: JourneySection[];
}
