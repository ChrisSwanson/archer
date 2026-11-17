import { expect, test } from "vitest";
import { editSequence, encodeSequenceText } from "../../src/authoring/sequence-edit.ts";
import { editDiagram, type DiagramEdit } from "../../src/authoring/diagram-edit.ts";
import { parseAuthoringPreview } from "../../src/authoring/preview.ts";
import { compile } from "../../src/mermaid/index.ts";
import type { FragmentEvent, MessageEvent, SequenceEvent, SequenceTrace } from "../../src/model/index.ts";

// Lines of the base diagram; `api` is declared below its first use and `db` last, unused.
const B = [
  "%% 🐦 keep",
  "sequenceDiagram",
  "    actor user as End user",
  "    participant web as Web app",
  "    user->>web: open",
  "    participant api",
  "    web->>+api: GET /x",
  "    Note over web,api: TLS",
  "    loop retry",
  "        api-->>web: 200",
  "        web-)api: ack",
  "    end",
  "    api-->>-web: done",
  "    participant db as Store",
] as const;
const [comment, header, user, web, open, api, get, note, loop, ok200, ack, end, done, db] = B;

async function model(source: string): Promise<SequenceTrace> {
  const result = await compile(source);
  if (result.model?.type !== "sequence-trace") throw new Error(JSON.stringify(result.diagnostics));
  return result.model;
}
/** The pre-order renumbering the compiler applies, for writing expected models. */
function renumber(m: SequenceTrace): SequenceTrace {
  const c = { msg: 0, note: 0, frag: 0 };
  const walk = (events: SequenceEvent[]): SequenceEvent[] =>
    events.map((e) =>
      e.type === "message"
        ? { ...e, id: `msg-${c.msg++}` }
        : e.type === "note"
          ? { ...e, id: `note-${c.note++}` }
          : e.type === "fragment"
            ? (() => {
                const id = `frag-${c.frag++}`;
                return { ...e, id, sections: e.sections.map((s) => ({ ...s, events: walk(s.events) })) };
              })()
            : e,
    );
  return { ...m, events: walk(m.events) };
}
const order = (m: SequenceTrace, ids: string[]) => ({
  ...m,
  participants: ids.map((id) => m.participants.find((p) => p.id === id)!),
});
const loopEvents = (m: SequenceTrace) =>
  (m.events.find((e) => e.type === "fragment") as FragmentEvent).sections[0]!.events;
const withLoop = (m: SequenceTrace, events: SequenceEvent[]): SequenceTrace => ({
  ...m,
  events: m.events.map((e) => (e.type === "fragment" ? { ...e, sections: [{ ...e.sections[0]!, events }] } : e)),
});
const message = (m: SequenceTrace, id: string) => {
  const all: SequenceEvent[] = [];
  const walk = (es: SequenceEvent[]) =>
    es.forEach((e) => {
      all.push(e);
      if (e.type === "fragment") e.sections.forEach((s) => walk(s.events));
    });
  walk(m.events);
  return all.find((e) => e.type === "message" && e.id === id) as MessageEvent;
};
const mapMessage = (m: SequenceTrace, id: string, f: (e: MessageEvent) => MessageEvent): SequenceTrace => {
  const walk = (es: SequenceEvent[]): SequenceEvent[] =>
    es.map((e) =>
      e.type === "message" && e.id === id
        ? f(e)
        : e.type === "fragment"
          ? { ...e, sections: e.sections.map((s) => ({ ...s, events: walk(s.events) })) }
          : e,
    );
  return { ...m, events: walk(m.events) };
};

