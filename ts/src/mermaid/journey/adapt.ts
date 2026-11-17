// Mermaid's reading of a user journey, held to the scan's and turned into the
// user-journey model. IDs and order come from the scan; names, scores and
// actors from Mermaid, compared with what is written.

import type { JourneySection, JourneyTask, UserJourney } from "../../model/index.ts";
import { error, isError, type Diagnostic, type Span } from "../diagnostics.ts";
import { restoreEntities } from "../entities.ts";
import { readLabel } from "../labels.ts";
import type { JourneyData } from "./db.ts";
import type { JourneyScan, ScannedText } from "./scan.ts";

export interface Adapted {
  model: UserJourney | undefined;
  diagnostics: Diagnostic[];
}

export function adaptJourney(data: JourneyData, scan: JourneyScan, fallback: Span): Adapted {
  const diagnostics: Diagnostic[] = [];
  const disagree = (what: string, at: Span = fallback) =>
    diagnostics.push(
      error(
        "parser_disagreement",
        `Mermaid reads ${what}; rewrite the statement that holds it plainly, one statement per line`,
        at,
      ),
    );
  const text = (where: string, mermaid: string, written: ScannedText): string => {
    const read = restoreEntities(mermaid).trim();
    if (read !== written.text) disagree(`the ${where} as '${read}'`, written.span);
    const { label, problems } = readLabel(read, written.span);
    diagnostics.push(...problems);
    return label;
  };

  const written = scan.sections.flatMap((section) => section.tasks.map((task) => ({ section, task })));
  if (data.tasks.length !== written.length) disagree(`${data.tasks.length} tasks, not the ${written.length} written`);
  if (data.sections.length !== scan.sections.length)
    disagree(`${data.sections.length} sections, not the ${scan.sections.length} written`);

  const actors: string[] = [];
  const sections: JourneySection[] = [];
  let index = 0;
  for (const section of scan.sections) {
    const model: JourneySection = {
      id: section.id,
      label: text("section's name", data.sections[sections.length] ?? "", section.name),
      tasks: [],
    };
    for (const task of section.tasks) {
      const found = data.tasks[index];
      index += 1;
      if (found === undefined) continue;
      if (restoreEntities(found.section).trim() !== section.name.text)
        disagree(`task '${task.name.text}' in section '${found.section}'`, task.name.span);
      if (found.score !== task.score) disagree(`the score of '${task.name.text}' as ${found.score}`, task.name.span);
      const label = text("task's name", found.task, task.name);
      if (found.people.length !== task.actors.length)
        disagree(`${found.people.length} actors for '${task.name.text}'`, task.name.span);
      const names = task.actors.map((actor, at) => text("actor", found.people[at] ?? "", actor));
      for (const name of names) if (!actors.includes(name)) actors.push(name);
      const modelTask: JourneyTask = { id: task.id, label, score: task.score, actors: names };
      model.tasks.push(modelTask);
    }
    sections.push(model);
  }

  const title = scan.title === undefined ? undefined : text("title", data.title, scan.title);
  if (scan.title === undefined && data.title.trim() !== "") disagree(`a title, '${data.title}'`);
  if (diagnostics.some(isError)) return { model: undefined, diagnostics };
  const model: UserJourney =
    title === undefined
      ? { type: "user-journey", actors, sections }
      : { type: "user-journey", title, actors, sections };
  return { model, diagnostics };
}
