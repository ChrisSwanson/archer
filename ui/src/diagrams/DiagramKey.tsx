/* @jsxRuntime automatic */
/* @jsxImportSource react */
/** A key describes only the notation present in the drawing on screen. */
import { KeySymbol } from "../export/KeySymbol";
import { browserStateKey } from "../runtime/address.ts";
import { useId, useLayoutEffect, useRef, useState, type JSX } from "react";
import { MoveHandle, useMovable } from "../chat/movable";
import { diagramKeyEntries, type KeyModel } from "./key-entries";
import { DockSideGlyph, PopOutGlyph } from "./ControlGlyphs";
import { type PaletteKeyRow, paletteKeyRows } from "./palette-key";

export {
  authoredLineKey,
  authoredLineLabel,
  diagramKeyEntries,
  keyOfDrawing,
  type KeyEntry,
  type KeyModel,
} from "./key-entries";

/** Where a viewer's choice to open or close the key is kept (this browser only). */
export const KEY_OPEN_STORAGE = "archer.diagram-key.open";
/** Where a viewer moved the key to, as fractions of the window (this browser only). */
export const KEY_POSITION_STORAGE = "archer.diagram-key.position";
/** A stage smaller than this starts the floating key closed to its header (G2). */

function rememberedOpen(): boolean | null {
  try {
    const value = window.localStorage.getItem(browserStateKey(KEY_OPEN_STORAGE));
    return value === "true" ? true : value === "false" ? false : null;
  } catch {
    return null;
  }
}
function rememberOpen(open: boolean): void {
  try {
    window.localStorage.setItem(browserStateKey(KEY_OPEN_STORAGE), String(open));
  } catch {
    // Storage refused (private window, blocked site data): the choice lasts this page only.
  }
}

/** The rows the key shows, the author's line meanings first: what no notation can tell the reader. */
/**
 * Whether the Key is shown: it has a row to give -- a colour, a notation's mark -- or the drawing has groups. A plain
 * group has no row of its own (its frame and caption say what it is, f472e318), but its drawing keeps the Key and the
 * side panel it sits in (lead's decision, 2026-11-12): the panel keeps the canvas one width from diagram to diagram,
 * carries the reader-blue / agent-amber note and is where the review docks. A flowchart of plain shapes and arrows
 * alone still shows none (2026-10-21).
 */
export function keyShown(model: KeyModel, omitLinePatterns: boolean): boolean {
  if (model.type === "graph" && (paletteKeyRows(model.view).length > 0 || model.view.groups.length > 0)) return true;
  return keyRows(model, omitLinePatterns).length > 0;
}

export function keyRows(model: KeyModel, omitLinePatterns: boolean): ReturnType<typeof diagramKeyEntries> {
  const priorities = [
    "Database",
    "Queue",
    "External",
    "Person",
    "Architecture group",
    "Score rail",
    "Satisfaction score",
  ];
  const priority = (label: string): number => {
    if (/^(Dotted|Dashed|Dash-dot|Thick) line: /.test(label)) return -1;
    const rank = priorities.indexOf(label);
    return rank < 0 ? priorities.length : rank;
  };
  return [...diagramKeyEntries(model, { omitLinePatterns })].sort((a, b) => priority(a.label) - priority(b.label));
}

/** Where the key is: floating over the drawing (moved like the chat bubble), the side panel's bottom section, or the phone's sheet. */
export type KeyPlacement = "floating" | "panel" | "sheet";

/**
 * The diagram key: what the notation on screen means.
 *
 * In a diagram stage it is the side panel's bottom section (0.6.4, D5; `app/diagram-panel.tsx`): a heading
 * that opens and closes its rows, and `↗` to pop it out. Popped out (and in the editor) it floats in the
 * drawing's lower-left corner, just inside the toolbar, and can be moved; `onDock` puts it back. It opens to
 * its rows wherever it appears (owner, 2026-11-12); a tap toggles it, and the viewer's choice is remembered. While a walkthrough is open (`suspended`) it starts closed,
 * for the steps. In the phone's sheet the rows are simply shown.
 */
