import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { locatePassage, passageAnchor } from "../../../shared/note-markdown.mts";
import {
  MAX_NOTE_EMPHASES,
  MAX_NOTE_EMPHASIS_CONTEXT_CHARS,
  MAX_NOTE_EMPHASIS_FILE_BYTES,
  MAX_NOTE_EMPHASIS_GROUPS,
  MAX_NOTE_EMPHASIS_ID_CHARS,
  MAX_NOTE_EMPHASIS_PASSAGES,
  MAX_NOTE_EMPHASIS_PASSAGES_PER_GROUP,
  MAX_NOTE_EMPHASIS_QUOTE_CHARS,
  NOTE_EMPHASIS_TEXT_LIMITS,
  validateNoteEmphasisSnapshot,
} from "../../../shared/note-emphasis.mts";
import { renderedNoteText } from "../../src/comments/note-text.ts";
import { NoteEmphasisError, NoteEmphasisStore, readUpsertNoteEmphasis } from "../../src/notes/emphasis.ts";
import { findProject } from "../../src/project/index.ts";
import { removeTempDirs, tempDir, write } from "../project/support.ts";

afterEach(removeTempDirs);

const anchor = (markdown: string, quote: string, from = 0) => {
  const text = renderedNoteText(markdown);
  const at = text.indexOf(quote, from);
  if (at < 0) throw new Error(`fixture has no ${quote}`);
  return passageAnchor(text, at, at + quote.length);
};

const group = (markdown: string, quote: string, name = "teal") => ({
  id: `g-${name}`,
  label: `Group ${name}`,
  passages: [anchor(markdown, quote)],
});
/** Four groups of 64 passages fill the note's 256 slots; at three groups a set, that takes two named sets. */
const twoSets = <T>(groups: readonly T[]) =>
  [groups.slice(0, MAX_NOTE_EMPHASIS_GROUPS), groups.slice(MAX_NOTE_EMPHASIS_GROUPS)] as const;

function refusal(work: () => unknown, code: NoteEmphasisError["code"]): NoteEmphasisError {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(NoteEmphasisError);
    expect(error).toMatchObject({ code });
    return error as NoteEmphasisError;
  }
  throw new Error(`expected ${code}`);
}

test("a named note emphasis is persisted, replaced with CAS, and cleared without changing the note", () => {
  const source = "# Login\n\nThe client sends a signed token to the API.\n";
  const root = tempDir({ ".archer/notes/auth.md": source, ".archer/notes/auth.comments.json": "comment sentinel" });
  const store = new NoteEmphasisStore(findProject(root));
  const first = store.upsert(
    {
      notePath: "notes/auth.md",
      id: "auth",
      title: "Authentication",
      expectedRevision: 0,
      groups: [
        {
          id: "token",
          label: "Token exchange",
          passages: [{ kind: "passage", quote: "signed token", prefix: "The client sends a ", suffix: " to the API." }],
        },
      ],
    },
    "agent",
  );
  expect(first.snapshot).toMatchObject({ revision: 1, emphases: [{ id: "auth", author: "agent" }] });
  expect(store.read("notes/auth.md")).toEqual(first);
  try {
    store.upsert({ notePath: "notes/auth.md", id: "auth", expectedRevision: 0, groups: [] }, "agent");
    throw new Error("expected a conflict");
  } catch (error) {
    expect(error).toBeInstanceOf(NoteEmphasisError);
    expect(error).toMatchObject({ code: "note_emphasis_conflict", details: { actualSnapshot: { revision: 1 } } });
  }
  expect(
    store.upsert({ notePath: "notes/auth.md", id: "auth", expectedRevision: 1, groups: [] }, "person").snapshot,
  ).toMatchObject({ revision: 2, emphases: [] });
  expect(
    store.upsert({ notePath: "notes/auth.md", id: "already-gone", expectedRevision: 2, groups: [] }, "person").snapshot,
  ).toMatchObject({ revision: 3, emphases: [] });
  expect(readFileSync(`${root}/.archer/notes/auth.md`, "utf8")).toBe(source);
  expect(readFileSync(`${root}/.archer/notes/auth.comments.json`, "utf8")).toBe("comment sentinel");
});