type Case = { name: string; edit: DiagramEdit; lines: string[]; effect: (m: SequenceTrace) => SequenceTrace };
const cases: Case[] = [
  // move-node: every direction, onto first and last, and null.
  {
    name: "move-node last to first",
    edit: { kind: "move-node", id: "db", before: "user" },
    lines: [comment, header, db, user, web, open, api, get, note, loop, ok200, ack, end, done],
    effect: (m) => order(m, ["db", "user", "web", "api"]),
  },
  {
    name: "move-node first to last (null)",
    edit: { kind: "move-node", id: "user", before: null },
    lines: [comment, header, web, open, api, get, note, loop, ok200, ack, end, done, db, user],
    effect: (m) => order(m, ["web", "api", "db", "user"]),
  },
  {
    name: "move-node a declaration below first use, left",
    edit: { kind: "move-node", id: "api", before: "web" },
    lines: [comment, header, user, api, web, open, get, note, loop, ok200, ack, end, done, db],
    effect: (m) => order(m, ["user", "api", "web", "db"]),
  },
  {
    name: "move-node right, below its uses",
    edit: { kind: "move-node", id: "web", before: "db" },
    lines: [comment, header, user, open, api, get, note, loop, ok200, ack, end, done, web, db],
    effect: (m) => order(m, ["user", "api", "web", "db"]),
  },
  {
    name: "move-node one step right",
    edit: { kind: "move-node", id: "user", before: "api" },
    lines: [comment, header, web, open, user, api, get, note, loop, ok200, ack, end, done, db],
    effect: (m) => order(m, ["web", "user", "api", "db"]),
  },
  // participants
  {
    name: "relabel-node replaces an alias, coding ; and #",
    edit: { kind: "relabel-node", id: "web", label: "Web; #1" },
    lines: [
      comment,
      header,
      user,
      "    participant web as Web#59; #35;1",
      open,
      api,
      get,
      note,
      loop,
      ok200,
      ack,
      end,
      done,
      db,
    ],
    effect: (m) => ({
      ...m,
      participants: m.participants.map((p) => (p.id === "web" ? { ...p, label: "Web; #1" } : p)),
    }),
  },
  {
    name: "relabel-node adds an alias",
    edit: { kind: "relabel-node", id: "api", label: "API Gateway" },
    lines: [
      comment,
      header,
      user,
      web,
      open,
      "    participant api as API Gateway",
      get,
      note,
      loop,
      ok200,
      ack,
      end,
      done,
      db,
    ],
    effect: (m) => ({
      ...m,
      participants: m.participants.map((p) => (p.id === "api" ? { ...p, label: "API Gateway" } : p)),
    }),
  },
  {
    name: "relabel-node with an empty label removes the alias",
    edit: { kind: "relabel-node", id: "user", label: "" },
    lines: [comment, header, "    actor user", web, open, api, get, note, loop, ok200, ack, end, done, db],
    effect: (m) => ({ ...m, participants: m.participants.map((p) => (p.id === "user" ? { ...p, label: "user" } : p)) }),
  },
  {
    name: "relabel-node to the ID removes the alias",
    edit: { kind: "relabel-node", id: "db", label: "db" },
    lines: [comment, header, user, web, open, api, get, note, loop, ok200, ack, end, done, "    participant db"],
    effect: (m) => ({ ...m, participants: m.participants.map((p) => (p.id === "db" ? { ...p, label: "db" } : p)) }),
  },
  {
    name: "add-node actor after the last declaration",
    edit: { kind: "add-node", id: "cache", label: 'Cache "hot"', participant: "actor" },
    lines: [...B, "    actor cache as Cache #quot;hot#quot;"],
    effect: (m) => ({ ...m, participants: [...m.participants, { id: "cache", label: 'Cache "hot"', kind: "actor" }] }),
  },
  {
    name: "add-node without a label",
    edit: { kind: "add-node", id: "cache", label: "" },
    lines: [...B, "    participant cache"],
    effect: (m) => ({ ...m, participants: [...m.participants, { id: "cache", label: "cache" }] }),
  },
  {
    name: "delete-node an unused participant",
    edit: { kind: "delete-node", id: "db" },
    lines: B.slice(0, -1),
    effect: (m) => ({ ...m, participants: m.participants.filter((p) => p.id !== "db") }),
  },
  // messages
  {
    name: "connect appends at the end of the top level",
    edit: { kind: "connect", source: "db", target: "api", label: "q", message: "async" },
    lines: [...B, "    db-)api: q"],
    effect: (m) => ({
      ...m,
      events: [...m.events, { type: "message", id: "msg-5", from: "db", to: "api", kind: "async", label: "q" }],
    }),
  },
  {
    name: "connect as the first message",
    edit: { kind: "connect", source: "web", target: "user", label: "hello", after: null, message: "reply" },
    lines: [
      comment,
      header,
      user,
      web,
      "    web-->>user: hello",
      open,
      api,
      get,
      note,
      loop,
      ok200,
      ack,
      end,
      done,
      db,
    ],
    effect: (m) =>
      renumber({
        ...m,
        events: [{ type: "message", id: "x", from: "web", to: "user", kind: "reply", label: "hello" }, ...m.events],
      }),
  },
  {
    name: "connect after a message inside a fragment, unlabelled, self",
    edit: { kind: "connect", source: "api", target: "api", after: "msg-2" },
    lines: [comment, header, user, web, open, api, get, note, loop, ok200, "        api->>api:", ack, end, done, db],
    effect: (m) =>
      renumber(
        withLoop(m, [
          loopEvents(m)[0]!,
          { type: "message", id: "x", from: "api", to: "api", kind: "sync" },
          loopEvents(m)[1]!,
        ]),
      ),
  },
  {
    name: "connect after a message with + lands after its activation",
    edit: { kind: "connect", source: "api", target: "db", label: "read", after: "msg-1" },
    lines: [comment, header, user, web, open, api, get, "    api->>db: read", note, loop, ok200, ack, end, done, db],
    effect: (m) =>
      renumber({
        ...m,
        events: [
          ...m.events.slice(0, 3),
          { type: "message", id: "x", from: "api", to: "db", kind: "sync", label: "read" },
          ...m.events.slice(3),
        ],
      }),
  },
  {
    name: "relabel-edge",
    edit: { kind: "relabel-edge", id: "msg-2", label: "wrap:OK" },
    lines: [
      comment,
      header,
      user,
      web,
      open,
      api,
      get,
      note,
      loop,
      "        api-->>web: wrap#58;OK",
      ack,
      end,
      done,
      db,
    ],
    effect: (m) => mapMessage(m, "msg-2", (e) => ({ ...e, label: "wrap:OK" })),
  },
  {
    name: "relabel-edge to empty removes the text",
    edit: { kind: "relabel-edge", id: "msg-0", label: "" },
    lines: [comment, header, user, web, "    user->>web:", api, get, note, loop, ok200, ack, end, done, db],
    effect: (m) => mapMessage(m, "msg-0", ({ label: _l, ...e }) => e),
  },
  {
    name: "delete-edge renumbers later messages",
    edit: { kind: "delete-edge", id: "msg-0" },
    lines: [comment, header, user, web, api, get, note, loop, ok200, ack, end, done, db],
    effect: (m) => renumber({ ...m, events: m.events.slice(1) }),
  },
  {
    name: "retarget-edge reverses and changes the arrow",
    edit: { kind: "retarget-edge", id: "msg-0", source: "web", target: "user", message: "async" },
    lines: [comment, header, user, web, "    web-)user: open", api, get, note, loop, ok200, ack, end, done, db],
    effect: (m) => mapMessage(m, "msg-0", (e) => ({ ...e, from: "web", to: "user", kind: "async" })),
  },
  {
    name: "retarget-edge changes only the arrow of a + message",
    edit: { kind: "retarget-edge", id: "msg-1", message: "reply" },
    lines: [comment, header, user, web, open, api, "    web-->>+api: GET /x", note, loop, ok200, ack, end, done, db],
    effect: (m) => mapMessage(m, "msg-1", (e) => ({ ...e, kind: "reply" })),
  },
  {
    name: "move-edge up within a fragment",
    edit: { kind: "move-edge", id: "msg-3", before: "msg-2" },
    lines: [comment, header, user, web, open, api, get, note, loop, ack, ok200, end, done, db],
    effect: (m) => renumber(withLoop(m, [loopEvents(m)[1]!, loopEvents(m)[0]!])),
  },
  {
    name: "move-edge to the end of its block (null)",
    edit: { kind: "move-edge", id: "msg-2", before: null },
    lines: [comment, header, user, web, open, api, get, note, loop, ack, ok200, end, done, db],
    effect: (m) => renumber(withLoop(m, [loopEvents(m)[1]!, loopEvents(m)[0]!])),
  },
  // notes
  {
    name: "add-note after a message",
    edit: { kind: "add-note", participants: ["user"], position: "left of", text: "100 %% sure", after: "msg-2" },
    lines: [
      comment,
      header,
      user,
      web,
      open,
      api,
      get,
      note,
      loop,
      ok200,
      "        Note left of user: 100 #37;#37; sure",
      ack,
      end,
      done,
      db,
    ],
    effect: (m) =>
      renumber(
        withLoop(m, [
          loopEvents(m)[0]!,
          { type: "note", id: "x", position: "left-of", participants: ["user"], text: "100 %% sure" },
          loopEvents(m)[1]!,
        ]),
      ),
  },
  {
    name: "add-note over two at the end",
    edit: { kind: "add-note", participants: ["web", "db"], position: "over", text: "sync" },
    lines: [...B, "    Note over web,db: sync"],
    effect: (m) => ({
      ...m,
      events: [
        ...m.events,
        { type: "note", id: "note-1", position: "over", participants: ["web", "db"], text: "sync" },
      ],
    }),
  },
  {
    name: "relabel-note",
    edit: { kind: "relabel-note", id: "note-0", text: "mTLS" },
    lines: [comment, header, user, web, open, api, get, "    Note over web,api: mTLS", loop, ok200, ack, end, done, db],
    effect: (m) => ({ ...m, events: m.events.map((e) => (e.type === "note" ? { ...e, text: "mTLS" } : e)) }),
  },
  {
    name: "delete-note",
    edit: { kind: "delete-note", id: "note-0" },
    lines: [comment, header, user, web, open, api, get, loop, ok200, ack, end, done, db],
    effect: (m) => ({ ...m, events: m.events.filter((e) => e.type !== "note") }),
  },
  // fragments
  {
    name: "wrap-edges inside a fragment re-indents by the file unit",
    edit: { kind: "wrap-edges", ids: ["msg-3", "msg-2"], fragment: "opt", label: "maybe" },
    lines: [
      comment,
      header,
      user,
      web,
      open,
      api,
      get,
      note,
      loop,
      "        opt maybe",
      "    " + ok200,
      "    " + ack,
      "        end",
      end,
      done,
      db,
    ],
    effect: (m) =>
      renumber(
        withLoop(m, [
          {
            type: "fragment",
            id: "x",
            kind: "opt",
            label: "maybe",
            sections: [{ label: "maybe", events: loopEvents(m) }],
          },
        ]),
      ),
  },
  {
    name: "unwrap-fragment dedents its lines",
    edit: { kind: "unwrap-fragment", id: "frag-0" },
    lines: [comment, header, user, web, open, api, get, note, "    api-->>web: 200", "    web-)api: ack", done, db],
    effect: (m) => ({ ...m, events: m.events.flatMap((e) => (e.type === "fragment" ? e.sections[0]!.events : [e])) }),
  },
];

