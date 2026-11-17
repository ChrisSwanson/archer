import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { addressable, parseEmphasis } from "../../../shared/emphasis.mts";
import {
  AGENT_HIGHLIGHT,
  FILM_HIGHLIGHTS,
  type FilmHighlight,
  SEQUENCE_HIGHLIGHT,
  WALKS,
} from "../../../site/.vitepress/theme/landing-film.mts";
import {
  FILM_DRAWINGS_PATH,
  FILM_SOURCES,
  filmEmphasis,
  renderFilmDrawings,
} from "../../../site/scripts/film-drawings.mts";
import { compile } from "../../../ts/src/mermaid/index.ts";
import { REFUSED_HOSTS } from "../../../ts/src/walkthroughs/contract.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");

it("draws the shop example from its Mermaid with Archer's own painter, theme-agnostic and inert", async () => {
  const drawings = await renderFilmDrawings(repoRoot);
  expect(Object.keys(drawings).sort()).toEqual(["proposal", "revised", "sequence"]);
  for (const [name, drawing] of Object.entries(drawings)) {
    expect(drawing.viewBox, name).toMatch(/^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/);
    // Colours stay theme tokens, so one drawing serves the light and the dark page.
    expect(drawing.svg, name).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(drawing.svg, name).toMatch(/var\(--node-bg\)/);
    // Markup goes into the page as is: nothing in it can run.
    for (const markup of [drawing.svg, drawing.key?.svg ?? "", ...Object.values(drawing.states).map((s) => s.markers)])
      expect(markup, name).not.toMatch(/<script|\son[a-z]+=|javascript:|<foreignObject/i);
  }
  const ids = (name: keyof typeof drawings) =>
    [...drawings[name].svg.matchAll(/data-element-id="([^"]+)"/g)].map((match) => match[1]);
  for (const step of WALKS.proposal)
    for (const id of [...step.nodes, ...step.edges.map((e) => e.id)]) expect(ids("proposal")).toContain(id);
  for (const group of SEQUENCE_HIGHLIGHT.groups)
    for (const id of [...group.nodes, ...group.edges]) expect(ids("sequence")).toContain(id);
  for (const id of [...AGENT_HIGHLIGHT.nodes, ...AGENT_HIGHLIGHT.edges]) expect(ids("revised")).toContain(id);
  // The revision says what the comment asked for.
  // The label wraps across two lines.
  expect(drawings.revised.svg).toMatch(/Charge, with<\/tspan>.*idempotency key/);
  expect(drawings.revised.svg).toContain("Dead-Letter Queue");
  expect(drawings.proposal.svg).not.toContain("Dead-Letter Queue");
  // A flowchart in family colours brings the Key's rows; a sequence has none.
  expect(drawings.proposal.key?.svg).toContain("New in this proposal");
  expect(drawings.sequence.key).toBeUndefined();
});

it("keeps each highlight as the painter drew it, scoped to its own state", async () => {
  const drawings = await renderFilmDrawings(repoRoot);
  for (const [id, highlight] of Object.entries(FILM_HIGHLIGHTS)) {
    const state = drawings[highlight.drawing].states[id];
    expect(state, id).toBeDefined();
    // Every rule applies only while the film shows this state.
    for (const rule of state!.css.split("}").filter(Boolean))
      for (const selector of rule.slice(0, rule.indexOf("{")).split(","))
        expect(selector.trim(), id).toMatch(new RegExp(`^\\[data-film-state="${id}"\\] `));
    expect(Object.keys(state!.attributes).length, id).toBeGreaterThan(0);
  }
  // The current step is the app's teal flow; the steps before it its quieter walked tone.
  expect(drawings.proposal.states["proposal-2"]!.css).toContain("var(--walked)");
  expect(drawings.proposal.states["proposal-1"]!.css).not.toContain("var(--walked)");
});

it("shows only what Archer can show on each diagram: walkthroughs where it hosts them, highlights it accepts", async () => {
  for (const [id, highlight] of Object.entries(FILM_HIGHLIGHTS) as [
    FilmHighlight,
    (typeof FILM_HIGHLIGHTS)[FilmHighlight],
  ][]) {
    const compiled = await compile(await readFile(resolve(repoRoot, FILM_SOURCES[highlight.drawing]), "utf8"));
    const model = compiled.model!;
    // A walkthrough step only on a diagram Archer lets host a walkthrough.
    if (highlight.step !== undefined) expect(REFUSED_HOSTS[model.type], id).toBeUndefined();
    // The agent's highlights are what set_emphasis accepts for that diagram, as the agent would send them.
    else {
      const { viewId, payload } = filmEmphasis(id, highlight.drawing);
      const parsed = parseEmphasis(payload, viewId, addressable(model));
      expect(parsed.ok ? [] : parsed.issues, id).toEqual([]);
    }
  }
});

it("is checked in as the generator draws it today", async () => {
  const fresh = await renderFilmDrawings(repoRoot);
  const saved = JSON.parse(await readFile(resolve(repoRoot, FILM_DRAWINGS_PATH), "utf8"));
  expect(saved, "run `npm run docs:film` and commit the result").toEqual(JSON.parse(JSON.stringify(fresh)));
});
