/**
 * The walkthrough panel (ADR 0034 §6; look and interaction from the approved prototype in
 * docs/prototypes/walkthroughs): the picker at the top, a status line and notices, then the steps
 * as one document, with only the current step's details open. Over it a wheel notch or ↑/↓ moves one
 * step, and ←/→, Home and End do from anywhere that is not a text field. The transport bar sits under
 * the graph (`WalkTransport`). Pure over its props: `use-walkthroughs.ts` owns the state and timers.
 */
import { useEffect, useId, useRef, useState, type JSX, type MouseEvent, type ReactNode } from "react";
import { menuKeys } from "../app/menu-keys";
import { browserStateKey } from "../runtime/address.ts";
import { timeAgo } from "../app/presence";
import { isTypingTarget } from "../app/shortcuts";
import { prefersReducedMotion } from "../emphasis/reduced-motion";
import { PinBadge } from "../diagrams/CommentPins";
import type { StepBadge } from "../comments/walk-anchors";
import { useStepBadges, useWalkComments } from "../comments/walk-comments";
import { useNow } from "../app/now";
import type { Walk, WalkStep } from "./contract";
import type { Presented } from "./use-walk-steering";
import type { OldVersion } from "./use-old-version";
import { INITIAL_WHEEL, stepStates, wheelStep, type WalkState } from "./walk-player";
import { routeOf } from "./walk-render";
import { dayLabel, plural, wasLine } from "./walk-stale";
import { live, Ood, WalkList, writtenFor } from "./WalkList";
import { WalkStaleNotice, type StaleProps } from "./WalkStaleNotice";
import { CloseGlyph } from "../diagrams/ControlGlyphs";

export type Go = "first" | "last" | "next" | "prev" | number;

export type PanelProps = Omit<StaleProps, "walk"> & {
  readonly walks: readonly Walk[];
  readonly state: WalkState;
  /** The diagram's model revision now, to say whether a walkthrough was written for it. */
  readonly revision?: string;
  readonly labelOf: (id: string) => string;
  readonly onSelect: (id: string) => void;
  readonly onClose: () => void;
  readonly onGo: (to: Go) => void;
  readonly onTogglePlay: () => void;
  /** The agent opened this walkthrough: said at the top, in the agent's amber, until the person chooses another. */
  readonly presented?: Presented | null;
  /** The Sequence tab's body (slice 6), given the step badges; the tab is there only when it is. */
  readonly sequence?: (badges: ReadonlyMap<string, StepBadge>) => ReactNode;
  /**
   * False: the step keys and the spoken step are the caller's (`WalkModeKeys`, `WalkLive`), mounted where they
   * outlive this panel (collapsed beside the drawing, a folded phone sheet), so there is one of each. Default true.
   */
  readonly standalone?: boolean;
  /** The transport bar, when the sheet covers the one under the graph (a phone). */
  readonly transport?: ReactNode;
  /** The chosen walkthrough's related note, when it names one the page can open: its title, address and opener. */
  readonly note?: WalkNoteLink | null;
};

export type WalkNoteLink = { readonly title: string; readonly href: string; readonly onOpen: () => void };

/** "Related note: <title>", a real link (a new tab still works); a plain press opens it in this page. */
function RelatedNote({ note }: { readonly note: WalkNoteLink }): JSX.Element {
  return (
    <p className="archer-walk-related">
      Related note:{" "}
      <a
        href={note.href}
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          note.onOpen();
        }}
      >
        {note.title}
      </a>
    </p>
  );
}

const current = (state: WalkState, walks: readonly Walk[]): Walk | null =>
  state.id === null ? null : (walks.find((w) => w.id === state.id) ?? null);

const TAB_KEY = "archer.walk.tab";
/** The tab last chosen, kept per viewer. */
function readTab(): "steps" | "sequence" {
  try {
    return localStorage.getItem(browserStateKey(TAB_KEY)) === "sequence" ? "sequence" : "steps";
  } catch {
    return "steps";
  }
}
function saveTab(tab: "steps" | "sequence"): void {
  try {
    localStorage.setItem(browserStateKey(TAB_KEY), tab);
  } catch {
    /* kept for this visit only */
  }
}