for (const newline of ["\n", "\r\n"]) {
  for (const c of cases) {
    test(`${c.name} (${JSON.stringify(newline)})`, async () => {
      const source = B.join(newline) + newline;
      const result = await editSequence(source, c.edit);
      expect(result).toEqual({ ok: true, source: c.lines.join(newline) + newline });
      expect(await model(result.source)).toEqual(c.effect(await model(source)));
      expect(await editDiagram(source, c.edit)).toEqual(result);
    });
  }
}

test("without a final line break, moving the last line keeps the file unterminated", async () => {
  const source = B.join("\n");
  expect(await editSequence(source, { kind: "move-node", id: "db", before: "web" })).toEqual({
    ok: true,
    source: [comment, header, user, db, web, open, api, get, note, loop, ok200, ack, end, done].join("\n"),
  });
  expect(await editSequence(source, { kind: "move-node", id: "user", before: null })).toEqual({
    ok: true,
    source: [comment, header, web, open, api, get, note, loop, ok200, ack, end, done, db, user].join("\n"),
  });
  expect(await editSequence(source, { kind: "add-node", id: "q", label: "Queue" })).toEqual({
    ok: true,
    source: `${source}\n    participant q as Queue`,
  });
  expect(await editSequence(source, { kind: "connect", source: "db", target: "web", label: "x" })).toEqual({
    ok: true,
    source: `${source}\n    db->>web: x`,
  });
});

