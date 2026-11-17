import { describe, expect, it, vi } from "vitest";
import { parseNoteEmphasisRead, type NoteEmphasisRead } from "../src/comments/contract";
import { httpCommentsTransport } from "../src/comments/transport";
import { appendPersonHighlight } from "../src/comments/useNoteEmphasis";

const passage = (quote = "café 😀") => ({ kind: "passage" as const, quote, prefix: "Alpha ", suffix: " beta" });
const read = (): NoteEmphasisRead => ({
  snapshot: {
    schemaVersion: 1,
    notePath: "notes/context.md",
    revision: 4,
    emphases: [
      {
        id: "design-review",
        title: "Design review changes",
        author: "agent",
        groups: [{ id: "risk", label: "Risk", palette: "teal", passages: [passage("Alpha")] }],
      },
    ],
  },
  orphans: [],
});

describe("the note emphasis transport boundary", () => {
  it("strictly reads a valid snapshot and bounded orphan references", () => {
    const answer = read();
    answer.snapshot.emphases[0]!.groups[0]!.passages;
    expect(parseNoteEmphasisRead(answer)).toEqual(answer);
    expect(
      parseNoteEmphasisRead({
        ...answer,
        orphans: [{ emphasisId: "design-review", groupId: "risk", passageIndex: 1 }],
      }),
    ).toBeUndefined();
  });

  it("reads the wire's palette as the colour of the group's position", () => {
    const answer: any = structuredClone(read());
    answer.snapshot.emphases[0].groups = [
      { ...answer.snapshot.emphases[0].groups[0], palette: "coral" },
      { ...answer.snapshot.emphases[0].groups[0], id: "two", palette: "coral" },
    ];
    expect(parseNoteEmphasisRead(answer)!.snapshot.emphases[0]!.groups.map((group) => group.palette)).toEqual([
      "teal",
      "violet",
    ]);
  });

  it.each([
    [
      "unknown author",
      (answer: any) => {
        answer.snapshot.emphases[0].author = "browser-agent";
      },
    ],
    [
      "unknown palette",
      (answer: any) => {
        answer.snapshot.emphases[0].groups[0].palette = "blue";
      },
    ],
    [
      "amber palette (the agent's voice, never a group)",
      (answer: any) => {
        answer.snapshot.emphases[0].groups[0].palette = "amber";
      },
    ],
    [
      "extra response field",
      (answer: any) => {
        answer.html = "<b>unsafe</b>";
      },
    ],
    [
      "extra orphan field",
      (answer: any) => {
        answer.orphans = [{ emphasisId: "design-review", groupId: "risk", passageIndex: 0, oldGroup: {} }];
      },
    ],
  ])("refuses %s", (_name, mutate) => {
    const answer: any = structuredClone(read());
    mutate(answer);
    expect(parseNoteEmphasisRead(answer)).toBeUndefined();
  });

  it("posts the CAS replacement and accepts only the named note in response", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify(read()), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const transport = httpCommentsTransport(fetcher);
    const input = {
      notePath: "notes/context.md",
      id: "reader-highlights",
      title: "Reader highlights",
      groups: [{ id: "question", label: "Question", passages: [passage()] }],
      expectedRevision: 4,
    };
    await expect(transport.upsertNoteEmphasis!(input)).resolves.toEqual(read());
    expect(fetcher).toHaveBeenCalledWith(
      "api/note-emphases?path=notes%2Fcontext.md",
      expect.objectContaining({ method: "POST", body: JSON.stringify(input) }),
    );
  });
});

describe("a person's named highlight set", () => {
  it("preserves agent sets and appends through a separate CAS replacement", () => {
    const built = appendPersonHighlight(read(), "Question", passage());
    expect(built).toMatchObject({ ok: true, setId: "reader-highlights" });
    if (!built.ok) throw new Error(built.problem);
    expect(built.input).toEqual({
      notePath: "notes/context.md",
      id: "reader-highlights",
      title: "Reader highlights",
      groups: [{ id: "question", label: "Question", passages: [passage()] }],
      expectedRevision: 4,
    });
    expect(read().snapshot.emphases[0]?.id).toBe("design-review");
  });

  it("never overwrites an agent set that already uses the reader id", () => {
    const held = read();
    const collision: NoteEmphasisRead = {
      ...held,
      snapshot: { ...held.snapshot, emphases: [{ ...held.snapshot.emphases[0]!, id: "reader-highlights" }] },
    };
    expect(appendPersonHighlight(collision, "Question", passage())).toMatchObject({
      ok: true,
      setId: "reader-highlights-2",
    });
  });

  it("does not append to an unrelated person-authored named set", () => {
    const held = read();
    const unrelated: NoteEmphasisRead = {
      ...held,
      snapshot: {
        ...held.snapshot,
        emphases: [
          {
            ...held.snapshot.emphases[0]!,
            id: "reader-highlights-imported",
            title: "Imported review",
            author: "person",
          },
        ],
      },
    };
    expect(appendPersonHighlight(unrelated, "Question", passage())).toMatchObject({
      ok: true,
      setId: "reader-highlights",
    });
  });

  it("does not claim an imported matching-title set outside reserved numeric ids", () => {
    const held = read();
    const imported: NoteEmphasisRead = {
      ...held,
      snapshot: {
        ...held.snapshot,
        emphases: [
          {
            ...held.snapshot.emphases[0]!,
            id: "reader-highlights-imported",
            title: "Reader highlights",
            author: "person",
          },
        ],
      },
    };
    expect(appendPersonHighlight(imported, "Question", passage())).toMatchObject({
      ok: true,
      setId: "reader-highlights",
    });
  });

  it("reports the passage cap without building a write", () => {
    const held = read();
    const full: NoteEmphasisRead = {
      ...held,
      snapshot: {
        ...held.snapshot,
        emphases: [
          {
            id: "reader-highlights",
            title: "Reader highlights",
            author: "person",
            groups: [
              {
                id: "full",
                label: "Full",
                palette: "teal",
                passages: Array.from({ length: 64 }, (_, at) => passage(`passage ${at}`)),
              },
            ],
          },
        ],
      },
    };
    expect(appendPersonHighlight(full, "Full", passage("one more"))).toEqual({
      ok: false,
      problem: "A group holds at most 64 passages.",
    });
  });
});