/** What a step is said as, aloud: "Step 3 of 8: The card is declined. Shop API → Shop database." */
function spoken(walk: Walk, step: number, labelOf: (id: string) => string, withTitle: boolean): string {
  const s = walk.steps[step - 1];
  if (s === undefined) return "";
  const route = routeOf(s, labelOf);
  return `${withTitle ? `${walk.title}. ` : ""}${walk.old === true ? "Old version. " : walk.status === "archived" ? "Archived. " : ""}Step ${step} of ${walk.steps.length}: ${s.title}.${route === "" ? "" : ` ${route}.`}${s.status === "out-of-date" ? " Out of date." : ""}`;
}

/** The polite live region: the step, said once each time it changes. */
export function WalkLive({ walks, state, labelOf }: Pick<PanelProps, "walks" | "state" | "labelOf">): JSX.Element {
  const [text, setText] = useState("");
  const said = useRef<string | null>(null);
  const walk = current(state, walks);
  useEffect(() => {
    if (walk === null) {
      said.current = null;
      setText("");
      return;
    }
    setText(spoken(walk, state.step, labelOf, said.current !== walk.id));
    said.current = walk.id;
  }, [walk?.id, walk?.old, state.step, walk?.steps[state.step - 1]?.title, labelOf]);
  return (
    <div className="archer-visually-hidden" aria-live="polite">
      {text}
    </div>
  );
}

