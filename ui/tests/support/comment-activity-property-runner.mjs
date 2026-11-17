import { parseCommentActivity } from "../../src/app/comment-activity.ts";

let seed = 23;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const words = [
  "{",
  "}",
  "[",
  "]",
  ":",
  ",",
  "null",
  "schemaVersion",
  "targets",
  "totalThreads",
  "unresolvedThreads",
  "lastCommentedAt",
  "view:x",
  "note:n.md",
];
const valid = JSON.stringify({
  schemaVersion: 1,
  targets: { "view:x": { totalThreads: 1, unresolvedThreads: 1, lastCommentedAt: "2026-10-11T10:15:00.000Z" } },
});
const samples = [];
for (let round = 0; round < 150; round += 1) {
  samples.push(
    Array.from({ length: Math.floor(random() * 120) }, () => String.fromCharCode(Math.floor(random() * 65536))).join(
      "",
    ),
  );
  samples.push(
    Array.from({ length: Math.floor(random() * 30) }, () => words[Math.floor(random() * words.length)]).join(""),
  );
  const at = Math.floor(random() * valid.length);
  samples.push(valid.slice(0, at) + words[Math.floor(random() * words.length)] + valid.slice(at + 1));
}
for (const sample of samples) {
  let value = sample;
  try {
    value = JSON.parse(sample);
  } catch {
    /* arbitrary text stays text */
  }
  const parsed = parseCommentActivity(value);
  if (parsed !== null)
    for (const [target, activity] of parsed) {
      if (
        !/^(view|note):.+/.test(target) ||
        !Number.isSafeInteger(activity.totalThreads) ||
        activity.totalThreads < 0 ||
        !Number.isSafeInteger(activity.unresolvedThreads) ||
        activity.unresolvedThreads < 0 ||
        activity.unresolvedThreads > activity.totalThreads ||
        (activity.lastCommentedAt !== null && Number.isNaN(Date.parse(activity.lastCommentedAt)))
      ) {
        throw new Error("invalid parsed activity");
      }
    }
}
process.stdout.write("valid");
