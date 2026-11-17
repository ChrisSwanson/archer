import {
  MAX_NOTE_EMPHASES,
  MAX_NOTE_EMPHASIS_GROUPS,
  MAX_NOTE_EMPHASIS_PASSAGES,
  MAX_NOTE_EMPHASIS_PASSAGES_PER_GROUP,
  NOTE_EMPHASIS_PALETTES,
  validateNoteEmphasisSnapshot,
  validateNoteEmphasisUpsert,
} from "../../../../shared/note-emphasis.mts";

let state = 0x4e4f5445;
const random = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let value = state;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
};
const pick = (values) => values[Math.floor(random() * values.length)];
const words = [
  "schemaVersion",
  "notePath",
  "revision",
  "emphases",
  "id",
  "title",
  "author",
  "groups",
  "label",
  "description",
  "palette",
  "passages",
  "kind",
  "passage",
  "quote",
  "prefix",
  "suffix",
  "expectedRevision",
  "person",
  "agent",
  ...NOTE_EMPHASIS_PALETTES,
  "__proto__",
  "constructor",
  "",
  "x".repeat(1100),
  "📘",
  "\u0000",
];

function value(depth = 0) {
  const roll = random();
  if (depth >= 7 || roll < 0.32) return pick([null, true, false, 0, 1, -1, 1.5, pick(words)]);
  if (roll < 0.58) return Array.from({ length: Math.floor(random() * 7) }, () => value(depth + 1));
  const answer = Object.create(null);
  for (let left = Math.floor(random() * 9); left > 0; left--) answer[pick(words)] = value(depth + 1);
  return answer;
}

function mutate(input) {
  if (typeof input !== "object" || input === null) return value();
  const copy = Array.isArray(input) ? [...input] : { ...input };
  const keys = Object.keys(copy);
  const key = pick(keys);
  if (key === undefined) return value();
  copy[key] = random() < 0.6 ? value() : mutate(copy[key]);
  return copy;
}

const passage = { kind: "passage", quote: "signed token", prefix: "sends a ", suffix: " to" };
const validInput = {
  notePath: "notes/auth.md",
  id: "auth",
  title: "Authentication",
  expectedRevision: 0,
  groups: [{ id: "token", label: "Token", description: "Signed", passages: [passage] }],
};
const validSnapshot = {
  schemaVersion: 1,
  notePath: "notes/auth.md",
  revision: 1,
  emphases: [{ id: "auth", title: "Authentication", author: "agent", groups: validInput.groups }],
};
const inputs = [];
for (let index = 0; index < 1_500; index++) inputs.push(value());
for (let index = 0; index < 1_500; index++) inputs.push(mutate(index % 2 === 0 ? validInput : validSnapshot));
// Partial and very deep corrupt objects exercise rejection without recursive descent.
let deep = { quote: "q" };
for (let index = 0; index < 8_000; index++) deep = { next: deep };
inputs.push({ ...validSnapshot, unexpected: deep });
inputs.push({
  schemaVersion: 1,
  notePath: "notes/auth.md",
  revision: 0,
  emphases: [{ id: "x", author: "agent", groups: [{ id: "g", label: "G", palette: "teal", passages: [deep] }] }],
});

for (const raw of inputs) {
  const snapshot = validateNoteEmphasisSnapshot(raw);
  if (snapshot.ok) {
    if (snapshot.snapshot.emphases.length > MAX_NOTE_EMPHASES) throw new Error("accepted too many emphases");
    let total = 0;
    for (const emphasis of snapshot.snapshot.emphases) {
      if (emphasis.groups.length > MAX_NOTE_EMPHASIS_GROUPS) throw new Error("accepted too many groups");
      for (const group of emphasis.groups) {
        if (group.passages.length > MAX_NOTE_EMPHASIS_PASSAGES_PER_GROUP)
          throw new Error("accepted too many group passages");
        total += group.passages.length;
      }
    }
    if (total > MAX_NOTE_EMPHASIS_PASSAGES) throw new Error("accepted too many total passages");
  } else if (typeof snapshot.problem !== "string" || snapshot.problem.length === 0)
    throw new Error("empty snapshot refusal");
  const upsert = validateNoteEmphasisUpsert(raw);
  if (upsert.ok) {
    if (upsert.input.groups.length > MAX_NOTE_EMPHASIS_GROUPS) throw new Error("accepted too many request groups");
  } else if (typeof upsert.problem !== "string" || upsert.problem.length === 0)
    throw new Error("empty request refusal");
}

console.log(`refused or valid: ${inputs.length}`);