function Picker({
  walks,
  walk,
  revision,
  onSelect,
}: {
  readonly walks: readonly Walk[];
  readonly walk: Walk | null;
  readonly revision?: string;
  readonly onSelect: (id: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    (
      menu.current?.querySelector<HTMLElement>('[aria-current="true"]') ??
      menu.current?.querySelector<HTMLElement>("button")
    )?.focus();
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !button.current?.parentElement?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    <div className="archer-walk-picker">
      <button
        ref={button}
        type="button"
        className="archer-walk-pick"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="archer-walk-pick-lead">Walkthrough</span>
        <span className="archer-walk-pick-title">{walk?.title ?? "Choose one"}</span>
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 4.5 6 8l3.5-3.5" />
        </svg>
      </button>
      {open ? (
        <div
          ref={menu}
          id={id}
          className="archer-walk-menu"
          role="group"
          aria-label="Walkthroughs on this diagram"
          onKeyDown={(event) =>
            menuKeys(event, [...(menu.current?.querySelectorAll<HTMLElement>("button") ?? [])], (refocus) => {
              setOpen(false);
              if (refocus) button.current?.focus();
            })
          }
          onClick={(event) => {
            if (event.target instanceof Element && event.target.closest("button")) {
              setOpen(false);
              button.current?.focus();
            }
          }}
        >
          <WalkList walks={walks} chosen={walk?.id ?? null} revision={revision} onSelect={onSelect} />
        </div>
      ) : null}
    </div>
  );
}

/** The status line: what the picker or the chosen walkthrough is. */
function status(
  walks: readonly Walk[],
  walk: Walk | null,
  revision: string | undefined,
  labelOf: (id: string) => string,
  old: OldVersion | undefined,
): ReactNode {
  if (walk === null) {
    const archived = walks.length - live(walks).length;
    return `${live(walks).length} on this diagram${archived > 0 ? ` · ${archived} archived` : ""}`;
  }
  const n = plural(walk.steps.length, "step");
  if (walk.old === true) {
    const day = old?.status === "found" ? dayLabel(old.committedAt) : "";
    return `${n} · ${day === "" ? "old version" : `shown on the ${day} version`}`;
  }
  if (walk.status === "archived") return `${n} · archived`;
  const here = revision === undefined || walk.modelRevision === revision;
  return (
    <>
      {n} · {writtenFor(walk, revision)}
      {here && walk.open.length > 0 ? ` · starts with ${walk.open.map(labelOf).join(", ")} open` : ""}
      <Ood n={walk.outOfDate.length} />
    </>
  );
}

/** "Presented by the agent · just now — caption": the time only when this page saw it made. */
function PresentedNotice({ presented }: { readonly presented: Presented }): JSX.Element {
  const now = useNow(presented.at !== null);
  return (
    <p className="archer-walk-presented">
      <span className="archer-walk-agent">Presented by the agent</span>
      {presented.at === null ? null : ` · ${timeAgo(presented.at, now)}`}
      {presented.caption === undefined ? null : (
        <>
          {" "}
          — <span className="archer-walk-caption">{presented.caption}</span>
        </>
      )}
    </p>
  );
}

/** The count of a step's threads, in the person's blue; pressed, it opens the first. */
function StepPin({ badge }: { readonly badge: StepBadge }): JSX.Element {
  return (
    <>
      <PinBadge
        pin={{ threadId: badge.thread, number: badge.count, state: badge.state }}
        className="archer-walk-pin"
        title={`${plural(badge.count, "comment")} on this step`}
      />
      <span className="archer-visually-hidden">, {plural(badge.count, "comment")}</span>
    </>
  );
}

export function StepItem({
  step,
  index,
  state,
  labelOf,
  onGo,
  badge,
}: {
  readonly step: WalkStep;
  readonly index: number;
  readonly state: "done" | "active" | "future";
  readonly labelOf: (id: string) => string;
  readonly onGo: (to: Go) => void;
  readonly badge?: StepBadge;
}): JSX.Element {
  const active = state === "active";
  const route = routeOf(step, labelOf);
  return (
    <li
      className={`archer-walk-step${step.status === "out-of-date" ? " stale" : ""}`}
      data-state={state}
      data-step-no={index + 1}
      data-step-id={step.id}
    >
      <button
        type="button"
        className="archer-walk-head"
        aria-current={active ? "step" : undefined}
        aria-expanded={active}
        onClick={() => onGo(index + 1)}
      >
        <span className="archer-walk-num">{index + 1}</span>
        <span className="archer-walk-step-title">
          {step.title}
          {step.status === "out-of-date" ? <span className="archer-walk-ood">Out of date</span> : null}
          {badge === undefined ? null : <StepPin badge={badge} />}
        </span>
        <span className="archer-walk-route">{route}</span>
      </button>
      {/* Opens by height; closed, it is inert, so it is neither read nor tabbed into. */}
      <div className="archer-walk-more" inert={!active}>
        <div className="archer-walk-clip">
          <dl className="archer-walk-body">
            <dt>{step.kind === "sends" ? "Sends" : "Does"}</dt>
            <dd>{step.what}</dd>
            {step.why === undefined ? null : (
              <>
                <dt>Why</dt>
                <dd className="why">{step.why}</dd>
              </>
            )}
            {step.code.length === 0 ? null : (
              <>
                <dt>Code</dt>
                <dd>
                  {step.code.map((c) => (
                    <code key={c}>{c}</code>
                  ))}
                </dd>
              </>
            )}
            {wasLine(step) === null ? null : <dd className="archer-walk-was">{wasLine(step)}</dd>}
            {step.messages.length > 0 && step.edges.length === 0 && step.status !== "out-of-date" ? (
              <dd className="archer-walk-noline">No line in this diagram</dd>
            ) : null}
          </dl>
        </div>
      </div>
    </li>
  );
}

/** What keeps its own Space inside the walkthrough or the diagram: Play itself, the picker, tabs, links, the divider, pins and "+". */
const KEEPS_SPACE =
  '.archer-walk-icon.play, .archer-walk-menu, .archer-walk-pick, [role="tab"], [role="separator"], a[href], [data-pin-thread], [data-nest-toggle]';

/** Whether Space on `target` plays the walkthrough: on the page, in the panel and step controls, and on the diagram. */
export function spacePlays(target: EventTarget | null, panel: Element | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target === document.body || target === document.documentElement) return true;
  const controls = panel?.contains(target) === true || target.closest(".archer-walk-transport") !== null;
  if (controls)
    return (
      target.closest(KEEPS_SPACE) === null &&
      (!isTypingTarget(target) || (target instanceof HTMLInputElement && target.type === "range"))
    );
  return (
    target.closest(".react-flow") !== null &&
    !isTypingTarget(target) &&
    target.closest(`${KEEPS_SPACE}, button`) === null
  );
}

/** The walkthrough panel on screen, wherever it is (beside the drawing or in the phone's sheet), or null. */
const openPanel = (): HTMLElement | null => document.getElementById("archer-walk-panel");

/**
 * The step keys, for as long as a walkthrough is open, whether or not its panel is on screen: ←/→, Home and
 * End from anywhere that is not a text field, ↑/↓ over or in the panel, and Space to play or pause.
 */
