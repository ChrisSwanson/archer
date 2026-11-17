// The page's own additions (ui/src/expand/use-expand.tsx): one frame per source in the order sources were
// first added (O7), and removing a source takes with it what was added from inside its frame.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { projectEnvelope, type ProjectedView } from "../src/diagrams/projection";
import {
  additionLimit,
  additionOf,
  expansionsOf,
  framesOf,
  withoutSource,
  type Addition,
} from "../src/expand/use-expand";
import { projectPiece, readExpandMenu, type ExpandMenu } from "../src/expand/pieces";

const dir = new URL("./fixtures/expand/", import.meta.url);
const envelopes = JSON.parse(readFileSync(new URL("envelopes.json", dir), "utf8")) as Record<string, unknown>;
const menuOf = (name: string): ExpandMenu => readExpandMenu(JSON.parse(readFileSync(new URL(name, dir), "utf8")))!;
const context = ((): ProjectedView => {
  const p = projectEnvelope(envelopes["context"]);
  if (!p.ok || p.type !== "graph") throw new Error("context");
  return p.view;
})();

function addition(menu: ExpandMenu, element: string, source: string): Addition {
  const entry = menu.diagrams.items.find((d) => d.source === source)!;
  return {
    element,
    source,
    title: entry.title,
    proposed: entry.proposed === true,
    revision: entry.sourceRevision,
    piece: projectPiece(entry.piece!, entry.title)!,
    truncated: entry.piece!.truncated,
  };
}

describe("additions on one page", () => {
  const first = addition(menuOf("menu-context-shop.json"), "shop", "containers");
  const second = addition(menuOf("menu-context-api-grown.json"), "api", "notes/deploy.md#deploy");

  test("one frame per source, in order of first addition; a second piece from a source grows its frame", () => {
    const again = { ...first, element: "shop" };
    const frames = framesOf([first, second, again]);
    expect(frames.map((f) => f.source)).toEqual(["containers", "notes/deploy.md#deploy"]);
    expect(frames[0]!.pieces).toHaveLength(2);
    expect(frames[1]!.proposed).toBe(true);
  });

  // codex-12-01 (O254): the list the page reports and copies names the neighbour it added, so it replays as that.
  test("a neighbour entry's addition names its neighbour in the list the page shares", () => {
    const grown = menuOf("menu-context-api-grown.json");
    const mail = additionOf("api", grown.neighbours.items.find((n) => n.element === "mail")!, () => "")!;
    expect(mail).toMatchObject({ element: "api", source: "containers", neighbour: "mail", title: "Containers" });
    const whole = additionOf(
      "shop",
      menuOf("menu-context-shop.json").diagrams.items.find((d) => d.source === "containers")!,
      () => "",
    )!;
    expect(whole.neighbour).toBeUndefined();
    expect(expansionsOf([whole, mail])).toEqual([
      { element: "shop", source: "containers" },
      { element: "api", source: "containers", neighbour: "mail" },
    ]);
  });

  // codex-12-03 (O255): the page refuses an addition its report and link could not carry, by the decoder's own limits.
  test("an addition past 24 entries, or past what one link holds, is refused with why", () => {
    const many = Array.from({ length: 24 }, (_, i): Addition => ({ ...first, element: "shop", neighbour: `n${i}` }));
    const room = { boxes: 0, wires: 0 };
    expect(
      additionLimit(
        many.slice(0, 23),
        room,
        "containers",
        { boxes: 1, wires: 1 },
        { element: "shop", source: "containers", neighbour: "x" },
      ),
    ).toBeNull();
    expect(
      additionLimit(
        many,
        room,
        "containers",
        { boxes: 1, wires: 1 },
        { element: "shop", source: "containers", neighbour: "x" },
      ),
    ).toBe("24 additions already");
    const long = [{ ...first, element: "e".repeat(256), source: "s".repeat(500) }];
    const longs = Array.from({ length: 4 }, () => long[0]!);
    expect(
      additionLimit(
        longs,
        room,
        "s".repeat(500),
        { boxes: 1, wires: 0 },
        { element: "e".repeat(256), source: "s".repeat(500), neighbour: "y" },
      ),
    ).toBe("too long to share as a link");
    // The canvas limits stand as before.
    expect(additionLimit([], { boxes: 60, wires: 0 }, "containers", { boxes: 1, wires: 0 }, null)).toBe(
      "over 60 added boxes",
    );
  });

  test("removing a source drops what was added from inside its frame", () => {
    expect(withoutSource(context, [first, second], "containers")).toEqual([]);
    expect(withoutSource(context, [first, second], "notes/deploy.md#deploy")).toEqual([first]);
  });
});
