/**
 * The source editor, loaded on first use (CodeMirror is evaluated only when a source is shown).
 *
 * The page is one file, so the dynamic import stays inline: what it saves is evaluating CodeMirror
 * on every reading page. Until it arrives a caller shows the text plainly (`useSourceEditor()` is
 * null), so the source never waits on the editor.
 */
import { useEffect, useState, type ComponentType } from "react";
import type { MermaidSourceEditorProps } from "./MermaidSourceEditor";

export type { MermaidSourceEditorProps } from "./MermaidSourceEditor";
export type { SourceFix } from "./diagnostics";

type Editor = ComponentType<MermaidSourceEditorProps>;
let loaded: Editor | null = null;
let pending: Promise<Editor> | null = null;

/** Starts loading the editor (idempotent); resolves to its component. */
export function preloadSourceEditor(): Promise<Editor> {
  pending ??= import("./MermaidSourceEditor").then(
    (module) => {
      loaded = module.MermaidSourceEditor;
      return loaded;
    },
    (error: unknown) => {
      pending = null;
      throw error;
    },
  );
  return pending;
}

/** The editor component once loaded, else null (and loading starts). */
export function useSourceEditor(): Editor | null {
  const [editor, setEditor] = useState<Editor | null>(() => loaded);
  useEffect(() => {
    if (editor !== null) return;
    let live = true;
    preloadSourceEditor().then(
      (component) => {
        if (live) setEditor(() => component);
      },
      (error: unknown) => console.error("[archer] loading the source editor failed", error),
    );
    return () => {
      live = false;
    };
  }, [editor]);
  return editor ?? loaded;
}