export function WalkModeKeys({
  stepping,
  onGo,
  onTogglePlay,
}: {
  readonly stepping: boolean;
  readonly onGo: (to: Go) => void;
  readonly onTogglePlay: () => void;
}): null {
  const latest = useRef({ stepping, onGo, onTogglePlay });
  latest.current = { stepping, onGo, onTogglePlay };
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const { stepping: on, onGo: go } = latest.current;
      const target = event.target;
      if (!on || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || isTypingTarget(target))
        return;
      // The divider and a nested "+" keep their own keys.
      if (target instanceof Element && target.closest('[role="separator"], .archer-walk-menu, [data-nest-toggle]'))
        return;
      const panel = openPanel();
      const vertical =
        panel !== null &&
        ((target instanceof Node && panel.contains(target)) || panel.hasAttribute("data-pointer-over"));
      const k = event.key;
      if (k === "ArrowRight" || (vertical && k === "ArrowDown")) go("next");
      else if (k === "ArrowLeft" || (vertical && k === "ArrowUp")) go("prev");
      else if (k === "Home") go("first");
      else if (k === "End") go("last");
      else return;
      event.preventDefault();
    };
    // Space plays, pauses, or plays again from the first step. Caught before the diagram's own keys (where Space
    // would select; Enter still does) and before a focused step row or step button, which would press it.
    let releasing = false;
    const down = (event: KeyboardEvent): void => {
      if (
        event.key !== " " ||
        !latest.current.stepping ||
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      if (!spacePlays(event.target, openPanel())) return;
      event.preventDefault();
      event.stopPropagation();
      releasing = true;
      if (!event.repeat) latest.current.onTogglePlay();
    };
    // A focused button presses on the release, so that is held back too.
    const up = (event: KeyboardEvent): void => {
      if (event.key !== " " || !releasing) return;
      releasing = false;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("keydown", down, true);
    document.addEventListener("keyup", up, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("keydown", down, true);
      document.removeEventListener("keyup", up, true);
    };
  }, []);
  return null;
}