export function DiagramKey({
  model,
  omitLinePatterns = false,
  suspended = false,
  placement = "floating",
  onPopOut,
  onDock,
}: {
  readonly model: KeyModel;
  /** While an emphasis legend is up its Key says these, so this key does not say them twice. */
  readonly omitLinePatterns?: boolean;
  /** A walkthrough is open: the key starts closed to its header, and the viewer's remembered choice is kept for after. */
  readonly suspended?: boolean;
  readonly placement?: KeyPlacement;
  /** In the panel: take the key out as the floating box. */
  readonly onPopOut?: () => void;
  /** Floating: put the key back in the panel. */
  readonly onDock?: () => void;
}): JSX.Element | null {
  const colours = model.type === "graph" ? paletteKeyRows(model.view) : [];
  // A kind's colour row carries its notation row's glyph and meaning: the kind is said once.
  const merged = new Set(colours.flatMap((row) => (row.glyph === undefined ? [] : [row.glyph])));
  const notation = keyRows(model, omitLinePatterns);
  const meaningOf = new Map(notation.map((e) => [e.label, e.meaning]));
  const entries = notation.filter((e) => !merged.has(e.label));
  const floating = placement === "floating";
  // `null` until the stage is measured: the floating key is drawn closed for that one layout pass.
  const [open, setOpen] = useState<boolean | null>(null);
  // Opened by the person while a walkthrough folds it: for this walkthrough only, not remembered.
  const [unfolded, setUnfolded] = useState(false);
  const chosen = useRef(false);
  const id = useId();
  const movable = useMovable({ storageKey: KEY_POSITION_STORAGE, label: "Diagram Key", enabled: floating });
  const button = useRef<HTMLButtonElement>(null);
  const shown = keyShown(model, omitLinePatterns);
  useLayoutEffect(() => {
    setUnfolded(false);
  }, [suspended]);
  useLayoutEffect(() => {
    if (!shown || placement === "sheet" || chosen.current) return;
    const remembered = rememberedOpen();
    if (remembered !== null) {
      setOpen(remembered);
      return;
    }
    // Expanded by default wherever it appears (owner, 2026-11-12); the reader's own choice, above, is remembered.
    setOpen(true);
  }, [shown, placement]);
  if (!shown) return null;
  const rows = (
    <>
      {colours.length > 0 ? <PaletteRows rows={colours} meaningOf={meaningOf} /> : null}
      {entries.length > 0 ? (
        <dl>
          {entries.map((e) => (
            <div key={e.label}>
              <dt>
                <KeySymbol label={e.label} />
                {e.label}
              </dt>
              <dd>{e.meaning}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </>
  );
  const voices = (
    <p className="archer-diagram-key-voices">
      Blue marks your selection and comments. Amber marks the agent's replies. Agent highlights have their own labelled
      key.
    </p>
  );
  if (placement === "sheet") {
    return (
      <section aria-labelledby={`${id}-h`} className="archer-diagram-key" data-placement="sheet" data-open="true">
        <h2 id={`${id}-h`} className="archer-diagram-key-title">
          Diagram Key
        </h2>
        <div className="archer-diagram-key-panel" role="group" aria-label="Diagram symbols">
          {rows}
          {voices}
        </div>
      </section>
    );
  }
  const expanded = suspended ? unfolded : open === true;
  const toggle = (next: boolean): void => {
    if (suspended) {
      setUnfolded(next);
      return;
    }
    chosen.current = true;
    setOpen(next);
    rememberOpen(next);
  };
  const disclosure = (
    <button ref={button} type="button" aria-expanded={expanded} aria-controls={id} onClick={() => toggle(!expanded)}>
      <span>Diagram Key</span>
      <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16">
        <path d={expanded ? "M3 8h10" : "M3 8h10M8 3v10"} stroke="currentColor" fill="none" />
      </svg>
    </button>
  );
  const action = (label: string, glyph: JSX.Element, act: (() => void) | undefined): JSX.Element | null =>
    act === undefined ? null : (
      <button type="button" className="archer-diagram-key-action" aria-label={label} title={label} onClick={act}>
        {glyph}
      </button>
    );
  return (
    <section
      ref={movable.ref}
      role="region"
      aria-label="Diagram Key"
      className="archer-diagram-key"
      data-placement={placement}
      data-open={expanded ? "true" : "false"}
      {...(movable.moved ? { "data-moved": "" } : {})}
      style={movable.style}
      onKeyDown={(event) => {
        if (event.key === "Escape" && expanded) {
          event.stopPropagation();
          toggle(false);
          button.current?.focus();
        }
      }}
    >
      <div className="archer-diagram-key-head">
        {floating ? <MoveHandle movable={movable} /> : null}
        {floating ? disclosure : <h2 className="archer-diagram-key-title">{disclosure}</h2>}
        {floating
          ? action("Dock diagram key", <DockSideGlyph />, onDock)
          : action("Pop out diagram key", <PopOutGlyph />, onPopOut)}
      </div>
      <div
        id={id}
        className="archer-diagram-key-panel"
        role="group"
        aria-label="Diagram symbols"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container is a Tab stop so a keyboard can scroll it (axe scrollable-region-focusable; UI_UX.md, RS1-02).
        tabIndex={0}
        hidden={!expanded}
      >
        {rows}
        {voices}
      </div>
    </section>
  );
}

/**
 * The colours the drawing uses (DESIGN.md, "The Key"): each row a real sample -- a card in its members'
 * fill and border, or a group's panel, dashed where they are -- its name, and its members behind a
 * disclosure. A kind's row keeps its notation glyph and meaning.
 */
function PaletteRows({
  rows,
  meaningOf,
}: {
  readonly rows: readonly PaletteKeyRow[];
  readonly meaningOf: ReadonlyMap<string, string>;
}): JSX.Element {
  return (
    <div className="archer-key-palette" role="group" aria-label="Colours">
      <dl>
        {rows.map((row) => {
          const meaning = row.glyph === undefined ? undefined : meaningOf.get(row.glyph);
          return (
            <div key={row.key} className="archer-key-palette-row" data-key-row={row.key}>
              <dt>
                <span
                  className="archer-key-swatch"
                  data-sample={row.swatch.sample}
                  aria-hidden="true"
                  style={{
                    backgroundColor: row.swatch.fill,
                    borderColor: row.swatch.border,
                    borderStyle: row.swatch.dashed ? "dashed" : "solid",
                  }}
                />
                <span className="archer-key-palette-name">
                  {row.glyph === undefined ? null : <KeySymbol label={row.glyph} />}
                  {row.label}
                </span>
              </dt>
              <dd>
                <span className="archer-key-palette-detail">{meaning ?? row.detail}</span>
                <Members row={row} />
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

/** A row's members by name, behind one button (as the highlights legend's Members). */
function Members({ row }: { readonly row: PaletteKeyRow }): JSX.Element {
  // A native disclosure: the browser keeps its state and says it, and it is not a control the phone's
  // sheet starts on (`stage-dock.tsx` focuses the sheet's Close, then Tab reaches the scrolling body).
  // The names are written only while open, as the highlights legend's are: a closed Key does not repeat
  // every element's name in the page.
  const [open, setOpen] = useState(false);
  return (
    <details className="archer-key-palette-members" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <svg className="archer-key-members-chevron" viewBox="0 0 10 10" width={10} height={10} aria-hidden="true">
          <path d="M3,2 L7,5 L3,8" />
        </svg>
        Members<span className="archer-visually-hidden"> of {row.label}</span>
      </summary>
      {open ? (
        <ul>
          {row.members.map((member) => (
            <li key={`${member.channel}:${member.id}`}>
              {member.label}
              {member.channel === "group" ? " (group)" : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}
