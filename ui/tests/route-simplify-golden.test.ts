// `simplifyRoutes` is a pure function of the layout it is given; how fast it runs is not part of what it draws. These
// are its inputs on real drawings -- each fixture whole, and every step of each grouped fixture opened in turn as a
// deep link opens them (the nested view's walls included) -- with a digest of what it returned for each when they
// were recorded. A change meant only to make it faster must return the same routes, byte for byte.
//
// Re-record (only for a change meant to draw differently):
//   ARCHER_RECORD_SIMPLIFY=1 npx vitest run tests/route-simplify-golden.test.ts
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { computeLayout, type LayoutResult } from "../src/layout/elk-adapter";
import { simplifyRoutes, unsimplified } from "../src/layout/route-simplify";
import { chainOrder } from "../src/nesting/nest-engine";
import { nestView } from "../src/nesting/nest-view";
import { growInPlaceV2 } from "../src/nesting/grow-in-place-v2";
import { frameToggleRect } from "../src/nesting/toggle-place";
import { viewOfFile } from "./route-metrics";

const ROOT = `${__dirname}/../..`;
const PAGETURNER = `${ROOT}/tools/devkit/corpus/pageturner/.archer/diagrams`;
const AWKWARD = `${ROOT}/tools/devkit/corpus/awkward/.archer/diagrams`;
const SOURCES: Record<string, string> = {
  "ship-loop": `${ROOT}/ui/tests/fixtures/palette/ship-loop.mmd`,
  "home-rig": `${ROOT}/ui/tests/fixtures/palette/home-rig.mmd`,
  fulfilment: `${PAGETURNER}/fulfilment.mmd`,
  containers: `${PAGETURNER}/containers.mmd`,
  deployment: `${PAGETURNER}/deployment.mmd`,
  "system-context": `${PAGETURNER}/system-context.mmd`,
  "data-model": `${PAGETURNER}/data-model.mmd`,
  "c4-boundaries": `${AWKWARD}/c4-boundaries.mmd`,
  "flow-styled": `${AWKWARD}/flow-styled.mmd`,
  "flow-large": `${AWKWARD}/flow-large.mmd`,
};
const GOLDEN = `${__dirname}/fixtures/route-simplify-golden.json.gz`;

type Box = { x: number; y: number; width: number; height: number };
type SimplifyCase = { name: string; input: LayoutResult; walls?: Box[]; digest: string };

const digest = (layout: LayoutResult): string => createHash("sha256").update(JSON.stringify(layout)).digest("hex");

async function record(): Promise<void> {
  const inputs: Omit<SimplifyCase, "digest">[] = [];
  for (const [name, path] of Object.entries(SOURCES)) {
    const full = await viewOfFile(path);
    inputs.push({ name: `${name}:full`, input: unsimplified(await computeLayout(full)) });
    if (full.groups.length === 0) continue;
    const base = nestView(full, []).view;
    let laid = { view: base, layout: await computeLayout(base) };
    const open: string[] = [];
    for (const id of chainOrder(
      full,
      full.groups.map((group) => group.id),
    )) {
      open.push(id);
      const view = nestView(full, open).view;
      laid = { view, layout: await growInPlaceV2(laid, view, id, { layout: (v) => computeLayout(v) }) };
      const aired = unsimplified(laid.layout);
      inputs.push({ name: `${name}:open:${open.join(",")}`, input: aired, walls: aired.groups.map(frameToggleRect) });
    }
  }
  // Recorded from the JSON round trip the test replays, so a field JSON drops cannot tell the two apart.
  const cases = inputs.map((c) => {
    const parsed = JSON.parse(JSON.stringify(c)) as Omit<SimplifyCase, "digest">;
    const out = simplifyRoutes(parsed.input, parsed.walls === undefined ? {} : { walls: parsed.walls });
    return { ...parsed, digest: digest(out) };
  });
  writeFileSync(GOLDEN, gzipSync(JSON.stringify(cases)));
}

describe("simplifyRoutes returns the routes it returned when recorded", () => {
  if (process.env.ARCHER_RECORD_SIMPLIFY === "1") it("records", record, 600_000);
  else {
    const cases = existsSync(GOLDEN)
      ? (JSON.parse(gunzipSync(readFileSync(GOLDEN)).toString("utf8")) as SimplifyCase[])
      : [];
    it("has a recording that covers a large drawing", () => {
      expect(Math.max(0, ...cases.map((c) => c.input.edges.length))).toBeGreaterThanOrEqual(100);
    });
    it.each(cases.map((c) => [c.name, c] as const))("%s", (_, c) => {
      const out = simplifyRoutes(c.input, c.walls === undefined ? {} : { walls: c.walls });
      expect(digest(out)).toBe(c.digest);
    });
  }
});