test("wrap-edges with notes and activations between, and the + message last", async () => {
  const source = [
    "sequenceDiagram",
    "  participant a",
    "  participant b",
    "  a->>b: one",
    "  activate b",
    "  Note over b: busy",
    "  b->>+a: two",
    "  a->>b: three",
    "",
  ].join("\n");
  const result = await editSequence(source, {
    kind: "wrap-edges",
    ids: ["msg-0", "msg-1"],
    fragment: "critical" as "loop",
    label: "x",
  });
  expect(result).toMatchObject({ ok: false, code: "edit_invalid_fragment" });
  const wrapped = await editSequence(source, {
    kind: "wrap-edges",
    ids: ["msg-1", "msg-0"],
    fragment: "alt",
    label: "ok",
  });
  expect(wrapped).toEqual({
    ok: true,
    source: [
      "sequenceDiagram",
      "  participant a",
      "  participant b",
      "  alt ok",
      "    a->>b: one",
      "    activate b",
      "    Note over b: busy",
      "    b->>+a: two",
      "  end",
      "  a->>b: three",
      "",
    ].join("\n"),
  });
  const before = await model(source);
  expect(await model(wrapped.source)).toEqual(
    renumber({
      ...before,
      events: [
        {
          type: "fragment",
          id: "x",
          kind: "alt",
          label: "ok",
          sections: [{ label: "ok", events: before.events.slice(0, 5) }],
        },
        before.events[5]!,
      ],
    }),
  );
});

