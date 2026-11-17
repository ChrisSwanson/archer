// ELK answers from geometry alone: ids, sizes, ports and options. A label's
// `text` rides along but never moves a box. So two inputs that differ only in
// label text lay out identically, and an edit that keeps every box its size --
// most renames, any edit the projection does not see -- needs no ELK run
// (smoke-a: a rename on the 150-node flowchart spent 1-2 s in the worker).
import type { ElkLabel, ElkNode } from "elkjs/lib/elk-api.js";

export const KERNEL_CACHE_ENTRIES = 16;

export interface Kernel {
  layout(graph: ElkNode): Promise<ElkNode>;
}

/** The input as ELK sees it: the graph without label text. */
function geometryKey(graph: ElkNode): string {
  return JSON.stringify(graph, (key, value: unknown) => (key === "text" ? undefined : value));
}

function labelTexts(graph: ElkNode): Map<string, string> {
  const texts = new Map<string, string>();
  const visit = (labels: readonly ElkLabel[] | undefined) => {
    for (const label of labels ?? [])
      if (label.id !== undefined && label.text !== undefined) texts.set(label.id, label.text);
  };
  const walk = (node: ElkNode) => {
    visit(node.labels);
    for (const port of node.ports ?? []) visit(port.labels);
    for (const edge of node.edges ?? []) visit(edge.labels);
    for (const child of node.children ?? []) walk(child);
  };
  walk(graph);
  return texts;
}

/** A copy of `laidOut` carrying the label text of `graph`, the request it now answers. */
function answering(laidOut: ElkNode, graph: ElkNode): ElkNode {
  const texts = labelTexts(graph);
  return JSON.parse(JSON.stringify(laidOut), (key, value: unknown) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value) && "text" in value && "id" in value) {
      const text = texts.get((value as { id: string }).id);
      if (text !== undefined) return { ...value, text };
    }
    return value;
  }) as ElkNode;
}

/** `kernel` with its answers kept by geometry, the newest `entries` of them. A refusal is not kept. */
export function cachedKernel(kernel: Kernel, entries = KERNEL_CACHE_ENTRIES): Kernel {
  const held = new Map<string, Promise<ElkNode>>();
  return {
    layout(graph: ElkNode): Promise<ElkNode> {
      const key = geometryKey(graph);
      let answer = held.get(key);
      if (answer === undefined) {
        answer = kernel.layout(graph);
        const kept = answer;
        kept.catch(() => {
          if (held.get(key) === kept) held.delete(key);
        });
      } else held.delete(key);
      held.set(key, answer);
      if (held.size > entries) held.delete(held.keys().next().value!);
      // Every caller gets its own copy: the layout core reads the answer, and a
      // shared object would carry one caller's label text to another.
      return answer.then((laidOut) => answering(laidOut, graph));
    },
  };
}
