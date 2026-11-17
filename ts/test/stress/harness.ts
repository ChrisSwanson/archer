/** Stress harness for the structured editors: seeded RNG, plausible op generation, postcondition checks, shrinking. */
import { compile } from "../../src/mermaid/index.ts";
import { editDiagram, type DiagramEdit } from "../../src/authoring/diagram-edit.ts";

export function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(a: readonly T[]): T => a[int(a.length)]!;
  const chance = (p: number) => next() < p;
  return { next, int, pick, chance };
}
export type Rng = ReturnType<typeof rng>;

export const DOCUMENTED = new Set([
  "edit_activation_dependency",
  "edit_delete_boundary_unsupported",
  "edit_delete_composite_unsupported",
  "edit_delete_inline_declaration",
  "edit_delete_last_in_boundary",
  "edit_delete_leaves_undrawn_state",
  "edit_delete_multiple_declarations",
  "edit_delete_nonisolated_declaration",
  "edit_delete_note_dependency",
  "edit_delete_referenced_node",
  "edit_delete_styling_dependency",
  "edit_element_required",
  "edit_endpoint_boundary",
  "edit_endpoint_required",
  "edit_fragment_unsupported",
  "edit_id_exists",
  "edit_id_required",
  "edit_id_reserved",
  "edit_invalid_cardinality",
  "edit_invalid_element",
  "edit_invalid_endpoint",
  "edit_invalid_fragment",
  "edit_invalid_id",
  "edit_invalid_label",
  "edit_invalid_line",
  "edit_invalid_message_kind",
  "edit_invalid_note",
  "edit_invalid_participant_kind",
  "edit_invalid_relation",
  "edit_invalid_result",
  "edit_invalid_shape",
  "edit_invalid_state_kind",
  "edit_label_required",
  "edit_label_unsupported",
  "edit_move_cross_block",
  "edit_move_in_fragment",
  "edit_move_same_message",
  "edit_move_same_participant",
  "edit_relabel_styled_declaration",
  "edit_relabel_unsupported",
  "edit_relationship_exists",
  "edit_relationship_id_ambiguous",
  "edit_relationship_id_derived",
  "edit_requires_valid_er",
  "edit_requires_valid_flowchart",
  "edit_requires_valid_sequence",
  "edit_requires_valid_state",
  "edit_requires_valid_c4",
  "edit_retarget_inline_declaration",
  "edit_retarget_leaves_undrawn_state",
  "edit_retarget_styling_dependency",
  "edit_scope_mismatch",
  "edit_source_mapping_ambiguous",
  "edit_start_end_scope",
  "edit_target_missing",
  "edit_unsupported_family",
  "edit_unsupported_for_family",
  "edit_unwrap_sections",
  "edit_wrap_cross_block",
  "edit_wrap_not_consecutive",
  "edit_wrap_spans_declaration",
]);

export type Family = "flowchart" | "c4" | "er" | "state" | "sequence";
export interface View {
  family: Family;
  nodes: any[];
  edges: any[];
  extra: any;
}

const strip = (o: any, ...keys: string[]) => {
  const c = { ...o };
  for (const k of keys) delete c[k];
  return c;
};
export function viewOf(model: any): View | null {
  switch (model?.type) {
    case "freeform-graph":
      return {
        family: "flowchart",
        nodes: model.nodes,
        edges: model.edges,
        extra: { groups: model.groups, direction: model.direction },
      };
    case "c4-model":
      return {
        family: "c4",
        nodes: model.elements,
        edges: model.relationships,
        extra: { boundaries: model.boundaries, title: model.title, level: model.level },
      };
    case "entity-relationship":
      return { family: "er", nodes: model.entities, edges: model.relationships, extra: { direction: model.direction } };
    case "state-machine":
      return { family: "state", nodes: model.states, edges: model.transitions, extra: { direction: model.direction } };
    case "sequence-trace": {
      const messages: any[] = [],
        notes: any[] = [],
        fragments: any[] = [],
        acts: any[] = [];
      const walk = (evs: any[]) => {
        for (const e of evs) {
          if (e.type === "message") messages.push(e);
          else if (e.type === "note") notes.push(e);
          else if (e.type === "fragment") {
            fragments.push({ kind: e.kind, label: e.label, sections: e.sections.map((s: any) => s.label ?? null) });
            for (const s of e.sections) walk(s.events);
          } else acts.push(e);
        }
      };
      walk(model.events);
      return {
        family: "sequence",
        nodes: model.participants,
        edges: messages,
        extra: { notes, fragments, acts, autonumber: model.autonumber },
      };
    }
  }
  return null;
}
export async function compileView(src: string): Promise<View | null> {
  const c = await compile(src);
  return c.model ? viewOf(c.model) : null;
}