test("no-op edits return the source unchanged", async () => {
  const source = B.join("\n");
  for (const edit of [
    { kind: "move-node", id: "user", before: "web" },
    { kind: "move-node", id: "db", before: null },
    { kind: "relabel-node", id: "web", label: "Web app" },
    { kind: "relabel-node", id: "api", label: "" },
    { kind: "relabel-edge", id: "msg-0", label: "open" },
    { kind: "relabel-note", id: "note-0", text: "TLS" },
    { kind: "retarget-edge", id: "msg-0", source: "user", message: "sync" },
    { kind: "move-edge", id: "msg-2", before: "msg-3" },
    { kind: "move-edge", id: "msg-3", before: null },
  ] as DiagramEdit[])
    expect(await editSequence(source, edit)).toEqual({ ok: true, source });
});

test("refusals are named", async () => {
  const source = B.join("\n");
  const refusals: [DiagramEdit, string][] = [
    [{ kind: "move-node", id: "nope", before: "web" }, "edit_target_missing"],
    [{ kind: "move-node", id: "web", before: "nope" }, "edit_target_missing"],
    [{ kind: "add-node", id: "web", label: "" }, "edit_id_exists"],
    [{ kind: "add-node", id: "End", label: "" }, "edit_id_reserved"],
    [{ kind: "add-node", id: "accTitle", label: "" }, "edit_id_reserved"],
    [{ kind: "add-node", id: "a-x", label: "" }, "edit_invalid_id"],
    [{ kind: "add-node", id: "q", label: " padded" }, "edit_invalid_label"],
    [{ kind: "add-node", id: "q", label: "a<br>b" }, "edit_invalid_label"],
    [{ kind: "add-node", id: "q", label: "", shape: "rounded" }, "edit_unsupported_for_family"],
    [{ kind: "relabel-node", id: "nope", label: "x" }, "edit_target_missing"],
    [{ kind: "delete-node", id: "api" }, "edit_delete_referenced_node"],
    [{ kind: "delete-node", id: "user" }, "edit_delete_referenced_node"],
    [{ kind: "connect", source: "user", target: "nope", label: "x" }, "edit_target_missing"],
    [{ kind: "connect", source: "user", target: "web", label: "x", after: "msg-9" }, "edit_target_missing"],
    [{ kind: "connect", id: "msg-0", source: "user", target: "web", label: "x" }, "edit_relationship_id_derived"],
    [{ kind: "connect", source: "user", target: "web", label: "x", line: "dotted" }, "edit_unsupported_for_family"],
    [{ kind: "relabel-edge", id: "msg-9", label: "x" }, "edit_target_missing"],
    [{ kind: "delete-edge", id: "msg-1" }, "edit_activation_dependency"],
    [{ kind: "retarget-edge", id: "msg-1", target: "db" }, "edit_activation_dependency"],
    [{ kind: "retarget-edge", id: "msg-0", target: "nope" }, "edit_target_missing"],
    [{ kind: "move-edge", id: "msg-0", before: "msg-2" }, "edit_move_cross_block"],
    [{ kind: "move-edge", id: "msg-1", before: "msg-0" }, "edit_activation_dependency"],
    [{ kind: "move-edge", id: "msg-0", before: null }, "edit_activation_dependency"],
    [{ kind: "add-note", participants: ["web", "api"], position: "left of", text: "x" }, "edit_invalid_note"],
    [{ kind: "add-note", participants: ["web", "web"], position: "over", text: "x" }, "edit_invalid_note"],
    [{ kind: "add-note", participants: ["web"], position: "over", text: "" }, "edit_label_required"],
    [{ kind: "relabel-note", id: "note-0", text: "" }, "edit_label_required"],
    [{ kind: "delete-note", id: "note-5" }, "edit_target_missing"],
    [{ kind: "wrap-edges", ids: ["msg-0", "msg-2"], fragment: "opt", label: "x" }, "edit_wrap_cross_block"],
    [{ kind: "wrap-edges", ids: ["msg-0", "msg-1"], fragment: "opt", label: "x" }, "edit_wrap_spans_declaration"],
    [{ kind: "wrap-edges", ids: ["msg-1", "msg-4"], fragment: "opt", label: "x" }, "edit_wrap_not_consecutive"],
    [{ kind: "wrap-edges", ids: ["msg-4"], fragment: "break" as "loop", label: "x" }, "edit_invalid_fragment"],
    [{ kind: "wrap-edges", ids: ["msg-4"], fragment: "opt", label: "" }, "edit_label_required"],
    [{ kind: "unwrap-fragment", id: "frag-3" }, "edit_target_missing"],
    [{ kind: "change-shape", id: "web", shape: "rounded" }, "edit_unsupported_for_family"],
    [{ kind: "direction", direction: "lr" }, "edit_unsupported_for_family"],
  ];
  for (const [edit, code] of refusals)
    expect(await editSequence(source, edit), JSON.stringify(edit)).toEqual({ ok: false, source, code });
});

