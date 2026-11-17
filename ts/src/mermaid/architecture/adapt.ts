// Mermaid's reading of an architecture-beta diagram, held to the scan's and
// turned into the service-architecture model; and Mermaid's complaints, which
// come from Langium with their position in the message text only.

import type {
  ArchitectureEdge,
  ArchitectureGroup,
  ArchitectureJunction,
  ArchitectureService,
  ServiceArchitecture,
} from "../../model/index.ts";
import { error, isError, type Diagnostic, type Span } from "../diagnostics.ts";
import type { MermaidFailure } from "../engine.ts";
import { restoreEntities } from "../entities.ts";
import { readLabel } from "../labels.ts";
import { sourcePosition } from "../preamble.ts";
import type { SourceLine } from "../source.ts";
import type { ArchitectureData, ArchitectureDbNode } from "./db.ts";
import type { ArchitectureScan, ScannedText } from "./scan.ts";

export interface Adapted {
  model: ServiceArchitecture | undefined;
  diagnostics: Diagnostic[];
}

const SIDE_LETTERS = { left: "L", right: "R", top: "T", bottom: "B" } as const;

export function adaptArchitecture(data: ArchitectureData, scan: ArchitectureScan, fallback: Span): Adapted {
  const diagnostics: Diagnostic[] = [];
  const disagree = (what: string, at: Span = fallback) =>
    diagnostics.push(
      error(
        "parser_disagreement",
        `Mermaid reads ${what}; rewrite the statement that holds it plainly, one statement per line`,
        at,
      ),
    );
  const text = (where: string, mermaid: string | undefined, written: ScannedText | undefined): string | undefined => {
    const read = restoreEntities(mermaid ?? "").trim();
    if (read !== (written?.text ?? "")) {
      disagree(`the ${where} as '${read}'`, written?.span);
      return undefined;
    }
    if (written === undefined) return undefined;
    const { label, problems } = readLabel(read, written.span);
    diagnostics.push(...problems);
    return label;
  };

  const tables: Record<"group" | "service" | "junction", Map<string, ArchitectureDbNode>> = {
    group: new Map(data.groups.map((g) => [g.id, g])),
    service: new Map(data.services.map((s) => [s.id, s])),
    junction: new Map(data.junctions.map((j) => [j.id, j])),
  };
  const counted = data.groups.length + data.services.length + data.junctions.length;
  if (counted !== scan.nodes.length)
    disagree(`${counted} groups, services and junctions, not the ${scan.nodes.length} written`);

  const groups: ArchitectureGroup[] = [];
  const services: ArchitectureService[] = [];
  const junctions: ArchitectureJunction[] = [];
  for (const scanned of scan.nodes) {
    const found = tables[scanned.what].get(scanned.id);
    if (found === undefined) {
      disagree(`no ${scanned.what} '${scanned.id}'`, scanned.span);
      continue;
    }
    if (found.in !== scanned.parent) disagree(`'${scanned.id}' in '${found.in ?? "no group"}'`, scanned.span);
    if (scanned.what === "junction") {
      junctions.push(scanned.parent === undefined ? { id: scanned.id } : { id: scanned.id, groupId: scanned.parent });
      continue;
    }
    if (found.icon !== scanned.icon) disagree(`the icon of '${scanned.id}' as '${found.icon ?? "none"}'`, scanned.span);
    const label = text(`label of '${scanned.id}'`, found.title, scanned.label) ?? "";
    if (scanned.what === "group") {
      const group: ArchitectureGroup = { id: scanned.id, label };
      if (scanned.icon !== undefined) group.icon = scanned.icon;
      if (scanned.parent !== undefined) group.parentId = scanned.parent;
      groups.push(group);
    } else {
      const service: ArchitectureService = { id: scanned.id, label };
      if (scanned.icon !== undefined) service.icon = scanned.icon;
      if (scanned.parent !== undefined) service.groupId = scanned.parent;
      services.push(service);
    }
  }

  // Mermaid reads every edge written, a repeated one included; the repeat is checked and left out.
  const written = [...scan.edges, ...scan.ignored].sort((a, b) => a.line.number - b.line.number);
  const ignored = new Set(scan.ignored);
  if (data.edges.length !== written.length) disagree(`${data.edges.length} edges, not the ${written.length} written`);
  const edges: ArchitectureEdge[] = [];
  written.forEach((scanned, index) => {
    const found = data.edges[index];
    if (found === undefined) return;
    if (
      found.lhsId !== scanned.source ||
      found.rhsId !== scanned.target ||
      found.lhsDir !== SIDE_LETTERS[scanned.sourceSide] ||
      found.rhsDir !== SIDE_LETTERS[scanned.targetSide] ||
      found.lhsInto !== scanned.sourceArrow ||
      found.rhsInto !== scanned.targetArrow ||
      found.lhsGroup !== scanned.sourceGroup ||
      found.rhsGroup !== scanned.targetGroup
    ) {
      disagree(`this edge as one from '${found.lhsId}' to '${found.rhsId}' drawn otherwise`, scanned.span);
      return;
    }
    const edge: ArchitectureEdge = {
      id: scanned.id,
      source: scanned.source,
      target: scanned.target,
      sourceSide: scanned.sourceSide,
      targetSide: scanned.targetSide,
    };
    if (scanned.sourceArrow) edge.sourceArrow = true;
    if (scanned.targetArrow) edge.targetArrow = true;
    if (scanned.sourceGroup) edge.sourceGroup = true;
    if (scanned.targetGroup) edge.targetGroup = true;
    const label = text("edge's label", found.title, scanned.label);
    if (label !== undefined) edge.label = label;
    if (!ignored.has(scanned)) edges.push(edge);
  });

  const title = text("title", data.title, scan.title);
  if (diagnostics.some(isError)) return { model: undefined, diagnostics };
  const model: ServiceArchitecture =
    title === undefined
      ? { type: "service-architecture", groups, services, junctions, edges }
      : { type: "service-architecture", title, groups, services, junctions, edges };
  return { model, diagnostics };
}

/**
 * Mermaid's complaint about an architecture diagram. A parse error carries
 * `line L, column C` (one-based, Mermaid's line 1 being the header) in its
 * message; a complaint about what the diagram says (an edge to an unknown
 * ID, a `{group}` that crosses no group) has no position and points at the
 * header.
 */
export function diagnoseArchitecture(
  failure: MermaidFailure,
  header: SourceLine,
  lines: readonly SourceLine[],
): Diagnostic {
  const located = /Parse error on line (\d+), column (\d+): ([^\n]*)/.exec(failure.message);
  if (located) {
    const { line, index } = sourcePosition(header, Number(located[1]), Number(located[2]) - 1);
    const sourceLine = lines[line - 1];
    const message = `Mermaid cannot read line ${line} here: ${located[3] ?? ""}`.trim();
    if (sourceLine) {
      const at = Math.min(index, sourceLine.text.length);
      return error("unexpected_token", message, sourceLine.span(at));
    }
  }
  const first = failure.message.replace(/^Parsing failed:\s*/, "").split("\n")[0] ?? "";
  return error("invalid_diagram", `Mermaid refuses this diagram: ${first}`, header.statementSpan());
}
