import type { DiagramEdit } from "../../src/authoring/diagram-edit.ts";
import type { Rng, View } from "./harness.ts";

export const LABELS = [
  "Plain",
  "Two words",
  'a "quoted" word',
  "it's",
  "hash # sign",
  "semi; colon",
  "%% not a comment",
  "pipe | bar",
  "a & b",
  "<b>tag</b>",
  "x --> y",
  "ünïcödé — 日本語",
  "emoji 🚀 ok",
  "   padded  ",
  "a".repeat(300),
  "line1\nline2",
  "brace {x} [y] (z)",
  "back\\slash",
  "colon: here",
  "end",
  "a,b,c",
  "#35;",
  "A: B",
  "[*]",
  "note over X: hi",
  "%%{init}%%",
  "<<x>>",
  "",
  " ",
  "tab\there",
];
const NASTY_IDS = [
  "end",
  "class",
  "style",
  "default",
  "x y",
  "",
  "a-b",
  "é",
  "1",
  "__proto__",
  "constructor",
  "graph",
  "subgraph",
  "A--B",
  "a.b",
  "[*]",
  "participant",
  "actor",
  "o",
  "x",
  "Note",
  "loop",
];

const fresh = (r: Rng, family: string, taken: Set<string>) => {
  for (let i = 0; i < 20; i++) {
    const n = r.int(60);
    const id = family === "er" ? `ENT${n}` : family === "sequence" ? `p${n}` : family === "state" ? `S${n}` : `n${n}`;
    if (!taken.has(id)) return id;
  }
  return "zz" + r.int(1e6);
};

export function genOp(r: Rng, v: View): DiagramEdit {
  const f = v.family;
  const nodes: string[] = v.nodes.map((n) => n.id);
  const edges: string[] = v.edges.map((e) => e.id);
  const chaos = r.chance(0.07);
  const nodeId = () => (chaos || nodes.length === 0 ? (r.chance(0.5) ? r.pick(NASTY_IDS) : "ghost") : r.pick(nodes));
  const edgeId = () => (chaos || edges.length === 0 ? "ghost--edge" : r.pick(edges));
  const endpoint = () => (f === "state" && r.chance(0.12) ? "[*]" : nodeId());
  const label = () => (r.chance(0.55) ? r.pick(LABELS.slice(0, 3)) : r.pick(LABELS));
  const newId = () => (chaos && r.chance(0.5) ? r.pick(NASTY_IDS) : fresh(r, f, new Set(nodes)));
  const shapes = ["rectangle", "rounded", "stadium", "circle", "diamond", "cylinder", "hexagon", "subroutine"];
  const kinds =
    f === "sequence"
      ? [
          "add-node",
          "add-node",
          "relabel-node",
          "connect",
          "connect",
          "connect",
          "relabel-edge",
          "relabel-edge",
          "retarget-edge",
          "retarget-edge",
          "delete-edge",
          "delete-edge",
          "move-edge",
          "move-edge",
          "move-node",
          "add-note",
          "add-note",
          "relabel-note",
          "delete-note",
          "wrap-edges",
          "wrap-edges",
          "unwrap-fragment",
        ]
      : [
          "add-node",
          "add-node",
          "relabel-node",
          "relabel-node",
          "connect",
          "connect",
          "connect",
          "relabel-edge",
          "relabel-edge",
          "retarget-edge",
          "retarget-edge",
          "delete-edge",
          "delete-edge",
          "delete-node",
          "delete-node",
          ...(f === "flowchart" ? ["change-shape", "direction"] : f === "er" || f === "state" ? ["direction"] : []),
        ];
  const kind = r.pick(kinds);
  const msgKinds = ["sync", "reply", "async"];
  switch (kind) {
    case "add-node": {
      const e: any = { kind, id: newId(), label: label() };
      if (f === "flowchart" && r.chance(0.6)) e.shape = r.pick(shapes);
      if (f === "c4") {
        e.element = r.pick([
          "Person",
          "System",
          "SystemDb",
          "SystemQueue",
          "Container",
          "ContainerDb",
          "Component",
          "ComponentQueue",
        ]);
        if (r.chance(0.3)) e.external = true;
      }
      if (f === "state" && r.chance(0.4)) e.state = r.pick(["state", "choice", "fork", "join"]);
      if (f === "sequence") e.participant = r.pick(["participant", "actor"]);
      return e;
    }
    case "relabel-node":
      return { kind, id: nodeId(), label: label() };
    case "change-shape":
      return { kind, id: nodeId(), shape: r.pick(shapes) as any };
    case "direction":
      return { kind, direction: r.pick(["tb", "bt", "lr", "rl"]) as any };
    case "connect": {
      const e: any = { kind, source: endpoint(), target: endpoint() };
      if (r.chance(0.85)) e.label = label();
      if (f === "flowchart") {
        e.id = "e" + r.int(80);
        if (r.chance(0.4)) e.line = r.pick(["solid", "dotted", "thick"]);
      }
      if (f === "c4" && r.chance(0.3)) e.relation = r.pick(["rel", "birel"]);
      if (f === "er") {
        if (r.chance(0.6)) e.cardinality = r.pick(["one-to-many", "one-to-one", "many-to-many", "zero-or-one-to-many"]);
        if (r.chance(0.5)) e.identifying = r.chance(0.5);
      }
      if (f === "sequence") {
        if (r.chance(0.7)) e.message = r.pick(msgKinds);
        e.after = r.chance(0.5) ? (edges.length ? r.pick(edges) : null) : r.chance(0.5) ? null : undefined;
        if (e.after === undefined) delete e.after;
      }
      return e;
    }
    case "relabel-edge":
      return { kind, id: edgeId(), label: label() };
    case "retarget-edge": {
      const e: any = { kind, id: edgeId() };
      const w = r.int(3);
      if (w !== 1) e.source = endpoint();
      if (w !== 0) e.target = endpoint();
      if (f === "sequence" && r.chance(0.3)) e.message = r.pick(msgKinds);
      return e;
    }
    case "delete-edge":
      return { kind, id: edgeId() };
    case "delete-node":
      return { kind, id: nodeId() };
    case "move-edge":
      return { kind, id: edgeId(), before: r.chance(0.2) ? null : edges.length ? r.pick(edges) : null };
    case "move-node":
      return { kind, id: nodeId(), before: r.chance(0.2) ? null : nodes.length ? r.pick(nodes) : null };
    case "add-note": {
      const pos = r.pick(["over", "left of", "right of"]);
      const ps = pos === "over" && r.chance(0.5) ? [nodeId(), nodeId()] : [nodeId()];
      const e: any = { kind, participants: ps, position: pos, text: label() };
      if (r.chance(0.5)) e.after = edges.length ? r.pick(edges) : null;
      return e;
    }
    case "relabel-note":
      return {
        kind,
        id: v.extra.notes.length && !chaos ? `note-${1 + r.int(v.extra.notes.length)}` : "note-99",
        text: label(),
      };
    case "delete-note":
      return { kind, id: v.extra.notes.length && !chaos ? `note-${1 + r.int(v.extra.notes.length)}` : "note-99" };
    case "wrap-edges": {
      const n = edges.length;
      const a = n ? r.int(n) : 0;
      const len = 1 + r.int(Math.min(3, Math.max(1, n - a)));
      return {
        kind,
        ids: n ? edges.slice(a, a + len) : ["msg-1"],
        fragment: r.pick(["loop", "alt", "opt", "par", "critical", "break"]) as any,
        label: label(),
      };
    }
    case "unwrap-fragment":
      return {
        kind,
        id: v.extra.fragments.length && !chaos ? `frag-${1 + r.int(v.extra.fragments.length)}` : "frag-99",
      };
  }
  throw new Error(kind);
}

