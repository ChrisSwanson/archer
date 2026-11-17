// Step ids (ADR 0034 §9). A comment names a step by id so it follows the step
// through an insert or a reorder. The caller need not send ids:
// - a step that sends one keeps it (so list_walkthroughs' echo round-trips);
// - else a stored step with the same title lends its id;
// - else the title's slug, with -2, -3 on a clash within the walkthrough.
// A stored file written before ids is read through the same rule.

/** A title as an id: lower-case letters, digits and hyphens, at most `max` characters. */
export function slug(title: string, max = 48): string {
  const text = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return text === "" ? "step" : text;
}

function fresh(title: string, taken: Set<string>): string {
  const base = slug(title);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${slug(title, 48 - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Every step with an id: the ones it has, then ids lent by `stored` steps of the same title, then slugs. */
export function assignStepIds<T extends { readonly id?: string; readonly title: string }>(
  steps: readonly T[],
  stored: readonly { readonly id: string; readonly title: string }[] = [],
): (T & { id: string })[] {
  const ids: (string | undefined)[] = steps.map((s) => s.id);
  const taken = new Set(ids.filter((id): id is string => id !== undefined));
  const lent = new Set<string>();
  steps.forEach((s, i) => {
    if (ids[i] !== undefined) return;
    const match = stored.find((o) => o.title === s.title && !lent.has(o.id) && !taken.has(o.id));
    if (match === undefined) return;
    ids[i] = match.id;
    lent.add(match.id);
    taken.add(match.id);
  });
  steps.forEach((s, i) => {
    if (ids[i] !== undefined) return;
    const id = fresh(s.title, taken);
    ids[i] = id;
    taken.add(id);
  });
  return steps.map((s, i) => ({ ...s, id: ids[i] as string }));
}
