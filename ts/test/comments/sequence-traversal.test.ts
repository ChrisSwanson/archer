import { expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import { blockContents, sequenceBlocks, sequenceNotes } from "../../src/comments/sequence-blocks.ts";

const source = `sequenceDiagram
 participant A as Alice
 participant B as Bob
 A->>B: Begin
 alt accepted
  Note over A,B: Outer annotation
  opt audit
   B-->>A: Record
   Note right of A: Audit annotation
  end
 else denied
  par report
   A-)B: Alert
  and review
   B->>A: Review
  end
 end
 Note left of B: Finished
`;

test("nested sequence comment scopes preserve source order and semantic fingerprints", async () => {
  const result = await compile(source);
  expect(result.diagnostics).toEqual([]);
  if (result.model?.type !== "sequence-trace") throw new Error("sequence did not compile");
  const before = JSON.stringify(result.model);
  const blocks = sequenceBlocks(result.model);
  const notes = sequenceNotes(result.model);
  expect(blocks.map(({ fragment, fingerprint }) => [fragment.id, fingerprint])).toEqual([
    ["frag-0", "sha256:41d6dad9ff25f778e1a0777191a1591f02b464228fccc726615229f53d585865"],
    ["frag-1", "sha256:3ce5b4db0025a3a330eeb435376300676b563b9f0805565730419c60a2cd4669"],
    ["frag-2", "sha256:39a1738d5904c16cf13b4aec103d5f3301f0f90a99f7e66183b96ba7462dd5c0"],
  ]);
  expect(notes.map(({ note, fingerprint, block }) => [note.id, fingerprint, block?.id])).toEqual([
    ["note-0", "sha256:1d4c9bfec144de10bcab6eb3ad51fc944eef565aad9ac8573e498f02b577ce80", "frag-0"],
    ["note-1", "sha256:d43829160823a94345cf6e7094ef8ad61f878d7b154fe9a740613a2bd415ea4a", "frag-1"],
    ["note-2", "sha256:a0a7c16cdc005b4a96062a7f5d23ac2719c575eeeca82818a6609bc99abd527d", undefined],
  ]);
  expect(blockContents(blocks[0]!.fragment)).toEqual({
    kind: "alt",
    condition: "accepted",
    messageIds: ["msg-1", "msg-2", "msg-3"],
    noteIds: ["note-0", "note-1"],
  });
  expect(JSON.stringify(result.model)).toBe(before);
});

test("identical compiled blocks and notes remain ambiguous", async () => {
  const result = await compile(`sequenceDiagram
 participant A
 participant B
 opt identical
  Note over A,B: Duplicate
  A->>B: Same
 end
 opt identical
  Note over A,B: Duplicate
  A->>B: Same
 end
`);
  expect(result.diagnostics).toEqual([]);
  if (result.model?.type !== "sequence-trace") throw new Error("sequence did not compile");
  const blocks = sequenceBlocks(result.model);
  const notes = sequenceNotes(result.model);
  expect(blocks).toHaveLength(2);
  expect(blocks[0]!.fingerprint).toBe(blocks[1]!.fingerprint);
  expect(notes).toHaveLength(2);
  expect(notes[0]!.fingerprint).toBe(notes[1]!.fingerprint);
});
