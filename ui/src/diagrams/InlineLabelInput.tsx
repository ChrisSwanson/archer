import { useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";

/**
 * A label as typed: a line break is the one control character a label keeps (the source writes it `<br/>`).
 * A pasted Windows or old-Mac line break becomes `\n`; a tab or any other control character becomes a space.
 */
export function labelText(typed: string): string {
  // eslint-disable-next-line no-control-regex
  return typed.replace(/\r\n?/gu, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/gu, " ");
}

/** Enter commits and Escape cancels a label field; Shift+Enter is left to the field (a line break). Composing (an IME) is never a commit. */
export function labelKey(event: {
  key: string;
  shiftKey: boolean;
  nativeEvent: { isComposing?: boolean };
}): "commit" | "cancel" | null {
  if (event.nativeEvent.isComposing === true) return null;
  if (event.key === "Escape") return "cancel";
  return event.key === "Enter" && !event.shiftKey ? "commit" : null;
}

/** The label typed in place: Enter or leaving keeps it, Shift+Enter starts a new line, Escape keeps the old one. */
export function InlineLabelInput({
  label,
  value,
  onCommit,
  onClose,
}: {
  label: string;
  value: string;
  onCommit: (text: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [text, setText] = useState(value);
  const input = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const [sent, setSent] = useState(false);
  const finish = (keep: boolean): void => {
    if (done.current) return;
    done.current = true;
    const typed = text.trim();
    if (keep && typed !== value.trim()) {
      // Keep showing the new text until the saved label arrives, so the old one never flashes back.
      setText(typed);
      onCommit(typed);
      setSent(true);
      input.current?.blur();
      return;
    }
    onClose();
  };
  useEffect(() => {
    if (!sent) return;
    if (value.trim() === text.trim()) {
      onClose();
      return;
    }
    // A slow change still closes the field; the label shows what was kept. (A refusal closes it at once: the editor stops editing.)
    const timer = setTimeout(() => onClose(), 4000);
    return () => clearTimeout(timer);
  }, [sent, value, text]); // eslint-disable-line react-hooks/exhaustive-deps
  // Focus and select once, when the field opens; typing must not reselect.
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  // The field grows with its lines (and with long lines wrapping), never a scrolled box.
  useLayoutEffect(() => {
    const field = input.current;
    if (!field) return;
    field.style.height = "auto";
    if (field.scrollHeight > 0) field.style.height = `${field.scrollHeight}px`;
  }, [text]);
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => {
    // Clicking anywhere else on the page keeps the text, as leaving the field does.
    const outside = (event: PointerEvent): void => {
      if (!input.current?.contains(event.target as globalThis.Node)) finishRef.current(true);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, []);
  const lines = text.split("\n");

  return (
    <textarea
      ref={input}
      className="archer-node-label-input nodrag nopan"
      aria-label={label}
      maxLength={256}
      value={text}
      rows={lines.length}
      cols={Math.max(4, ...lines.map((line) => line.length))}
      spellCheck={false}
      onChange={(event) => setText(labelText(event.target.value))}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      readOnly={sent}
      onBlur={(event) => {
        if (done.current) return;
        // Selecting the node focuses its wrapper; that is not the typist leaving.
        const node = event.currentTarget.closest(".react-flow__node, .archer-edge-label");
        if (event.relatedTarget === null || node?.contains(event.relatedTarget as globalThis.Node)) {
          const field = event.currentTarget;
          requestAnimationFrame(() => {
            if (!done.current) field.focus();
          });
          return;
        }
        finish(true);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        // Sent and waiting for the saved label: Escape still closes the field (the label shows what was kept).
        if (sent) {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
          return;
        }
        const action = labelKey(event);
        if (action !== null) {
          event.preventDefault();
          finish(action === "commit");
        }
      }}
    />
  );
}
