import type { DiagramModel, SequenceEvent } from "../model/index.ts";
import type { Project } from "../project/index.ts";
import { AccuracyError } from "./errors.ts";
import { readDiagramAtCommit, type HistoricalDiagram } from "./history.ts";
export { diffElements, type ElementChange } from "./elements.ts";
export interface SemanticChange {
  readonly key: string;
  readonly status: "added" | "removed" | "changed" | "moved";
  readonly before?: unknown;
  readonly after?: unknown;
  readonly beforeIndex?: number;
  readonly afterIndex?: number;
}
export interface ModelComparison {
  readonly status: "compared" | "incompatible";
  readonly changes: readonly SemanticChange[];
}
const MAX_ENTRIES = 4096,
  MAX_ORDER_CELLS = 1000000;
/** Canonical bounded JSON, iterative so deeply nested metadata cannot consume the call stack. */
function canonical(value: unknown): string {
  type Work = { value: unknown } | { token: string };
  const output: string[] = [],
    pending: Work[] = [{ value }];
  let count = 0;
  while (pending.length) {
    if (++count > 100_000) throw new AccuracyError("accuracy_limit", "semantic comparison exceeds its value budget");
    const work = pending.pop()!;
    if ("token" in work) {
      output.push(work.token);
      continue;
    }
    const item = work.value;
    if (item !== null && typeof item === "object") {
      if (Array.isArray(item)) {
        output.push("[");
        pending.push({ token: "]" });
        for (let i = item.length - 1; i >= 0; i--) {
          pending.push({ value: item[i] });
          if (i > 0) pending.push({ token: "," });
        }
      } else {
        output.push("{");
        pending.push({ token: "}" });
        const keys = Object.keys(item).sort();
        for (let i = keys.length - 1; i >= 0; i--) {
          const key = keys[i]!;
          pending.push({ value: (item as Record<string, unknown>)[key] });
          pending.push({ token: `${JSON.stringify(key)}:` });
          if (i > 0) pending.push({ token: "," });
        }
      }
    } else output.push(JSON.stringify(item) ?? "undefined");
  }
  return output.join("");
}

