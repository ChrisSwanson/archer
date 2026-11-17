// Copies what Archer needs out of Mermaid's journey database (internal API of
// mermaid 12.1.0, checked at run time; see flowchart/db.ts).

import { call, drift, fields, optionalText, texts } from "../db-fields.ts";

export interface JourneyDbTask {
  section: string;
  task: string;
  score: number;
  people: string[];
}

export interface JourneyData {
  title: string;
  sections: string[];
  tasks: JourneyDbTask[];
}

const DB = "journey";

export function readJourneyDb(db: unknown): JourneyData {
  const journey = fields(db, DB, "not an object");
  const tasks = call(journey, DB, "getTasks");
  const sections = call(journey, DB, "getSections");
  if (!Array.isArray(tasks) || !Array.isArray(sections)) throw drift(DB, "getTasks() or getSections()");
  return {
    title: optionalText(call(journey, DB, "getDiagramTitle")) ?? "",
    sections: texts(sections),
    tasks: tasks.map((value: unknown) => {
      const task = fields(value, DB, "task");
      return {
        section: optionalText(task["section"]) ?? "",
        task: optionalText(task["task"]) ?? "",
        score: typeof task["score"] === "number" ? task["score"] : Number.NaN,
        people: texts(task["people"]),
      };
    }),
  };
}