test("the trusted publishing actor replaces any prior author", () => {
  const source = "teal amber violet coral";
  const root = tempDir({ ".archer/note.md": source });
  const store = new NoteEmphasisStore(findProject(root));
  let revision = 0;
  for (const name of ["teal", "amber", "violet", "coral"]) {
    const result = store.upsert(
      { notePath: "note.md", id: name, groups: [group(source, name, name)], expectedRevision: revision },
      "person",
    );
    revision = result.snapshot.revision;
  }
  const replaced = store.upsert(
    { notePath: "note.md", id: "teal", groups: [group(source, "teal")], expectedRevision: revision },
    "agent",
  );
  expect(replaced.snapshot.emphases.map((entry) => [entry.id, entry.author])).toEqual([
    ["teal", "agent"],
    ["amber", "person"],
    ["violet", "person"],
    ["coral", "person"],
  ]);
  refusal(
    () =>
      readUpsertNoteEmphasis({ notePath: "note.md", id: "spoof", author: "agent", groups: [], expectedRevision: 0 }),
    "invalid_note_emphasis",
  );
});

test("passages are grounded as rendered text, repeated quotes need distinguishing context, and failures are atomic", () => {
  const source = "First signed token here.\n\nSecond token there.\n\nTwin token. Twin token.";
  const root = tempDir({ ".archer/note.md": source });
  const store = new NoteEmphasisStore(findProject(root));
  const firstToken = anchor(source, "token", 0);
  const secondAt = renderedNoteText(source).indexOf("token", firstToken.quote.length + firstToken.prefix.length);
  const secondToken = passageAnchor(renderedNoteText(source), secondAt, secondAt + "token".length);
  const overlapping = anchor(source, "signed token");
  const accepted = store.upsert(
    {
      notePath: "note.md",
      id: "tokens",
      expectedRevision: 0,
      groups: [{ id: "distinct", label: "Distinct", passages: [firstToken, secondToken, overlapping] }],
    },
    "agent",
  );
  expect(accepted.snapshot.revision).toBe(1);
  const before = readFileSync(`${root}/.archer/note.md.emphases.json`);
  const ambiguous = { kind: "passage" as const, quote: "token", prefix: "", suffix: "" };
  const errors = refusal(
    () =>
      store.upsert(
        {
          notePath: "note.md",
          id: "bad",
          expectedRevision: 1,
          groups: [{ id: "ambiguous", label: "Ambiguous", passages: [ambiguous, { ...ambiguous, quote: "missing" }] }],
        },
        "agent",
      ),
    "invalid_note_emphasis",
  );
  expect(errors.details).toMatchObject({
    issues: [
      { path: "groups[0].passages[0]", problem: expect.stringContaining("ambiguous") },
      { path: "groups[0].passages[1]", problem: expect.stringContaining("not in") },
    ],
  });
  expect(readFileSync(`${root}/.archer/note.md.emphases.json`)).toEqual(before);
});

test("a quote typed across a soft line break is grounded and stored as the rendered text the page highlights", () => {
  // The demo ADR wraps "which a three-person / team cannot carry" over two source lines.
  const source = readFileSync(
    new URL("../fixtures/pageturner/.archer/notes/0001-hosted-payment-page.md", import.meta.url),
    "utf8",
  );
  const root = tempDir({ ".archer/notes/adr.md": source });
  const store = new NoteEmphasisStore(findProject(root));
  const typed = {
    kind: "passage" as const,
    quote: "which a three-person team cannot carry",
    prefix: "for PCI DSS, ",
    suffix: ".",
  };
  const saved = store.upsert(
    {
      notePath: "notes/adr.md",
      id: "pci",
      expectedRevision: 0,
      groups: [{ id: "cost", label: "Cost", passages: [typed] }],
    },
    "agent",
  );
  const stored = saved.snapshot.emphases[0]!.groups[0]!.passages[0]!;
  expect(stored).toEqual({ ...typed, quote: "which a three-person\nteam cannot carry" });
  const rendered = renderedNoteText(source);
  const at = locatePassage(rendered, stored)!;
  expect(rendered.slice(at.start, at.end)).toBe("which a three-person\nteam cannot carry");
  expect(saved.orphans).toEqual([]);
  // Context typed across a soft break is grounded the same way.
  const wrapped = {
    kind: "passage" as const,
    quote: "three-person team",
    prefix: "in scope for PCI DSS, which a ",
    suffix: " cannot carry",
  };
  const context = store.upsert(
    {
      notePath: "notes/adr.md",
      id: "team",
      expectedRevision: 1,
      groups: [{ id: "team", label: "Team", passages: [wrapped] }],
    },
    "agent",
  );
  expect(context.snapshot.emphases[1]!.groups[0]!.passages[0]).toEqual({ ...wrapped, quote: "three-person\nteam" });
});

