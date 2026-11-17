import { useCallback, useSyncExternalStore } from "react";

/**
 * Where the project review sits on a diagram page (decided 2026-10-29): in the diagram panel's cell,
 * in place of the panel's own content, which comes back when the review closes. The panel offers the
 * place; without it (a note, the contents, a collapsed panel, a phone) the review is its own sidebar.
 */
let host: HTMLElement | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useReviewHost(): HTMLElement | null {
  return useSyncExternalStore(
    subscribe,
    () => host,
    () => null,
  );
}

/** A ref for the element offering the place; it is withdrawn when that element goes. */
export function useOfferReviewHost(): (element: HTMLElement | null) => () => void {
  return useCallback((element: HTMLElement | null) => {
    const offer = (next: HTMLElement | null) => {
      if (host !== next) {
        host = next;
        listeners.forEach((listener) => listener());
      }
    };
    offer(element);
    return () => {
      if (host === element) offer(null);
    };
  }, []);
}
