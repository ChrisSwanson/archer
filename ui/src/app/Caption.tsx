/**
 * The agent's caption for the view it is presenting.
 *
 * `present_diagram` takes an `annotation`, "a caption of a few sentences". It
 * was carried all the way to the presentation state and drawn nowhere, so an
 * agent could believe it had explained a drawing to a reader looking at a page
 * with no explanation on it (adversarial review 2026-10-02, F6).
 *
 * BESIDE THE DRAWING, NOT ON IT. The caption is a block under the stage, in
 * the page's own column, in both shells. Everything else that floats over a
 * canvas -- the legend, the controls, the cue -- has to be kept off the
 * drawing by the framing, and on a narrow canvas the framing has to give up
 * (`fitPadding` caps the legend's reservation and lets it overlap). A caption
 * that takes its height out of the stage instead cannot cover anything: the
 * canvas is simply that much shorter, and it frames itself to the box it has,
 * as it does when the tab strip or the dataflow bar arrives.
 *
 * TEXT, never markup: the words are a React text node, whatever they contain.
 *
 * BOUNDED twice. The server refuses more than 500 characters; the page clamps
 * to the same number in case anything else ever sends more, and caps the
 * block's height at a share of the window, scrolling inside it, so a long
 * caption in a small pane cannot take the stage away.
 *
 * ANNOUNCED POLITELY. The region is always in the page, empty when there is
 * no caption, because a live region has to exist before its text changes for
 * the change to be read out. The caption's own element is what the stage is
 * described by (`aria-describedby`), so a screen reader entering the drawing
 * is told what the agent said about it.
 */
import { useLayoutEffect, useRef, useState, type JSX } from "react";

/** The most a caption can be: the server's own limit (`MAX_ANNOTATION_CHARS`). */
export const CAPTION_MAX_CHARS = 500;

/** The caption's element id, which the stage names in `aria-describedby`. */
export const CAPTION_ID = "archer-caption";

/**
 * What to show for an annotation: its text, trimmed and bounded, or `null`
 * when there is nothing to say. Counted in code points, as the server counts.
 */
export function captionText(annotation: string | undefined): string | null {
  if (annotation === undefined) {
    return null;
  }
  const trimmed = annotation.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const points = [...trimmed];
  return points.length <= CAPTION_MAX_CHARS ? trimmed : `${points.slice(0, CAPTION_MAX_CHARS).join("")}…`;
}

/**
 * `inHeader`: the presence line shows the caption (a short one, phase 3b), so
 * the bar is not drawn a second time. It stays in the page, visually hidden,
 * as the live region that announces the caption and the text the stage is
 * described by.
 */
export function Caption({
  text,
  inHeader = false,
}: {
  readonly text: string | null;
  readonly inHeader?: boolean;
}): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  // Whether the caption is taller than the room it is allowed, and so scrolls.
  // A region that scrolls has to be reachable from the keyboard to be read.
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const measure = (): void => {
      const element = box.current;
      // The hidden copy is clipped to a pixel, so it always "scrolls": as a tab stop it would be an invisible one.
      setScrolls(!inHeader && element !== null && element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [text, inHeader]);

  return (
    <div className="archer-caption-region" aria-live="polite" aria-atomic="true">
      {text === null ? null : (
        // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the label is set only together with the role (both conditional on the same test).
        <div
          className={inHeader ? "archer-caption-box archer-visually-hidden" : "archer-caption-box"}
          ref={box}
          tabIndex={scrolls ? 0 : undefined}
          role={scrolls ? "group" : undefined}
          aria-label={scrolls ? "Caption from the agent" : undefined}
        >
          <span className="archer-caption-by">From the agent</span>
          <p className="archer-caption" id={CAPTION_ID}>
            {text}
          </p>
        </div>
      )}
    </div>
  );
}