test("a quote still may not run across a paragraph, list item or hard break", () => {
  const source = "Alpha beta\n\ngamma delta.\n\n- one two\n- three four\n\nfive six  \nseven eight\n";
  const root = tempDir({ ".archer/note.md": source });
  const store = new NoteEmphasisStore(findProject(root));
  const passage = (quote: string) => ({ kind: "passage" as const, quote, prefix: "", suffix: "" });
  const errors = refusal(
    () =>
      store.upsert(
        {
          notePath: "note.md",
          id: "across",
          expectedRevision: 0,
          groups: [
            { id: "g", label: "G", passages: [passage("beta gamma"), passage("two three"), passage("six seven")] },
          ],
        },
        "agent",
      ),
    "invalid_note_emphasis",
  );
  expect(errors.details).toMatchObject({
    issues: [0, 1, 2].map((index) => ({
      path: `groups[0].passages[${index}]`,
      problem: expect.stringContaining("not in"),
    })),
  });
});

test("a whitespace-tolerant passage is stored with context that still finds the occurrence it matched", () => {
  const save = (source: string, passage: { quote: string; prefix: string; suffix: string }) => {
    const root = tempDir({ ".archer/note.md": source });
    return () =>
      new NoteEmphasisStore(findProject(root)).upsert(
        {
          notePath: "note.md",
          id: "e",
          expectedRevision: 0,
          groups: [{ id: "g", label: "G", passages: [{ kind: "passage" as const, ...passage }] }],
        },
        "agent",
      ).snapshot.emphases[0]!.groups[0]!.passages[0]!;
  };
  // Codex's repro: the 201 spaces before each passage leave no 200 characters
  // of prefix that tell the two apart, so the request is refused rather than
  // stored with context that lands on the first.
  const tied = `first${" ".repeat(201)}alpha\nbeta and second${" ".repeat(201)}alpha\nbeta`;
  const error = refusal(save(tied, { quote: "alpha beta", prefix: "second ", suffix: "" }), "invalid_note_emphasis");
  expect(error.details).toMatchObject({
    issues: [{ path: "groups[0].passages[0]", problem: expect.stringContaining("ambiguous") }],
  });
  // Over-long rendered context is cut to its nearest 200 characters, which here still tell them apart.
  const told = `one${" ".repeat(191)}first alpha\nbeta and one${" ".repeat(191)}second alpha\nbeta`;
  const stored = save(told, { quote: "alpha beta", prefix: "one second ", suffix: "" })();
  expect(stored.prefix).toBe(`ne${" ".repeat(191)}second `);
  const rendered = renderedNoteText(told);
  expect(locatePassage(rendered, stored)).toEqual({
    start: rendered.lastIndexOf("alpha"),
    end: rendered.lastIndexOf("alpha") + "alpha\nbeta".length,
  });
});

