// Reads a user journey line by line: its title, sections and tasks, where
// each is written, and the IDs Archer derives from their names (see
// model/journey.ts).
//
// The profile, statement by statement:
//   title Text
//   section Name
//   Task name: 5: Actor, Actor      a task in the section above: a score from 1
//                                   to 5, then the actors (optional)

import { decodeEntities } from "../entities.ts";
import { MAX_ID_CHARS, MAX_JOURNEY_SCORE, MIN_JOURNEY_SCORE } from "../../model/index.ts";
import type { Span } from "../diagnostics.ts";
import { isBlank, isCommentLine, type SourceLine } from "../source.ts";
import { Report, textSpan } from "../statements.ts";

export interface ScannedText {
  text: string;
  span: Span;
}

export interface ScannedTask {
  id: string;
  name: ScannedText;
  score: number;
  actors: ScannedText[];
  line: SourceLine;
}

export interface ScannedSection {
  id: string;
  name: ScannedText;
  tasks: ScannedTask[];
  line: SourceLine;
}

export interface JourneyScan {
  report: Report;
  title: ScannedText | undefined;
  sections: ScannedSection[];
  stopped: boolean;
}

/**
 * An ID from a name, its entity codes decoded: ASCII letters and digits in lower case; any other letter
 * or digit as `u` and its code point in hex; every run of anything else, and
 * the boundaries around a spelled code point, a single `-`.
 */
export function idFromName(name: string): string {
  let id = "";
  for (const character of decodeEntities(name)) {
    if (/[A-Za-z0-9]/.test(character)) id += character.toLowerCase();
    else if (/[\p{L}\p{N}]/u.test(character)) id += `-u${(character.codePointAt(0) ?? 0).toString(16)}-`;
    else id += "-";
  }
  return id.replace(/-+/g, "-").replace(/^-|-$/g, "");
}

class Scanner {
  readonly report = new Report();
  readonly scan: JourneyScan = { report: this.report, title: undefined, sections: [], stopped: false };
  readonly #ids = new Map<string, { what: string; line: SourceLine }>();

  line(line: SourceLine): void {
    const text = line.text;
    const start = text.length - text.trimStart().length;
    const trimmed = text.trim();
    if (this.report.trailingComment(line, start)) return;
    this.report.delimiters(line, "#;");
    const word = /^\S+/.exec(trimmed)?.[0] ?? "";
    if (word === "title") return this.#title(line, start);
    if (word === "section") return this.#section(line, start);
    if (/^(acctitle|accdescr)/i.test(word))
      return this.report.unsupported(line, "accessibility titles and descriptions", "remove them");
    this.#task(line, start);
  }

  #title(line: SourceLine, start: number): void {
    if (this.scan.title !== undefined)
      return this.report.error(line, "duplicate_title", "the title is set more than once: keep one `title` line");
    const from = start + "title".length;
    const text = line.text.slice(from).trim();
    if (text === "") return this.report.error(line, "expected_label", "expected the title's text after `title`");
    this.scan.title = { text, span: textSpan(line, from) };
  }

  /** `id`, unless it is empty, too long or taken; the problem is reported at `at`. */
  #claim(line: SourceLine, id: string, what: string, name: string, at: Span): boolean {
    if (id === "") {
      this.report.error(
        line,
        "invalid_id",
        `Archer names a ${what} by its name, and '${name}' has no letter or digit: add one`,
        at,
      );
      return false;
    }
    if (id.length > MAX_ID_CHARS) {
      this.report.error(
        line,
        "id_too_long",
        `Archer names a ${what} by its name, and this one makes an ID longer than ${MAX_ID_CHARS} characters: shorten it`,
        at,
      );
      return false;
    }
    const known = this.#ids.get(id);
    if (known) {
      this.report.error(
        line,
        "duplicate_id",
        `Mermaid has no IDs in a journey, so Archer names a ${what} by its name, and this one gives '${id}', as the ` +
          `${known.what} on line ${known.line.number} does: rename one of them`,
        at,
      );
      return false;
    }
    this.#ids.set(id, { what, line });
    return true;
  }

  #section(line: SourceLine, start: number): void {
    const from = start + "section".length;
    const text = line.text.slice(from).trim();
    if (text === "") return this.report.error(line, "expected_label", "expected the section's name after `section`");
    const name = { text, span: textSpan(line, from) };
    const id = `section-${idFromName(text)}`;
    if (!this.#claim(line, id === "section-" ? "" : id, "section", text, name.span)) {
      // Its tasks still belong to a section, so they are not reported again.
      this.scan.sections.push({ id: "", name, tasks: [], line });
      return;
    }
    this.scan.sections.push({ id, name, tasks: [], line });
  }

  #task(line: SourceLine, start: number): void {
    const section = this.scan.sections.at(-1);
    const example = "`Task name: 5: Actor, Actor`";
    const first = line.text.indexOf(":", start);
    if (first === -1) {
      return this.report.unsupported(
        line,
        "this statement",
        `a journey line is \`title\`, \`section\`, or a task: ${example}`,
      );
    }
    if (section === undefined) {
      return this.report.error(
        line,
        "task_outside_section",
        "a task belongs in a section: add `section Name` above it",
        line.statementSpan(),
      );
    }
    const nameText = line.text.slice(start, first).trim();
    const second = line.text.indexOf(":", first + 1);
    const scoreText = line.text.slice(first + 1, second === -1 ? line.text.length : second).trim();
    const nameSpan = line.span(start, start + Math.max(nameText.length, 1));
    if (nameText === "")
      return this.report.error(line, "expected_label", `expected the task's name before \`:\`: ${example}`, nameSpan);
    const score = Number(scoreText);
    if (!/^\d+$/.test(scoreText) || score < MIN_JOURNEY_SCORE || score > MAX_JOURNEY_SCORE) {
      const at = scoreText === "" ? line.span(first) : textSpan(line, first + 1, second === -1 ? undefined : second);
      return this.report.error(
        line,
        "invalid_score",
        `a task's score is a whole number from ${MIN_JOURNEY_SCORE} to ${MAX_JOURNEY_SCORE}: ${example}`,
        at,
      );
    }
    const actors: ScannedText[] = [];
    if (second !== -1) {
      const list = line.text.slice(second + 1);
      if (list.trim() === "") {
        return this.report.error(
          line,
          "expected_label",
          `expected actors after the second \`:\`, or no second \`:\`: ${example}`,
          line.span(second),
        );
      }
      let from = second + 1;
      for (const piece of list.split(",")) {
        const name = piece.trim();
        const at = from + (piece.length - piece.trimStart().length);
        if (name === "" || name.includes(":")) {
          return this.report.error(
            line,
            "expected_label",
            `expected actor names separated by commas: ${example}`,
            line.span(at),
          );
        }
        actors.push({ text: name, span: line.span(at, at + name.length) });
        from += piece.length + 1;
      }
    }
    if (section.id === "") return;
    const id = idFromName(nameText);
    if (!this.#claim(line, id, "task", nameText, nameSpan)) return;
    section.tasks.push({ id, name: { text: nameText, span: nameSpan }, score, actors, line });
  }

  finish(): void {}
}

export function scanJourney(header: SourceLine, statements: readonly SourceLine[]): JourneyScan {
  const scanner = new Scanner();
  if (header.text.trim() !== "journey")
    scanner.report.unsupported(header, "text after the header", "write `journey` alone on its line");
  for (const line of statements) {
    if (line.number <= header.number || isBlank(line.text) || isCommentLine(line.text)) continue;
    scanner.line(line);
  }
  scanner.finish();
  return scanner.scan;
}
