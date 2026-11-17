import { useEffect, useId, useState, type ChangeEvent, type JSX } from "react";
import type { CountRange } from "./file-index";
import "./CountRangeFilter.css";

type CountOperator = "any" | "equals" | "at-least" | "at-most" | "between";
type Draft = { readonly min: string; readonly max: string };

export type CountRangeFilterProps = {
  readonly label: string;
  readonly range: CountRange | null;
  readonly onChange: (next: CountRange | null) => void;
};

const operatorOf = (range: CountRange | null): CountOperator => {
  if (range === null || (range.min === undefined && range.max === undefined)) return "any";
  if (range.min !== undefined && range.max !== undefined) return range.min === range.max ? "equals" : "between";
  return range.min !== undefined ? "at-least" : "at-most";
};

const draftOf = (range: CountRange | null): Draft => ({
  min: range?.min === undefined ? "" : String(range.min),
  max: range?.max === undefined ? "" : String(range.max),
});

const integer = (raw: string): number | undefined => {
  if (!/^\d+$/u.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

function candidate(operator: CountOperator, draft: Draft): CountRange | null | undefined {
  if (operator === "any") return null;
  const min = integer(draft.min);
  const max = integer(draft.max);
  if (operator === "equals") return min === undefined ? undefined : { min, max: min };
  if (operator === "at-least") return min === undefined ? undefined : { min };
  if (operator === "at-most") return max === undefined ? undefined : { max };
  if (min === undefined || max === undefined || min > max) return undefined;
  return { min, max };
}

function errorFor(operator: CountOperator, draft: Draft): string | null {
  const used = operator === "at-most" ? [draft.max] : operator === "between" ? [draft.min, draft.max] : [draft.min];
  if (used.some((raw) => raw !== "" && integer(raw) === undefined)) return "Enter a non-negative whole number.";
  if (operator === "between") {
    const min = integer(draft.min);
    const max = integer(draft.max);
    if (min !== undefined && max !== undefined && min > max) return "Minimum cannot exceed maximum.";
  }
  return null;
}

/** Maps readable count conditions onto the existing inclusive min/max URL contract. */
export function CountRangeFilter({ label, range, onChange }: CountRangeFilterProps): JSX.Element {
  const operatorId = useId();
  const firstId = useId();
  const secondId = useId();
  const errorId = useId();
  const [operator, setOperator] = useState<CountOperator>(() => operatorOf(range));
  const [draft, setDraft] = useState<Draft>(() => draftOf(range));

  useEffect(() => {
    setOperator(operatorOf(range));
    setDraft(draftOf(range));
  }, [range?.min, range?.max]);

  const commit = (nextOperator: CountOperator, nextDraft: Draft): void => {
    const next = candidate(nextOperator, nextDraft);
    if (next === undefined) return;
    if (next === null && range === null) return;
    if (next !== null && range !== null && next.min === range.min && next.max === range.max) return;
    onChange(next);
  };

  const changeOperator = (event: ChangeEvent<HTMLSelectElement>): void => {
    const next = event.target.value as CountOperator;
    const firstKnown = draft.min || draft.max;
    const nextDraft =
      next === "equals" || next === "at-least"
        ? { min: firstKnown, max: "" }
        : next === "at-most"
          ? { min: "", max: draft.max || draft.min }
          : next === "between"
            ? { min: draft.min, max: draft.max }
            : { min: "", max: "" };
    setOperator(next);
    setDraft(nextDraft);
    commit(next, nextDraft);
  };

  const changeDraft = (key: keyof Draft, raw: string): void => {
    const next = { ...draft, [key]: raw };
    setDraft(next);
    commit(operator, next);
  };

  const error = errorFor(operator, draft);
  const describedBy = error === null ? undefined : errorId;
  const numberInput = (key: keyof Draft, id: string, inputLabel: string): JSX.Element => (
    <label className="archer-count-range-value" htmlFor={id}>
      <span>{inputLabel}</span>
      <input
        id={id}
        type="number"
        min="0"
        step="1"
        inputMode="numeric"
        value={draft[key]}
        aria-invalid={error !== null ? "true" : undefined}
        aria-describedby={describedBy}
        onChange={(event) => changeDraft(key, event.target.value)}
      />
    </label>
  );

  return (
    <fieldset className="archer-search-facet archer-count-range">
      <legend>{label}</legend>
      <div className="archer-count-range-row">
        <label className="archer-count-range-operator" htmlFor={operatorId}>
          <span className="archer-visually-hidden">{label} condition</span>
          <select id={operatorId} value={operator} onChange={changeOperator}>
            <option value="any">Any</option>
            <option value="equals">Equals</option>
            <option value="at-least">At least</option>
            <option value="at-most">At most</option>
            <option value="between">Between</option>
          </select>
        </label>
        {operator === "equals" ? numberInput("min", firstId, "Count") : null}
        {operator === "at-least" ? numberInput("min", firstId, "Minimum") : null}
        {operator === "at-most" ? numberInput("max", firstId, "Maximum") : null}
        {operator === "between" ? (
          <div className="archer-count-range-values">
            {numberInput("min", firstId, "Minimum")}
            <span className="archer-count-range-and" aria-hidden="true">
              to
            </span>
            {numberInput("max", secondId, "Maximum")}
          </div>
        ) : null}
      </div>
      {error === null ? null : (
        <p id={errorId} className="archer-search-range-error" role="alert">
          {error} The current filter remains applied.
        </p>
      )}
    </fieldset>
  );
}
