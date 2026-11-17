import { useLayoutEffect, type RefObject } from "react";

/**
 * Keep the editor tall enough for its whole value, including initial edit
 * text and wrapping after its panel changes width. Its rows and CSS minimum
 * still set the empty height; the review panel owns scrolling for long text.
 * Measuring changes no value, focus or selection.
 */
export function useAutosizeTextarea(ref: RefObject<HTMLTextAreaElement | null>, value: string): void {
  useLayoutEffect(() => {
    const area = ref.current;
    if (area === null) return;
    fit(area);
  }, [ref, value]);

  useLayoutEffect(() => {
    const area = ref.current;
    if (area === null) return;
    let width = area.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const next = area.getBoundingClientRect().width;
      // Setting height also notifies ResizeObserver. Only a new width can
      // change wrapping; ignoring height prevents a feedback loop.
      if (next === width) return;
      width = next;
      fit(area);
    });
    observer.observe(area);
    // A loaded face can change wrapping without changing the editor width.
    let disposed = false;
    const onFonts = (): void => {
      if (!disposed) fit(area);
    };
    void document.fonts?.ready.then(onFonts);
    document.fonts?.addEventListener("loadingdone", onFonts);
    return () => {
      disposed = true;
      observer.disconnect();
      document.fonts?.removeEventListener("loadingdone", onFonts);
    };
  }, [ref]);
}

function fit(area: HTMLTextAreaElement): void {
  // Reset to the intrinsic row height before measuring, so deleting text
  // shrinks the editor instead of measuring its previous tall box.
  area.style.height = "auto";
  const style = getComputedStyle(area);
  const px = (value: string): number => Number.parseFloat(value) || 0;
  const borders =
    style.boxSizing === "border-box"
      ? px(style.borderTopWidth) + px(style.borderBottomWidth)
      : -px(style.paddingTop) - px(style.paddingBottom);
  area.style.height = `${area.scrollHeight + borders}px`;
}
