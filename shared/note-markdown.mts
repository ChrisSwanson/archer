/**
 * A note's Markdown, rendered without raw HTML.
 *
 * markdown-it with `html: false`, its default: every tag written in a note is
 * shown as text, escaped by the renderer itself, and its link validator
 * refuses `javascript:`, `vbscript:`, `file:` and non-image `data:` URLs, so a
 * link can never run script. Chosen over writing a subset here because a
 * hand-rolled parser is exactly the kind of code that gets escaping wrong, and
 * over a React renderer (react-markdown and the unified stack) because it is
 * one small, CommonMark-compliant, long-maintained package with no DOM of its
 * own and a renderer that escapes by default.
 *
 * Two departures from its defaults, both about what a note may make the page
 * DO rather than what it says:
 *   - links open in a new tab, with no opener and no referrer: a note linking
 *     to the web must not navigate the page away, or hand that site the page's
 *     tokened URL;
 *   - images are shown as their alt text. The page's policy allows images only
 *     from `data:` URLs, so a remote one would be refused (and logged) anyway,
 *     and a note fetching from the network as it is read is a tracking pixel.
 */
import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });

const defaultLinkOpen =
  markdown.renderer.rules.link_open ??
  ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));

/**
 * Only a web link stays a link, and it opens in a new tab. Anything else -- a
 * relative link to a diagram or note, `//host`, `mailto:`, `#part` -- would
 * navigate this tab away from the live review (a relative one to a 404 under
 * the page's address), so it is kept as its words. The pair of rules below drops
 * the `a` around them, opening and closing alike.
 */
const isInternalLink = (href: string): boolean =>
  /\.(?:md|mmd)(?:#[^\s]*)?$/i.test(href) && !/^[\\/]|:|[\x00-\x20\x7f\\]/.test(href);

const isWebLink = (href: unknown): boolean => /^https?:\/\//i.test(String(href ?? ""));

markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index]!;
  const href = String(token.attrGet("href") ?? "");
  const internal = (env as { internalLinks?: boolean } | undefined)?.internalLinks === true && isInternalLink(href);
  if (!isWebLink(href) && !internal) {
    token.meta = { ...(token.meta as object), dropped: true };
    return "";
  }
  if (!internal) {
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noopener noreferrer");
  }
  return defaultLinkOpen(tokens, index, options, env, self);
};

markdown.renderer.rules.link_close = (tokens, index, options, _env, self) => {
  // The matching opener is the nearest unclosed one before this token.
  let depth = 0;
  for (let at = index - 1; at >= 0; at--) {
    const token = tokens[at]!;
    if (token.type === "link_close") depth++;
    else if (token.type === "link_open") {
      if (depth === 0)
        return (token.meta as { dropped?: boolean } | null)?.dropped === true
          ? ""
          : self.renderToken(tokens, index, options);
      depth--;
    }
  }
  return self.renderToken(tokens, index, options);
};

/**
 * A note's headings sit under the note's own title (an `h4` in the panel), so
 * they are drawn as `h5` and `h6`: a note's `# Title` as a page's `h1` would
 * tell a screen reader the note outranks the page. The level it was written at
 * is kept as a class, which is what the stylesheet sizes it by.
 */
const NOTE_HEADING_OFFSET = 4;

const heading =
  (closing: boolean): NonNullable<typeof markdown.renderer.rules.heading_open> =>
  (tokens, index, options, env, self) => {
    const token = tokens[index]!;
    const written = Number(token.tag.slice(1));
    const offset = (env as { headingOffset?: number } | undefined)?.headingOffset ?? NOTE_HEADING_OFFSET;
    token.tag = `h${Math.min(6, written + offset)}`;
    if (!closing) token.attrSet("class", `archer-note-h${written}`);
    return self.renderToken(tokens, index, options);
  };

markdown.renderer.rules.heading_open = heading(false);
markdown.renderer.rules.heading_close = heading(true);

markdown.renderer.rules.image = (tokens, index) => {
  const alt = tokens[index]!.content;
  return `<span class="archer-note-image">${markdown.utils.escapeHtml(alt === "" ? "image" : alt)}</span>`;
};

/**
 * A soft line break (a newline inside a paragraph) is drawn as `\n` by
 * default. `env.softBreak` replaces it, so the server can tell a soft break
 * from a block edge in the rendered text without a second Markdown parser.
 */
markdown.renderer.rules.softbreak = (_tokens, _index, options, env) =>
  (env as { softBreak?: string } | undefined)?.softBreak ?? (options.breaks ? "<br>\n" : "\n");

