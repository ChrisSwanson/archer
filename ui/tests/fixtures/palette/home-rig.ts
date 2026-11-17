// The owner's home rig (DESIGN.md, "Diagram palette"), the Key's reference drawing, as a projected view.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compile } from "../../../../ts/src/mermaid/index";
import { projectEnvelope, type ProjectedView } from "../../../src/diagrams/projection";

export const HOME_RIG = readFileSync(resolve(__dirname, "home-rig.mmd"), "utf8");
/** The owner's favourite reference ("the loop"): you decide (blue), the AI's work (slate), consequential (red), dropped. */
export const SHIP_LOOP = readFileSync(resolve(__dirname, "ship-loop.mmd"), "utf8");

export async function viewOf(source: string): Promise<ProjectedView> {
  const compiled = await compile(source);
  if (compiled.model === null) throw new Error(JSON.stringify(compiled.diagnostics));
  const projected = projectEnvelope({
    schemaVersion: 2,
    revision: `sha256:${"a".repeat(64)}`,
    view: { id: "home-rig", kind: "freeform", title: "The Home Rig" },
    model: compiled.model,
  });
  if (!projected.ok || projected.type !== "graph") throw new Error("expected a graph");
  return projected.view;
}

