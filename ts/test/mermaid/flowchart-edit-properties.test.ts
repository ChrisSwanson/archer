import { expect, test } from "vitest";
import { editFlowchart } from "../../src/authoring/flowchart-edit.ts";
import { compile } from "../../src/mermaid/index.ts";
import { validateModel } from "../../src/mermaid/validate.ts";
const vocabulary = [
  "a",
  "b",
  "[",
  "]",
  '"',
  "#quot;",
  "%%",
  "e1@",
  "-->",
  "subgraph",
  "end",
  "\r",
  "\n",
  "🦉",
  "\u001b",
  "style",
  ":::person",
];
let state = 42;
function random(n: number) {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state % n;
}
test("bounded trust boundary: arbitrary, vocabulary and edited-valid sources refuse unchanged or produce valid model", async () => {
  for (let round = 0; round < 90; round++) {
    const arbitrary = Array.from({ length: random(80) }, () => String.fromCharCode(random(65536))).join("");
    const words =
      "flowchart LR\n" + Array.from({ length: random(20) }, () => vocabulary[random(vocabulary.length)]).join(" ");
    const valid = "flowchart LR\na[A]\nb[B]\na e1@--> b";
    const at = random(valid.length);
    const mutated = valid.slice(0, at) + vocabulary[random(vocabulary.length)] + valid.slice(at + random(3));
    for (const source of [arbitrary, words, mutated]) {
      const edit =
        round % 2
          ? { kind: "relabel-node" as const, id: "a", label: arbitrary }
          : { kind: "add-node" as const, id: arbitrary, label: "New" };
      const result = await editFlowchart(source, edit);
      if (!result.ok) {
        expect(result.source).toBe(source);
        expect(result.code).toMatch(/^edit_/u);
      } else {
        const compiled = await compile(result.source);
        expect(compiled.model).not.toBeNull();
        if (compiled.model) expect(validateModel(compiled.model)).toEqual([]);
      }
    }
  }
}, 30_000);
