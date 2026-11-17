/**
 * What the bridge hears that the review panel must act on, handed across
 * without making the bridge -- connected once, with stable callbacks -- know
 * the panel exists.
 */
import type { TargetRef } from "./contract";

export type ReviewEvent =
  /** A target's threads changed: the `comments` event. */
  | { readonly type: "comments"; readonly target: TargetRef }
  /** Notes or their associations changed: the `notes` event. */
  | { readonly type: "notes"; readonly viewId?: string }
  /** A note's durable named passage emphasis changed. */
  | { readonly type: "note-emphasis"; readonly notePath: string }
  /** A view's walkthroughs, or how they resolve, changed: the `walkthroughs` event. */
  | { readonly type: "walkthroughs"; readonly viewId: string }
  /**
   * The stream (re)opened and the page is current again. The stream replays
   * nothing, so anything that changed while it was down is read again.
   */
  | { readonly type: "reconnect" };

export type ReviewEvents = {
  emit(event: ReviewEvent): void;
  subscribe(listener: (event: ReviewEvent) => void): () => void;
};

export function createReviewEvents(): ReviewEvents {
  const listeners = new Set<(event: ReviewEvent) => void>();
  return {
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
