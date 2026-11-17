/**
 * Reordering a table's columns by a drag handle at the left of each header
 * (or Left/Right Arrow on it, or a click that offers Move left and Move right:
 * WCAG 2.5.7, a single pointer reorders without dragging). The drag previews its landing by sliding the
 * column's cells, never by reordering the DOM mid-drag: moving the drag source
 * can cancel a native drag. Shared by the file table and the Folders tree.
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type JSX,
  type KeyboardEvent,
  type RefObject,
} from "react";

export type ColumnDragOptions<C extends string> = {
  readonly frameRef: RefObject<HTMLElement | null>;
  /** The columns as the reader can move them, in order; reported whole on a move. */
  readonly order: readonly C[];
  /** Columns that never move and never take another's place (the name). */
  readonly fixed?: (column: string) => boolean;
  readonly onReorder?: (columns: readonly C[]) => void;
  /** Header cells, each carrying `data-column`. */
  readonly headerSelector: string;
  /** Every cell of one column, its header included. */
  readonly cellSelector: (column: string) => string;
};

export function useColumnDrag<C extends string>(
  options: ColumnDragOptions<C>,
): {
  readonly frameHandlers: {
    readonly onDragOver?: (event: DragEvent<HTMLElement>) => void;
    readonly onDrop?: (event: DragEvent<HTMLElement>) => void;
  };
  readonly dragHandle: (column: string, label: string) => JSX.Element | null;
} {
  const { frameRef, order, onReorder, headerSelector, cellSelector } = options;
  const movable = (column: string): column is C => order.includes(column as C) && options.fixed?.(column) !== true;
  const drag = useRef<{ source: C; slots: { column: string; left: number; width: number }[]; target: C | null } | null>(
    null,
  );
  /** The column whose Move left / Move right choice is open, if any. */
  const [menu, setMenu] = useState<string | null>(null);
  /** After a move from the choice, the button to focus again once the column has landed. */
  const refocus = useRef<{ column: string; side: "left" | "right" } | null>(null);
  const menuId = useId();
  const cellsOf = (column: string): HTMLElement[] => [
    ...(frameRef.current?.querySelectorAll<HTMLElement>(cellSelector(column)) ?? []),
  ];
  const clearPreview = (animate: boolean): void => {
    const frame = frameRef.current;
    if (frame === null) return;
    if (!animate) frame.removeAttribute("data-column-drag");
    for (const cell of frame.querySelectorAll<HTMLElement>("[data-column]")) {
      cell.style.transform = "";
      cell.removeAttribute("data-column-dragging");
    }
    if (animate)
      setTimeout(() => {
        if (drag.current === null) frame.removeAttribute("data-column-drag");
      }, 200);
  };
  const reorder = (source: C, target: C): void => {
    if (onReorder === undefined || source === target) return;
    const next = [...order];
    const from = next.indexOf(source),
      to = next.indexOf(target);
    if (from < 0 || to < 0) return;
    next.splice(from, 1);
    next.splice(to, 0, source);
    onReorder(next);
  };
  const move = (source: C, offset: -1 | 1): void => {
    const index = order.indexOf(source);
    const neighbour = order[index + offset];
    if (onReorder === undefined || neighbour === undefined || !movable(neighbour)) return;
    const next = [...order];
    [next[index], next[index + offset]] = [neighbour, source];
    onReorder(next);
  };
  const handleOf = (column: string): HTMLButtonElement | null =>
    frameRef.current?.querySelector<HTMLButtonElement>(
      `${headerSelector}[data-column="${column}"] .archer-files-column-drag`,
    ) ?? null;
  useLayoutEffect(() => {
    const pending = refocus.current;
    if (pending === null) return;
    refocus.current = null;
    frameRef.current
      ?.querySelector<HTMLButtonElement>(
        `${headerSelector}[data-column="${pending.column}"] [data-move="${pending.side}"]`,
      )
      ?.focus();
  });
  // A press anywhere outside the open choice closes it.
  useEffect(() => {
    if (menu === null) return;
    const away = (event: PointerEvent): void => {
      const target = event.target instanceof Element ? event.target : null;
      if (
        target?.closest(`[data-column-move="${menu}"]`) == null &&
        target?.closest(`${headerSelector}[data-column="${menu}"] .archer-files-column-drag`) == null
      )
        setMenu(null);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [menu, headerSelector]);
  const start = (column: C, event: DragEvent<HTMLButtonElement>): void => {
    setMenu(null);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", column);
    const heading = event.currentTarget.closest<HTMLElement>(headerSelector);
    if (heading !== null && typeof event.dataTransfer.setDragImage === "function") {
      const box = heading.getBoundingClientRect();
      event.dataTransfer.setDragImage(heading, event.clientX - box.left, event.clientY - box.top);
    }
    const frame = frameRef.current;
    if (frame === null) return;
    const slots = [...frame.querySelectorAll<HTMLElement>(headerSelector)].map((cell) => {
      const box = cell.getBoundingClientRect();
      return { column: cell.dataset.column ?? "", left: box.left, width: box.width };
    });
    drag.current = { source: column, slots, target: null };
    frame.setAttribute("data-column-drag", "true");
    for (const cell of cellsOf(column)) cell.setAttribute("data-column-dragging", "true");
  };
  const preview = (clientX: number, over: EventTarget): void => {
    const current = drag.current;
    if (current === null) return;
    // Slots are measured before anything slides, so the pointer is matched
    // against where columns were, not where the preview has moved them.
    const measured = current.slots.some(({ width }) => width > 0);
    const heading = over instanceof Element ? over.closest<HTMLElement>(headerSelector)?.dataset.column : undefined;
    const slot =
      (measured ? current.slots.find(({ left, width }) => clientX >= left && clientX < left + width) : undefined) ??
      current.slots.find(({ column }) => column === heading);
    if (slot === undefined || !movable(slot.column) || slot.column === current.target) return;
    current.target = slot.column;
    const landing = current.slots.map(({ column }) => column);
    landing.splice(landing.indexOf(current.source), 1);
    landing.splice(
      current.slots.findIndex(({ column }) => column === slot.column),
      0,
      current.source,
    );
    if (!measured) return;
    let x = current.slots[0]!.left;
    for (const column of landing) {
      const at = current.slots.find((candidate) => candidate.column === column)!;
      const shift = x - at.left;
      for (const cell of cellsOf(column)) cell.style.transform = shift === 0 ? "" : `translateX(${shift}px)`;
      x += at.width;
    }
  };
  const frameHandlers =
    onReorder === undefined
      ? {}
      : {
          onDragOver: (event: DragEvent<HTMLElement>) => {
            if (drag.current === null) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            preview(event.clientX, event.target);
          },
          onDrop: (event: DragEvent<HTMLElement>) => {
            const current = drag.current;
            if (current === null) return;
            event.preventDefault();
            drag.current = null;
            clearPreview(false);
            if (current.target !== null) reorder(current.source, current.target);
          },
        };
  const canMove = (column: string, offset: -1 | 1): boolean => {
    const neighbour = order[order.indexOf(column as C) + offset];
    return neighbour !== undefined && movable(neighbour);
  };
  const choiceKeys =
    (column: string) =>
    (event: KeyboardEvent<HTMLElement>): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setMenu(null);
      handleOf(column)?.focus();
    };
  const dragHandle = (column: string, label: string): JSX.Element | null =>
    onReorder === undefined || !movable(column) ? null : (
      <>
        <button
          type="button"
          className="archer-files-column-drag"
          aria-label={`Move ${label} column`}
          aria-description="Drag, click for Move left and Move right, or use Left and Right Arrow keys."
          aria-expanded={menu === column}
          aria-controls={menu === column ? `${menuId}-${column}` : undefined}
          title={`Drag or click to move ${label}; arrow keys also move it`}
          draggable
          onClick={() => setMenu((open) => (open === column ? null : column))}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              move(column as C, event.key === "ArrowLeft" ? -1 : 1);
              return;
            }
            if (menu === column) choiceKeys(column)(event);
          }}
          onDragStart={(event: DragEvent<HTMLButtonElement>) => start(column as C, event)}
          onDragEnd={() => {
            if (drag.current !== null) {
              drag.current = null;
              clearPreview(true);
            }
          }}
        />
        {menu === column ? (
          <span
            id={`${menuId}-${column}`}
            role="group"
            aria-label={`Move ${label}`}
            className="archer-files-column-move"
            data-column-move={column}
            onKeyDown={choiceKeys(column)}
          >
            {(["left", "right"] as const).map((side) => {
              const offset = side === "left" ? -1 : 1;
              const able = canMove(column, offset);
              return (
                <button
                  key={side}
                  type="button"
                  data-move={side}
                  aria-disabled={able ? undefined : true}
                  onClick={() => {
                    if (!able) return;
                    refocus.current = { column, side };
                    move(column as C, offset);
                  }}
                >
                  {side === "left" ? "Move left" : "Move right"}
                </button>
              );
            })}
          </span>
        ) : null}
      </>
    );
  return { frameHandlers, dragHandle };
}