test("declarations inside fragments do not move; unwrap refuses alt with else", async () => {
  const source = [
    "sequenceDiagram",
    "    participant a",
    "    alt yes",
    "        participant b",
    "        a->>b: x",
    "    else no",
    "        b->>a: y",
    "    end",
    "    participant c",
    "",
  ].join("\n");
  expect(await editSequence(source, { kind: "move-node", id: "b", before: "a" })).toMatchObject({
    ok: false,
    code: "edit_move_in_fragment",
  });
  expect(await editSequence(source, { kind: "move-node", id: "c", before: "b" })).toMatchObject({
    ok: false,
    code: "edit_move_in_fragment",
  });
  expect(await editSequence(source, { kind: "move-node", id: "c", before: "a" })).toEqual({
    ok: true,
    source: [
      "sequenceDiagram",
      "    participant c",
      "    participant a",
      "    alt yes",
      "        participant b",
      "        a->>b: x",
      "    else no",
      "        b->>a: y",
      "    end",
      "",
    ].join("\n"),
  });
  expect(await editSequence(source, { kind: "unwrap-fragment", id: "frag-0" })).toMatchObject({
    ok: false,
    code: "edit_unwrap_sections",
  });
  expect(await editSequence(source, { kind: "move-edge", id: "msg-1", before: "msg-0" })).toMatchObject({
    ok: false,
    code: "edit_move_cross_block",
  });
});

test("box, create and destroy are outside the profile, so nothing is edited", async () => {
  for (const source of [
    "sequenceDiagram\n    box Blue\n    participant a\n    end\n    participant b\n    a->>b: x\n",
    "sequenceDiagram\n    participant a\n    create participant b\n    a->>b: x\n",
    "sequenceDiagram\n    participant a\n    participant b\n    a->>b: x\n    destroy b\n",
  ])
    expect(await editSequence(source, { kind: "move-node", id: "b", before: "a" })).toMatchObject({
      ok: false,
      source,
      code: "edit_requires_valid_sequence",
    });
});

