import { AccuracyError } from "./errors.ts";
export const MAX_COVERAGE_PATTERNS = 64;
export const MAX_COVERAGE_PATH_CHARS = 1024;
/** Literal paths, * and ? within a segment, ** as a whole segment. No shell/glob expansion. */
export function coveragePatterns(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > MAX_COVERAGE_PATTERNS)
    throw new AccuracyError(
      "invalid_coverage",
      `covers must be an array of at most ${MAX_COVERAGE_PATTERNS} quoted paths/globs`,
    );
  return [
    ...new Set(
      raw.map((value) => {
        if (
          typeof value !== "string" ||
          value.length === 0 ||
          value.length > MAX_COVERAGE_PATH_CHARS ||
          /[\u0000-\u001f\u007f\\:{}[\]!]/.test(value) ||
          /[@+?*]\(/.test(value)
        )
          throw new AccuracyError(
            "invalid_coverage",
            "covers paths/globs must be nonempty relative paths; supported wildcards are *, ? and whole-segment **",
          );
        const parts = value.split("/");
        if (
          parts.length > 64 ||
          parts.some(
            (part) =>
              part === "" ||
              part === "." ||
              part === ".." ||
              part.toLowerCase() === ".git" ||
              (part.includes("**") && part !== "**"),
          )
        )
          throw new AccuracyError(
            "invalid_coverage",
            "covers paths/globs must stay in the project, avoid .git and use ** only as a whole segment",
          );
        return value;
      }),
    ),
  ];
}
/** Iterative bounded segment matcher; pattern syntax is validated before use. */
export function coveredBy(path: string, patterns: readonly string[]): boolean {
  if (path.length > MAX_COVERAGE_PATH_CHARS) throw new AccuracyError("accuracy_limit", "a covered path is too long");
  const parts = path.split("/");
  return patterns.some((pattern) => {
    const glob = pattern.split("/");
    let states = new Set([0]);
    const expand = () => {
      for (let i = 0; i < glob.length; i++) if (glob[i] === "**" && states.has(i)) states.add(i + 1);
    };
    for (const part of parts) {
      expand();
      const next = new Set<number>();
      for (const i of states) {
        if (glob[i] === "**") next.add(i);
        else if (glob[i] !== undefined && segmentMatches(part, glob[i]!)) next.add(i + 1);
      }
      states = next;
    }
    expand();
    return states.has(glob.length);
  });
}
function segmentMatches(text: string, pattern: string): boolean {
  // Wildcard matching with a monotonic text cursor and a remembered last *.
  let i = 0,
    j = 0,
    star = -1,
    retry = 0;
  while (i < text.length) {
    if (pattern[j] === "?" || pattern[j] === text[i]) {
      i++;
      j++;
    } else if (pattern[j] === "*") {
      star = j++;
      retry = i;
    } else if (star !== -1) {
      j = star + 1;
      i = ++retry;
    } else return false;
  }
  while (pattern[j] === "*") j++;
  return j === pattern.length;
}
/** Literal directory prefixes narrow Git enumeration before any output/files are read. */
export function coverageRoots(patterns: readonly string[]): string[] {
  const roots = patterns.map((pattern) => {
    const parts = pattern.split("/");
    const firstWildcard = parts.findIndex((part) => /[*?]/.test(part));
    return (firstWildcard < 0 ? parts : parts.slice(0, firstWildcard)).join("/");
  });
  if (roots.includes("")) return [""];
  return [...new Set(roots)].filter((root) => !roots.some((other) => other !== root && root.startsWith(`${other}/`)));
}
