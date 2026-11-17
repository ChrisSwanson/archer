// Mermaid's entity codes. Its preprocessor rewrites `#quot;` to `ﬂ°quot¶ß`
// and `#35;` to `ﬂ°°35¶ß` before parsing, and its renderer turns those into
// `&quot;` and `&#35;`, which the browser resolves as HTML character
// references. So a code means the character Mermaid draws, and that is what
// Archer's model holds (decided for the TypeScript port).
//
// The adapters first restore Mermaid's placeholders to the codes as written,
// to compare Mermaid's reading with the scan's, then decode the codes for the
// model. A decoded label is checked like any other: a code that stands for a
// control character, or codes that spell an HTML tag, are refused.

import { LEGACY_NAMES, namedReference } from "./html-entities.ts";

const PLACEHOLDER = /ﬂ°(°?)(\w+)¶ß/g;

/** Mermaid's placeholders turned back into the entity codes they were written as. */
export function restoreEntities(text: string): string {
  return text.replace(PLACEHOLDER, (_match, _numeric: string, name: string) => `#${name};`);
}

/** An entity code as Mermaid's preprocessor finds one. */
const ENTITY_CODE = /#(\w+);/g;

/** Each entity code in `text` replaced by the characters Mermaid draws for it. */
export function decodeEntities(text: string): string {
  return text.replace(ENTITY_CODE, (_code, inner: string) => (/^\d+$/.test(inner) ? numeric(inner) : named(inner)));
}

const REPLACEMENT = "�";

// The browser reads these numeric references as Windows-1252, not as the C1
// controls they number (HTML's "numeric character reference end state").
const WINDOWS_1252: Record<number, number> = {
  128: 0x20ac,
  130: 0x201a,
  131: 0x0192,
  132: 0x201e,
  133: 0x2026,
  134: 0x2020,
  135: 0x2021,
  136: 0x02c6,
  137: 0x2030,
  138: 0x0160,
  139: 0x2039,
  140: 0x0152,
  142: 0x017d,
  145: 0x2018,
  146: 0x2019,
  147: 0x201c,
  148: 0x201d,
  149: 0x2022,
  150: 0x2013,
  151: 0x2014,
  152: 0x02dc,
  153: 0x2122,
  154: 0x0161,
  155: 0x203a,
  156: 0x0153,
  158: 0x017e,
  159: 0x0178,
};

function numeric(digits: string): string {
  const value = Number(digits);
  if (value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return REPLACEMENT;
  return String.fromCodePoint(WINDOWS_1252[value] ?? value);
}

function named(name: string): string {
  const full = namedReference(name);
  if (full !== undefined) return full;
  // In text the browser takes the longest name it knows without a `;` and
  // keeps the rest: `&notit;` is `¬it;`. A name it does not know stays as
  // `&name;`, which is what Mermaid draws.
  let legacy = "";
  for (const candidate of LEGACY_NAMES)
    if (name.startsWith(candidate) && candidate.length > legacy.length) legacy = candidate;
  if (legacy === "") return `&${name};`;
  return `${namedReference(legacy) ?? ""}${name.slice(legacy.length)};`;
}
