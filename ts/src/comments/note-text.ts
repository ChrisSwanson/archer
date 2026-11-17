// Extract the same textContent the browser's inert Markdown fragment has.
// The shared renderer owns Markdown semantics/options; parse5 implements HTML
// parsing/entities, rather than another handwritten Markdown normalizer.
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { renderNoteMarkdown, renderNoteMarkdownWithLines } from "../../../shared/note-markdown.mts";

export function renderedNoteText(markdown: string): string {
  return textOf(renderNoteMarkdown(markdown));
}

const SOFT_BREAK_MARK = "\uE000";

/**
 * `renderedNoteText` with each soft line break (a newline inside a paragraph,
 * not a block edge or hard break) as a space instead: same length and offsets,
 * so a match found in it is the same range of the rendered text.
 */
export function renderedNoteFlow(markdown: string, text: string = renderedNoteText(markdown)): string {
  const marked = textOf(renderNoteMarkdown(markdown, { softBreak: SOFT_BREAK_MARK }));
  // The marker replaces one newline with one character; anything else means no soft break is known.
  if (marked.length !== text.length) return text;
  let flow = "";
  let from = 0;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) {
    if (marked[at] !== SOFT_BREAK_MARK) continue;
    flow += `${text.slice(from, at)} `;
    from = at + 1;
  }
  return flow + text.slice(from);
}

const LINE_MARK = "\uE001";
const LINE_MARK_END = "\uE002";

/**
 * Which source line of `markdown` each offset of its rendered text (`renderedNoteText`) was written on, as a
 * function from offset to 0-based line; null when the text cannot be traced (it already holds the private
 * marks used here, or the marked rendering does not reduce to the same text).
 */
export function renderedNoteLines(
  markdown: string,
  text: string = renderedNoteText(markdown),
): ((offset: number) => number | null) | null {
  if (markdown.includes(LINE_MARK) || markdown.includes(LINE_MARK_END)) return null;
  const marked = textOf(renderNoteMarkdownWithLines(markdown, (line) => `${LINE_MARK}${line}${LINE_MARK_END}`));
  const starts: number[] = [];
  const lines: number[] = [];
  let plain = "";
  let from = 0;
  for (let at = marked.indexOf(LINE_MARK); at !== -1; at = marked.indexOf(LINE_MARK, from)) {
    const close = marked.indexOf(LINE_MARK_END, at);
    if (close === -1) return null;
    plain += marked.slice(from, at);
    starts.push(plain.length);
    lines.push(Number(marked.slice(at + 1, close)));
    from = close + 1;
  }
  plain += marked.slice(from);
  if (plain !== text) return null;
  return (offset: number): number | null => {
    let low = 0;
    let high = starts.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (starts[middle]! <= offset) {
        found = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    if (found === -1) return null;
    let line = lines[found]!;
    for (let at = plain.indexOf("\n", starts[found]!); at !== -1 && at < offset; at = plain.indexOf("\n", at + 1))
      line++;
    return line;
  };
}

function textOf(html: string): string {
  const root = parseFragment(html);
  const pending: DefaultTreeAdapterMap["node"][] = [...root.childNodes].reverse();
  const pieces: string[] = [];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.nodeName === "#text" && "value" in node) pieces.push(node.value);
    else if ("childNodes" in node) {
      for (let i = node.childNodes.length - 1; i >= 0; i--) pending.push(node.childNodes[i]!);
    }
  }
  return pieces.join("");
}
