// Rename suggestions for ids that already drifted (ADR 0036 §10, A22, P44). The write rule flags only ids
// a draft introduces; an id two views already spell differently (shopApi here, api there) is a migration
// candidate, offered on request: validate_diagram with suggest: true. Built on the model with the draft
// substituted, from the pairs that touch the checked view, followed through the pairs they lead to, so a
// chain settles on its one survivor and no id is renamed two ways. Nothing is edited (§10): each
// suggestion is advice the person agrees to, with the rename-plan entry that would make it.
import { similarPairs, type ScanBudget, type SimilarPair } from "../project-model/advice.ts";
import type { ModelElement, ProjectModel } from "../project-model/merge.ts";
import { entryFor, renameCollisions, survivor, type RenameEntry } from "./rename-plan.ts";

export interface SuggestionCandidate {
  readonly id: string;
  readonly label: string;
  readonly views: readonly string[];
  readonly similarity: number;
}

export interface Suggestion {
  /** The id to rename, its name, and every view that draws it. */
  readonly id: string;
  readonly label: string;
  readonly views: readonly string[];
  /** The probable survivor (§10's rule); absent when two survivors are as likely: see candidates. */
  readonly to?: string;
  readonly toLabel?: string;
  readonly toViews?: readonly string[];
  /** Trigram similarity of the names that matched, 0 to 1 (A22's score): not a probability. */
  readonly similarity: number;
  /** The element whose name matched (the survivor, or the id that leads to it) and the two names. */
  readonly evidence: { readonly matched: string; readonly labels: readonly [string, string] };
  /** When ambiguous: each survivor it could be. */
  readonly candidates?: readonly SuggestionCandidate[];
  /** When its one survivor cannot be its new id: the rename plan's reason, in the view where it fails. */
  readonly blocked?: { readonly viewId: string; readonly problem: string };
  /** When blocked because another id of that view looks like the same survivor: those ids. */
  readonly competing?: readonly string[];
  /** The current sourceRevision of each view named: a write's expectedRevision. */
  readonly revisions: Readonly<Record<string, string | null>>;
  /** The rename-plan entry (planRenames) that makes it; absent when ambiguous. */
  readonly entry?: RenameEntry;
  /**
   * With an entry: whether it renames only in the checked view. Ruling 2026-11-06: a rename in the
   * diagram the person asked to change is part of that change; in any other view it needs their yes.
   */
  readonly withinView?: boolean;
}

/** How far a chain is followed from the checked view's ids: a → b → c → d. */
const CHAIN_DEPTH = 3;

/**
 * What one request may cost (R13-04): pairs scored (about 4 µs each, so ~100 ms), the members of one
 * survivor's group (a name shared that widely is a common word, not one thing), and suggestions
 * returned. Past any of them the list is what was found, marked incomplete.
 */
export const SUGGESTION_BUDGET = { scored: 25_000, group: 25, suggestions: 50 } as const;

/** One request's suggestions: `incomplete` when a budget stopped the scan; `scored`, the pairs compared. */
export interface ViewSuggestions {
  readonly suggestions: readonly Suggestion[];
  readonly incomplete?: true;
  readonly scored: number;
}

const viewsOf = (e: ModelElement): string[] => [...new Set(e.occurrences.map((o) => o.viewId))].sort();
const round = (score: number): number => Math.round(score * 100) / 100;

/** A person, a table, or a part of the system at some level: system, container and component are one class. */
const classOf = (kind: string): string => (kind === "person" || kind === "code" ? kind : "part");

const CLASS_NAMES: Readonly<Record<string, string>> = {
  person: "a person",
  code: "a table",
  part: "a part of the system",
};
const classesOf = (e: ModelElement): Set<string> => new Set(e.kinds.map((k) => classOf(k.value)));
const classText = (classes: Iterable<string>): string =>
  [...classes]
    .sort()
    .map((c) => CLASS_NAMES[c] ?? c)
    .join(" and ");

