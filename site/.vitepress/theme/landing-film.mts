/**
 * The landing's scripted film (the owner's R3-2 design): a coding agent's long answer in a terminal beside the same
 * answer drawn in Archer, walked, pointed at, commented on and revised on the agent's next turn. The frames are data;
 * `filmView` derives what each one shows, and `createFilmPlayer` decides when the next one comes.
 *
 * The drawings are real: `site/diagrams/shop-*.mmd`, drawn by Archer's own export painter
 * (`site/scripts/film-drawings.mts`). Highlights are Archer's walkthrough and agent highlights, by element id. The
 * film shows only what Archer does: a walkthrough on the flowchart (a sequence diagram cannot host one), and on the
 * sequence diagram the agent's highlights, shown with their legend as the side panel shows them (with no walkthrough
 * open, the app shows them at once).
 */

export type FilmDrawing = "proposal" | "revised" | "sequence";
/** Where the cursor goes: a part of the drawing by its element id, or a named control in the frame. */
export type FilmTarget =
  | { readonly element: string }
  | { readonly control: "canvas" | "play" | "step" | "comment" | "thread" | "legend" | "rest" };

export interface FilmFrame {
  readonly ms: number;
  readonly lead: string;
  readonly cap: string;
  readonly drawing: FilmDrawing;
  /** The walkthrough step shown, 1-based; 0 when none is. */
  readonly step: 0 | 1 | 2 | 3;
  readonly cursor: FilmTarget;
  readonly click?: true;
  readonly selected?: true;
  readonly comment?: "draft" | "waiting" | "replied";
  readonly toast?: true;
  /** The terminal's reader has typed a follow-up question. */
  readonly followUp?: true;
  /** The agent's highlights are on the drawing, with their legend in the side panel. */
  readonly highlights?: true;
  /** The reader has zoomed the canvas to these parts. */
  readonly zoom?: readonly string[];
}

/** A walkthrough step as the app stores one: its boxes and its lines, each line with the boxes at its ends. */
export interface WalkStep {
  readonly title: string;
  readonly nodes: readonly string[];
  readonly edges: readonly { readonly id: string; readonly source: string; readonly target: string }[];
}

export const WALKS = {
  proposal: [
    {
      title: "The order is saved",
      nodes: ["api", "db"],
      edges: [{ id: "save", source: "api", target: "db" }],
    },
    {
      title: "The API hands off a capture job",
      nodes: ["api", "queue", "worker"],
      edges: [
        { id: "enqueue", source: "api", target: "queue" },
        { id: "take", source: "queue", target: "worker" },
      ],
    },
    {
      title: "The worker charges the card",
      nodes: ["worker", "provider"],
      edges: [{ id: "charge", source: "worker", target: "provider" }],
    },
  ],
} as const satisfies Record<"proposal", readonly WalkStep[]>;

/** The flowchart's saved walkthrough. */
export const WALK_TITLE = "How a Payment Is Captured";

/** What the agent highlighted when it redrew: the part it added and the lines it changed. */
export const AGENT_HIGHLIGHT = { title: "What I changed", nodes: ["dlq"], edges: ["charge", "park"] } as const;

/**
 * What the agent highlighted on the sequence diagram, as it sends `set_emphasis`: messages by their positional ids,
 * coloured in order (teal, then violet).
 */
export const SEQUENCE_HIGHLIGHT = {
  title: "Checkout, in Order",
  groups: [
    {
      id: "answered",
      style: "highlight",
      label: "Answered at once",
      description: "The API saves the order, queues the capture and answers.",
      nodes: [],
      edges: ["msg-0", "msg-1", "msg-2", "msg-3"],
    },
    {
      id: "charged",
      style: "flow",
      label: "Charged once",
      description: "The worker charges with the idempotency key.",
      nodes: [],
      edges: ["msg-4", "msg-5", "msg-6"],
    },
  ],
} as const;

export type FilmHighlight = "proposal-1" | "proposal-2" | "proposal-3" | "revised-agent" | "sequence-agent";