test("whitespace-tolerant grounding counts the contract's characters (code points) at the quote and context limits", () => {
  const smile = "\u{1F600}";
  const store = (source: string) => new NoteEmphasisStore(findProject(tempDir({ ".archer/note.md": source })));
  const upsert = (source: string, passage: { quote: string; prefix: string; suffix: string }) => () =>
    store(source).upsert(
      {
        notePath: "note.md",
        id: "e",
        expectedRevision: 0,
        groups: [{ id: "g", label: "G", passages: [{ kind: "passage" as const, ...passage }] }],
      },
      "agent",
    ).snapshot.emphases[0]!.groups[0]!.passages[0]!;
  // Codex's repro: 501 emoji and " next" is 506 characters, across a soft break.
  expect(
    upsert(`${smile.repeat(501)}\nnext`, { quote: `${smile.repeat(501)} next`, prefix: "", suffix: "" })().quote,
  ).toBe(`${smile.repeat(501)}\nnext`);
  // The rendered quote (two spaces, a soft break) is one longer than the typed one.
  const quoteOf = (n: number) => ({
    source: `${smile.repeat(n)}  ${smile}\nnext`,
    passage: { quote: `${smile.repeat(n)} ${smile} next`, prefix: "", suffix: "" },
  });
  const atLimit = quoteOf(MAX_NOTE_EMPHASIS_QUOTE_CHARS - 8);
  expect([...upsert(atLimit.source, atLimit.passage)().quote]).toHaveLength(MAX_NOTE_EMPHASIS_QUOTE_CHARS);
  const over = quoteOf(MAX_NOTE_EMPHASIS_QUOTE_CHARS - 7);
  expect([...over.passage.quote]).toHaveLength(MAX_NOTE_EMPHASIS_QUOTE_CHARS);
  expect(refusal(upsert(over.source, over.passage), "invalid_note_emphasis").details).toMatchObject({
    issues: [{ problem: expect.stringContaining(`over ${MAX_NOTE_EMPHASIS_QUOTE_CHARS} characters`) }],
  });
  // The rendered prefix: exactly at the limit is stored whole; one over is cut by a code point, never a surrogate half.
  const prefixOf = (n: number) => ({
    source: `lead ${smile.repeat(n)}  zz alpha\nbeta`,
    passage: { quote: "alpha beta", prefix: `${smile.repeat(n)} zz `, suffix: "" },
  });
  const whole = prefixOf(MAX_NOTE_EMPHASIS_CONTEXT_CHARS - 5);
  expect(upsert(whole.source, whole.passage)().prefix).toBe(
    `${smile.repeat(MAX_NOTE_EMPHASIS_CONTEXT_CHARS - 5)}  zz `,
  );
  const cut = prefixOf(MAX_NOTE_EMPHASIS_CONTEXT_CHARS - 4);
  expect(upsert(cut.source, cut.passage)().prefix).toBe(`${smile.repeat(MAX_NOTE_EMPHASIS_CONTEXT_CHARS - 5)}  zz `);
});

test("whitespace-tolerant grounding stays fast on adversarial quotes", () => {
  // Every word is the start of a near-match: the quote's 300 words agree for
  // up to 299 before the final word fails, and its spacing never matches the
  // note's as written, so the whitespace-tolerant path runs for each passage.
  const quote = `${"a \t".repeat(299)}b`;
  const adversarial = Array.from({ length: 64 }, (_, index) => ({
    kind: "passage" as const,
    quote,
    prefix: `${"  ".repeat(index + 1)}a`,
    suffix: `${" ".repeat(150)}never`,
  }));
  // A trivial miss on the same path: the cost of rendering the note twice, which the adversarial work adds to.
  const trivial = adversarial.map((passage, index) => ({ ...passage, quote: `zz ${index}`, prefix: "", suffix: "" }));
  const timed = (source: string, passages: readonly (typeof adversarial)[number][]): number => {
    const root = tempDir({ ".archer/note.md": source });
    const store = new NoteEmphasisStore(findProject(root));
    const began = performance.now();
    const error = refusal(
      () =>
        store.upsert(
          {
            notePath: "note.md",
            id: "slow",
            expectedRevision: 0,
            groups: [{ id: "g", label: "G", passages: [...passages] }],
          },
          "agent",
        ),
      "invalid_note_emphasis",
    );
    const issues = (error.details as { issues: { problem: string }[] }).issues;
    expect(issues).toHaveLength(64);
    expect(issues.every((issue) => issue.problem.includes("not in"))).toBe(true);
    return performance.now() - began;
  };
  const words = (count: number) => `${"a   ".repeat(count)}\n`;
  // A realistic note (~12 KB of text). Measured 17-48 ms; 1.5 s with RegExp
  // matching. The bound is generous for a loaded shared host.
  expect(timed(words(3_000), adversarial)).toBeLessThan(250);
  // Near the note size limit, rendering alone takes about a second on a busy
  // host, so the bound is on the matching the adversarial passages add: one
  // linear indexOf scan each, measured 0.1-0.25 s for all 64 (0.8 s beside other suites),
  // where the RegExp matcher was some 35 times slower on the realistic note.
  const big = words(250_000);
  expect(timed(big, adversarial) - timed(big, trivial)).toBeLessThan(2_000);
});

