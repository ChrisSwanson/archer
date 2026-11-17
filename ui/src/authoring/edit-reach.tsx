import { useCallback, useEffect, useId, useRef, useState, type JSX, type ReactNode } from "react";
import { authoringStatus } from "./status-cache";
import "./edit-reach.css";

/**
 * Editing reach (0.6.4 D6): what this browser may do about editing, as New and Edit show it.
 * `unknown` until the service answers: nothing is offered for that moment.
 * `failed`: the status could not be read; New and Edit stay, say so and try again (D6: always visible).
 * They never act on it: only an answer with a grant exposes the editor (ADR 0025).
 * `request`: this page was not opened with a sign-in link or pairing code (an older token address, say), which reads but cannot edit.
 * `off`: editing is turned off (ADR 0028): `edit = false` in the project's or the account's archer.toml, or the account's rules.
 */
export type EditReach =
  | { readonly kind: "unknown" }
  | { readonly kind: "failed"; readonly failures: number }
  | { readonly kind: "edit" }
  | { readonly kind: "request" }
  | { readonly kind: "off"; readonly reason: OffReason };
/** Who turned editing off: the project's archer.toml `edit`, the account's (`global`), or a `[[projects]]` rule (`account`). */
export type OffReason = "project" | "global" | "account";
type Trigger = "new" | "edit";

const UNKNOWN: EditReach = { kind: "unknown" };
/** Every mounted reach, so one "Try again" asks for all of them (New and Edit share the one status read). */
const askers = new Set<() => void>();
/** The trigger whose "Try again" was pressed: the control that replaces it takes focus. */
let refocus: Trigger | null = null;

export function useEditReach(projectSlug: string): EditReach {
  const [reach, setReach] = useState<EditReach>(UNKNOWN);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const again = (): void => setAttempt((n) => n + 1);
    askers.add(again);
    return () => {
      askers.delete(again);
    };
  }, []);
  useEffect(() => {
    let live = true;
    void authoringStatus().then(
      (status) => {
        if (!live) return;
        if (!status.authorized) setReach({ kind: "request" });
        else if (!status.edit.enabled)
          setReach({
            kind: "off",
            reason:
              status.edit.reason === "account" || status.edit.reason === "global" ? status.edit.reason : "project",
          });
        else setReach({ kind: "edit" });
      },
      () => {
        if (!live) return;
        refocus = null;
        setReach((was) => ({ kind: "failed", failures: was.kind === "failed" ? was.failures + 1 : 1 }));
      },
    );
    return () => {
      live = false;
    };
  }, [projectSlug, attempt]);
  return reach;
}

/** Takes focus on mount when it replaces the trigger whose "Try again" was pressed. */
export function useRefocus(as: Trigger): (node: HTMLElement | null) => void {
  return useCallback(
    (node: HTMLElement | null) => {
      if (node === null || refocus !== as) return;
      refocus = null;
      node.focus();
    },
    [as],
  );
}

/** Where the README explains editing in the browser; one place, so the page and the README cannot drift apart. */
export const EDITING_HELP_URL = "https://github.com/chrisswanson/archer#editing-diagrams-in-the-browser";
/** The sentence the reader hands their agent. */
export const editingRequest = (projectName: string): string => `Please give me a new Archer link for ${projectName}.`;

/**
 * A button that opens a short explanation beside it (a non-modal dialog): Escape or a click outside
 * closes it and focus goes back to the button.
 */
function Explained({
  trigger,
  title,
  className,
  as,
  children,
  off,
}: {
  trigger: ReactNode;
  title: string;
  className: string;
  as: Trigger;
  children: ReactNode;
  off?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const take = useRefocus(as);
  const setButton = useCallback(
    (node: HTMLButtonElement | null) => {
      button.current = node;
      take(node);
    },
    [take],
  );
  const dialog = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    dialog.current?.querySelector<HTMLElement>("button, a")?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", onEscape, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", onEscape, true);
    };
  }, [open]);
  return (
    <span ref={root} className="archer-reach">
      <button
        ref={setButton}
        type="button"
        className={className}
        {...(off === undefined ? {} : { "aria-disabled": true, title: off, "data-off": "" })}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        {trigger}
      </button>
      {open ? (
        <div ref={dialog} id={id} role="dialog" aria-labelledby={`${id}-title`} className="archer-reach-popup">
          <h2 id={`${id}-title`} className="archer-reach-title">
            {title}
          </h2>
          {children}
        </div>
      ) : null}
    </span>
  );
}

/** Copies `text`; where the Clipboard API is missing (plain HTTP on a LAN), selects it and copies the selection. */
async function copyText(text: string, element: HTMLElement | null): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall back below */
  }
  if (element === null) return false;
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  }
}

