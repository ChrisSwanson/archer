/**
 * Where a chat message was sent from (wave 2, ticket 08): the page's route and, on a diagram or note page, the
 * file relative to the Archer folder (the service stores it relative to the project). The agent receives it with
 * the message. Pure, and shaped to the service's own bounds so a long address is cut here rather than refused there.
 */
import { MAX_CONTEXT_DOCUMENT_CHARS, MAX_CONTEXT_PAGE_CHARS, type CommentContext } from "../comments/contract";

/** The text without control characters, cut to `max` characters (by code point). */
const tidy = (text: string, max: number): string =>
  [...text]
    .filter((ch) => ch >= " " && ch !== "\u007f")
    .slice(0, max)
    .join("");

/** `undefined` where there is no page to name: the message is then sent without a context. */
export function chatContext(page: string | null | undefined, document?: string | null): CommentContext | undefined {
  const where = tidy(page ?? "", MAX_CONTEXT_PAGE_CHARS);
  if (where === "") return undefined;
  const file = tidy(document ?? "", MAX_CONTEXT_DOCUMENT_CHARS);
  return file === "" ? { page: where } : { page: where, document: file };
}
