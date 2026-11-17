import { useLayoutEffect, useRef, useState, type JSX } from "react";
import { labelKey, labelText } from "../diagrams/InlineLabelInput";
export function Pencil(): JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z" />
    </svg>
  );
}
/** One displayed value becomes its field; Enter/blur commit, Escape cancels; Shift+Enter is a line break in a text value. */
export function InlineValue(props: {
  label: string;
  value: string;
  onCommit: (value: string) => void;
  disabled?: boolean;
  choices?: readonly string[];
  onSelect?: () => void;
  selected?: boolean;
}): JSX.Element {
  const [editing, setEditing] = useState(false),
    [text, setText] = useState(props.value);
  const input = useRef<HTMLTextAreaElement | HTMLSelectElement | null>(null),
    pencil = useRef<HTMLButtonElement>(null),
    active = useRef(false);
  useLayoutEffect(() => {
    if (props.disabled && editing) {
      active.current = false;
      setEditing(false);
      return;
    }
    if (editing) {
      input.current?.focus();
      if (input.current instanceof HTMLTextAreaElement) input.current.select();
    }
  }, [editing, props.disabled]);
  const finish = (commit: boolean, focus: boolean) => {
    if (!active.current) return;
    active.current = false;
    setEditing(false);
    if (commit && text !== props.value) props.onCommit(text);
    if (focus) pencil.current?.focus();
  };
  return (
    <span className="authoring-inline">
      <button
        ref={pencil}
        className="authoring-pencil"
        type="button"
        aria-label={`Edit ${props.label}`}
        title={`Edit ${props.label}`}
        aria-disabled={props.disabled || undefined}
        onClick={() => {
          if (props.disabled) return;
          props.onSelect?.();
          setText(props.value);
          active.current = true;
          setEditing(true);
        }}
      >
        <Pencil />
      </button>
      {editing ? (
        props.choices ? (
          <select
            ref={(element) => {
              input.current = element;
            }}
            aria-label={props.label}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => finish(true, false)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Escape") {
                e.preventDefault();
                finish(e.key === "Enter", true);
              }
            }}
          >
            {props.choices.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        ) : (
          <textarea
            ref={(element) => {
              input.current = element;
            }}
            className="authoring-inline-text"
            aria-label={props.label}
            value={text}
            rows={text.split("\n").length}
            maxLength={256}
            onChange={(e) => setText(labelText(e.target.value))}
            onBlur={() => finish(true, false)}
            onKeyDown={(e) => {
              const action = labelKey(e);
              if (action !== null) {
                e.preventDefault();
                finish(action === "commit", true);
              }
            }}
          />
        )
      ) : props.onSelect ? (
        <button className="authoring-select" type="button" onClick={props.onSelect} aria-expanded={props.selected}>
          {props.value || "No label"}
        </button>
      ) : (
        <span>{props.value || "No label"}</span>
      )}
    </span>
  );
}