/**
 * Whether a pair may be one thing renamed: not two boxes of one drawing (its author drew two things,
 * and renaming one onto the other is a merge), and not two classes of kind (the ER entity CUSTOMER is
 * not the person customer). A system in a context view and a container in a containers view are one
 * thing drawn at two levels: archer's state / account (2422068). "bridge" when they share a class but
 * one is drawn as two (R13-02): a table in one view and a person in another is no one's identity, so
 * it neither survives nor leads anywhere; the person settles it first.
 */
function renamable({ a, b }: SimilarPair): "yes" | "no" | "bridge" {
  const there = new Set(a.occurrences.map((o) => o.viewId));
  if (b.occurrences.some((o) => there.has(o.viewId))) return "no";
  const x = classesOf(a),
    y = classesOf(b);
  if (x.size === 0 || y.size === 0) return x.size > 1 || y.size > 1 ? "bridge" : "yes";
  if (![...x].some((c) => y.has(c))) return "no";
  return x.size > 1 || y.size > 1 ? "bridge" : "yes";
}

interface Lead {
  readonly other: ModelElement;
  readonly pair: SimilarPair;
}

/**
 * Rename suggestions for the view `viewId` of `model` (the draft already substituted). `namespace`
 * gives a view's every id (unkinded nodes and groups too, the draft's for the checked view); without
 * it, the ids the model has drawn there.
 */