test("a header-only diagram takes its first participant and message", async () => {
  const first = await editSequence("sequenceDiagram\n", { kind: "add-node", id: "a", label: "Alpha" });
  expect(first).toEqual({ ok: true, source: "sequenceDiagram\n    participant a as Alpha\n" });
  const second = await editSequence(first.source, {
    kind: "connect",
    source: "a",
    target: "a",
    label: "self",
    after: null,
  });
  expect(second).toEqual({ ok: true, source: "sequenceDiagram\n    participant a as Alpha\n    a->>a: self\n" });
});

test("the text codec round-trips through the compiler in every text position", async () => {
  const labels = [
    "a;b",
    "a#b",
    "#59;",
    "#quot;",
    '"quoted"',
    '"lead',
    'trail"',
    "100 %% pure",
    "%%%",
    "x as y",
    "q: r",
    "wrap:x",
    "nowrap: y",
    "Wrap:x",
    "->> b",
    "+x",
    "-x",
    "a,b",
    "end",
    "note",
    "&amp;",
    "émoji 🐦",
    "x:::y",
    "{braces}",
  ];
  for (const label of labels) {
    const encoded = encodeSequenceText(label);
    const source = [
      "sequenceDiagram",
      `    participant a as ${encoded}`,
      "    participant b",
      `    a->>b: ${encoded}`,
      `    Note over a: ${encoded}`,
      `    loop ${encoded}`,
      `        b-->>a: x`,
      "    end",
      "",
    ].join("\n");
    const m = await model(source);
    expect(m.participants[0]!.label, label).toBe(label);
    expect((m.events[0] as MessageEvent).label, label).toBe(label);
    expect(m.events[1], label).toMatchObject({ type: "note", text: label });
    expect(m.events[2], label).toMatchObject({ type: "fragment", label });
    const relabelled = await editSequence("sequenceDiagram\n    participant a\n    participant b\n    a->>b: x\n", {
      kind: "relabel-edge",
      id: "msg-0",
      label,
    });
    expect(relabelled.ok, label).toBe(true);
  }
});

test("other families refuse the sequence operations and parameters", async () => {
  const flowchart = "flowchart LR\n    a[A]\n    b[B]\n";
  const state = "stateDiagram-v2\n    state A\n    A --> B\n";
  for (const source of [flowchart, state]) {
    for (const edit of [
      { kind: "move-node", id: "a", before: null },
      { kind: "move-edge", id: "e", before: null },
      { kind: "retarget-edge", id: "e", target: "b", message: "sync" },
      { kind: "add-note", participants: ["a"], position: "over", text: "x" },
      { kind: "relabel-note", id: "n", text: "x" },
      { kind: "delete-note", id: "n" },
      { kind: "wrap-edges", ids: ["e"], fragment: "loop", label: "x" },
      { kind: "unwrap-fragment", id: "f" },
      { kind: "add-node", id: "c", label: "C", participant: "actor" },
      { kind: "connect", id: "e", source: "a", target: "b", message: "sync" },
      { kind: "connect", id: "e", source: "a", target: "b", after: null },
    ] as DiagramEdit[])
      expect(await editDiagram(source, edit), JSON.stringify(edit)).toEqual({
        ok: false,
        source,
        code: "edit_unsupported_for_family",
      });
  }
});

