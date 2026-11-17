/**
 * The Mermaid source as an editor: line numbers, colouring, the compiler's problems underlined on
 * their lines with a gutter mark, quick fixes in the problem's tooltip, search (Ctrl/Cmd+F) and Tab
 * to indent. Escape, then Tab, leaves the editor (CodeMirror's tab-focus mode), so the keyboard is
 * never trapped.
 *
 * Controlled: `value` is the document, `onChange` hears each edit. A new `value` from outside (an
 * edit on the canvas, a reload) replaces the text without entering the editor's undo history, so
 * Ctrl+Z here undoes only what was typed here.
 *
 * Load it through `./lazy` (a dynamic import), never statically from page code: CodeMirror is
 * evaluated only when a source is first shown.
 */
import { useEffect, useRef, type JSX } from "react";
import { Annotation, Compartment, EditorState, Transaction, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, StreamLanguage, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { lintGutter, lintKeymap, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { tags } from "@lezer/highlight";
import { fixLabel, placeDiagnostics, type SourceFix } from "./diagnostics";
import { mermaidStreamParser } from "./mermaid-language";
import "./source-editor.css";

export interface MermaidSourceEditorProps {
  readonly value: string;
  readonly onChange?: (value: string) => void;
  /** Shown and selectable, searchable and copyable, but not editable. */
  readonly readOnly?: boolean;
  /** The text box's accessible name. */
  readonly ariaLabel: string;
  readonly ariaDescribedBy?: string;
  /** The id of the editable element, for a `<label htmlFor>`'s sake and for tests. */
  readonly id?: string;
  /** The compiler's diagnostics for `value`, as the server sent them. */
  readonly diagnostics?: readonly unknown[];
  /** Apply a diagnostic's machine fix (`{operation:'add-edge-ids'}`); without it no fix is offered. */
  readonly onFix?: (fix: SourceFix) => void;
  readonly className?: string;
  /** Hears the view once it exists (focus, tests); null when it goes. */
  readonly onView?: (view: EditorView | null) => void;
}

/** Marks a transaction that brought `value` in from outside: it is not the person's typing. */
const external = Annotation.define<boolean>();

const mermaid = StreamLanguage.define(mermaidStreamParser);

const colours = HighlightStyle.define([
  { tag: tags.heading, class: "cm-mmd-header" },
  { tag: tags.keyword, class: "cm-mmd-keyword" },
  { tag: tags.operator, class: "cm-mmd-arrow" },
  { tag: tags.string, class: "cm-mmd-label" },
  { tag: tags.comment, class: "cm-mmd-comment" },
  { tag: tags.meta, class: "cm-mmd-directive" },
  { tag: tags.variableName, class: "cm-mmd-id" },
  { tag: tags.labelName, class: "cm-mmd-edge-id" },
  { tag: [tags.typeName, tags.atom], class: "cm-mmd-type" },
  { tag: tags.number, class: "cm-mmd-number" },
  { tag: [tags.bracket, tags.punctuation], class: "cm-mmd-punctuation" },
]);

function toCodeMirror(
  text: string,
  diagnostics: readonly unknown[] | undefined,
  onFix: ((fix: SourceFix) => void) | undefined,
): Diagnostic[] {
  const length = text.length;
  return placeDiagnostics(text, diagnostics).map((d) => {
    const fix = d.fix;
    return {
      from: Math.min(d.from, length),
      to: Math.min(d.to, length),
      severity: d.severity,
      message: d.message,
      ...(d.code ? { source: d.code } : {}),
      ...(fix && onFix ? { actions: [{ name: fixLabel(fix), apply: () => onFix(fix) }] } : {}),
    };
  });
}

function editability(readOnly: boolean): Extension {
  return readOnly ? [EditorState.readOnly.of(true)] : [keymap.of([indentWithTab])];
}

export function MermaidSourceEditor(props: MermaidSourceEditorProps): JSX.Element {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const modes = useRef({ edit: new Compartment(), attributes: new Compartment() });

  const attributes = (): Extension =>
    EditorView.contentAttributes.of({
      "aria-label": props.ariaLabel,
      ...(props.ariaDescribedBy ? { "aria-describedby": props.ariaDescribedBy } : {}),
      ...(props.id ? { id: props.id } : {}),
      ...(props.readOnly ? { "aria-readonly": "true" } : {}),
    });

  useEffect(() => {
    const parent = host.current;
    if (parent === null) return;
    const created = new EditorView({
      parent,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          drawSelection(),
          indentUnit.of("    "),
          EditorState.tabSize.of(4),
          mermaid,
          syntaxHighlighting(colours),
          search({ top: true }),
          highlightSelectionMatches(),
          lintGutter(),
          modes.current.edit.of(editability(Boolean(latest.current.readOnly))),
          modes.current.attributes.of(attributes()),
          keymap.of([...searchKeymap, ...lintKeymap, ...historyKeymap, ...defaultKeymap]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged || update.transactions.some((t) => t.annotation(external))) return;
            latest.current.onChange?.(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = created;
    latest.current.onView?.(created);
    return () => {
      latest.current.onView?.(null);
      created.destroy();
      view.current = null;
    };
  }, []);

  // Text from outside: replace what differs, keep the cursor where it still fits.
  useEffect(() => {
    const current = view.current;
    if (current === null) return;
    const doc = current.state.doc.toString();
    if (doc === props.value) return;
    let start = 0;
    while (start < doc.length && start < props.value.length && doc.charCodeAt(start) === props.value.charCodeAt(start))
      start += 1;
    let endOld = doc.length,
      endNew = props.value.length;
    while (endOld > start && endNew > start && doc.charCodeAt(endOld - 1) === props.value.charCodeAt(endNew - 1)) {
      endOld -= 1;
      endNew -= 1;
    }
    current.dispatch({
      changes: { from: start, to: endOld, insert: props.value.slice(start, endNew) },
      annotations: [external.of(true), Transaction.addToHistory.of(false)],
    });
  }, [props.value]);

  useEffect(() => {
    view.current?.dispatch({
      effects: [
        modes.current.edit.reconfigure(editability(Boolean(props.readOnly))),
        modes.current.attributes.reconfigure(attributes()),
      ],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `attributes` reads exactly these props.
  }, [props.readOnly, props.ariaLabel, props.ariaDescribedBy, props.id]);

  // Placed on the text as it is now; later typing moves them along with the text they mark.
  useEffect(() => {
    const current = view.current;
    if (current === null) return;
    current.dispatch(
      setDiagnostics(
        current.state,
        toCodeMirror(
          current.state.doc.toString(),
          props.diagnostics,
          props.onFix ? (fix) => latest.current.onFix?.(fix) : undefined,
        ),
      ),
    );
  }, [props.diagnostics, Boolean(props.onFix)]);

  return (
    <div
      ref={host}
      className={`archer-mermaid-editor${props.className ? ` ${props.className}` : ""}${props.readOnly ? " is-readonly" : ""}`}
    />
  );
}

export default MermaidSourceEditor;