test("source edits preserve matching anchors and report removed passages as read-only orphans", () => {
  const source = "The client sends a signed token to the API.";
  const root = tempDir({ ".archer/note.md": source });
  const store = new NoteEmphasisStore(findProject(root));
  const saved = store.upsert(
    { notePath: "note.md", id: "auth", expectedRevision: 0, groups: [group(source, "signed token")] },
    "agent",
  );
  const persisted = readFileSync(`${root}/.archer/note.md.emphases.json`, "utf8");
  write(root, ".archer/note.md", `New introduction.\n\n${source}`);
  expect(store.read("note.md").orphans).toEqual([]);
  write(root, ".archer/note.md", "The API accepts a session cookie.");
  const drifted = store.read("note.md");
  expect(drifted.snapshot).toEqual(saved.snapshot);
  expect(drifted.orphans).toEqual([{ emphasisId: "auth", groupId: "g-teal", passageIndex: 0 }]);
  const orphan = drifted.orphans[0]!;
  expect(
    drifted.snapshot.emphases
      .find((entry) => entry.id === orphan.emphasisId)
      ?.groups.find((entry) => entry.id === orphan.groupId)?.passages[orphan.passageIndex],
  ).toMatchObject({ quote: "signed token" });
  expect(readFileSync(`${root}/.archer/note.md.emphases.json`, "utf8")).toBe(persisted);
  write(root, ".archer/note.md", source);
  expect(store.read("note.md").orphans).toEqual([]);
});

test("all 256 long orphan passages stay a bounded compact index into the snapshot", () => {
  const quotes = Array.from(
    { length: MAX_NOTE_EMPHASIS_PASSAGES },
    (_, index) => `passage-${index.toString().padStart(3, "0")}-${String.fromCharCode(97 + (index % 26)).repeat(768)}`,
  );
  const source = quotes.join("\n\n");
  expect(Buffer.byteLength(source)).toBeLessThan(1024 * 1024);
  const root = tempDir({ ".archer/note.md": source });
  const store = new NoteEmphasisStore(findProject(root));
  const groups = Array.from({ length: 4 }, (_, groupIndex) => ({
    id: `g${groupIndex}`,
    label: `Group ${groupIndex}`,
    description: "A long group whose passages must not be copied into every orphan decorator.",
    passages: quotes
      .slice(groupIndex * MAX_NOTE_EMPHASIS_PASSAGES_PER_GROUP, (groupIndex + 1) * MAX_NOTE_EMPHASIS_PASSAGES_PER_GROUP)
      .map((quote) => ({ kind: "passage" as const, quote, prefix: "", suffix: "" })),
  }));
  twoSets(groups).forEach((held, index) =>
    store.upsert({ notePath: "note.md", id: `all-${index}`, expectedRevision: index, groups: [...held] }, "agent"),
  );

  write(root, ".archer/note.md", "# Changed\n\nEvery highlighted passage has been removed.\n");
  const read = store.read("note.md");
  expect(read.orphans).toHaveLength(MAX_NOTE_EMPHASIS_PASSAGES);
  for (const orphan of read.orphans) {
    expect(Object.keys(orphan).sort()).toEqual(["emphasisId", "groupId", "passageIndex"]);
    const emphasis = read.snapshot.emphases.find((entry) => entry.id === orphan.emphasisId);
    const heldGroup = emphasis?.groups.find((entry) => entry.id === orphan.groupId);
    expect(heldGroup?.passages[orphan.passageIndex]).toBeDefined();
  }
  const snapshotBytes = Buffer.byteLength(JSON.stringify(read.snapshot));
  expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThanOrEqual(snapshotBytes + 128 * 1024);
});