const J = (x: any) => JSON.stringify(x);
const edgeKey = (e: any) => J(strip(e, "id"));
const lab = (x: any) => x ?? "";

function lines(s: string) {
  return (s.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? []).filter((l, i, a) => !(l === "" && i === a.length - 1));
}
const bare = (l: string) => l.replace(/[\r\n]+$/, "");
function multisetDiff(a: string[], b: string[]) {
  const m = new Map<string, number>();
  for (const x of b) m.set(x, (m.get(x) ?? 0) + 1);
  const out: string[] = [];
  for (const x of a) {
    const c = m.get(x) ?? 0;
    if (c > 0) m.set(x, c - 1);
    else out.push(x);
  }
  return out;
}

export interface Failure {
  kind: string;
  detail: string;
}

function idsOf(op: any): string[] {
  return [op.id, op.source, op.target, ...(op.ids ?? []), ...(op.participants ?? [])].filter(
    (x) => typeof x === "string",
  );
}

/** Compare model change against what the op says. Returns a mismatch description or null. */
function modelMismatch(b: View, a: View, op: any): string | null {
  const fam = b.family;
  const implicit = (n: any) => fam === "state" && (n.kind === "initial" || n.kind === "final");
  const nodeById = (v: View) => new Map<string, any>(v.nodes.filter((n) => !implicit(n)).map((n) => [n.id, n]));
  const bn = nodeById(b),
    an = nodeById(a);
  const sameNodesExcept = (skip: string[]) => {
    for (const [id, n] of bn)
      if (!skip.includes(id) && J(n) !== J(an.get(id))) return `node ${id} changed: ${J(n)} -> ${J(an.get(id))}`;
    return null;
  };
  const edgesMulti = (v: View) => v.edges.map(edgeKey).sort();
  const sameExtra = (skipKeys: string[] = []) => {
    const x = strip(b.extra, ...skipKeys),
      y = strip(a.extra, ...skipKeys);
    return J(x) === J(y) ? null : `extra changed ${J(x)} -> ${J(y)}`;
  };
  const removeOne = (arr: string[], k: string) => {
    const i = arr.indexOf(k);
    if (i < 0) return arr;
    return [...arr.slice(0, i), ...arr.slice(i + 1)];
  };
  const orderedEdges = (v: View) => v.edges.map(edgeKey);
  const k = op.kind;
  if (fam !== "sequence") {
    if (k === "add-node") {
      if (!an.has(op.id)) return `node ${op.id} missing`;
      if (bn.has(op.id)) return null;
      if (an.size !== bn.size + 1) return `node count ${bn.size}->${an.size}`;
      const n = an.get(op.id);
      if (n.label !== op.label && !(fam === "er" && op.label === "")) return `label ${J(n.label)} != ${J(op.label)}`;
      if (J(edgesMulti(b)) !== J(edgesMulti(a))) return "edges changed";
      return sameNodesExcept([op.id]) ?? sameExtra();
    }
    if (k === "relabel-node") {
      const n = an.get(op.id);
      if (!n) return "node vanished";
      if (n.label !== op.label) return `label ${J(n.label)} != ${J(op.label)}`;
      if (an.size !== bn.size) return "node count changed";
      if (J(edgesMulti(b)) !== J(edgesMulti(a))) return "edges changed";
      return sameNodesExcept([op.id]) ?? sameExtra();
    }
    if (k === "change-shape") {
      const n = an.get(op.id);
      if (!n) return "node vanished";
      if ((n.shape ?? "rectangle") !== op.shape) return `shape ${n.shape}`;
      if (J(edgesMulti(b)) !== J(edgesMulti(a))) return "edges changed";
      return sameNodesExcept([op.id]) ?? sameExtra();
    }
    if (k === "direction") {
      if (a.extra.direction !== op.direction) return `direction ${a.extra.direction}`;
      return (
        sameNodesExcept([]) ??
        (J(edgesMulti(b)) === J(edgesMulti(a)) ? null : "edges changed") ??
        sameExtra(["direction"])
      );
    }
    if (k === "connect") {
      if (a.edges.length !== b.edges.length + 1) return `edge count ${b.edges.length}->${a.edges.length}`;
      const want: any = { source: op.source, target: op.target };
      const added = removeAll(edgesMulti(a), edgesMulti(b));
      if (added.length !== 1) return `edge multiset delta ${added.length}`;
      const e = JSON.parse(added[0]!);
      if (fam !== "state" || (op.source !== "[*]" && op.target !== "[*]"))
        if (e.source !== op.source || e.target !== op.target) return `edge ${J(e)} != ${J(want)}`;
      if (lab(e.label) !== lab(op.label)) return `edge label ${J(e.label)} != ${J(op.label)}`;
      if (fam === "state" && (op.source === "[*]" || op.target === "[*]")) return null;
      if (an.size !== bn.size) return `node count ${bn.size}->${an.size}`;
      return sameNodesExcept([]);
    }
    if (k === "relabel-edge") {
      const be = b.edges.find((e) => e.id === op.id),
        ae = a.edges.find((e) => e.id === op.id);
      if (!be || !ae) return "edge missing";
      if (lab(ae.label) !== lab(op.label)) return `edge label ${J(ae.label)} != ${J(op.label)}`;
      if (a.edges.length !== b.edges.length) return "edge count changed";
      const exp = removeOne(edgesMulti(b), edgeKey(be));
      const got = removeOne(edgesMulti(a), edgeKey(ae));
      if (J(exp) !== J(got)) return "other edges changed";
      return sameNodesExcept([]) ?? (an.size === bn.size ? null : "node count changed");
    }
    if (k === "retarget-edge") {
      const be = b.edges.find((e) => e.id === op.id);
      if (!be) return "edge missing before";
      const src = op.source ?? be.source,
        tgt = op.target ?? be.target;
      const exp = removeOne(edgesMulti(b), edgeKey(be));
      exp.push(edgeKey({ ...be, source: src, target: tgt }));
      exp.sort();
      if (J(exp) !== J(edgesMulti(a))) return `edge multiset mismatch want ${J(src)}->${J(tgt)}`;
      if (fam === "state" && (op.source === "[*]" || op.target === "[*]")) return null;
      if (fam === "state") return sameNodesExcept([]);
      return sameNodesExcept([]) ?? (an.size === bn.size ? null : "node count changed");
    }
    if (k === "delete-edge") {
      const be = b.edges.find((e) => e.id === op.id);
      if (!be) return "edge missing before";
      if (J(removeOne(edgesMulti(b), edgeKey(be))) !== J(edgesMulti(a))) return "edges mismatch";
      return an.size === bn.size ? sameNodesExcept([]) : fam === "state" ? null : "node count changed";
    }
    if (k === "delete-node") {
      if (an.has(op.id)) return "node still present";
      if (an.size !== bn.size - 1 && fam !== "state") return `node count ${bn.size}->${an.size}`;
      return sameNodesExcept([op.id]);
    }
    return null;
  }
  // sequence
  const bm = orderedEdges(b),
    am = orderedEdges(a);
  const pj = (v: View) => J(v.nodes.map((n) => strip(n)));
  const noteJ = (v: View) => J(v.extra.notes.map((n: any) => strip(n, "id")));
  const fragJ = (v: View) => J(v.extra.fragments);
  const sameNotes = () => (noteJ(b) === noteJ(a) ? null : "notes changed");
  const sameFrags = () => (fragJ(b) === fragJ(a) ? null : "fragments changed");
  const sameMsgs = () => (J(bm) === J(am) ? null : "messages changed");
  const sameActs = () => (J(b.extra.acts) === J(a.extra.acts) ? null : "activations changed");
  if (k === "add-node") {
    if (!an.has(op.id)) return "participant missing";
    if (bn.has(op.id)) return null;
    if (a.nodes.length !== b.nodes.length + 1) return "participant count";
    if (an.get(op.id).label !== op.label) return `label ${J(an.get(op.id).label)} != ${J(op.label)}`;
    return sameMsgs() ?? sameNotes() ?? sameFrags() ?? sameActs();
  }
  if (k === "relabel-node") {
    if (an.get(op.id)?.label !== op.label) return `label ${J(an.get(op.id)?.label)} != ${J(op.label)}`;
    for (const [id, n] of bn) if (id !== op.id && J(n) !== J(an.get(id))) return `participant ${id} changed`;
    return sameMsgs() ?? sameNotes() ?? sameFrags() ?? sameActs();
  }
  if (k === "move-node") {
    if (J([...b.nodes.map((n) => n.id)].sort()) !== J([...a.nodes.map((n) => n.id)].sort()))
      return "participants changed";
    return sameMsgs() ?? sameNotes() ?? sameFrags();
  }
  if (k === "connect") {
    if (am.length !== bm.length + 1) return `message count ${bm.length}->${am.length}`;
    const msgs = a.edges.map((e) => strip(e, "id"));
    const want = { from: op.source, to: op.target, kind: op.message ?? "sync" };
    const idx = (() => {
      for (let i = 0; i < msgs.length; i++) {
        const rest = [...am.slice(0, i), ...am.slice(i + 1)];
        if (J(rest) === J(bm)) return i;
      }
      return -1;
    })();
    if (idx < 0) return "other messages changed or reordered";
    const m = msgs[idx];
    if (m.from !== want.from || m.to !== want.to || m.kind !== want.kind || lab(m.label) !== lab(op.label))
      return `new message ${J(m)} != ${J(want)}/${J(op.label)}`;
    if (op.after === undefined || op.after === null) {
      /* position: first for null, end for undefined */
    }
    return sameNotes() ?? sameActs();
  }
  if (k === "relabel-edge" || k === "retarget-edge") {
    const i = b.edges.findIndex((e) => e.id === op.id);
    if (i < 0) return "message missing before";
    const exp = b.edges.map((e) => strip(e, "id"));
    const e0 = { ...exp[i] };
    if (k === "relabel-edge") {
      if (op.label === "") delete e0.label;
      else e0.label = op.label;
    } else {
      if (op.source !== undefined) e0.from = op.source;
      if (op.target !== undefined) e0.to = op.target;
      if (op.message !== undefined) e0.kind = op.message;
    }
    exp[i] = e0;
    const got = a.edges.map((e) => strip(e, "id"));
    const norm = (m: any) => J({ from: m.from, to: m.to, kind: m.kind, label: lab(m.label) });
    if (J(exp.map(norm)) !== J(got.map(norm))) return `messages mismatch at ${i}: got ${J(got[i])}`;
    return sameNotes() ?? sameFrags();
  }
  if (k === "delete-edge") {
    const i = b.edges.findIndex((e) => e.id === op.id);
    if (i < 0) return "message missing before";
    const exp = [...bm.slice(0, i), ...bm.slice(i + 1)];
    if (J(exp) !== J(am)) return "messages mismatch after delete";
    return null;
  }
  if (k === "move-edge") {
    if (J([...bm].sort()) !== J([...am].sort())) return "message multiset changed";
    const i = b.edges.findIndex((e) => e.id === op.id);
    const exp = bm.filter((_, j) => j !== i);
    const j = am.findIndex((_, p) => J([...am.slice(0, p), ...am.slice(p + 1)]) === J(exp) && am[p] === bm[i]);
    if (j < 0) return "moved message not found as single displacement";
    if (op.before !== null) {
      const t = b.edges.findIndex((e) => e.id === op.before);
      if (t >= 0) {
        const tk = bm[t];
        const bi = am.findIndex((x, p) => x === tk && p > j);
        if (am[j + 1] !== tk && bi < 0) return `moved message not before ${op.before}`;
      }
    }
    return sameNotes() ?? sameFrags();
  }
  if (k === "add-note") {
    if (a.extra.notes.length !== b.extra.notes.length + 1) return "note count";
    const n = a.extra.notes.find((n: any) => n.text === op.text && J(n.participants) === J(op.participants));
    if (!n) return `note not found with text ${J(op.text)}`;
    return sameMsgs() ?? sameFrags();
  }
  if (k === "relabel-note") {
    if (!a.extra.notes.some((n: any) => n.text === op.text)) return `note text ${J(op.text)} not found`;
    return sameMsgs() ?? sameFrags();
  }
  if (k === "delete-note") {
    if (a.extra.notes.length !== b.extra.notes.length - 1) return "note count";
    return sameMsgs() ?? sameFrags();
  }
  if (k === "wrap-edges") {
    if (a.extra.fragments.length !== b.extra.fragments.length + 1) return "fragment count";
    const f = a.extra.fragments.find((f: any) => f.kind === op.fragment && f.label === op.label);
    if (!f) return `fragment ${op.fragment} ${J(op.label)} not found`;
    return sameMsgs() ?? sameNotes();
  }
  if (k === "unwrap-fragment") {
    if (a.extra.fragments.length !== b.extra.fragments.length - 1) return "fragment count";
    return sameMsgs() ?? sameNotes();
  }
  return null;
}
function removeAll(a: string[], b: string[]) {
  const m = [...a];
  for (const x of b) {
    const i = m.indexOf(x);
    if (i >= 0) m.splice(i, 1);
  }
  return m;
}