/** Source mutations. Each returns new text or null when not applicable. */
export const MUTATIONS: Record<string, (s: string, r: Rng) => string | null> = {
  crlf: (s) => s.replace(/\r\n|\r|\n/g, "\r\n"),
  cr: (s) => s.replace(/\r\n|\r|\n/g, "\r"),
  bom: (s) => "﻿" + s,
  trailingWs: (s) => s.replace(/(\r\n|\r|\n)/g, "  $1"),
  tabs: (s) => s.replace(/^( {4}| {2})/gm, "\t"),
  noFinalNewline: (s) => s.replace(/(\r\n|\r|\n)+$/, ""),
  commentsBetween: (s, r) => {
    const parts = s.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)!.filter(Boolean);
    const eol = /\r\n|\r|\n/.exec(s)?.[0] ?? "\n";
    return parts.map((l, i) => (i > 0 && r.chance(0.4) ? `    %% interlude ${i}${eol}${l}` : l)).join("");
  },
  init: (s) => (/^\s*%%\{/m.test(s) ? null : '%%{init: {"theme": "dark"}}%%\n' + s),
  frontmatter: (s) => (/^---/.test(s) ? null : '---\ntitle: A "title": with colon\n---\n' + s),
  blankLines: (s) => s.replace(/(\r\n|\r|\n)/g, "$1$1"),
  styling: (s, r) => {
    if (!/^\s*(flowchart|graph)\b/m.test(s)) return null;
    const eol = /\r\n|\r|\n/.exec(s)?.[0] ?? "\n";
    const id = /^\s*([A-Za-z_]\w*)\s*[[({]/m.exec(s)?.[1];
    return (
      s.replace(/(\r\n|\r|\n)*$/, eol) +
      `classDef hot fill:#f96${eol}` +
      (id ? `style ${id} fill:#f00${eol}class ${id} hot${eol}` : "") +
      `linkStyle 0 stroke:#f00${eol}`
    );
  },
  duplicate: (s, r) => {
    const parts = s.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)!.filter(Boolean);
    if (parts.length < 3) return null;
    const i = 1 + r.int(parts.length - 1);
    const eol = /\r\n|\r|\n/.exec(s)?.[0] ?? "\n";
    const l = parts[i]!;
    return [...parts.slice(0, i + 1), /[\r\n]$/.test(l) ? l : eol + l + eol, ...parts.slice(i + 1)].join("");
  },
};
