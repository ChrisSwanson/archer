import { useCallback, useEffect, useId, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { editorHref } from "../authoring/address";
import {
  EditOff,
  EditOnDesktop,
  EditRequest,
  EditUnavailable,
  useEditReach,
  useRefocus,
} from "../authoring/edit-reach";
import { menuKeys } from "./menu-keys";
import { NARROW_QUERY, useMediaQuery } from "./media";
import "./NewMenu.css";

/**
 * New, at the end of the project page's tab row and in the diagram and note pages' header (D6).
 * Server capability is not entitlement: the menu opens only once the service answers that this
 * browser may author. Without an editing grant, New stays visible and explains how to get one;
 * with editing turned off (ADR 0028) a "Read & comment" cue says where; when the status cannot be
 * read, New says so and tries again; nothing while the first answer is on its way.
 */
export function NewMenu({
  projectSlug,
  projectName,
}: {
  projectSlug: string;
  projectName: string;
}): JSX.Element | null {
  const reach = useEditReach(projectSlug);
  const [open, setOpen] = useState<"first" | "last" | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  // The editor is read-only on a phone (ADR 0027), so New would lead to a draft nobody can edit there: a note says so.
  const phone = useMediaQuery(NARROW_QUERY);
  const take = useRefocus("new");
  const setButton = useCallback(
    (node: HTMLButtonElement | null) => {
      button.current = node;
      take(node);
    },
    [take],
  );

  const items = (): HTMLElement[] => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  const close = (refocus: boolean) => {
    setOpen(null);
    if (refocus) button.current?.focus();
  };

  useEffect(() => {
    if (open === null) return;
    const all = items();
    (open === "first" ? all[0] : all[all.length - 1])?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(null);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  if (reach.kind === "unknown") return null;
  if (reach.kind === "off") return <EditOff reason={reach.reason} as="new" />;
  if (phone) return <EditOnDesktop />;
  if (reach.kind === "failed") return <EditUnavailable as="new" failures={reach.failures} />;
  if (reach.kind === "request") return <EditRequest projectName={projectName} as="new" />;
  const href = editorHref(projectSlug, null);
  if (href === null) return null;

  const buttonKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(event.key === "ArrowDown" ? "first" : "last");
    }
  };
  const menuKey = (event: KeyboardEvent<HTMLDivElement>) => menuKeys(event, items(), close);

  return (
    <div ref={root} className="archer-new">
      <button
        ref={setButton}
        type="button"
        className="archer-new-button"
        aria-label="New"
        aria-haspopup="menu"
        aria-expanded={open !== null}
        aria-controls={open === null ? undefined : `${id}-menu`}
        onClick={() => setOpen(open === null ? "first" : null)}
        onKeyDown={buttonKey}
      >
        <span aria-hidden="true" className="archer-new-plus">
          +
        </span>
        <span aria-hidden="true" className="archer-new-label">
          New
        </span>
        <span aria-hidden="true" className="archer-new-caret">
          ▾
        </span>
      </button>
      {open === null ? null : (
        <div className="archer-new-popup">
          <div
            ref={menu}
            id={`${id}-menu`}
            role="menu"
            aria-label="New"
            aria-describedby={`${id}-foot`}
            onKeyDown={menuKey}
          >
            <a
              role="menuitem"
              tabIndex={-1}
              className="archer-new-item"
              href={href}
              aria-labelledby={`${id}-diagram`}
              aria-describedby={`${id}-diagram-detail`}
            >
              <svg className="archer-new-icon" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
                <rect x="2.5" y="3" width="6" height="5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
                <rect
                  x="11.5"
                  y="12"
                  width="6"
                  height="5"
                  rx="1.2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <path
                  d="M5.5 8v3.5a1 1 0 0 0 1 1h5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
              <span className="archer-new-text">
                <span id={`${id}-diagram`} className="archer-new-title">
                  Diagram
                </span>
                <span id={`${id}-diagram-detail`} className="archer-new-detail">
                  A new .mmd file in diagrams/. Pick flowchart, sequence, C4 and more.
                </span>
              </span>
            </a>
          </div>
          <p id={`${id}-foot`} className="archer-new-foot">
            Nothing is written to the repository until you Save.
          </p>
        </div>
      )}
    </div>
  );
}
