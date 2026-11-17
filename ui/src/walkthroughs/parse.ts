/**
 * Reads `GET api/walkthroughs?viewId=` (ADR 0034 §6). Atomic per walkthrough: one that does not
 * read is left out whole, with its resolution, because half a path on the diagram says something
 * the author did not (the rule for emphasis, `emphasis/contract.ts`). A payload that is not this
 * contract's version reads as nothing.
 */
import {
  WALKTHROUGHS_SCHEMA_VERSION,
  type RefStatus,
  type Walk,
  type WalkStatus,
  type WalkStep,
  type WalkthroughsRead,
} from "./contract";

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Rec) : undefined;
const str = (value: unknown): value is string => typeof value === "string";
const REF: readonly string[] = ["current", "changed", "out-of-date"];
const STATUS: readonly string[] = ["current", "partly-out-of-date", "archived"];

/** Every element of `value` through `read`, or undefined when it is not a list or any element fails. */
function all<T>(value: unknown, read: (item: unknown) => T | undefined): T[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const out: T[] = [];
  for (const item of value) {
    const one = read(item);
    if (one === undefined) return undefined;
    out.push(one);
  }
  return out;
}

function step(
  value: unknown,
  status: RefStatus,
  refs: Rec | undefined,
  labels: ReadonlyMap<string, string>,
): WalkStep | undefined {
  const s = rec(value);
  if (s === undefined || !str(s.id) || !str(s.title) || !str(s.what) || (s.kind !== "sends" && s.kind !== "does"))
    return undefined;
  const code = all(s.code, (c) => (str(c) ? c : undefined));
  const nodes = all<WalkStep["nodes"][number]>(s.nodes, (n) => {
    const r = rec(n);
    return r !== undefined && str(r.id) && str(r.label) && (r.kind === "node" || r.kind === "group")
      ? { kind: r.kind, id: r.id, label: r.label }
      : undefined;
  });
  const edges = all(s.edges, (e) => {
    const r = rec(e);
    return r !== undefined && str(r.id) && str(r.source) && str(r.target)
      ? { id: r.id, source: r.source, target: r.target, ...(str(r.label) ? { label: r.label } : {}) }
      : undefined;
  });
  const messages = all(s.messages, (m) => {
    const r = rec(m);
    return r !== undefined && str(r.from) && str(r.to) && str(r.label)
      ? { from: r.from, to: r.to, label: r.label }
      : undefined;
  });
  if (code === undefined || nodes === undefined || edges === undefined || messages === undefined) return undefined;
  const gone = (channel: string, i: number): boolean =>
    rec((Array.isArray(refs?.[channel]) ? (refs![channel] as unknown[]) : [])[i])?.status === "out-of-date";
  // Boxes by their stored labels; a line or message as "from → to", the ends by the labels the walkthrough kept for them.
  const named = (id: string): string => labels.get(id) ?? id;
  const missing = [
    ...new Set([
      ...nodes.flatMap((n, i) => (gone("nodes", i) ? [n.label] : [])),
      ...edges.flatMap((e, i) => (gone("edges", i) ? [`${named(e.source)} → ${named(e.target)}`] : [])),
      ...messages.flatMap((m, i) => (gone("messages", i) ? [`${named(m.from)} → ${named(m.to)}`] : [])),
    ]),
  ];
  return {
    id: s.id,
    title: s.title,
    kind: s.kind,
    what: s.what,
    ...(str(s.why) ? { why: s.why } : {}),
    code,
    nodes,
    edges,
    messages,
    status,
    missing,
  };
}

function walk(value: unknown, resolution: Rec | undefined): Walk | undefined {
  const w = rec(value);
  if (
    w === undefined ||
    !str(w.id) ||
    !str(w.title) ||
    !str(w.modelRevision) ||
    !Array.isArray(w.steps) ||
    w.steps.length === 0
  )
    return undefined;
  const open = all(w.open, (id) => (str(id) ? id : undefined));
  if (open === undefined) return undefined;
  // No resolution: the view has never compiled, so nothing is known to be wrong.
  const resolved = Array.isArray(resolution?.steps) ? (resolution.steps as unknown[]) : [];
  const steps: WalkStep[] = [];
  // Every box the walkthrough names, with the label it kept.
  const labels = new Map<string, string>();
  for (const raw of w.steps)
    for (const n of Array.isArray(rec(raw)?.nodes) ? (rec(raw)!.nodes as unknown[]) : [])
      if (str(rec(n)?.id) && str(rec(n)?.label)) labels.set(rec(n)!.id as string, rec(n)!.label as string);
  for (const [i, raw] of w.steps.entries()) {
    const status = rec(resolved[i])?.status;
    const read = step(
      raw,
      typeof status === "string" && REF.includes(status) ? (status as RefStatus) : "current",
      rec(resolved[i]),
      labels,
    );
    if (read === undefined) return undefined;
    steps.push(read);
  }
  const status = resolution?.status;
  return {
    id: w.id,
    title: w.title,
    ...(str(w.description) ? { description: w.description } : {}),
    ...(str(w.writtenAt) ? { writtenAt: w.writtenAt } : {}),
    ...(str(w.note) ? { note: w.note } : {}),
    modelRevision: w.modelRevision,
    open,
    steps,
    status: typeof status === "string" && STATUS.includes(status) ? (status as WalkStatus) : "current",
    outOfDate: steps.flatMap((s, i) => (s.status === "out-of-date" ? [i + 1] : [])),
  };
}

export function parseWalkthroughs(payload: unknown): WalkthroughsRead | undefined {
  const p = rec(payload);
  if (
    p === undefined ||
    p.schemaVersion !== WALKTHROUGHS_SCHEMA_VERSION ||
    !str(p.viewId) ||
    !Array.isArray(p.walkthroughs)
  )
    return undefined;
  const resolutions = new Map<string, Rec>();
  for (const r of Array.isArray(p.resolution) ? p.resolution : []) {
    const one = rec(r);
    if (one !== undefined && str(one.id)) resolutions.set(one.id, one);
  }
  const walks = p.walkthroughs.flatMap((w) => {
    const read = walk(w, resolutions.get(str(rec(w)?.id) ? (rec(w)!.id as string) : ""));
    return read === undefined ? [] : [read];
  });
  return { viewId: p.viewId, walks, ...(str(p.unsupported) ? { unsupported: p.unsupported } : {}) };
}