const LIMITS: Record<string, [number, number]> = {
  "add-node": [0, 1],
  connect: [0, 1],
  "relabel-node": [1, 1],
  "relabel-edge": [1, 1],
  "retarget-edge": [1, 1],
  "change-shape": [1, 1],
  direction: [1, 1],
  "delete-edge": [1, 0],
  "delete-node": [60, 0],
  "move-node": [1, 1],
  "move-edge": [1, 1],
  "add-note": [0, 1],
  "relabel-note": [1, 1],
  "delete-note": [1, 0],
};

export interface StepResult {
  failure: Failure | null;
  ok: boolean;
  code?: string;
  source: string;
  ms: number;
  before: View | null;
}

/** Run one op against `source` and check every postcondition. */
export async function runStep(source: string, op: DiagramEdit, before?: View | null): Promise<StepResult> {
  const b = before === undefined ? await compileView(source) : before;
  let res: any;
  const t0 = performance.now();
  try {
    res = await editDiagram(source, op);
  } catch (e) {
    return {
      failure: {
        kind: "throw",
        detail: String((e as Error)?.stack ?? e)
          .split("\n")
          .slice(0, 4)
          .join(" | "),
      },
      ok: false,
      source,
      ms: performance.now() - t0,
      before: b,
    };
  }
  const ms = performance.now() - t0;
  const out = (failure: Failure | null): StepResult => ({
    failure,
    ok: !!res.ok,
    code: res.code,
    source: res.ok ? res.source : source,
    ms,
    before: b,
  });
  if (ms > 200) {
    const t1 = performance.now();
    await editDiagram(source, op).catch(() => null);
    const m2 = performance.now() - t1;
    if (m2 > 200)
      return out({
        kind: "slow",
        detail: `${ms.toFixed(0)} ms, retry ${m2.toFixed(0)} ms, source ${source.length} bytes`,
      });
  }
  if (!res.ok) {
    if (res.source !== source) return out({ kind: "refusal-changed-source", detail: res.code });
    if (!DOCUMENTED.has(res.code)) return out({ kind: "undocumented-code", detail: String(res.code) });
    return out(null);
  }
  const next: string = res.source;
  if (next === source) return out(null);
  const a = await compileView(next);
  if (!a) return out({ kind: "noncompile", detail: "result does not compile" });
  if (b && a.family !== b.family) return out({ kind: "family-changed", detail: `${b.family}->${a.family}` });
  if (b) {
    const m = modelMismatch(b, a, op);
    if (m) return out({ kind: "model-mismatch", detail: m });
  }
  // bytes
  if (source.startsWith("﻿") && !next.startsWith("﻿")) return out({ kind: "bom-lost", detail: "" });
  const eols = (s: string) => new Set(s.match(/\r\n|\r|\n/g) ?? []);
  const se = eols(source),
    ne = eols(next);
  if (se.size > 0 && [...ne].some((e) => !se.has(e)))
    return out({ kind: "eol-mixed", detail: `${[...se].map((e) => J(e))} -> ${[...ne].map((e) => J(e))}` });
  const sl = lines(source).map(bare),
    nl = lines(next).map(bare);
  const removed = multisetDiff(sl, nl),
    added = multisetDiff(nl, sl);
  let [r, ad] = LIMITS[op.kind] ?? [3, 3];
  if (op.kind === "wrap-edges") {
    r = 60;
    ad = 62;
  }
  if (op.kind === "unwrap-fragment") {
    r = 2 + 200;
    ad = 200;
  }
  // Blank/comment-only lines removed are always a violation unless the op deletes.
  if (removed.length > r || added.length > ad)
    return out({
      kind: "bytes",
      detail: `removed ${removed.length} added ${added.length}: -${J(removed.slice(0, 4))} +${J(added.slice(0, 4))}`,
    });
  if (op.kind !== "unwrap-fragment")
    for (const l of removed)
      if (/^\s*(%%|$)/.test(l) && !/^\s*%%\s*archer-id/.test(l))
        return out({ kind: "bytes-comment-or-blank-removed", detail: J(l) });
  return out(null);
}

export async function shrink(
  source: string,
  op: DiagramEdit,
  same: (r: StepResult) => boolean,
  budgetMs = 15000,
): Promise<string> {
  let cur = source;
  const t0 = performance.now();
  const sep = /\r\n|\r|\n/;
  for (let pass = 0; pass < 3; pass++) {
    const parts = cur.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)!.filter(Boolean);
    let changed = false;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts.length <= 1 || performance.now() - t0 > budgetMs) break;
      const cand = [...parts.slice(0, i), ...parts.slice(i + 1)].join("");
      if (!sep.test(cand) && cand.length === cur.length) continue;
      const r = await runStep(cand, op).catch(() => null);
      if (r && same(r)) {
        parts.splice(i, 1);
        changed = true;
      }
    }
    cur = parts.join("");
    if (!changed) break;
  }
  return cur;
}
