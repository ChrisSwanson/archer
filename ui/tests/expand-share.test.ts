// The exploration shared with the agent, as the page reads it (ADR 0036 §14, A8, O10): an exploration answer
// (routes 2 and 3, fixtures captured from the service), the presentation's stamp, and the copied link.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { projectPiece, readExploration } from "../src/expand/pieces";
import { presentedOf } from "../src/expand/use-expand";
import { decodeExpansions, withExpandParam } from "../../shared/explorations.mts";

const dir = new URL("./fixtures/expand/", import.meta.url);
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(name, dir), "utf8"));

describe("an exploration answer", () => {
  test("a presented one: every added entry carries a piece the page projects as a menu add's", () => {
    const answer = readExploration(fixture("exploration-presented.json"))!;
    expect(answer.origin).toBe("presentation");
    const added = answer.expansions.items.filter((i) => i.status === "added");
    expect(added.length).toBeGreaterThan(0);
    for (const item of added) {
      if (item.status !== "added") continue;
      expect(answer.frames[item.frame]!.source).toBe(item.source);
      expect(projectPiece(item.piece, answer.frames[item.frame]!.title)?.nodes.length).toBeGreaterThan(0);
    }
  });

  test("a link's: what it could not add is listed with a reason", () => {
    const answer = readExploration(fixture("exploration-link-dropped.json"))!;
    expect(answer.origin).toBe("link");
    expect(answer.expansions.items.some((i) => i.status === "dropped" && typeof i.reason === "string")).toBe(true);
  });

  test("anything else is not read", () => {
    expect(readExploration(null)).toBeNull();
    expect(readExploration({ schemaVersion: 2 })).toBeNull();
    const bad = fixture("exploration-presented.json") as { expansions: { items: Record<string, unknown>[] } };
    bad.expansions.items[0] = { ...bad.expansions.items[0], status: "added", piece: undefined };
    expect(readExploration(bad)).toBeNull();
  });
});

describe("the presentation's stamp", () => {
  test("read when the agent presented with expand, null otherwise", () => {
    expect(
      presentedOf({
        presentationId: "present-aaaaaaaaaaaa",
        viewId: "context",
        exploration: { generation: 3, sources: 1, parts: 3 },
      }),
    ).toEqual({
      presentationId: "present-aaaaaaaaaaaa",
      viewId: "context",
      stamp: { generation: 3, sources: 1, parts: 3 },
    });
    expect(presentedOf({ presentationId: "present-aaaaaaaaaaaa", viewId: "context" })?.stamp).toBeNull();
    expect(
      presentedOf({ presentationId: "present-aaaaaaaaaaaa", viewId: "context", exploration: { generation: "3" } })
        ?.stamp,
    ).toBeNull();
    expect(presentedOf(null)).toBeNull();
  });
});

describe("Copy link (O10)", () => {
  test("keeps the page's address and its other parameters; sets expand, and clears it for none", () => {
    const pairs = [
      { element: "shop", source: "containers" },
      { element: "api", source: "notes/deploy.md#deploy" },
    ];
    const link = new URL(
      withExpandParam("https://h/projects/shop/.archer/diagrams/context.mmd?zoom=full&expand=old", pairs).href,
    );
    expect(link.pathname).toBe("/projects/shop/.archer/diagrams/context.mmd");
    expect(link.searchParams.get("zoom")).toBe("full");
    expect(decodeExpansions(link.searchParams.get("expand"))).toEqual({ ok: true, expansions: pairs });
    expect(new URL(withExpandParam(link.href, []).href).searchParams.has("expand")).toBe(false);
  });

  // codex-12-03 (O255): a list the reader's page would refuse is never what Copy link copies.
  test("a list past 24 entries or 4,096 characters copies the view's own address, and says it is not shared", () => {
    const at = (n: number) =>
      withExpandParam(
        "https://h/p/x.mmd",
        Array.from({ length: n }, (_, i) => ({ element: `e${i}`, source: "s" })),
      );
    expect(at(24)).toMatchObject({ shared: true });
    expect(decodeExpansions(new URL(at(24).href).searchParams.get("expand"))).toMatchObject({ ok: true });
    expect(at(25)).toEqual({ href: "https://h/p/x.mmd", shared: false, problem: expect.any(String) });
    const long = withExpandParam(
      "https://h/p/x.mmd",
      Array.from({ length: 6 }, (_, i) => ({ element: "e".repeat(200), source: `s${i}`.padEnd(500, "s") })),
    );
    expect(long).toMatchObject({ href: "https://h/p/x.mmd", shared: false });
  });
});
