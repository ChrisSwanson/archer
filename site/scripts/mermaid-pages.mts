/** The agent-facing profile remains the single source for every syntax rule and example. */
export const mermaidFamilies = [
  {
    slug: "flowchart",
    title: "Flowcharts",
    heading: "Supported Mermaid flowchart profile",
    purpose: "Processing stages and data movement",
  },
  {
    slug: "sequence",
    title: "Sequence diagrams",
    heading: "Supported Mermaid sequence diagram profile",
    purpose: "Messages in a concrete scenario",
  },
  {
    slug: "state",
    title: "State diagrams",
    heading: "Supported Mermaid state diagram profile",
    purpose: "States and their transitions",
  },
  {
    slug: "er",
    title: "Entity relationships",
    heading: "Supported Mermaid ER diagram profile",
    purpose: "Entities, attributes and cardinality",
  },
  {
    slug: "c4",
    title: "C4 diagrams",
    heading: "Supported Mermaid C4 profile",
    purpose: "System context, containers or components",
  },
  {
    slug: "architecture",
    title: "Architecture diagrams",
    heading: "Supported Mermaid architecture profile",
    purpose: "Services and infrastructure groups",
  },
  {
    slug: "journey",
    title: "User journeys",
    heading: "Supported Mermaid user journey profile",
    purpose: "Tasks, actors and satisfaction scores",
  },
] as const;

const sharedHeadings = ["Nesting profile", "Limits", "Entity codes", "Migrating from Archer 0.3"];
const generated = "<!-- Generated from ts/docs/supported-mermaid.md; edit the source document. -->\n\n";
const rulesLink = "[Shared rules](/supported-mermaid/rules) cover labels, limits, nesting and diagnostics.";

/** Hide long specialist detail while keeping section headings available to the page outline. */
function disclose(body: string, headings: string[]): string {
  return body.replace(/^## (.+)\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm, (whole, heading: string, content: string) =>
    headings.includes(heading)
      ? `## ${heading}\n\n::: details Syntax and detailed rules\n\n${content.trim()}\n\n:::\n\n`
      : whole,
  );
}

/** A new top-level source section must be assigned explicitly, rather than disappearing from the site. */
export function mermaidPages(source: string): Record<string, string> {
  const sections = new Map<string, string>();
  for (const match of source.matchAll(/^# (.+)\r?\n([\s\S]*?)(?=^# |$(?![\s\S]))/gm)) {
    sections.set(match[1]!, match[2]!.trim());
  }
  const expected = new Set([
    "Supported Mermaid",
    ...mermaidFamilies.map((family) => family.heading),
    ...sharedHeadings,
  ]);
  for (const heading of sections.keys()) {
    if (!expected.has(heading)) throw new Error(`Unknown Mermaid profile section: ${heading}`);
  }
  for (const heading of expected) {
    if (!sections.has(heading)) throw new Error(`Missing Mermaid profile section: ${heading}`);
  }

  const overview = sections.get("Supported Mermaid")!;
  const presentationStart = overview.indexOf("## Presentation:");
  if (presentationStart < 0) throw new Error("Missing Mermaid presentation guidance");
  const chooser = [
    "## Choose a diagram",
    "",
    "| Diagram | Use it for |",
    "| --- | --- |",
    ...mermaidFamilies.map((family) => `| [${family.title}](/supported-mermaid/${family.slug}) | ${family.purpose} |`),
  ].join("\n");
  const pages: Record<string, string> = {
    "supported-mermaid/index.md": `${generated}# Supported Mermaid\n\n${overview.slice(0, presentationStart).trim()}\n\n${chooser}\n\n## Before you write\n\nDeclare every element. Keep IDs stable: comments and highlights refer to them. Flowchart edges need explicit IDs; other families use the IDs described on their pages.\n\n${rulesLink}\n\n::: details Choosing structure, data flow or message order\n\n${overview
      .slice(presentationStart)
      .replace(/^## .+\n/, "")
      .trim()}\n\n:::\n`,
  };
  let diagnostics = "";
  for (const family of mermaidFamilies) {
    let body = sections.get(family.heading)!;
    if (family.slug === "flowchart") {
      const start = body.indexOf("## Diagnostics\n");
      if (start < 0) throw new Error("Missing Mermaid diagnostics guidance");
      diagnostics = body.slice(start);
      body = disclose(body.slice(0, start).trim(), ["Label text", "Kinds and categories"]);
    }
    if (family.slug === "sequence") body = disclose(body, ["Notes", "Fragment types"]);
    pages[`supported-mermaid/${family.slug}.md`] = `${generated}# ${family.title}\n\n${body}\n\n${rulesLink}\n`;
  }
  const rules = sharedHeadings.map((heading) => {
    const body = sections.get(heading)!;
    return `## ${heading === "Nesting profile" ? "Nesting" : heading}\n\n${body.replace(/^## /gm, "### ")}`;
  });
  pages["supported-mermaid/rules.md"] =
    `${generated}# Shared Mermaid rules\n\nThese rules apply to every supported diagram family.\n\n${diagnostics}\n\n${rules.join("\n\n")}\n`;
  return pages;
}