test("the exact character and collection limits are discoverable and load-bearing", () => {
  const emoji = "📘";
  const passage = {
    kind: "passage" as const,
    quote: emoji.repeat(MAX_NOTE_EMPHASIS_QUOTE_CHARS),
    prefix: emoji.repeat(MAX_NOTE_EMPHASIS_CONTEXT_CHARS),
    suffix: emoji.repeat(MAX_NOTE_EMPHASIS_CONTEXT_CHARS),
  };
  const bounded = {
    notePath: "note.md",
    id: emoji.repeat(MAX_NOTE_EMPHASIS_ID_CHARS),
    title: emoji.repeat(NOTE_EMPHASIS_TEXT_LIMITS.title.chars),
    groups: Array.from({ length: MAX_NOTE_EMPHASIS_GROUPS }, (_, index) => ({
      id: `g${index}`,
      label: emoji.repeat(NOTE_EMPHASIS_TEXT_LIMITS.label.chars),
      description: emoji.repeat(NOTE_EMPHASIS_TEXT_LIMITS.description.chars),
      passages: Array.from({ length: index === 0 ? MAX_NOTE_EMPHASIS_PASSAGES_PER_GROUP : 0 }, () => passage),
    })),
    expectedRevision: 0,
  };
  expect(readUpsertNoteEmphasis(bounded)).toEqual(bounded);
  for (const changed of [
    { ...bounded, id: `${bounded.id}${emoji}` },
    { ...bounded, title: `${bounded.title}${emoji}` },
    { ...bounded, groups: [...bounded.groups, bounded.groups[0]!] },
    { ...bounded, groups: [{ ...bounded.groups[0]!, passages: [...bounded.groups[0]!.passages, passage] }] },
    { ...bounded, groups: [{ ...bounded.groups[0]!, passages: [{ ...passage, quote: `${passage.quote}${emoji}` }] }] },
    {
      ...bounded,
      groups: [{ ...bounded.groups[0]!, passages: [{ ...passage, prefix: `${passage.prefix}${emoji}` }] }],
    },
  ])
    refusal(() => readUpsertNoteEmphasis(changed), "invalid_note_emphasis");

  const emphases = Array.from({ length: MAX_NOTE_EMPHASES }, (_, index) => ({
    id: `e${index}`,
    author: "agent" as const,
    groups: [
      {
        id: "g",
        label: "Group",
        palette: "teal" as const,
        passages: Array.from({ length: MAX_NOTE_EMPHASIS_PASSAGES / MAX_NOTE_EMPHASES }, (_, p) => ({
          kind: "passage" as const,
          quote: `q${index}-${p}`,
          prefix: "",
          suffix: "",
        })),
      },
    ],
  }));
  expect(validateNoteEmphasisSnapshot({ schemaVersion: 1, notePath: "note.md", revision: 0, emphases })).toMatchObject({
    ok: true,
  });
  expect(
    validateNoteEmphasisSnapshot({
      schemaVersion: 1,
      notePath: "note.md",
      revision: 0,
      emphases: [...emphases, emphases[0]],
    }),
  ).toMatchObject({ ok: false });
  const overTotal = emphases.map((entry, index) =>
    index === 0
      ? {
          ...entry,
          groups: [
            {
              ...entry.groups[0]!,
              passages: [...entry.groups[0]!.passages, { kind: "passage", quote: "one-more", prefix: "", suffix: "" }],
            },
          ],
        }
      : entry,
  );
  expect(
    validateNoteEmphasisSnapshot({ schemaVersion: 1, notePath: "note.md", revision: 0, emphases: overTotal }),
  ).toMatchObject({ ok: false, problem: expect.stringContaining(String(MAX_NOTE_EMPHASIS_PASSAGES)) });
  const worstCase = {
    schemaVersion: 1,
    notePath: "note.md",
    revision: 1,
    emphases: Array.from({ length: MAX_NOTE_EMPHASES }, (_, emphasisIndex) => ({
      id: `e${emphasisIndex}`,
      title: emoji.repeat(NOTE_EMPHASIS_TEXT_LIMITS.title.chars),
      author: "agent",
      groups: Array.from({ length: MAX_NOTE_EMPHASIS_GROUPS }, (_, groupIndex) => ({
        id: `g${groupIndex}`,
        label: emoji.repeat(NOTE_EMPHASIS_TEXT_LIMITS.label.chars),
        description: emoji.repeat(NOTE_EMPHASIS_TEXT_LIMITS.description.chars),
        palette: "teal",
        passages:
          emphasisIndex * MAX_NOTE_EMPHASIS_GROUPS + groupIndex < 4
            ? Array.from({ length: MAX_NOTE_EMPHASIS_PASSAGES_PER_GROUP }, () => passage)
            : [],
      })),
    })),
  };
  expect(validateNoteEmphasisSnapshot(worstCase)).toMatchObject({ ok: true });
  expect(Buffer.byteLength(`${JSON.stringify(worstCase, null, 2)}\n`)).toBeLessThanOrEqual(
    MAX_NOTE_EMPHASIS_FILE_BYTES,
  );
});