test("preview input takes the sequence operations with closed fields", () => {
  const source = "sequenceDiagram\n";
  const accepted: unknown[] = [
    { kind: "move-node", id: "a", before: null },
    { kind: "move-node", id: "a", before: "b" },
    { kind: "move-edge", id: "msg-0", before: "msg-1" },
    { kind: "add-node", id: "a", label: "", participant: "actor" },
    { kind: "connect", source: "a", target: "b", label: "x", message: "reply", after: null },
    { kind: "connect", source: "a", target: "b", after: "msg-2" },
    { kind: "retarget-edge", id: "msg-0", source: "b", message: "async" },
    { kind: "add-note", participants: ["a", "b"], position: "over", text: "x", after: "msg-0" },
    { kind: "relabel-note", id: "note-0", text: "x" },
    { kind: "delete-note", id: "note-0" },
    { kind: "wrap-edges", ids: ["msg-0", "msg-1"], fragment: "par", label: "x" },
    { kind: "unwrap-fragment", id: "frag-0" },
  ];
  for (const edit of accepted)
    expect(parseAuthoringPreview({ source, edit }, true), JSON.stringify(edit)).toEqual({ source, edit });
  const refused: unknown[] = [
    { kind: "move-node", id: "a" },
    { kind: "move-node", id: "a", before: 3 },
    { kind: "move-node", id: "a", before: "b c" },
    { kind: "move-node", id: "a", before: null, label: "x" },
    { kind: "add-node", id: "a", label: "", participant: "boundary" },
    { kind: "connect", source: "a", target: "b", message: "sync2" },
    { kind: "connect", source: "a", target: "b", after: "x y" },
    { kind: "retarget-edge", id: "msg-0", label: "x" },
    { kind: "add-note", participants: [], position: "over", text: "x" },
    { kind: "add-note", participants: ["a", "b", "c"], position: "over", text: "x" },
    { kind: "add-note", participants: ["a"], position: "above", text: "x" },
    { kind: "add-note", participants: ["a"], position: "over" },
    { kind: "relabel-note", id: "note-0", label: "x" },
    { kind: "wrap-edges", ids: "msg-0", fragment: "loop", label: "x" },
    { kind: "wrap-edges", ids: ["msg-0"], fragment: "rect", label: "x" },
    { kind: "wrap-edges", ids: ["msg-0"], fragment: "loop" },
    { kind: "unwrap-fragment", id: "frag-0", label: "x" },
  ];
  for (const edit of refused)
    expect(() => parseAuthoringPreview({ source, edit }, true), JSON.stringify(edit)).toThrow();
  expect(() =>
    parseAuthoringPreview({ source, edit: { kind: "relabel-note", id: "note-0", text: "a\rb" } }, true),
  ).toThrow(/control characters/u);
  expect(
    parseAuthoringPreview({ source, edit: { kind: "relabel-note", id: "note-0", text: "a\nb" } }, true).edit,
  ).toEqual({ kind: "relabel-note", id: "note-0", text: "a\nb" });
});

test("message IDs are ordinals that the compiler and the editor agree on", async () => {
  const source = B.join("\n");
  expect(message(await model(source), "msg-4")).toMatchObject({ from: "api", to: "web", label: "done" });
});

test("never throws: random edits on small mutations of the base are refused or compile", async () => {
  let seed = 7;
  const next = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const ids = ["user", "web", "api", "db", "msg-0", "msg-1", "msg-2", "msg-3", "msg-4", "note-0", "frag-0", null];
  const pick = () => ids[next(ids.length)] as string;
  const makers: (() => DiagramEdit)[] = [
    () => ({ kind: "move-node", id: pick() ?? "web", before: ids[next(ids.length)] as string | null }),
    () => ({ kind: "move-edge", id: pick() ?? "msg-0", before: ids[next(ids.length)] as string | null }),
    () =>
      next(3) === 0
        ? { kind: "connect", source: pick() ?? "web", target: pick() ?? "api", label: "x" }
        : {
            kind: "connect",
            source: pick() ?? "web",
            target: pick() ?? "api",
            label: "x",
            after: ids[next(ids.length)] as string | null,
          },
    () => ({ kind: "retarget-edge", id: pick() ?? "msg-0", source: pick() ?? "web", message: "reply" }),
    () => ({
      kind: "add-note",
      participants: [pick() ?? "web"],
      position: "over",
      text: "t",
      after: ids[next(ids.length)] as string | null,
    }),
    () => ({ kind: "wrap-edges", ids: [pick() ?? "msg-2", pick() ?? "msg-3"], fragment: "loop", label: "l" }),
    () => ({ kind: "unwrap-fragment", id: pick() ?? "frag-0" }),
    () => ({ kind: "delete-edge", id: pick() ?? "msg-0" }),
    () => ({ kind: "delete-node", id: pick() ?? "db" }),
  ];
  const started = Date.now();
  for (let i = 0; i < 150 && Date.now() - started < 8000; i += 1) {
    const lines: string[] = [...B];
    if (next(2)) lines.splice(2 + next(lines.length - 2), 1);
    const source = lines.join(next(2) ? "\n" : "\r\n");
    const edit = makers[next(makers.length)]!();
    const result = await editSequence(source, edit);
    if (result.ok && result.source !== source)
      expect((await compile(result.source)).model?.type, JSON.stringify(edit)).toBe("sequence-trace");
  }
}, 20000);