export function WalkthroughPanel(props: PanelProps): JSX.Element {
  const { walks, state, revision, labelOf, onSelect, onClose, onGo, onTogglePlay } = props;
  const walk = current(state, walks);
  const panel = useRef<HTMLElement>(null);
  const wheel = useRef(INITIAL_WHEEL);
  const scroll = useRef<HTMLDivElement>(null);
  const tabId = useId();
  const stepping = walk !== null && walk.status !== "archived";
  const [tab, setTab] = useState<"steps" | "sequence">(readTab);
  const comments = useWalkComments();
  const badges = useStepBadges(walk);
  const latest = useRef({ stepping, onGo, onClose, walk, comments });
  latest.current = { stepping, onGo, onClose, walk, comments };

  // Over the panel, a wheel notch is one step. Not passive: it has to stop the panel scrolling.
  useEffect(() => {
    const node = panel.current;
    if (node === null) return;
    const onWheel = (event: WheelEvent): void => {
      if (!latest.current.stepping) return;
      const dy = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1);
      // Sideways scrolling (the sequence) passes through.
      if (Math.abs(event.deltaX) > Math.abs(dy)) return;
      if (event.target instanceof Element && event.target.closest(".archer-walk-menu")) return;
      event.preventDefault();
      const next = wheelStep(wheel.current, { dy, now: performance.now() });
      wheel.current = next.state;
      if (next.delta !== 0) latest.current.onGo(next.delta > 0 ? "next" : "prev");
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  // Choosing (or opening on the picker) moves focus in to the current step, unless it is already there,
  // the person is typing, or the agent made the change.
  const walkId = walk?.id ?? null;
  useEffect(() => {
    const was = document.activeElement;
    const node = panel.current;
    if (props.presented != null || node === null || node.contains(was) || isTypingTarget(was)) return;
    (walkId === null
      ? node.querySelector<HTMLElement>(".archer-walk-list .archer-walk-item")
      : (node.querySelector<HTMLElement>('[aria-current="step"]') ??
        node.querySelector<HTMLElement>(".archer-walk-head"))
    )?.focus();
  }, [walkId]);

  // The current step comes into view once its details have finished opening; only the panel scrolls.
  useEffect(() => {
    if (tab !== "steps") return;
    const timer = setTimeout(
      () => {
        const box = scroll.current;
        const row = box?.querySelector('.archer-walk-step[data-state="active"]');
        if (box == null || row == null || typeof box.scrollTo !== "function") return;
        const r = row.getBoundingClientRect(),
          p = box.getBoundingClientRect();
        const by = r.top < p.top + 4 ? r.top - p.top - 8 : r.bottom > p.bottom - 4 ? r.bottom - p.bottom + 8 : 0;
        if (by !== 0) box.scrollTo({ top: box.scrollTop + by, behavior: prefersReducedMotion() ? "auto" : "smooth" });
      },
      prefersReducedMotion() ? 0 : 210,
    );
    return () => clearTimeout(timer);
  }, [state.step, walkId, tab]);

  // `C` on a focused step row or Sequence message comments on that step (ADR 0034 §9); Escape in the panel closes it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const { onClose: close, walk: now, comments: talk } = latest.current;
      const target = event.target;
      const inPanel = target instanceof Node && panel.current?.contains(target) === true;
      if (
        (event.key === "c" || event.key === "C") &&
        inPanel &&
        now !== null &&
        talk !== null &&
        !event.defaultPrevented &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !isTypingTarget(target)
      ) {
        const at = (target as Element).closest("[data-step-no]");
        if (at !== null) {
          event.preventDefault();
          talk.comment(now, Number(at.getAttribute("data-step-no")));
          return;
        }
      }
      if (event.key === "Escape" && inPanel && !event.defaultPrevented) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // One gesture everywhere: right-click, the context-menu key and Shift+F10 on a step row or message comment on it,
  // and a badge opens its thread.
  const onContextMenu = (event: MouseEvent): void => {
    // The row's head and a Sequence message only: the opened body keeps the browser's menu (copy, inspect).
    const at =
      event.target instanceof Element
        ? (event.target.closest(".archer-walk-head, .archer-seq-message")?.closest("[data-step-no]") ?? null)
        : null;
    if (at === null || walk === null || comments === null) return;
    event.preventDefault();
    comments.comment(walk, Number(at.getAttribute("data-step-no")));
  };
  const onClickCapture = (event: MouseEvent): void => {
    const pin = event.target instanceof Element ? event.target.closest("[data-pin-thread]") : null;
    if (pin === null || comments === null) return;
    event.stopPropagation();
    comments.openThread(pin.getAttribute("data-pin-thread") ?? "");
  };

  const tabbed = walk !== null && props.sequence !== undefined;
  const hint = stepping ? <p className="archer-walk-hint">Scroll, or use ↑ ↓, over this panel to step.</p> : null;
  const states = stepStates(state.step, walk?.steps.length ?? 0);
  const body =
    walk === null ? (
      <div className="archer-walk-list" role="group" aria-label="Walkthroughs on this diagram">
        <WalkList walks={walks} chosen={null} revision={revision} onSelect={onSelect} />
      </div>
    ) : tab === "sequence" && props.sequence !== undefined ? (
      props.sequence(badges)
    ) : (
      <ol className="archer-walk-steps" aria-label={`Steps of ${walk.title}`}>
        {walk.steps.map((step, i) => (
          <StepItem
            // biome-ignore lint/suspicious/noArrayIndexKey: a walkthrough step is identified by its position (step n of m); steps are never reordered in place.
            key={i}
            step={step}
            index={i}
            state={states[i] ?? "future"}
            labelOf={labelOf}
            onGo={onGo}
            {...(badges.has(step.id) ? { badge: badges.get(step.id)! } : {})}
          />
        ))}
      </ol>
    );
  return (
    // The side panel's top section while a walkthrough is open (`diagram-panel.tsx`): a named region, its heading first.
    <section
      ref={panel}
      id="archer-walk-panel"
      className="archer-walk"
      aria-labelledby={`${tabId}-heading`}
      onPointerEnter={(event) => event.currentTarget.setAttribute("data-pointer-over", "")}
      onPointerLeave={(event) => event.currentTarget.removeAttribute("data-pointer-over")}
      onContextMenu={onContextMenu}
      onClickCapture={onClickCapture}
    >
      <h2 id={`${tabId}-heading`} className="archer-visually-hidden">
        Walkthrough
      </h2>
      <div className="archer-walk-top">
        <Picker walks={walks} walk={walk} revision={revision} onSelect={onSelect} />
        <p className="archer-walk-meta">{status(walks, walk, revision, labelOf, props.old)}</p>
        {walk === null || walk.note === undefined || props.note == null ? null : <RelatedNote note={props.note} />}
        {props.presented == null ? null : <PresentedNotice presented={props.presented} />}
        <WalkStaleNotice
          walk={walk}
          {...(props.changedAt === undefined ? {} : { changedAt: props.changedAt })}
          {...(props.old === undefined ? {} : { old: props.old })}
          {...(props.onOpenOld === undefined ? {} : { onOpenOld: props.onOpenOld })}
          {...(props.onBackToCurrent === undefined ? {} : { onBackToCurrent: props.onBackToCurrent })}
        />
      </div>
      <div className="archer-walk-bar">
        {tabbed ? (
          // ←/→ switch tabs and Home/End go to the first and last; the tab keys are not step keys (propagation stops here).
          <div
            className="archer-walk-tabs"
            role="tablist"
            aria-label="Panel view"
            onKeyDown={(event) => {
              const to =
                event.key === "Home"
                  ? "steps"
                  : event.key === "End"
                    ? "sequence"
                    : event.key === "ArrowLeft" || event.key === "ArrowRight"
                      ? tab === "steps"
                        ? "sequence"
                        : "steps"
                      : null;
              if (to === null) return;
              event.preventDefault();
              event.stopPropagation();
              setTab(to);
              saveTab(to);
              document.getElementById(`${tabId}-${to}`)?.focus();
            }}
          >
            {(["steps", "sequence"] as const).map((name) => (
              <button
                key={name}
                id={`${tabId}-${name}`}
                type="button"
                role="tab"
                aria-selected={tab === name}
                aria-controls={`${tabId}-panel`}
                tabIndex={tab === name ? 0 : -1}
                onClick={() => {
                  setTab(name);
                  saveTab(name);
                }}
              >
                {name === "steps" ? "Steps" : "Sequence"}
              </button>
            ))}
          </div>
        ) : (
          hint
        )}
        <button
          type="button"
          className="archer-walk-icon archer-walk-close"
          aria-label="Close walkthrough"
          title="Close walkthrough (Esc)"
          onClick={onClose}
        >
          <CloseGlyph />
        </button>
      </div>
      {props.transport}
      {tabbed ? hint : null}
      <div
        ref={scroll}
        className="archer-walk-scroll"
        {...(tabbed ? { role: "tabpanel", id: `${tabId}-panel`, "aria-labelledby": `${tabId}-${tab}` } : {})}
      >
        {body}
      </div>
      {props.standalone === false ? null : (
        <>
          <WalkModeKeys stepping={stepping} onGo={onGo} onTogglePlay={onTogglePlay} />
          <WalkLive walks={walks} state={state} labelOf={labelOf} />
        </>
      )}
    </section>
  );
}

const ICON = {
  first: "M3 2h2v12H3zM14 2v12L6 8z",
  prev: "M12 2v12L3 8z",
  next: "M4 2v12l9-6z",
  last: "M11 2h2v12h-2zM2 2v12l8-6z",
  play: "M4 2v12l10-6z",
  pause: "M3.5 2h3v12h-3zM9.5 2h3v12h-3z",
} as const;

/** First, previous, Play, next, last, the position, and a scrubber: under the graph. */
export function WalkTransport({
  walks,
  state,
  onGo,
  onTogglePlay,
}: Pick<PanelProps, "walks" | "state" | "onGo" | "onTogglePlay">): JSX.Element | null {
  const walk = current(state, walks);
  if (walk === null || walk.status === "archived") return null;
  const n = walk.steps.length;
  const title = walk.steps[state.step - 1]?.title ?? "";
  // Not `disabled`: pressing Previous into the first step would drop focus to the page.
  const button = (label: string, path: string, go: Go, off: boolean): JSX.Element => (
    <button
      type="button"
      className="archer-walk-icon"
      aria-label={label}
      aria-disabled={off || undefined}
      onClick={() => {
        if (!off) onGo(go);
      }}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d={path} />
      </svg>
    </button>
  );
  const atStart = state.step <= 1;
  const atEnd = state.step >= n;
  return (
    <div className="archer-walk-transport" role="group" aria-label="Step controls">
      <span className="archer-walk-icons">
        {button("First step", ICON.first, "first", atStart)}
        {button("Previous step", ICON.prev, "prev", atStart)}
        <button
          type="button"
          className="archer-walk-icon play"
          aria-label={state.playing ? "Pause" : "Play"}
          onClick={onTogglePlay}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d={state.playing ? ICON.pause : ICON.play} />
          </svg>
        </button>
        {button("Next step", ICON.next, "next", atEnd)}
        {button("Last step", ICON.last, "last", atEnd)}
      </span>
      <span className="archer-walk-pos">
        Step <b>{state.step}</b> of {n} · {title}
      </span>
      <input
        type="range"
        className="archer-walk-scrub"
        aria-label="Step"
        min={1}
        max={n}
        step={1}
        value={state.step}
        aria-valuetext={`Step ${state.step} of ${n}: ${title}`}
        onChange={(event) => onGo(Number(event.target.value))}
      />
    </div>
  );
}