/** Each highlight the film shows, on the drawing it is drawn on; a walk step also carries the steps before it. */
export const FILM_HIGHLIGHTS: Record<FilmHighlight, { readonly drawing: FilmDrawing; readonly step?: number }> = {
  "proposal-1": { drawing: "proposal", step: 1 },
  "proposal-2": { drawing: "proposal", step: 2 },
  "proposal-3": { drawing: "proposal", step: 3 },
  "revised-agent": { drawing: "revised" },
  "sequence-agent": { drawing: "sequence" },
};

const play = { control: "play" } as const;
const charge = { element: "charge" } as const;

/** The owner's frame list (R3Split's `F()`), with captions that say only what Archer does. */
export const FILM_FRAMES: readonly FilmFrame[] = [
  {
    ms: 2300,
    lead: "With Archer.",
    cap: "The same answer, drawn. The Diagram Key names every colour.",
    drawing: "proposal",
    step: 0,
    cursor: { control: "canvas" },
  },
  { ms: 1100, lead: "With Archer.", cap: "Play the walkthrough.", drawing: "proposal", step: 0, cursor: play },
  {
    ms: 1900,
    lead: "Walk through it.",
    cap: "Each step lights the parts it is about.",
    drawing: "proposal",
    step: 1,
    cursor: play,
    click: true,
  },
  {
    ms: 1900,
    lead: "Walk through it.",
    cap: "Each step lights the parts it is about.",
    drawing: "proposal",
    step: 2,
    cursor: { control: "step" },
    followUp: true,
  },
  {
    ms: 1900,
    lead: "Walk through it.",
    cap: "Each step lights the parts it is about.",
    drawing: "proposal",
    step: 3,
    cursor: { control: "canvas" },
    followUp: true,
  },
  {
    ms: 1100,
    lead: "Point at it.",
    cap: "Select the connection you doubt.",
    drawing: "proposal",
    step: 0,
    cursor: charge,
    selected: true,
    followUp: true,
  },
  {
    ms: 2400,
    lead: "Point at it.",
    cap: "Comment right on it.",
    drawing: "proposal",
    step: 0,
    cursor: { control: "comment" },
    click: true,
    selected: true,
    comment: "draft",
    followUp: true,
  },
  {
    ms: 1800,
    lead: "It waits.",
    cap: "Your agent reads the comment on its next turn, in your terminal.",
    drawing: "proposal",
    step: 0,
    cursor: { control: "thread" },
    selected: true,
    comment: "waiting",
    followUp: true,
  },
  {
    ms: 2800,
    lead: "Its next turn.",
    cap: "You talk to your agent as usual, and it picks up the comment.",
    drawing: "proposal",
    step: 0,
    cursor: { control: "thread" },
    selected: true,
    comment: "waiting",
    toast: true,
    followUp: true,
  },
  {
    ms: 3800,
    lead: "Revised.",
    cap: "It answers in the thread, redraws, and highlights what it changed.",
    drawing: "revised",
    step: 0,
    cursor: { control: "thread" },
    comment: "replied",
    followUp: true,
  },
  {
    ms: 3000,
    lead: "Another view.",
    cap: "The same proposal as a sequence diagram: who calls whom, in order.",
    drawing: "sequence",
    step: 0,
    cursor: { control: "rest" },
    highlights: true,
    followUp: true,
  },
  {
    ms: 3000,
    lead: "Its highlights.",
    cap: "Your agent lit each part of the flow in its own colour, and the legend names them.",
    drawing: "sequence",
    step: 0,
    cursor: { control: "legend" },
    highlights: true,
    followUp: true,
  },
  {
    ms: 3200,
    lead: "Zoom in.",
    cap: "The worker charges once, with the key your agent added. Then it starts again.",
    drawing: "sequence",
    step: 0,
    cursor: { control: "canvas" },
    highlights: true,
    zoom: ["worker", "provider", "msg-4", "msg-5", "msg-6"],
    followUp: true,
  },
];

