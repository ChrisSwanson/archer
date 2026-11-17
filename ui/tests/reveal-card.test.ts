// @vitest-environment jsdom
// revealCard (FloatingDiscussion.tsx, O99): scrolls the discussion's own body so a focused card and its ring show.
import { describe, expect, test } from "vitest";
import { revealCard } from "../src/comments/FloatingDiscussion";

const box = (top: number, height: number) =>
  ({ top, bottom: top + height, left: 0, right: 300, width: 300, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

function layout(cardTop: number, cardHeight: number, scrollTop = 100) {
  const body = document.createElement("div");
  body.className = "primary-floating-content";
  const card = document.createElement("article");
  body.append(card);
  document.body.append(body);
  Object.defineProperty(body, "clientHeight", { value: 400 });
  Object.defineProperty(body, "clientTop", { value: 0 });
  body.scrollTop = scrollTop;
  body.getBoundingClientRect = () => box(200, 400);
  card.getBoundingClientRect = () => box(cardTop, cardHeight);
  return { body, card };
}

describe("revealCard", () => {
  test("a card whose ring starts above the body scrolls down to show it, ring and all", () => {
    const { body, card } = layout(190, 100);
    revealCard(card);
    expect(body.scrollTop).toBe(100 - 14); // 200 - (190 - 4)
  });
  test("a card below the body scrolls up into it; one taller than the body shows its top", () => {
    const below = layout(560, 100);
    revealCard(below.card);
    expect(below.body.scrollTop).toBe(100 + 64); // (660 + 4) - 600
    const tall = layout(300, 900);
    revealCard(tall.card);
    expect(tall.body.scrollTop).toBe(100 + 96); // its top (300 - 4) brought to the body's top (200)
  });
  test("a card already inside leaves the scroll as it is; outside a discussion body nothing happens", () => {
    const inside = layout(260, 100);
    revealCard(inside.card);
    expect(inside.body.scrollTop).toBe(100);
    const lone = document.createElement("article");
    expect(() => revealCard(lone)).not.toThrow();
  });
});