function RequestBody({ projectName }: { projectName: string }): JSX.Element {
  const sentence = editingRequest(projectName);
  const [copied, setCopied] = useState<"idle" | "copied" | "select">("idle");
  const quote = useRef<HTMLParagraphElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    void copyText(sentence, quote.current).then((ok) => {
      setCopied(ok ? "copied" : "select");
      clearTimeout(timer.current);
      if (ok) timer.current = setTimeout(() => setCopied("idle"), 2400);
    });
  };
  return (
    <>
      <p className="archer-reach-text">
        This page was opened with an address that can read and comment but not edit. Open Archer from a new link or
        pairing code to edit here; ask your agent, for example:
      </p>
      <div className="archer-reach-request">
        <p ref={quote} className="archer-reach-quote">
          {sentence}
        </p>
        <button type="button" className="archer-reach-copy" onClick={copy}>
          Copy request
        </button>
      </div>
      <p role="status" className="archer-reach-status">
        {copied === "copied" ? "Copied" : copied === "select" ? "Selected: press Ctrl+C or ⌘C to copy" : ""}
      </p>
      <a className="archer-reach-link" href={EDITING_HELP_URL} target="_blank" rel="noreferrer">
        How editing works
      </a>
    </>
  );
}

const NEW_TRIGGER = (
  <>
    <span aria-hidden="true" className="archer-new-plus">
      +
    </span>
    <span className="archer-new-label">New</span>
  </>
);
const PENCIL = (
  <svg aria-hidden="true" viewBox="0 0 24 24">
    <path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" />
  </svg>
);

/** New or Edit on a page opened without a sign-in link or pairing code: the same control, opening how to get one. */
export function EditRequest({ projectName, as }: { projectName: string; as: "new" | "edit" }): JSX.Element {
  const trigger = as === "new" ? NEW_TRIGGER : <>{PENCIL}Edit</>;
  return (
    <Explained
      trigger={trigger}
      title="Editing needs a sign-in link"
      className={as === "new" ? "archer-new-button" : "archer-reader-edit"}
      as={as}
    >
      <RequestBody projectName={projectName} />
    </Explained>
  );
}

/** New or Edit when the editing status could not be read: the same control, saying so, with "Try again". */
export function EditUnavailable({ as, failures }: { as: Trigger; failures: number }): JSX.Element {
  // The failures seen when "Try again" was pressed: more since means it failed again.
  const [pressed, setPressed] = useState<number | null>(null);
  const retry = () => {
    refocus = as;
    setPressed(failures);
    for (const ask of askers) ask();
  };
  return (
    <Explained
      trigger={as === "new" ? NEW_TRIGGER : <>{PENCIL}Edit</>}
      title="Editing is unavailable right now"
      className={as === "new" ? "archer-new-button" : "archer-reader-edit"}
      as={as}
    >
      <p className="archer-reach-text">
        Archer could not check whether this link can edit. The service may be restarting or out of reach.
      </p>
      <button type="button" className="archer-reach-copy archer-reach-retry" onClick={retry}>
        Try again
      </button>
      <p role="status" className="archer-reach-status">
        {pressed === null ? "" : failures > pressed ? "Still unavailable. Try again in a moment." : "Checking…"}
      </p>
    </Explained>
  );
}

/** The tooltip on a greyed-out New or Edit: which setting turned editing off. */
export const offTip = (reason: OffReason): string =>
  reason === "project"
    ? "Editing is off: edit = false in this project's archer.toml"
    : reason === "global"
      ? "Editing is off: edit = false in your account's archer.toml"
      : "Editing is off: a [[projects]] rule in your Archer configuration";

/**
 * Editing turned off (ADR 0028; decided 2026-10-28): New or Edit, greyed out like any setting the page cannot change,
 * with a tooltip naming the setting. Pressing it says where to change it; it never opens the editor.
 */
export function EditOff({ reason, as }: { reason: OffReason; as: Trigger }): JSX.Element {
  return (
    <Explained
      trigger={as === "new" ? NEW_TRIGGER : <>{PENCIL}Edit</>}
      title="Editing is turned off"
      className={as === "new" ? "archer-new-button" : "archer-reader-edit"}
      as={as}
      off={offTip(reason)}
    >
      {reason === "account" ? (
        <p className="archer-reach-text">
          Your Archer configuration turns off diagram and note writes for this project (a <code>[[projects]]</code>{" "}
          rule), so this page is for reading and commenting. Settings shows the rule.
        </p>
      ) : (
        <p className="archer-reach-text">
          {reason === "project" ? (
            <>
              This project's <code>archer.toml</code>
            </>
          ) : (
            <>
              Your account's <code>archer.toml</code>
            </>
          )}{" "}
          sets <code>edit = false</code>, so this page is for reading and commenting; Settings shows it. Change it in
          that file
          {reason === "global" ? (
            <>
              , or set <code>edit = true</code> in this project's <code>archer.toml</code>
            </>
          ) : null}
          . Your agent can still change diagrams.
        </p>
      )}
    </Explained>
  );
}

/** On a phone the editor is view-only (ADR 0027, 0028): a quiet note where New would be. */
export function EditOnDesktop(): JSX.Element {
  return <span className="archer-new-desktop">Editing is on desktop</span>;
}