type RecordValue = {
  id: string;
} & Record<string, unknown>;
function entries(model: DiagramModel): Map<string, unknown> {
  const result = new Map<string, unknown>();
  const add = (kind: string, items: unknown[]) => {
    for (const value of items) {
      const item = value as RecordValue;
      result.set(`${kind}:${item.id}`, item);
      if (result.size > MAX_ENTRIES)
        throw new AccuracyError("accuracy_limit", "semantic comparison exceeds its element limit");
    }
  };
  switch (model.type) {
    case "architecture-graph":
    case "data-flow-graph":
    case "freeform-graph":
      add("node", model.nodes);
      add("edge", model.edges);
      add("group", model.groups);
      result.set("model:metadata", { direction: model.direction });
      break;
    case "state-machine":
      add("state", model.states);
      add("transition", model.transitions);
      result.set("model:metadata", { direction: model.direction });
      break;
    case "entity-relationship":
      add("entity", model.entities);
      add("relationship", model.relationships);
      result.set("model:metadata", { direction: model.direction });
      break;
    case "c4-model":
      add("element", model.elements);
      add("boundary", model.boundaries);
      add("relationship", model.relationships);
      result.set("model:metadata", { level: model.level, title: model.title });
      break;
    case "service-architecture":
      add("group", model.groups);
      add("service", model.services);
      add("junction", model.junctions);
      add("edge", model.edges);
      result.set("model:metadata", { title: model.title });
      break;
    case "sequence-trace":
      add("participant", model.participants);
      result.set("model:metadata", {
        autonumber: model.autonumber,
        participantOrder: model.participants.map((p) => p.id),
      });
      break;
    case "user-journey":
      add(
        "section",
        model.sections.map(({ tasks: _tasks, ...section }) => section),
      );
      for (const section of model.sections)
        add(
          "task",
          section.tasks.map((task) => ({ ...task, sectionId: section.id })),
        );
      result.set("model:metadata", { title: model.title, actors: model.actors });
      break;
    default: {
      const exhaustive: never = model;
      return exhaustive;
    }
  }
  return result;
}
interface Token {
  readonly key: string;
  readonly value: unknown;
  readonly signature: string;
  readonly identity: string;
}
function ordered(model: DiagramModel): Token[] {
  const tokens: Token[] = [];
  const append = (key: string, value: unknown, identity: string) => {
    tokens.push({ key, value, signature: canonical(value), identity });
    if (tokens.length > MAX_ENTRIES)
      throw new AccuracyError("accuracy_limit", "ordered comparison exceeds its event limit");
  };
  if (model.type === "user-journey")
    for (const section of model.sections) {
      append(`section:${section.id}`, { sectionId: section.id }, `section:${section.id}`);
      for (const task of section.tasks)
        append(`task:${task.id}`, { ...task, sectionId: section.id }, `task:${task.id}`);
    }
  if (model.type === "sequence-trace") {
    type Work =
      | {
          event: SequenceEvent;
          context: readonly unknown[];
        }
      | {
          marker: string;
          context: readonly unknown[];
        };
    const pending: Work[] = model.events.map((event) => ({ event, context: [] })).reverse();
    while (pending.length) {
      const work = pending.pop()!;
      if ("marker" in work) {
        append(work.marker, { marker: work.marker, context: work.context }, work.marker);
        continue;
      }
      const { event, context } = work;
      const { id: _id, ...body } = event as SequenceEvent & {
        id?: string;
      };
      if (event.type === "fragment") {
        append(
          `fragment:${event.id}`,
          { type: event.type, kind: event.kind, label: event.label, context },
          `fragment:${event.kind}`,
        );
        pending.push({ marker: "fragment:end", context });
        for (let i = event.sections.length - 1; i >= 0; i--) {
          const section = event.sections[i]!;
          const inner = [...context, { kind: event.kind, label: event.label, section: section.label ?? null }];
          pending.push({ marker: "section:end", context: inner });
          for (let j = section.events.length - 1; j >= 0; j--)
            pending.push({ event: section.events[j]!, context: inner });
          pending.push({ marker: "section:start", context: inner });
        }
      } else {
        const identity =
          event.type === "message"
            ? `${event.type}:${event.from}:${event.to}`
            : event.type === "note"
              ? `${event.type}:${event.participants.join(",")}`
              : `${event.type}:${event.participant}`;
        append("id" in event ? `event:${event.id}` : `event:${tokens.length}`, { ...body, context }, identity);
      }
    }
  }
  return tokens;
}
function orderedChanges(before: Token[], after: Token[]): SemanticChange[] {
  if ((before.length + 1) * (after.length + 1) > MAX_ORDER_CELLS)
    throw new AccuracyError("accuracy_limit", "ordered comparison exceeds its alignment budget");
  const width = after.length + 1,
    table = new Uint32Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i--)
    for (let j = after.length - 1; j >= 0; j--)
      table[i * width + j] =
        before[i]!.signature === after[j]!.signature
          ? 1 + table[(i + 1) * width + j + 1]!
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
  const usedBefore = new Set<number>(),
    usedAfter = new Set<number>();
  let i = 0,
    j = 0;
  while (i < before.length && j < after.length) {
    if (before[i]!.signature === after[j]!.signature) {
      usedBefore.add(i++);
      usedAfter.add(j++);
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) i++;
    else j++;
  }
  const changes: SemanticChange[] = [];
  for (const same of [true, false])
    for (let a = 0; a < before.length; a++) {
      if (usedBefore.has(a)) continue;
      const b = after.findIndex(
        (item, index) =>
          !usedAfter.has(index) &&
          (same ? item.signature === before[a]!.signature : item.identity === before[a]!.identity),
      );
      if (b < 0) continue;
      usedBefore.add(a);
      usedAfter.add(b);
      changes.push({
        key: after[b]!.key,
        status: same ? "moved" : "changed",
        before: before[a]!.value,
        after: after[b]!.value,
        beforeIndex: a,
        afterIndex: b,
      });
    }
  before.forEach((item, index) => {
    if (!usedBefore.has(index))
      changes.push({ key: item.key, status: "removed", before: item.value, beforeIndex: index });
  });
  after.forEach((item, index) => {
    if (!usedAfter.has(index)) changes.push({ key: item.key, status: "added", after: item.value, afterIndex: index });
  });
  return changes;
}
/** Input models come from the production compiler, not arbitrary JSON. Typed keys retain collection identity. */
export function compareModels(before: DiagramModel, after: DiagramModel): ModelComparison {
  if (before.type !== after.type) return { status: "incompatible", changes: [] };
  const old = entries(before),
    now = entries(after),
    changes: SemanticChange[] = [];
  for (const [key, value] of now) {
    if (!old.has(key)) changes.push({ key, status: "added", after: value });
    else if (canonical(old.get(key)) !== canonical(value))
      changes.push({ key, status: "changed", before: old.get(key), after: value });
  }
  for (const [key, value] of old) if (!now.has(key)) changes.push({ key, status: "removed", before: value });
  changes.push(...orderedChanges(ordered(before), ordered(after)));
  return { status: "compared", changes };
}
export interface DiagramCommitComparison {
  readonly before: HistoricalDiagram;
  readonly after: HistoricalDiagram;
  readonly sourceChanged: boolean | null;
  readonly semantic: ModelComparison | null;
}
export async function compareDiagramCommits(
  project: Project,
  viewId: string,
  from: string,
  to: string,
): Promise<DiagramCommitComparison> {
  const before = await readDiagramAtCommit(project, viewId, from),
    after = await readDiagramAtCommit(project, viewId, to);
  const sourceChanged =
    before.status === "unavailable" || after.status === "unavailable"
      ? null
      : before.sourceRevision !== after.sourceRevision;
  const semantic =
    before.status === "compiled" && after.status === "compiled"
      ? compareModels(before.result.envelope!.model, after.result.envelope!.model)
      : null;
  return { before, after, sourceChanged, semantic };
}
