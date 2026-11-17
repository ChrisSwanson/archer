import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";

type ScopedId = { readonly contextKey: string; readonly id: string } | null;

export type LegendFocusBindings = {
  readonly onPointerEnter: () => void;
  readonly onPointerLeave: () => void;
  readonly onPointerCancel: () => void;
  readonly onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerUp: () => void;
  readonly onMouseEnter: () => void;
  readonly onMouseLeave: () => void;
  readonly onFocus: (event: FocusEvent<HTMLElement>) => void;
  readonly onBlur: (event: FocusEvent<HTMLElement>) => void;
  readonly onClick: (event: MouseEvent<HTMLElement>) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
};

export type LegendFocus = {
  readonly previewId: string | null;
  readonly heldId: string | null;
  readonly effectiveId: string | null;
  readonly clear: () => void;
  readonly bind: (id: string) => LegendFocusBindings;
};

/** Shared transient-preview and click-to-hold behavior for emphasis legends. */
export function useLegendFocus(contextKey: string, availableIds: readonly string[]): LegendFocus {
  const [hoverPreview, setHoverPreview] = useState<ScopedId>(null);
  const [focusPreview, setFocusPreview] = useState<ScopedId>(null);
  const [held, setHeld] = useState<ScopedId>(null);
  const pointerFocus = useRef(false);
  const available = useMemo(() => new Set(availableIds), [availableIds]);
  const valid = useCallback(
    (value: ScopedId): string | null =>
      value !== null && value.contextKey === contextKey && available.has(value.id) ? value.id : null,
    [available, contextKey],
  );
  const hoverPreviewId = valid(hoverPreview);
  const focusPreviewId = valid(focusPreview);
  const previewId = hoverPreviewId ?? focusPreviewId;
  const heldId = valid(held);

  const clear = useCallback(() => {
    setHoverPreview(null);
    setFocusPreview(null);
    setHeld(null);
  }, []);

  useEffect(() => {
    if (hoverPreview !== null && hoverPreviewId === null) setHoverPreview(null);
    if (focusPreview !== null && focusPreviewId === null) setFocusPreview(null);
    if (held !== null && heldId === null) setHeld(null);
  }, [focusPreview, focusPreviewId, held, heldId, hoverPreview, hoverPreviewId]);

  const bind = useCallback(
    (id: string): LegendFocusBindings => {
      const actionable = () => available.has(id);
      const showHoverPreview = () => {
        if (actionable()) setHoverPreview({ contextKey, id });
      };
      const hideHoverPreview = () => {
        setHoverPreview((current) => (valid(current) === id ? null : current));
      };
      const showFocusPreview = () => {
        if (actionable()) setFocusPreview({ contextKey, id });
      };
      const hideFocusPreview = () => {
        setFocusPreview((current) => (valid(current) === id ? null : current));
      };
      const leavePointerPreview = () => {
        pointerFocus.current = false;
        hideHoverPreview();
      };
      return {
        onPointerEnter: showHoverPreview,
        onPointerLeave: leavePointerPreview,
        onPointerCancel: leavePointerPreview,
        // React's mouse events keep the behavior testable in jsdom and cover
        // older mouse-only hosts; pointer events cover pen and touch-capable UIs.
        onMouseEnter: showHoverPreview,
        onMouseLeave: leavePointerPreview,
        onPointerDown: () => {
          pointerFocus.current = true;
          hideFocusPreview();
        },
        onPointerUp: () => {
          pointerFocus.current = false;
        },
        onFocus: () => {
          if (!pointerFocus.current) showFocusPreview();
        },
        onBlur: hideFocusPreview,
        onClick: (event) => {
          pointerFocus.current = false;
          if (!actionable()) return;
          if (event.detail === 0) hideFocusPreview();
          setHeld((current) => (valid(current) === id ? null : { contextKey, id }));
        },
        onKeyDown: (event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          clear();
          event.currentTarget.blur();
        },
      };
    },
    [available, clear, contextKey, valid],
  );

  return { previewId, heldId, effectiveId: previewId ?? heldId, clear, bind };
}
