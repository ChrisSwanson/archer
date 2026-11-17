// Generated projects of a chosen size for scale and fs-budget tests (performance plan, slices 2-3).
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ScaleOptions {
  /** Unregistered `.mmd` files under `.archer/diagrams/`. */
  readonly diagrams: number;
  /** Notes under `.archer/notes/`, each about its same-numbered diagram; every tenth embeds one diagram. */
  readonly notes?: number;
  /** Padding added to every diagram source, in bytes. */
  readonly size?: number;
}

/** Creates a project in a fresh temp dir; the caller removes it (tests register it with their own cleanup). */
export function scaleProject(options: ScaleOptions): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archer-scale-")));
  mkdirSync(join(root, ".archer/diagrams"), { recursive: true });
  mkdirSync(join(root, ".archer/notes"), { recursive: true });
  writeFileSync(join(root, "archer.toml"), "version = 1\n");
  const notes = options.notes ?? options.diagrams;
  for (let i = 0; i < Math.max(options.diagrams, notes); i++) {
    if (i < options.diagrams) {
      let body = `flowchart LR\n  a${i}[Alpha ${i}] e1@--> b${i}[Beta ${i}]\n  b${i} e2@--> c${i}[Gamma ${i}]\n`;
      for (let k = 0; body.length < (options.size ?? 0); k++)
        body += `  n${k}[Node ${k} padding text] e${k + 3}@--> b${i}\n`;
      writeFileSync(join(root, `.archer/diagrams/d${i}.mmd`), body);
    }
    if (i < notes) {
      const embedded = i % 10 === 5 ? "\n```mermaid\n%% archer-id: emb\nflowchart LR\n  p[P] e1@--> q[Q]\n```\n" : "";
      writeFileSync(
        join(root, `.archer/notes/n${i}.md`),
        `---\ndiagrams: [d${i}]\n---\n# Note ${i}\n\nSome text about diagram ${i} and its parts.\n${embedded}`,
      );
    }
  }
  // A note with no front matter entry is about the diagrams beside it (resolved by folder).
  writeFileSync(join(root, ".archer/diagrams/beside.md"), "# Beside\n\nAbout the diagrams in this folder.\n");
  return root;
}
