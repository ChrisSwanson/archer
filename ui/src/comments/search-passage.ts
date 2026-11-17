/**
 * Where a search match is in a note on screen (J3-F1). The service's match text is an excerpt of the note's
 * Markdown around the first query word it holds (`excerpt`, ts/src/service/front-door.ts): whitespace folded, cut
 * at the edges with "…", Markdown marks kept. The page's text is the rendered note. So the excerpt is found by its
 * words (case and whitespace aside, Markdown punctuation dropped), the longest leading run of them that the page
 * holds, and the query's words are marked inside it. Pure: character offsets into `text`.
 */
type Range = { readonly start: number; readonly end: number };

/** `text` folded for matching (lower case, each whitespace run one space), with each folded char's offset in `text`. */
function fold(text: string): { folded: string; at: number[] } {
  let folded = "";
  const at: number[] = [];
  let space = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      space = folded.length > 0;
      continue;
    }
    if (space) {
      folded += " ";
      at.push(i);
      space = false;
    }
    folded += ch.toLowerCase();
    at.push(i);
  }
  return { folded, at };
}

const MARKDOWN = /[#*_>`[\]()]|\]\([^)]*\)/g;
/** Words of the excerpt, without its "…" ends, link targets or Markdown marks. */
function excerptWords(snippet: string): string[] {
  return snippet
    .replace(/^…|…$/g, "")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(MARKDOWN, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

export function locateSearchMatch(text: string, snippet: string, words: readonly string[]): Range[] | null {
  const { folded, at } = fold(text);
  const toRange = (from: number, length: number): Range => ({ start: at[from]!, end: at[from + length - 1]! + 1 });
  const quoted = excerptWords(snippet);
  // The longest leading run of the excerpt's words the page holds (at least two words, or all of a shorter one).
  let passage: { from: number; length: number } | null = null;
  for (let n = quoted.length; n >= Math.min(2, quoted.length) && n > 0 && passage === null; n--) {
    const run = quoted.slice(0, n).join(" ");
    const from = folded.indexOf(run);
    if (from >= 0) passage = { from, length: run.length };
  }
  const wanted = words.map((w) => w.toLowerCase()).filter(Boolean);
  if (passage !== null) {
    // The excerpt's run may stop before the word it was cut around: look a little past it too.
    const region = folded.slice(passage.from, passage.from + Math.max(passage.length, snippet.length + 40));
    const hits = wanted.flatMap((w) => {
      const i = region.indexOf(w);
      return i < 0 ? [] : [{ from: passage!.from + i, length: w.length }];
    });
    if (hits.length > 0) return hits.sort((a, b) => a.from - b.from).map((h) => toRange(h.from, h.length));
    if (wanted.length === 0) return [toRange(passage.from, passage.length)];
  }
  const first = wanted
    .map((w) => ({ from: folded.indexOf(w), length: w.length }))
    .filter((h) => h.from >= 0)
    .sort((a, b) => a.from - b.from)[0];
  return first === undefined ? null : [toRange(first.from, first.length)];
}
