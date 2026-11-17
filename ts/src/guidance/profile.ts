// One family's part of the supported-Mermaid profile (ts/docs/supported-mermaid.md): the
// overview, that family's section, nesting where the family nests, the limits and entity codes. The whole
// profile is ~45 KB; an agent drawing one family needs a fifth of it.

export const PROFILE_FAMILIES = ["flowchart", "sequence", "state", "er", "c4", "architecture", "journey"] as const;
export type ProfileFamily = (typeof PROFILE_FAMILIES)[number];

const HEADINGS: Record<ProfileFamily, string> = {
  flowchart: "Supported Mermaid flowchart profile",
  sequence: "Supported Mermaid sequence diagram profile",
  state: "Supported Mermaid state diagram profile",
  er: "Supported Mermaid ER diagram profile",
  c4: "Supported Mermaid C4 profile",
  architecture: "Supported Mermaid architecture profile",
  journey: "Supported Mermaid user journey profile",
};
/** Families whose boundaries, subgraphs, groups or composite states nest. */
const NESTS: ReadonlySet<ProfileFamily> = new Set(["flowchart", "state", "c4", "architecture"]);

export function isProfileFamily(value: string): value is ProfileFamily {
  return (PROFILE_FAMILIES as readonly string[]).includes(value);
}

/** The parts of `profile` for `family`, in the profile's order; refuses an unknown family. */
export function profileForFamily(profile: string, family: string): string {
  if (!isProfileFamily(family))
    throw new Error(`unknown Mermaid family "${family.slice(0, 40)}"; choose ${PROFILE_FAMILIES.join(", ")}`);
  const sections = profile.split(/^(?=# )/m);
  // Entity codes: every family's labels decode them, and the family sections point to them.
  const wanted = new Set([
    "Supported Mermaid",
    HEADINGS[family],
    "Limits",
    "Entity codes",
    ...(NESTS.has(family) ? ["Nesting profile"] : []),
  ]);
  const kept = sections.filter((section) => wanted.has(/^# (.*)$/m.exec(section)?.[1]?.trim() ?? ""));
  return `${kept.join("").trimEnd()}\n\nThe whole profile, every family: archer://docs/supported-mermaid.\n`;
}
