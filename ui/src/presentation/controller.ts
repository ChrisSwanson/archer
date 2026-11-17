export type PresentationCommand = {
  readonly presentationId: string;
  readonly viewId: string;
  readonly expectedRevision?: string;
  readonly focus?: {
    readonly nodeIds?: readonly string[];
    readonly edgeIds?: readonly string[];
  };
  readonly viewport?: "fit-all" | "fit-focus" | "preserve";
  readonly transition?: "replace" | "focus";
  readonly annotation?: string;
};

export type PresentationState = {
  readonly presentationId: string;
  readonly viewId: string;
  readonly revision: string | undefined;
  readonly focus: {
    readonly nodeIds: readonly string[];
    readonly edgeIds: readonly string[];
  };
  readonly viewport: "fit-all" | "fit-focus" | "preserve";
  readonly annotation: string | undefined;
  readonly generation: number;
  readonly layoutGeneration: number;
};

export type PresentationAction =
  | { type: "present"; command: PresentationCommand; revision: string }
  | { type: "layout_complete"; generation: number }
  | { type: "reset" };

export function initialPresentationState(): null {
  return null;
}

export function presentationReducer(
  state: PresentationState | null,
  action: PresentationAction,
): PresentationState | null {
  switch (action.type) {
    case "reset":
      return null;

    case "layout_complete": {
      if (state === null) {
        return state;
      }
      // This is purely an acknowledgement; matching or stale generations both
      // leave state unchanged (stale ones are ignored, matching ones are a no-op ack).
      return state;
    }

    case "present": {
      const { command, revision } = action;
      const isSameView =
        state !== null && state.presentationId === command.presentationId && state.viewId === command.viewId;

      const nodeIds = command.focus?.nodeIds ?? [];
      const edgeIds = command.focus?.edgeIds ?? [];

      // Arriving on a view frames the whole thing; being pointed at something
      // on the view already shown frames that. A re-present of the same view
      // with nothing focused -- which is what a live-reload redraw is -- asks
      // for no new framing, so the frame the user chose is kept.
      const defaultViewport = !isSameView
        ? "fit-all"
        : nodeIds.length > 0 || edgeIds.length > 0
          ? "fit-focus"
          : "preserve";
      const viewport = command.viewport ?? defaultViewport;

      const generation = state === null ? 1 : state.generation + 1;
      // The layout cache in App.tsx is keyed on layoutGeneration, so this has
      // to move whenever the drawn graph could differ. Staying on the same view
      // is not enough: a live-reload push re-presents that view under a new
      // revision, and reusing the cached layout would redraw the pre-edit
      // diagram. The revision is the model's identity, so compare on it.
      const isSameModel = isSameView && state.revision === revision;
      const layoutGeneration = state === null ? 1 : isSameModel ? state.layoutGeneration : state.layoutGeneration + 1;

      return {
        presentationId: command.presentationId,
        viewId: command.viewId,
        revision,
        focus: {
          nodeIds,
          edgeIds,
        },
        viewport,
        annotation: command.annotation,
        generation,
        layoutGeneration,
      };
    }

    default:
      return state;
  }
}
