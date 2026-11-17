/**
 * Whether emphasis should use less motion, from a local On/Off/Auto choice.
 * On (the default) keeps the flow moving: the moving arrows say which way a
 * path runs, so they are content, not decoration. Auto follows the browser's
 * reduced-motion setting. The choice applies only to Archer's emphasis
 * renderers, never to the browser or OS accessibility setting.
 *
 * Read in JavaScript rather than left to a `@media (prefers-reduced-motion)`
 * block because the travelling packet is not only an animation: switching it
 * off in CSS would leave an `<animateMotion>` in the DOM still driving it in
 * every engine that ignores the rule, and hiding the packet outright would
 * withdraw the claim that this edge is part of the path. The reduced-motion
 * packet is a different ELEMENT -- parked at the midpoint -- not a hidden one,
 * and that decision has to be made where the element is built.
 *
 * One source of truth, so the stylesheet keys off the class this publishes
 * (`archer-emph-static`) rather than asking the media query a second time and
 * risking the two disagreeing.
 */
import { useSyncExternalStore } from "react";
import { browserStateKey } from "../runtime/address.ts";
import { mediaList } from "../theme/media-list";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const STORAGE_KEY = "archer.flow-animation";
const PREFERENCE_ATTRIBUTE = "data-flow-animation";
const VOLATILE_ATTRIBUTE = "data-flow-animation-volatile";

export type FlowAnimationPreference = "auto" | "on" | "off";

/** With nothing chosen (or a value this page does not know) the flow moves. */
export const DEFAULT_FLOW_ANIMATION: FlowAnimationPreference = "on";

function isPreference(value: unknown): value is FlowAnimationPreference {
  return value === "auto" || value === "on" || value === "off";
}

function readPreference(): FlowAnimationPreference {
  const root = typeof document === "undefined" ? null : document.documentElement;
  const applied = root?.getAttribute(PREFERENCE_ATTRIBUTE);
  // A failed write belongs to this document. A successfully stored choice is
  // reread so another tab's changes are discovered even across an unmount.
  if (root?.hasAttribute(VOLATILE_ATTRIBUTE) && isPreference(applied)) return applied;
  try {
    const stored = window.localStorage.getItem(browserStateKey(STORAGE_KEY));
    return isPreference(stored) ? stored : DEFAULT_FLOW_ANIMATION;
  } catch {
    return isPreference(applied) ? applied : DEFAULT_FLOW_ANIMATION;
  }
}

function setPreference(preference: FlowAnimationPreference): void {
  let remembered = false;
  try {
    window.localStorage.setItem(browserStateKey(STORAGE_KEY), preference);
    remembered = true;
  } catch {
    // A blocked store still permits an explicit choice in this document.
  }
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    if (remembered) root.removeAttribute(VOLATILE_ATTRIBUTE);
    else root.setAttribute(VOLATILE_ATTRIBUTE, "true");
    root.setAttribute(PREFERENCE_ATTRIBUTE, preference);
  }
}

function subscribePreference(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [PREFERENCE_ATTRIBUTE, VOLATILE_ATTRIBUTE],
  });
  const storage = (event: StorageEvent): void => {
    if (event.key !== browserStateKey(STORAGE_KEY) && event.key !== null) return;
    if (event.storageArea !== null) {
      try {
        if (event.storageArea !== window.localStorage) return;
      } catch {
        return;
      }
    }
    const preference = isPreference(event.newValue) ? event.newValue : DEFAULT_FLOW_ANIMATION;
    document.documentElement.removeAttribute(VOLATILE_ATTRIBUTE);
    document.documentElement.setAttribute(PREFERENCE_ATTRIBUTE, preference);
    onChange();
  };
  window.addEventListener("storage", storage);
  return () => {
    observer.disconnect();
    window.removeEventListener("storage", storage);
  };
}

/** Local browser preference shared by every emphasis renderer and legend. */
export function useFlowAnimationPreference(): {
  preference: FlowAnimationPreference;
  setPreference: (value: FlowAnimationPreference) => void;
} {
  const preference = useSyncExternalStore(subscribePreference, readPreference, () => DEFAULT_FLOW_ANIMATION);
  return { preference, setPreference };
}

function query(): MediaQueryList | null {
  return mediaList(REDUCED_MOTION_QUERY);
}

export function prefersReducedMotion(): boolean {
  return query()?.matches ?? false;
}

function subscribe(onChange: () => void): () => void {
  const list = query();
  if (list === null) {
    return () => {};
  }
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}

/**
 * The browser's own reduced-motion setting, for motion that is not emphasis: the camera gliding to a
 * walkthrough step or a legend member, boxes moving when a container opens. The Flow animation choice
 * keeps the arrows moving because they say which way a path runs; it never overrides the setting for
 * anything else (ADR 0034 §6: the camera jumps under reduced motion).
 */
export function useBrowserReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
}

/**
 * A preference can change mid-session (an OS accessibility toggle), so this
 * subscribes rather than sampling once at mount. The server snapshot is
 * `false`: a page rendered without a browser has no motion to reduce.
 */
export function useReducedMotion(): boolean {
  const { preference } = useFlowAnimationPreference();
  const browserReduced = useBrowserReducedMotion();
  return preference === "off" || (preference === "auto" && browserReduced);
}