test("the store accepts eight named sets and 256 total passages, then refuses either next mutation", () => {
  const source = Array.from(
    { length: MAX_NOTE_EMPHASIS_PASSAGES + 1 },
    (_, index) => `passage-${index.toString().padStart(3, "0")}`,
  ).join("\n\n");
  const text = renderedNoteText(source);
  const anchors = Array.from({ length: MAX_NOTE_EMPHASIS_PASSAGES + 1 }, (_, index) => {
    const quote = `passage-${index.toString().padStart(3, "0")}`;
    const at = text.indexOf(quote);
    return passageAnchor(text, at, at + quote.length);
  });
  const root = tempDir({ ".archer/note.md": source, ".archer/other.md": "only" });
  const project = findProject(root);
  const named = new NoteEmphasisStore(project);
  let revision = 0;
  for (let index = 0; index < MAX_NOTE_EMPHASES; index++) {
    revision = named.upsert(
      { notePath: "other.md", id: `e${index}`, expectedRevision: revision, groups: [group("only", "only")] },
      "agent",
    ).snapshot.revision;
  }
  refusal(
    () =>
      named.upsert(
        { notePath: "other.md", id: "ninth", expectedRevision: revision, groups: [group("only", "only")] },
        "agent",
      ),
    "invalid_note_emphasis",
  );

  const total = new NoteEmphasisStore(project);
  const groups = Array.from({ length: 4 }, (_, groupIndex) => ({
    id: `g${groupIndex}`,
    label: `Group ${groupIndex}`,
    passages: anchors.slice(
      groupIndex * MAX_NOTE_EMPHASIS_PASSAGES_PER_GROUP,
      (groupIndex + 1) * MAX_NOTE_EMPHASIS_PASSAGES_PER_GROUP,
    ),
  }));
  const [head, tail] = twoSets(groups);
  total.upsert({ notePath: "note.md", id: "all", expectedRevision: 0, groups: [...head] }, "agent");
  const full = total.upsert({ notePath: "note.md", id: "rest", expectedRevision: 1, groups: [...tail] }, "agent");
  expect(full.snapshot.emphases.flatMap((entry) => entry.groups.flatMap((held) => held.passages))).toHaveLength(
    MAX_NOTE_EMPHASIS_PASSAGES,
  );
  refusal(
    () =>
      total.upsert(
        {
          notePath: "note.md",
          id: "one-more",
          expectedRevision: 2,
          groups: [{ id: "extra", label: "Extra", passages: [anchors[MAX_NOTE_EMPHASIS_PASSAGES]!] }],
        },
        "agent",
      ),
    "invalid_note_emphasis",
  );
});

test("missing notes and malformed, colliding, linked, nonregular and oversized sidecars are refused without overwrite", () => {
  const root = tempDir({ ".archer/note.md": "A live passage." });
  const project = findProject(root);
  const store = new NoteEmphasisStore(project);
  refusal(() => store.read("missing.md"), "note_not_found");
  refusal(
    () => store.upsert({ notePath: "missing.md", id: "x", expectedRevision: 0, groups: [] }, "agent"),
    "note_not_found",
  );
  expect(existsSync(`${root}/.archer/.missing.md.emphases.json.writers`)).toBe(false); // claims are never in the repo

  const realNote = write(root, ".archer/real.md", "Real note");
  symlinkSync(realNote, `${root}/.archer/linked.md`);
  refusal(() => store.read("linked.md"), "note_not_found");

  const path = `${root}/.archer/note.md.emphases.json`;
  for (const [name, value, code] of [
    ["malformed", "{", "malformed_note_emphasis_file"],
    [
      "collision",
      JSON.stringify({ schemaVersion: 1, notePath: "other.md", revision: 2, emphases: [] }),
      "note_emphasis_file_conflict",
    ],
  ] as const) {
    writeFileSync(path, value);
    refusal(() => store.upsert({ notePath: "note.md", id: "x", expectedRevision: 0, groups: [] }, "agent"), code);
    expect(readFileSync(path, "utf8"), name).toBe(value);
  }
  writeFileSync(path, "x".repeat(MAX_NOTE_EMPHASIS_FILE_BYTES + 1));
  refusal(() => store.read("note.md"), "note_emphasis_file_too_large");

  writeFileSync(path, "sentinel");
  const victim = write(root, ".archer/victim", "victim");
  writeFileSync(path, "sentinel");
  // Replace the sidecar with a link and verify its target is neither read as JSON nor changed.
  unlinkSync(path);
  symlinkSync(victim, path);
  refusal(() => store.read("note.md"), "malformed_note_emphasis_file");
  expect(readFileSync(victim, "utf8")).toBe("victim");

  unlinkSync(path);
  mkdirSync(path);
  refusal(() => store.read("note.md"), "malformed_note_emphasis_file");
});