export function viewSuggestions(
  model: ProjectModel,
  viewId: string,
  revisions: ReadonlyMap<string, string | null>,
  namespace?: (viewId: string) => ReadonlySet<string> | undefined,
): ViewSuggestions {
  const mine = new Set(model.elements.filter((e) => e.occurrences.some((o) => o.viewId === viewId)).map((e) => e.id));
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const budget = { scored: 0, limit: SUGGESTION_BUDGET.scored } as ScanBudget;
  let incomplete = false;
  // The pairs that touch the view, then the pairs those lead to; an id already scanned is not scanned again.
  const better = new Map<string, Lead[]>();
  const neighbours = new Map<string, Set<string>>();
  const seen = new Set<string>();
  const add = (pair: SimilarPair): void => {
    const key = `${pair.a.id}\0${pair.b.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    const keep = survivor(pair.a, pair.b);
    const lose = keep === pair.a ? pair.b : pair.a;
    const up = better.get(lose.id);
    if (up === undefined) better.set(lose.id, [{ other: keep, pair }]);
    else up.push({ other: keep, pair });
    for (const [x, y] of [
      [pair.a.id, pair.b.id],
      [pair.b.id, pair.a.id],
    ] as const) {
      const set = neighbours.get(x);
      if (set === undefined) neighbours.set(x, new Set([y]));
      else set.add(y);
    }
  };
  // Ids that look like an id drawn as two classes: told so, never renamed through it.
  const bridges = new Map<string, Lead>();
  const scanned = new Set<string>();
  const reached = new Set(mine);
  let frontier = new Set(mine);
  for (let depth = 0; depth < CHAIN_DEPTH && frontier.size > 0 && budget.exhausted !== true; depth++) {
    const next = new Set<string>();
    for (const pair of similarPairs(model, frontier, budget, scanned)) {
      const verdict = renamable(pair);
      if (verdict === "no") continue;
      if (verdict === "bridge") {
        for (const [x, y] of [
          [pair.a, pair.b],
          [pair.b, pair.a],
        ] as const)
          if (classesOf(y).size > 1 && classesOf(x).size <= 1 && !bridges.has(x.id))
            bridges.set(x.id, { other: y, pair });
        continue;
      }
      add(pair);
      for (const id of [pair.a.id, pair.b.id])
        if (!reached.has(id)) {
          reached.add(id);
          next.add(id);
        }
    }
    for (const id of frontier) scanned.add(id);
    frontier = next;
  }
  if (budget.exhausted === true) incomplete = true;
  // Each element's ultimate survivors. §10's order is total, so no cycle.
  const finals = new Map<string, Set<string>>();
  const finalOf = (id: string): Set<string> => {
    const known = finals.get(id);
    if (known !== undefined) return known;
    const up = better.get(id) ?? [];
    const out = up.length === 0 ? new Set([id]) : new Set(up.flatMap((u) => [...finalOf(u.other.id)]));
    finals.set(id, out);
    return out;
  };
  // Each survivor's group: the ids that would take its id.
  const groups = new Map<string, string[]>();
  for (const id of better.keys()) {
    const ends = finalOf(id);
    if (ends.size !== 1) continue;
    const end = [...ends][0]!;
    const group = groups.get(end);
    if (group === undefined) groups.set(end, [id]);
    else group.push(id);
  }
  const out: Suggestion[] = [];
  for (const [id, up] of better) {
    const ends = finalOf(id);
    const touches =
      mine.has(id) || [...ends].some((x) => mine.has(x)) || [...(neighbours.get(id) ?? [])].some((x) => mine.has(x));
    if (!touches) continue;
    const e = byId.get(id)!;
    const views = viewsOf(e);
    // A name shared that widely is a common word: only the checked view's own ids are offered.
    if (ends.size === 1 && (groups.get([...ends][0]!)?.length ?? 0) + 1 > SUGGESTION_BUDGET.group) {
      incomplete = true;
      if (!mine.has(id)) continue;
    }
    // Per survivor, the strongest direct match that leads to it.
    const lead = new Map<string, Lead>();
    for (const u of up)
      for (const end of finalOf(u.other.id)) {
        const was = lead.get(end);
        if (was === undefined || u.pair.score > was.pair.score) lead.set(end, u);
      }
    const best = [...lead.values()].sort((x, y) => y.pair.score - x.pair.score)[0]!;
    const evidence = {
      matched: best.other.id,
      labels: (best.pair.a.id === id ? best.pair.labels : [best.pair.labels[1], best.pair.labels[0]]) as readonly [
        string,
        string,
      ],
    };
    const named = new Set(views);
    if (ends.size === 1) {
      const to = byId.get([...ends][0]!)!;
      const toViews = viewsOf(to);
      for (const v of toViews) named.add(v);
      out.push({
        id,
        label: e.name,
        views,
        to: to.id,
        toLabel: to.name,
        toViews,
        similarity: round(lead.get(to.id)!.pair.score),
        evidence,
        revisions: revisionsOf(named, revisions),
        entry: entryFor(e, to, views),
        withinView: views.length === 1 && views[0] === viewId,
      });
    } else {
      const candidates = [...ends].sort().map((c) => {
        const other = byId.get(c)!;
        for (const v of viewsOf(other)) named.add(v);
        return { id: c, label: other.name, views: viewsOf(other), similarity: round(lead.get(c)!.pair.score) };
      });
      out.push({
        id,
        label: e.name,
        views,
        similarity: round(best.pair.score),
        evidence,
        candidates,
        revisions: revisionsOf(named, revisions),
      });
    }
  }
  for (const [id, { other, pair }] of bridges) {
    if (better.has(id) || !(mine.has(id) || mine.has(other.id))) continue;
    const e = byId.get(id)!;
    const views = viewsOf(e);
    out.push({
      id,
      label: e.name,
      views,
      similarity: round(pair.score),
      evidence: {
        matched: other.id,
        labels: (pair.a.id === id ? pair.labels : [pair.labels[1], pair.labels[0]]) as readonly [string, string],
      },
      candidates: [{ id: other.id, label: other.name, views: viewsOf(other), similarity: round(pair.score) }],
      blocked: {
        viewId: viewsOf(other)[0]!,
        problem: `'${other.id}' is drawn as ${classText(classesOf(other))}: settle what it is first`,
      },
      revisions: revisionsOf(new Set([...views, ...viewsOf(other)]), revisions),
    });
  }
  settle(out, model, namespace);
  // Definite first, the most similar first, the checked view's own ids before others; the ambiguous last.
  const order = (s: Suggestion): number => (mine.has(s.id) ? 0 : 1);
  out.sort((x, y) =>
    (x.to === undefined) !== (y.to === undefined)
      ? x.to === undefined
        ? 1
        : -1
      : y.similarity - x.similarity ||
        order(x) - order(y) ||
        (x.to ?? "").localeCompare(y.to ?? "") ||
        x.id.localeCompare(y.id),
  );
  if (out.length > SUGGESTION_BUDGET.suggestions) {
    incomplete = true;
    out.length = SUGGESTION_BUDGET.suggestions;
  }
  return { suggestions: out, ...(incomplete ? { incomplete: true as const } : {}), scored: budget.scored };
}

/**
 * The definite suggestions taken together, per view (R13-01, R13-03): the rename plan's preflight on
 * each view's ids. A source whose survivor is already an id there (drawn beside it, or a local step or
 * group), or that competes with another of that view for one survivor, keeps its survivor only as a
 * candidate, with the reason, and no entry. Taking renames away frees nothing else, so one pass holds.
 */
function settle(
  out: Suggestion[],
  model: ProjectModel,
  namespace?: (viewId: string) => ReadonlySet<string> | undefined,
): void {
  const drawn = new Map<string, Set<string>>();
  const idsIn = (v: string): ReadonlySet<string> => {
    const given = namespace?.(v);
    if (given !== undefined) return given;
    if (drawn.size === 0)
      for (const e of model.elements)
        for (const o of e.occurrences) (drawn.get(o.viewId) ?? drawn.set(o.viewId, new Set()).get(o.viewId)!).add(e.id);
    return drawn.get(v) ?? new Set();
  };
  const blocked = new Map<string, { viewId: string; problem: string; competing: Set<string> }>();
  // Every survivor's group is one class (R13-02): an unkinded id may sit between a table and a person.
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const groups = new Map<string, Suggestion[]>();
  for (const s of out) if (s.entry !== undefined) (groups.get(s.to!) ?? groups.set(s.to!, []).get(s.to!)!).push(s);
  for (const [to, members] of groups) {
    const classes = new Set([to, ...members.map((m) => m.id)].flatMap((id) => [...classesOf(byId.get(id)!)]));
    if (classes.size <= 1) continue;
    for (const m of members)
      blocked.set(m.id, {
        viewId: m.views[0]!,
        problem: `'${to}' and the ids that would take its id are drawn as ${classText(classes)}, which are never one thing`,
        competing: new Set(),
      });
  }
  const perView = new Map<string, Map<string, string>>();
  for (const s of out)
    if (s.entry !== undefined && !blocked.has(s.id))
      for (const v of s.views) (perView.get(v) ?? perView.set(v, new Map()).get(v)!).set(s.id, s.to!);
  for (const [v, renames] of perView)
    for (const c of renameCollisions(idsIn(v), renames)) {
      const was = blocked.get(c.from) ?? { viewId: v, problem: c.problem, competing: new Set<string>() };
      if (c.with !== undefined) was.competing.add(c.with);
      blocked.set(c.from, was);
    }
  for (const [i, s] of out.entries()) {
    const why = blocked.get(s.id);
    if (why === undefined) continue;
    const { to, toLabel, toViews, entry: _entry, withinView: _within, ...rest } = s;
    out[i] = {
      ...rest,
      candidates: [{ id: to!, label: toLabel!, views: toViews!, similarity: s.similarity }],
      blocked: { viewId: why.viewId, problem: why.problem },
      ...(why.competing.size > 0 ? { competing: [...why.competing].sort() } : {}),
    };
  }
}

function revisionsOf(
  views: Iterable<string>,
  revisions: ReadonlyMap<string, string | null>,
): Record<string, string | null> {
  return Object.fromEntries([...views].sort().map((v) => [v, revisions.get(v) ?? null]));
}

/** How many an existing view's check lists by default (decided 2026-11-06): definite ones only. */
export const DEFAULT_SUGGESTIONS = 5;

/** Why no analysis ran though suggestions were asked for (R13-05). */
export type SuggestionsUnavailable = "does_not_compile";

/** The suggestions as every result carries them whenever they were asked for: the API's, the CLI's and its JSON. */
export interface SuggestionFields {
  readonly suggestions: readonly Suggestion[];
  /** A budget stopped the scan: more may exist. */
  readonly suggestionsIncomplete?: true;
  /** No analysis ran, and why: the list is empty for that reason, not because nothing drifted. */
  readonly suggestionsUnavailable?: SuggestionsUnavailable;
  /** The default list (no `suggest`) left some out: `suggestionsTotal` were found; suggest: true lists them. */
  readonly suggestionsTruncated?: true;
  readonly suggestionsTotal?: number;
}

/**
 * The list an existing view's check shows when `suggest` is not given (decided 2026-11-06): at most
 * DEFAULT_SUGGESTIONS definite ones, those renaming only in this view first, then the most similar.
 */
export function defaultSuggestions(all: SuggestionFields): SuggestionFields {
  const definite = all.suggestions.filter((s) => s.entry !== undefined);
  const shown = [...definite]
    .sort((x, y) => Number(y.withinView === true) - Number(x.withinView === true) || y.similarity - x.similarity)
    .slice(0, DEFAULT_SUGGESTIONS);
  const total = all.suggestions.length;
  return {
    suggestions: shown,
    ...(all.suggestionsIncomplete === true ? { suggestionsIncomplete: true as const } : {}),
    ...(total > shown.length ? { suggestionsTruncated: true as const, suggestionsTotal: total } : {}),
  };
}

/** The fields for a scan's result, or for one that could not run. */
export function suggestionFields(found: ViewSuggestions | SuggestionsUnavailable): SuggestionFields {
  if (typeof found === "string") return { suggestions: [], suggestionsUnavailable: found };
  return {
    suggestions: found.suggestions,
    ...(found.incomplete === true ? { suggestionsIncomplete: true as const } : {}),
  };
}

/** What validate_diagram says of them, after its advice. */
export function suggestionText(
  found: SuggestionFields,
  viewId: string,
  all = "validate again with suggest: true",
  max = 10,
): string {
  if (found.suggestionsUnavailable === "does_not_compile")
    return "\nNo rename suggestions: they need a source that compiles.";
  const list = found.suggestions;
  const cut =
    found.suggestionsIncomplete === true ? "\nThe scan stopped at its budget, so the list may be incomplete." : "";
  const rest =
    found.suggestionsTruncated === true
      ? `\n${(found.suggestionsTotal ?? list.length) - list.length} more: ${all} for all.`
      : "";
  if (list.length === 0) return rest === "" ? `\nNo rename suggestions.${cut}` : `${rest}${cut}`;
  // One short line each, the most similar first: output cut at a few thousand characters keeps the best.
  const where = (views: readonly string[]): string =>
    views.length <= 2 ? views.join(", ") : `${views.slice(0, 2).join(", ")} +${views.length - 2}`;
  const ids = (s: Suggestion): string => (s.candidates ?? []).map((c) => c.id).join(" or ");
  const lines = list
    .slice(0, max)
    .map((s) =>
      s.to !== undefined
        ? `- ${s.id} → ${s.to} in ${where(s.views)}: '${s.label}'${s.toLabel === s.label ? "" : ` ~ '${s.toLabel}'`} (${s.similarity.toFixed(2)})`
        : s.blocked !== undefined
          ? `- ${s.id} ('${s.label}', in ${where(s.views)}) looks like ${ids(s)}, not offered: in ${s.blocked.viewId}, ${s.blocked.problem}`
          : `- ${s.id} ('${s.label}', in ${where(s.views)}): ambiguous, ${ids(s)}; ask the person which, if either`,
    );
  const more = list.length > max ? `\n${list.length - max} more in structuredContent.suggestions.` : "";
  return `\nRename suggestions (nothing was changed):\n${lines.join("\n")}${more}${rest}\nRename in ${viewId} as part of this change; for other views, ask the person first.${cut}`;
}

/** Suggestions by model signature: the pair scan is k × n within its budget, so an unchanged project is not scanned again. */
export class SuggestionCache {
  readonly #entries = new Map<string, ViewSuggestions>();
  /** How many times a list was computed rather than reused. */
  scans = 0;

  get(key: string, compute: () => ViewSuggestions): ViewSuggestions {
    const known = this.#entries.get(key);
    if (known !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, known);
      return known;
    }
    this.scans++;
    const value = compute();
    this.#entries.set(key, value);
    while (this.#entries.size > 8) this.#entries.delete(this.#entries.keys().next().value!);
    return value;
  }
}
