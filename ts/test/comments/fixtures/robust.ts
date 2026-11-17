// Runs the new on-disk ticket and rendered-note boundaries on a small stack.
import { parseClaimTicket } from "../../../src/comments/lock.ts";
import { renderedNoteText } from "../../../src/comments/note-text.ts";
let seed = 918273;
const vocabulary = [
  "claim",
  "choosing",
  "1",
  "9999999999999999",
  "NaN",
  "__proto__",
  "# note\n",
  "**word**",
  "[API][api]\n\n[api]: https://example.com",
  "&amp;",
  "<script>x</script>",
  "- nested\n",
  "\u0000",
];
const valid = ["", "1", "200", "The client sends a token.", "Fish &amp; chips."];
for (let i = 0; i < 3000; i++) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const raw =
    i % 3 === 0
      ? String.fromCharCode(seed & 65535).repeat(i % 40)
      : i % 3 === 1
        ? vocabulary[i % vocabulary.length]!
        : valid[i % valid.length]! + String.fromCharCode(seed & 255);
  const ticket = parseClaimTicket(raw);
  if (ticket !== undefined && ticket !== null && (!Number.isSafeInteger(ticket) || ticket < 1))
    throw new Error("invalid accepted ticket");
  try {
    if (typeof renderedNoteText(raw) !== "string") throw new Error("invalid rendered note");
  } catch (error) {
    console.error("boundary input", i, JSON.stringify(raw));
    throw error;
  }
}
process.send?.({ completed: 3000 });
process.disconnect?.();
