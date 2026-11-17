import { useEffect, useId, useRef, useState, type FormEvent, type JSX, type KeyboardEvent } from "react";
import { NOTE_EMPHASIS_TEXT_LIMITS, type NoteEmphasisAuthor } from "./contract";

export type HighlightSaveResult = { readonly ok: true } | { readonly ok: false; readonly problem: string };
export type HighlightGroupChoice = {
  /** Stable within the note, including the named set that owns this group. */
  readonly key: string;
  readonly id: string;
  readonly label: string;
  readonly author: NoteEmphasisAuthor;
  readonly setTitle?: string;
};

export function NoteHighlightEditor(props: {
  readonly groups?: readonly HighlightGroupChoice[];
  /**
   * Colours follow group order (ADR 0030): a highlight names its group, never a colour. `typedOn` says, once the save
   * has answered, whether the label or group changed while it waited (O207): the form then stays open with them, so a
   * caller closes it only when `typedOn()` is false.
   */
  readonly onSave: (label: string, typedOn: () => boolean) => Promise<HighlightSaveResult>;
  readonly onCancel: () => void;
}): JSX.Element {
  const id = useId();
  const groups = props.groups ?? [];
  const [choice, setChoice] = useState("new");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** The label a save carried while the form stayed open with what was typed after it (O207). */
  const [savedAs, setSavedAs] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, []);
  const selected = choice === "new" ? undefined : groups.find((group) => group.key === choice);
  const missingChoice = choice !== "new" && selected === undefined;
  // What the form holds now, read after the save's await (O207).
  const current = useRef({ label, choice });
  current.current = { label, choice };
  const save = async (): Promise<void> => {
    const savedLabel = selected?.label ?? label;
    if (missingChoice || savedLabel.trim() === "" || saving) return;
    setSaving(true);
    setProblem(null);
    setSavedAs(null);
    // Only what this Save carried is done with (O207, codex-1301, as O189 for comments): a label typed or a group
    // chosen while it waited stays in the form.
    const typedOn = (): boolean =>
      current.current.choice !== choice ||
      (choice === "new" && current.current.label !== label && current.current.label.trim() !== "");
    const result = await props.onSave(savedLabel, typedOn);
    setSaving(false);
    if (!result.ok) setProblem(result.problem);
    else if (typedOn()) setSavedAs(savedLabel);
  };
  const key = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    props.onCancel();
  };
  const canSave = !missingChoice && (selected !== undefined || label.trim() !== "");
  return (
    <form
      className="primary-note-highlight-editor"
      aria-label="Highlight selection"
      onKeyDown={key}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void save();
      }}
    >
      {groups.length === 0 && !missingChoice ? null : (
        <>
          <label htmlFor={`${id}-group`}>Highlight group</label>
          <select id={`${id}-group`} value={choice} onChange={(event) => setChoice(event.target.value)}>
            <option value="new">New highlight group</option>
            {missingChoice ? (
              <option value={choice} disabled>
                Previously selected group (unavailable)
              </option>
            ) : null}
            {groups.map((group) => (
              <option key={group.key} value={group.key}>
                {group.label}
                {group.setTitle ? ` · ${group.setTitle}` : group.author === "agent" ? " · Agent review" : ""}
              </option>
            ))}
          </select>
        </>
      )}
      {selected === undefined ? (
        <>
          <label htmlFor={id}>Group label</label>
          <input
            ref={input}
            id={id}
            value={label}
            maxLength={NOTE_EMPHASIS_TEXT_LIMITS.label.chars}
            onChange={(event) => setLabel(event.target.value)}
          />
        </>
      ) : selected.author === "agent" ? (
        <p className="archer-review-quiet">
          This label came from an agent review. Your highlight will be saved in Reader highlights.
        </p>
      ) : null}
      {missingChoice ? (
        <p className="archer-review-quiet" role="alert">
          That highlight group is no longer available. Choose another group.
        </p>
      ) : null}
      {problem === null ? null : (
        <p className="archer-review-quiet" role="alert">
          {problem}
        </p>
      )}
      {savedAs === null ? null : (
        <p className="archer-review-quiet" role="status">
          Highlighted as “{savedAs}”. What you changed since is kept here: Save adds the passage under it too.
        </p>
      )}
      <div className="archer-composer-actions">
        <button
          type="submit"
          className="archer-review-button archer-review-button--primary"
          disabled={!canSave || saving}
        >
          Save
        </button>
        <button type="button" className="archer-review-button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
