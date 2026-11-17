import { useEffect, useRef, useState, type JSX } from "react";
import { dismissFilePopup, SHOWN_MS, subscribeFileUpdates, type FileUpdatesPopupState } from "./file-updates";
import "./FileUpdatesPopup.css";

const FADE_MS = 300;

/**
 * The transient "<file> updated" popup beside the notifications inbox (ADR 0028). It is not an
 * inbox entry and keeps no read state: it fades after a few seconds, paused while pointed at or
 * focused, and Dismiss removes it at once. The polite live region stays mounted so the first
 * message is announced; focus never moves.
 */
export function FileUpdatesPopup(): JSX.Element {
  const [popup, setPopup] = useState<FileUpdatesPopupState>(null);
  const [leaving, setLeaving] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () =>
      subscribeFileUpdates((next) => {
        setLeaving(false);
        setHovered(false);
        setFocused(false);
        setPopup(next);
      }),
    [],
  );
  useEffect(() => {
    if (popup === null || popup.persistent === true || hovered || focused) return;
    timer.current = setTimeout(() => {
      setLeaving(true);
      timer.current = setTimeout(() => dismissFilePopup(), FADE_MS);
    }, SHOWN_MS);
    return () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    };
  }, [popup, hovered, focused]);
  return (
    <div className="archer-file-updates-anchor">
      <div className="archer-file-updates-live" aria-live="polite" aria-atomic="true">
        {popup?.text ?? ""}
      </div>
      {popup === null ? null : (
        // biome-ignore lint/a11y/noStaticElementInteractions: hover pauses the popup's dismissal timer; it is no control and focus inside it pauses it too.
        <div
          className="archer-file-updates"
          data-leaving={leaving ? "" : undefined}
          onMouseEnter={() => {
            setHovered(true);
            setLeaving(false);
          }}
          onMouseLeave={() => setHovered(false)}
          onFocus={() => {
            setFocused(true);
            setLeaving(false);
          }}
          onBlur={() => setFocused(false)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              dismissFilePopup();
            }
          }}
        >
          <span className="archer-file-updates-text" aria-hidden="true">
            {popup.text}
          </span>
          {popup.actions?.map((action) => (
            <button
              key={action.label}
              type="button"
              className="archer-file-updates-action"
              onClick={() => {
                if (action.run() !== false) dismissFilePopup();
              }}
            >
              {action.label}
            </button>
          ))}
          <button
            type="button"
            className="archer-file-updates-dismiss"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() => dismissFilePopup()}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M6 6l8 8M14 6l-8 8" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
