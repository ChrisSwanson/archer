// A walkthrough as the prototype's Markdown (docs/prototypes/walkthroughs/README.md): what
// `archer walkthrough show --markdown` prints, so a walkthrough is readable on GitHub as prose
// (ADR 0034 §1). One way only: the JSON sidecar stays the format.
import type { Resolution, Step, Walkthrough } from "./contract.ts";

const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);
const code = (text: string): string => `\`${text.replace(/`/g, "'")}\``;

function refsOf(step: Step): string[] {
  const edges = (step.edges ?? []).map((e) =>
    code(`${e.source} -> ${e.target}${e.label === undefined ? "" : `: ${e.label}`}`),
  );
  const nodes =
    (step.nodes ?? []).length === 0
      ? []
      : [
          `${step.nodes!.some((n) => n.kind === "group") ? "boxes and groups" : "boxes"} ${step.nodes!.map((n) => code(n.id)).join(", ")}`,
        ];
  const messages = (step.messages ?? []).map((m) => `message ${code(`${m.from} -> ${m.to}: ${m.label}`)}`);
  return [...edges, ...nodes, ...messages];
}

export function walkthroughMarkdown(w: Walkthrough, resolution?: Resolution): string {
  const lines = [`### ${w.title}`];
  if (w.description !== undefined) lines.push(w.description);
  lines.push("", `revision: ${w.modelRevision.replace(/^sha256:/, "").slice(0, 7)}`);
  if (w.note !== undefined) lines.push(`scenario: ${w.note}`);
  lines.push("");
  w.steps.forEach((step, i) => {
    const stale = resolution?.steps[i]?.status === "out-of-date" ? " (out of date)" : "";
    lines.push(`${i + 1}. **${step.title}**${stale} — ${refsOf(step).join(", ")}`);
    lines.push(
      `   ${step.kind === "sends" ? "Sends" : "Does"}: ${sentence(step.what)}${step.why === undefined ? "" : ` Why: ${sentence(step.why)}`}`,
    );
    if ((step.code ?? []).length > 0) lines.push(`   Code: ${step.code!.map(code).join(", ")}`);
  });
  return `${lines.join("\n")}\n`;
}
