// Archer's reading rules on top of a diagram that compiles (ADR 0030): what
// keeps a drawing legible, as opposed to what makes it valid.
//
// A lint finding is a WARNING on its own: a file that already carries one still
// compiles and renders. The agent may not INTRODUCE one, though: `write_diagram`
// compares the findings of the source it replaces with those of the source it
// writes, by identity (code and element, never position, so moving lines
// introduces nothing), and refuses a write that adds any. The person's own
// canvas saves are not refused: they see the same findings as warnings.
import type { DiagramModel } from "../model/index.ts";
import { elementsOf } from "../model/index.ts";
import { span, warning, type Diagnostic } from "./diagnostics.ts";
import { lintLinePatterns } from "./line-key.ts";
import { edgeLineOf } from "./source.ts";

/** An edge caption wraps at about this many characters on the page (`EDGE_LABEL_WRAP_CHARS`), on at most this many lines. */
export const LABEL_WRAP_CHARS = 24;
export const LABEL_MAX_LINES = 2;

export interface LintFinding {
  readonly diagnostic: Diagnostic;
  /** What the finding is about, stably: its code and the element (or pattern) it names. */
  readonly identity: string;
  /** The words it is about, where it is about a caption: how a baseline that cannot compile is still compared. */
  readonly text?: string;
}

/**
 * How many lines a caption takes wrapped greedily at `LABEL_WRAP_CHARS`
 * characters. A word longer than a line keeps a line of its own, as the page
 * draws it; an author's own line breaks start new lines.
 */
export function captionLines(text: string): number {
  let total = 0;
  for (const authored of text.split(/\n|<br\s*\/?>/i)) {
    let lines = 0;
    let current = 0;
    for (const word of authored.split(/\s+/).filter((token) => token.length > 0)) {
      const length = [...word].length;
      // A word longer than a line is split across lines, as the page splits it.
      if (length > LABEL_WRAP_CHARS) {
        lines += Math.ceil(length / LABEL_WRAP_CHARS);
        current = length % LABEL_WRAP_CHARS || LABEL_WRAP_CHARS;
        continue;
      }
      if (current === 0) {
        lines += 1;
        current = length;
      } else if (current + 1 + length <= LABEL_WRAP_CHARS) current += 1 + length;
      else {
        lines += 1;
        current = length;
      }
    }
    total += Math.max(lines, 1);
  }
  return total;
}

/** Every reading-rule finding for a model that compiled. Sequence and journey views have no edge captions to check. */
export function lint(source: string, model: DiagramModel): LintFinding[] {
  if (model.type === "sequence-trace" || model.type === "user-journey") return [];
  const findings: LintFinding[] = [];
  for (const link of elementsOf(model).links) {
    const label = link.label;
    if (label === undefined || label === null || label === "") continue;
    const lines = captionLines(label);
    if (lines <= LABEL_MAX_LINES) continue;
    const line = edgeLineOf(source, link.id, label, [link.source, link.target]);
    findings.push({
      identity: `edge_label_too_long:${link.id}`,
      text: label,
      diagnostic: warning(
        "edge_label_too_long",
        `edge '${link.id}' has a label of ${[...label].length} characters, which needs ${lines} lines at the ${LABEL_WRAP_CHARS}-character wrap: ` +
          `a label that long hides its own line. Say it in ${LABEL_MAX_LINES} short lines (about ${LABEL_WRAP_CHARS * LABEL_MAX_LINES} characters, 4 words); ` +
          "put the detail in the note or the node's description.",
        span(line, 1),
      ),
    });
  }
  findings.push(...lintLinePatterns(source, model));
  return findings;
}

/**
 * The findings `after` has that `before` did not: what a write would introduce. `renamed` maps old
 * element ids to new ones (O9): a relationship id derived from its ends (`a--b`) follows them, so an
 * old long label on a renamed end is the old finding, not a new one.
 */
export function introduced(
  before: readonly LintFinding[],
  after: readonly LintFinding[],
  renamed: ReadonlyMap<string, string> = new Map(),
): LintFinding[] {
  const had = new Set(
    before.map((finding) => (renamed.size === 0 ? finding.identity : renameIdentity(finding.identity, renamed))),
  );
  return after.filter((finding) => !had.has(finding.identity));
}

