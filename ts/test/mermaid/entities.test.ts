// Mermaid entity codes (`#quot;`, `#35;`) mean the characters Mermaid draws:
// its preprocessor turns `#name;` into `&name;` and `#123;` into `&#123;`, and
// the browser resolves those as HTML character references. Archer's model
// holds those characters.

import { describe, expect, test } from "vitest";
import { decodeEntities } from "../../src/mermaid/entities.ts";

describe("decodeEntities", () => {
  test.each([
    ["#quot;", '"'],
    ["#amp;", "&"],
    ["#lt;", "<"],
    ["#gt;", ">"],
    ["#nbsp;", " "],
    ["#apos;", "'"],
    ["#eacute;", "é"],
    ["#hearts;", "♥"],
    ["#rarr;", "→"],
    ["#QUOT;", '"'],
    ["#NotEqualTilde;", "≂̸"],
    ["#35;", "#"],
    ["#59;", ";"],
    ["#9829;", "♥"],
    ["#0035;", "#"],
    ["#128512;", "😀"],
  ])("%s is %s", (code, character) => {
    expect(decodeEntities(code)).toBe(character);
  });

  test("decodes every code in a label and leaves the rest of the text", () => {
    expect(decodeEntities("say #quot;hi#quot; #35;1#59; R&D # not; #")).toBe('say "hi" #1; R&D # not; #');
  });

  test.each([
    ["#0;", "�"],
    ["#55296;", "�"],
    ["#1114112;", "�"],
    ["#99999999999999999999;", "�"],
    ["#128;", "€"],
    ["#150;", "–"],
    ["#159;", "Ÿ"],
    ["#129;", "\u0081"],
    ["#27;", "\u001b"],
  ])("a numeric code follows the browser's rules: %s", (code, character) => {
    expect(decodeEntities(code)).toBe(character);
  });

  test.each([
    ["#foo;", "&foo;"],
    ["#Quot;", "&Quot;"],
    ["#x41;", "&x41;"],
    ["#notit;", "¬it;"],
    ["#ampx;", "&x;"],
    ["#notin;", "∉"],
  ])("a name the browser does not know is drawn as the browser draws it: %s", (code, drawn) => {
    expect(decodeEntities(code)).toBe(drawn);
  });
});
