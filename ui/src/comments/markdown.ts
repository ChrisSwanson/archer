/** The page and service render the same note Markdown (HTML off). */
export { renderNoteMarkdown } from "../../../shared/note-markdown.mjs";

/** Every element markdown-it emits with HTML off, and nothing else. */
const ALLOWED_TAGS = new Set([
  "A",
  "BLOCKQUOTE",
  "BR",
  "CODE",
  "DEL",
  "EM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HR",
  "LI",
  "OL",
  "P",
  "PRE",
  "S",
  "SPAN",
  "STRONG",
  "TABLE",
  "TBODY",
  "TD",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);

function allowedAttribute(element: Element, name: string, value: string): boolean {
  switch (name) {
    case "href":
      return element.tagName === "A" && !/^\s*(javascript|vbscript|data|file):/i.test(value);
    case "target":
    case "rel":
    case "title":
      return true;
    case "start":
      return element.tagName === "OL";
    case "class":
      return value === "archer-note-image" || /^archer-note-h[1-6]$/.test(value) || /^language-[\w-]+$/.test(value);
    case "style":
      return /^text-align:(left|right|center)$/.test(value);
    default:
      return false;
  }
}

/**
 * Puts rendered note HTML into `root`, keeping only what markdown-it emits.
 *
 * Defence in depth, not the defence: with `html: false` none of this can
 * occur. It is here so that a future change to the renderer's options cannot
 * quietly put a note's markup on the page. Parsed in a `template`, whose
 * content is inert -- no script runs and no image loads while it is read.
 */
export function placeNoteHtml(root: HTMLElement, html: string): void {
  const template = root.ownerDocument.createElement("template");
  template.innerHTML = html;
  for (const element of [...template.content.querySelectorAll("*")]) {
    if (!ALLOWED_TAGS.has(element.tagName)) {
      element.replaceWith(root.ownerDocument.createTextNode(element.textContent ?? ""));
      continue;
    }
    for (const attribute of [...element.attributes]) {
      if (!allowedAttribute(element, attribute.name, attribute.value)) element.removeAttribute(attribute.name);
    }
  }
  root.replaceChildren(template.content);
}