export interface FilmView {
  readonly drawing: FilmDrawing;
  readonly step: number;
  readonly highlight: FilmHighlight | null;
  readonly selection: string | null;
  readonly pin: boolean;
  readonly panel: "walkthrough" | "comments" | "highlights";
  /** The parts the reader zoomed the canvas to, if they did. */
  readonly zoom: readonly string[] | null;
  readonly comment: "none" | "draft" | "waiting" | "replied";
  readonly toast: boolean;
  readonly address: string;
  readonly title: string;
  readonly terminalAtEnd: boolean;
  readonly followUp: boolean;
  readonly cursor: FilmTarget;
  readonly click: boolean;
  readonly lead: string;
  readonly cap: string;
}

const ADDRESS = "127.0.0.1:4317/projects/shop/notes/proposals/payment-worker.md";

/** What the frame at `index` shows (any integer: the film loops). */
export function filmView(index: number): FilmView {
  const count = FILM_FRAMES.length;
  const at = ((index % count) + count) % count;
  const frame = FILM_FRAMES[at]!;
  const sequence = frame.drawing === "sequence";
  const comment = frame.comment ?? "none";
  const highlight: FilmHighlight | null =
    frame.drawing === "revised"
      ? "revised-agent"
      : frame.highlights
        ? "sequence-agent"
        : frame.step > 0
          ? (`proposal-${frame.step}` as FilmHighlight)
          : null;
  return {
    drawing: frame.drawing,
    step: frame.step,
    highlight,
    selection: frame.selected ? "charge" : null,
    // The comment's pin stays on its connection once it is written.
    pin: Boolean(frame.selected) || comment !== "none",
    panel: comment !== "none" || frame.selected ? "comments" : frame.highlights ? "highlights" : "walkthrough",
    zoom: frame.zoom ?? null,
    comment,
    toast: Boolean(frame.toast),
    address: `${ADDRESS}#${sequence ? "sequence" : "flow"}`,
    title: sequence ? "Checkout Sequence" : "Payment Worker",
    terminalAtEnd: at > 0,
    followUp: Boolean(frame.followUp),
    cursor: frame.cursor,
    click: Boolean(frame.click),
    lead: frame.lead,
    cap: frame.cap,
  };
}

export interface FilmPlayerState {
  /** The reader's choice (or reduced motion's start): the film does not advance while paused. */
  readonly paused: boolean;
  /** Advancing now: not paused, on screen and in a visible tab. */
  readonly running: boolean;
  readonly frame: number;
}

/**
 * Advances the film while it is wanted and seen. It starts paused under reduced motion; otherwise it plays once it is
 * on screen. Off screen or in a hidden tab it holds the frame it is on, and comes back to it; a reader's Pause holds
 * until the reader plays again.
 */
export function createFilmPlayer(options: {
  win: Window;
  root: Element;
  durations: readonly number[];
  reducedMotion: boolean;
  onFrame: (index: number) => void;
  onState?: (state: FilmPlayerState) => void;
}) {
  const { win, durations } = options;
  let paused = options.reducedMotion;
  let onScreen = false;
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const shown = () => !win.document.hidden;
  const running = () => !disposed && !paused && onScreen && shown();
  const state = (): FilmPlayerState => ({ paused, running: running(), frame });
  function schedule() {
    clearTimeout(timer);
    timer = undefined;
    if (!running()) return;
    timer = setTimeout(() => {
      frame = (frame + 1) % durations.length;
      options.onFrame(frame);
      schedule();
      options.onState?.(state());
    }, durations[frame]);
  }
  function update() {
    schedule();
    options.onState?.(state());
  }
  const observer = new (win as Window & typeof globalThis).IntersectionObserver((entries) => {
    const entry = entries.at(-1);
    if (!entry || entry.isIntersecting === onScreen) return;
    onScreen = entry.isIntersecting;
    update();
  });
  observer.observe(options.root);
  const visibility = () => update();
  win.document.addEventListener("visibilitychange", visibility);
  return {
    state,
    toggle() {
      paused = !paused;
      update();
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      observer.disconnect();
      win.document.removeEventListener("visibilitychange", visibility);
    },
  };
}
