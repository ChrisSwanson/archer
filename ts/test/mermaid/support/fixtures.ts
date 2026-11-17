// The golden fixtures ported to real Mermaid syntax: each `<name>.mmd` beside
// the `<name>.json` model it compiles to.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface Fixture {
  /** `flowchart/minimal`, for test names. */
  name: string;
  source: string;
  expected: unknown;
}

const ROOT = fileURLToPath(new URL("../../fixtures/", import.meta.url));
export const FIXTURE_FAMILIES = ["flowchart", "sequence", "state", "er", "c4", "architecture", "journey"] as const;

/** The diagram type Mermaid reports for each family's fixtures. */
export const MERMAID_TYPES: Record<(typeof FIXTURE_FAMILIES)[number], string> = {
  flowchart: "flowchart-v2",
  sequence: "sequence",
  state: "stateDiagram",
  er: "er",
  c4: "c4",
  architecture: "architecture",
  journey: "journey",
};

export function listFixtureFiles(family: string): string[] {
  return readdirSync(`${ROOT}${family}`).sort();
}

export function loadFixtures(): Fixture[] {
  return FIXTURE_FAMILIES.flatMap((family) =>
    listFixtureFiles(family)
      .filter((file) => file.endsWith(".mmd"))
      .map((file) => {
        const stem = file.slice(0, -".mmd".length);
        return {
          name: `${family}/${stem}`,
          source: readFileSync(`${ROOT}${family}/${file}`, "utf8"),
          expected: JSON.parse(readFileSync(`${ROOT}${family}/${stem}.json`, "utf8")) as unknown,
        };
      }),
  );
}