/** An identity (`code:…:id`) with each id segment, and each end of a derived `a--b` id, renamed. */
function renameIdentity(identity: string, renamed: ReadonlyMap<string, string>): string {
  const one = (id: string): string => renamed.get(id) ?? id;
  return identity
    .split(":")
    .map((part) => {
      if (renamed.has(part)) return one(part);
      const ends = part.split("--");
      return ends.length === 2 ? `${one(ends[0]!)}--${one(ends[1]!)}` : part;
    })
    .join(":");
}

/**
 * The renames a write makes, read from the two models (ADR 0036 A14, O9): an element id that is
 * gone, matched to one that is new with the same label, where each label names exactly one of each.
 * A write that renames and relabels at once is not a rename: its findings compare as before.
 */
export function renamesBetween(before: DiagramModel, after: DiagramModel): Map<string, string> {
  if (
    before.type === "sequence-trace" ||
    before.type === "user-journey" ||
    after.type === "sequence-trace" ||
    after.type === "user-journey"
  )
    return new Map();
  const was = elementsOf(before).nodes,
    now = elementsOf(after).nodes;
  const nowIds = new Set(now.map((n) => n.id)),
    wasIds = new Set(was.map((n) => n.id));
  const gone = was.filter((n) => !nowIds.has(n.id)),
    added = now.filter((n) => !wasIds.has(n.id));
  const map = new Map<string, string>();
  for (const old of gone) {
    const matches = added.filter((n) => n.label === old.label);
    if (matches.length !== 1 || gone.filter((n) => n.label === old.label).length !== 1) continue;
    map.set(old.id, matches[0]!.id);
  }
  // A label that is the id itself (a state written without one) moves with the id: one such of each.
  const bare = (list: typeof was) =>
    list.filter((n) => n.label === n.id && !map.has(n.id) && ![...map.values()].includes(n.id));
  const [oldBare, newBare] = [bare(gone), bare(added)];
  if (oldBare.length === 1 && newBare.length === 1) map.set(oldBare[0]!.id, newBare[0]!.id);
  return map;
}

/** The findings of a source, or none when it does not compile (its errors are the compiler's to report). */
export async function lintText(source: string): Promise<LintFinding[]> {
  const { compile } = await import("./compile.ts");
  const { model } = await compile(source);
  return model === null ? [] : lint(source, model);
}

/**
 * What a writer refuses: the reading-rule findings `after` introduces over
 * `before` (`null` for a new file). Empty means the write may go ahead.
 */
export async function introducedBy(before: string | null, after: string): Promise<Diagnostic[]> {
  const { compile } = await import("./compile.ts");
  if (before !== null && (await compile(before)).model === null) {
    // The file being replaced does not compile, so its findings cannot be
    // read. A caption it already spelled out is not held against the repair;
    // a new one is. Other findings cannot be compared and are left as warnings.
    return (await lintText(after))
      .filter((finding) => finding.text !== undefined && !before.includes(finding.text))
      .map((finding) => finding.diagnostic);
  }
  if (before === null) return (await lintText(after)).map((finding) => finding.diagnostic);
  const [was, now] = await Promise.all([compile(before), compile(after)]);
  if (now.model === null) return [];
  const had = lint(before, was.model!),
    has = lint(after, now.model);
  return introduced(had, has, renamesBetween(was.model!, now.model)).map((finding) => finding.diagnostic);
}

/** The refusal text for a write that would introduce findings. */
export function lintRefusal(tool: string, found: readonly Diagnostic[]): string {
  return (
    `${tool} refused: the new source introduces ${found.length} reading ${found.length === 1 ? "problem" : "problems"} (ADR 0030). Nothing was written. ` +
    `Fix ${found.length === 1 ? "it" : "them"} and retry; problems the file already had are not held against this write.` +
    found.map((d) => `\n- line ${d.span.start.line}: ${d.code}: ${d.message}`).join("")
  );
}
