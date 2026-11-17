// Label safety and the label bound, for every kind of label: node, edge and
// subgraph labels, participant aliases, message and note text, fragment and
// section labels.
//
// Mermaid's sanitizer is stubbed out (purify-stub.ts), so this is the policy
// half of Archer's defence: HTML and control characters never reach a model.
// The other half is each painter escaping for its own medium. Text such as
// `a < b` or `R&D` is not HTML and is kept exactly.

import { error, type Diagnostic, type Span } from "./diagnostics.ts";
import { decodeEntities } from "./entities.ts";
import { characterCount, labelTooLongMessage, MAX_LABEL_CHARS } from "./limits.ts";

/** A `<` that opens a tag: a letter, or `/` and a letter, with a `>` later on. */
export function containsHtmlTag(text: string): boolean {
  return /<\/?[A-Za-z][^>]*>/.test(text);
}

/**
 * C0 controls other than tab, DEL and the C1 controls (ESC, BEL, NUL, CSI
 * ...), which a terminal acts on; and the bidirectional formatting characters
 * (marks, embeddings, overrides, isolates), which make text display in an
 * order other than the one it is read in.
 */
const CONTROL = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

export function findControlCharacter(text: string): string | undefined {
  return CONTROL.exec(text)?.[0];
}

function describe(character: string): string {
  return `U+${character.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0") ?? "?"}`;
}

/**
 * Mermaid's line break in a label (its `lineBreakRegex`, mermaid 12.1.0):
 * `<br>`, `<br/>`, `<br />`, `</br>`, in any case. The model holds a line
 * break as `\n`; it is the one piece of HTML a label may hold.
 */
export const LINE_BREAK = /<\/?br\s*\/?>/i;
const LINE_BREAKS = new RegExp(LINE_BREAK.source, "gi");

/** A model label's line breaks written as Mermaid's `<br/>`, after the family's own encoding of the text. */
export function writeLineBreaks(text: string): string {
  return text.replace(/\n/g, "<br/>");
}

/** What the refusal of any other HTML tells the author. */
export const LINE_BREAK_ONLY = "use `<br/>` for a line break; other HTML isn't supported";

/** Every reason `label` (a model label, lines joined by `\n`) cannot be drawn, at `at`; empty when it can. */
export function checkLabel(label: string, at: Span): Diagnostic[] {
  const lines = label.split("\n");
  return problemsOf(label, lines, at, lines);
}

/**
 * A label as written, with each line break read as `\n` and its entity codes
 * decoded into the characters Mermaid draws for them, and every reason it
 * cannot be drawn. A code that stands for a control character, or codes that
 * spell an HTML tag (a line break included: Mermaid shows `#lt;br#gt;` as
 * text), are refused as the characters themselves would be.
 */
export function readLabel(written: string, at: Span): { label: string; problems: Diagnostic[] } {
  const pieces = written.split(LINE_BREAKS);
  const lines = pieces.map(decodeEntities);
  const label = lines.join("\n");
  return { label, problems: problemsOf(label, lines, at, pieces) };
}

function problemsOf(label: string, lines: readonly string[], at: Span, written: readonly string[]): Diagnostic[] {
  const problems: Diagnostic[] = [];
  const length = label.length > MAX_LABEL_CHARS ? characterCount(label) : label.length;
  if (length > MAX_LABEL_CHARS) {
    problems.push(error("label_too_long", labelTooLongMessage(length), at));
    return problems;
  }
  if (lines.some(containsHtmlTag)) {
    problems.push(
      error(
        "unsupported_construct",
        written.some(containsHtmlTag)
          ? `HTML in labels: ${LINE_BREAK_ONLY}. Tags such as \`<b>\` are refused rather than rendered; write plain text.`
          : "HTML in labels, even spelled with entity codes such as `#lt;` and `#gt;`: the label would hold a tag. " +
              `Write a literal \`<br/>\` for a line break; other HTML isn't supported.`,
        at,
      ),
    );
  }
  const index = lines.findIndex((line) => findControlCharacter(line) !== undefined);
  const control = index === -1 ? undefined : findControlCharacter(lines[index] ?? "");
  if (control !== undefined) {
    const coded = findControlCharacter(written[index] ?? "") !== control;
    problems.push(
      error(
        "control_character",
        `this label holds the control or bidirectional-formatting character ${describe(control)}` +
          (coded ? ", written as an entity code," : ",") +
          " which a terminal or page would act on rather than show. Remove it; only tab is allowed" +
          " (write `<br/>` for a line break).",
        at,
      ),
    );
  }
  return problems;
}