/** HTML for a note's body. Safe to place in the page: see above. */
export function renderNoteMarkdown(
  source: string,
  options: { readonly internalLinks?: boolean; readonly headingOffset?: number; readonly softBreak?: string } = {},
): string {
  const wellFormed = wellFormedText(source);
  return markdown.render(wellFormed, {
    internalLinks: options.internalLinks === true,
    headingOffset:
      Number.isInteger(options.headingOffset) && options.headingOffset! >= 0 && options.headingOffset! <= 4
        ? options.headingOffset
        : NOTE_HEADING_OFFSET,
    ...(options.softBreak === undefined ? {} : { softBreak: options.softBreak }),
  });
}

// JSON can carry isolated UTF-16 surrogates even though disk UTF-8 cannot.
// Normalize those on BOTH sides before rendering; preserve valid pairs.
const wellFormedText = (source: string): string =>
  source.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");

/**
 * For the service, never the page: `renderNoteMarkdown`'s HTML with `mark(line)` written as text before the
 * text of each inline run and each code block, `line` being the 0-based source line of the block it is in
 * (a paragraph, heading, table row, fenced code). Remove the marks and the text is the rendered note's, so
 * a passage found in it can be traced to the lines it was written on: from a mark, each newline of the text
 * is the next source line.
 */
export function renderNoteMarkdownWithLines(source: string, mark: (line: number) => string): string {
  const env = { internalLinks: false, headingOffset: NOTE_HEADING_OFFSET };
  const tokens = markdown.parse(wellFormedText(source), env);
  let line: number | null = null;
  for (const token of tokens) {
    if (token.map !== null) line = token.map[0];
    if (line === null) continue;
    if (token.type === "inline" && token.children !== null) {
      const Text = token.constructor as new (type: string, tag: string, nesting: 0) => typeof token;
      const text = new Text("text", "", 0);
      text.content = mark(line);
      token.children.unshift(text);
    } else if (token.type === "fence" || token.type === "code_block") {
      // A fence's first line is its opening fence; its content starts on the next.
      token.content = mark(token.type === "fence" ? line + 1 : line) + token.content;
    }
  }
  return markdown.renderer.render(tokens, markdown.options, env);
}

/** How much text either side of a passage is kept to find it again. */
export const PASSAGE_CONTEXT_CHARS = 32;

export type PassageAnchor = {
  readonly kind: "passage";
  readonly quote: string;
  readonly prefix: string;
  readonly suffix: string;
};

/**
 * A passage of `text` (the rendered note's text), anchored by its words and a
 * little of each side.
 *
 * The context stops at the edge of the block the passage is in -- a line
 * break in the rendered text. The page and server locate the same rendered
 * quote and rank repeated occurrences by how much surrounding context still
 * agrees. Context identifies the occurrence; it need not survive nearby edits.
 */
export function passageAnchor(text: string, start: number, end: number): PassageAnchor {
  const blockStart = text.lastIndexOf("\n", start - 1) + 1;
  const nextBreak = text.indexOf("\n", end);
  const blockEnd = nextBreak === -1 ? text.length : nextBreak;
  return {
    kind: "passage",
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(blockStart, start - PASSAGE_CONTEXT_CHARS), start),
    suffix: text.slice(end, Math.min(blockEnd, end + PASSAGE_CONTEXT_CHARS)),
  };
}

/** How many characters `a` and `b` share at their ends: the prefix, read from the quote outwards. */
function sharedSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** How many characters `a` and `b` share at their starts: the suffix, read from the quote outwards. */
function sharedPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * Where a passage is in `text` now, or `null` when its words are gone.
 *
 * Every occurrence of the quote is a candidate; the one whose surroundings
 * agree longest with the recorded prefix and suffix wins, so a phrase that
 * appears twice is found where it was commented on, and text added elsewhere
 * in the note does not move it.
 */
export function locatePassage(text: string, anchor: PassageAnchor): { start: number; end: number } | null {
  if (anchor.quote === "") {
    return null;
  }
  let best: { start: number; score: number } | null = null;
  for (let at = text.indexOf(anchor.quote); at !== -1; at = text.indexOf(anchor.quote, at + 1)) {
    const end = at + anchor.quote.length;
    const score =
      sharedSuffix(text.slice(Math.max(0, at - anchor.prefix.length), at), anchor.prefix) +
      sharedPrefix(text.slice(end, end + anchor.suffix.length), anchor.suffix);
    if (best === null || score > best.score) {
      best = { start: at, score };
    }
  }
  return best === null ? null : { start: best.start, end: best.start + anchor.quote.length };
}
