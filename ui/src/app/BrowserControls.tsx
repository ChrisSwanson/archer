import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import "./BrowserControlsRefinement.css";

export type BrowserControlsProps = {
  readonly filterContent: ReactNode;
  readonly filterCount: number;
  readonly resultCount: number;
};

const LIVE_HELPER_IDS = new Set([
  "impeccable-live-root",
  "impeccable-live-annot",
  "impeccable-live-global-bar",
  "impeccable-live-pending-dock",
  "impeccable-live-highlight",
  "impeccable-live-tooltip",
  "impeccable-live-bar",
  "impeccable-live-picker",
  "impeccable-live-params-panel",
  "impeccable-live-design-host",
  "impeccable-live-toast",
  "impeccable-live-mount-error",
  "impeccable-live-edit-badge",
  "impeccable-live-shader",
]);

export function BrowserControls(props: BrowserControlsProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [portal] = useState(() => document.createElement("div"));
  const launcher = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (!open) return;
    portal.className = "archer-browser-portal";
    document.body.append(portal);
    const liveHelperInjected = [...document.querySelectorAll<HTMLScriptElement>("script[src]")].some((script) => {
      try {
        const url = new URL(script.src, document.baseURI);
        const parameters = [...url.searchParams.keys()];
        return (
          url.origin === window.location.origin &&
          url.pathname === "/__impeccable/live.js" &&
          url.hash === "" &&
          (parameters.length === 0 ||
            (parameters.length === 1 && parameters[0] === "token" && url.searchParams.get("token") !== ""))
        );
      } catch {
        return false;
      }
    });
    const backgrounds = [...document.body.children]
      .filter((element) => element !== portal && !(liveHelperInjected && LIVE_HELPER_IDS.has(element.id)))
      .map((element) => ({ element, inert: element.getAttribute("inert") }));
    for (const { element } of backgrounds) element.setAttribute("inert", "");
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      for (const { element, inert } of backgrounds) {
        if (inert === null) element.removeAttribute("inert");
        else element.setAttribute("inert", inert);
      }
      document.body.style.overflow = overflow;
      portal.remove();
      launcher.current?.focus();
    };
  }, [open, portal]);

  const keyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Keys belong to this modal, including Escape, rather than the canvas or
    // page-level search bindings behind it.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key !== "Tab") return;
    const controls = dialog.current?.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])",
    );
    if (!controls || controls.length === 0) {
      event.preventDefault();
      dialog.current?.focus();
      return;
    }
    const first = controls[0]!,
      last = controls[controls.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialog.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || active === dialog.current)) {
      event.preventDefault();
      first.focus();
    }
  };
  const show = (event: MouseEvent<HTMLButtonElement>): void => {
    launcher.current = event.currentTarget;
    setOpen(true);
  };

  const dialogContents = (headingId: string): JSX.Element => (
    <>
      <div className="archer-browser-dialog-heading">
        <h2 id={headingId}>
          <span>Project Filters</span>
          {props.filterCount > 0 ? (
            <span className="archer-browser-dialog-active-count" aria-hidden="true">
              {props.filterCount} active
            </span>
          ) : null}
        </h2>
        <button
          type="button"
          className="archer-browser-close"
          aria-label="Close filters"
          title="Close filters"
          onClick={() => setOpen(false)}
        >
          <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
            <path d="M5 5l10 10M15 5 5 15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="archer-browser-content">
        <div className="archer-browser-filter-content">{props.filterContent}</div>
      </div>
    </>
  );

  return (
    <>
      <button
        type="button"
        className="archer-browser-filter-button archer-filter-variant"
        aria-label={props.filterCount > 0 ? `Filters (${props.filterCount})` : "Filters"}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Filters"
        onClick={show}
      >
        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
          <path
            d="M4 5h12M4 10h12M4 15h12M8 3v4M13 8v4M7 13v4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <circle cx="8" cy="5" r="1.5" fill="var(--surface-2)" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="13" cy="10" r="1.5" fill="var(--surface-2)" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="7" cy="15" r="1.5" fill="var(--surface-2)" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        {props.filterCount > 0 ? (
          <span className="archer-filter-count" aria-hidden="true">
            {props.filterCount}
          </span>
        ) : null}
      </button>
      {open
        ? createPortal(
            // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop closes on a click on itself only; the keyboard closes the dialog with Escape, handled inside it.
            // biome-ignore lint/a11y/useKeyWithClickEvents: the backdrop closes on a click on itself only; the keyboard closes the dialog with Escape, handled inside it.
            <div
              className="archer-browser-overlay"
              onClick={(event) => {
                if (event.target === event.currentTarget) setOpen(false);
              }}
            >
              <div
                ref={dialog}
                className="archer-browser-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby={id}
                tabIndex={-1}
                onKeyDown={keyDown}
              >
                {dialogContents(id)}
              </div>
            </div>,
            portal,
          )
        : null}
    </>
  );
}
