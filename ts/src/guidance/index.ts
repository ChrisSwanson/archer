// Both MCP and CLI expose the installed skill references verbatim. Keep the
// authoring advice in those canonical Markdown files, not in adapter copies.
import { installationAsset } from "../assets.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SURFACES_RULE } from "./surfaces.ts";
import { bundledSkillDir } from "./skill-folder.ts";

export type GuidanceId = "surfaces" | "authoring" | "cli" | "mcp" | "admin" | "docs-mode" | "walkthroughs";

export const GUIDANCE = [
  {
    id: "surfaces",
    uri: "archer://docs/surfaces",
    name: "surfaces_guidance",
    title: "Which Archer surface to use",
    description:
      "The one rule: use the archer CLI; MCP is an opt-in adapter over the same operations; follow the fix an error names. The same text the skill and these instructions carry.",
    text: SURFACES_RULE,
  },
  {
    id: "authoring",
    uri: "archer://docs/authoring",
    name: "authoring_guidance",
    title: "Archer authoring guide",
    description:
      "Choose a visualization for the user's question, preserve facts and deliver a verified diagram. The same authoring reference shipped with the Archer skill.",
    asset: "guidance/authoring.md",
  },
  {
    id: "cli",
    uri: "archer://docs/cli",
    name: "cli_guidance",
    title: "Archer CLI guide",
    description:
      "CLI discovery, authoring, revision and presentation workflows: how to run every Archer operation from a shell. The same CLI reference shipped with the Archer skill.",
    asset: "guidance/cli.md",
  },
  {
    id: "mcp",
    uri: "archer://docs/mcp",
    name: "mcp_guidance",
    title: "Archer over MCP",
    description:
      "What the opt-in MCP adapter adds (inline drawing in web chat, the client's own consent prompt), the relay to the service and its tool refresh. The same reference shipped with the Archer skill.",
    skillReference: "mcp.md",
  },
  {
    id: "admin",
    uri: "archer://docs/admin",
    name: "admin_guidance",
    title: "Archer administration",
    description:
      "Setup, doctor, the turn-start hook, browser links, pairing and network access, running copies, startup overrides and upgrades. Open only for that work. The same reference shipped with the Archer skill.",
    skillReference: "admin.md",
  },
  {
    id: "docs-mode",
    uri: "archer://docs/docs-mode",
    name: "docs_mode_guidance",
    title: "Archer docs mode",
    description:
      'For a project with mode = "docs": the doc pack\'s files and caps, answering from it, end-of-task upkeep, growth control and the intent interview. The same reference shipped with the Archer skill.',
    asset: "guidance/docs-mode.md",
  },
  {
    id: "walkthroughs",
    uri: "archer://docs/walkthroughs",
    name: "walkthroughs_guidance",
    title: "Archer walkthroughs",
    description:
      "Numbered step-by-step paths over a diagram: presenting an existing one, writing one when asked, and keeping them true. The same reference shipped with the Archer skill.",
    asset: "guidance/walkthroughs.md",
  },
] as const satisfies readonly ({ id: GuidanceId; uri: string; name: string; title: string; description: string } & (
  | { asset: string }
  | { text: string }
  | { skillReference: string }
))[];

export function readGuidance(id: GuidanceId): string {
  const reference = GUIDANCE.find((guide) => guide.id === id);
  if (reference === undefined) throw new Error(`Unknown Archer guidance: ${String(id)}`);
  // The surfaces rule is one line kept in code; `archer docs surfaces` prints it as a file would.
  if ("text" in reference) return `${reference.text}\n`;
  // Kept only in the skill folder, which every installation ships beside its CLI.
  if ("skillReference" in reference)
    return readFileSync(join(bundledSkillDir(), "references", reference.skillReference), "utf8");
  return installationAsset(reference.asset).toString("utf8");
}
