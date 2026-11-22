<script setup lang="ts">
// The owner's R3-2 film: the same answer as a long terminal reply and as Archer draws it. The drawings are the shop
// example's real Mermaid, drawn by Archer's export painter (`film-drawings.json`); the frames and when they advance
// are `landing-film.mts`. Every part lit, selected, pinned or pointed at is found by its element id.
import { withBase } from "vitepress";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import drawingsJson from "./film-drawings.json";
import {
  createFilmPlayer,
  FILM_FRAMES,
  type FilmDrawing,
  type FilmTarget,
  filmView,
  SEQUENCE_HIGHLIGHT,
  WALK_TITLE,
  WALKS,
} from "./landing-film.mts";

interface FilmDrawingData {
  title: string;
  viewBox: string;
  svg: string;
  key?: { svg: string; width: number; height: number };
  states: Record<string, { css: string; attributes: Record<string, Record<string, string>>; markers: string }>;
}
const drawings = drawingsJson as unknown as Record<FilmDrawing, FilmDrawingData>;
const ORDER: FilmDrawing[] = ["proposal", "revised", "sequence"];

const frame = ref(0);
const view = computed(() => filmView(frame.value));
const paused = ref(false);
const running = ref(false);
const reduced = ref(false);
const playground = withBase("/playground/app/index.html");

/** The comment's pin sits at the top right of its connection's words, where the painter put them. */
function pinAt(svg: string): { x: number; y: number } | null {
  const start = svg.indexOf('data-element-id="charge" data-element-channel="edge"');
  if (start < 0) return null;
  const plate = /<rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="([\d.]+)" rx="0" fill="var\(--bg\)"/.exec(
    svg.slice(start),
  );
  return plate ? { x: Number(plate[1]) + Number(plate[3]) + 4, y: Number(plate[2]) - 2 } : null;
}
const layers = ORDER.map((name) => {
  const drawing = drawings[name];
  const css = Object.values(drawing.states)
    .map((state) => state.css)
    .join("");
  const pin = pinAt(drawing.svg);
  const pinMarkup = pin
    ? `<g class="film-pin" transform="translate(${pin.x} ${pin.y})"><circle r="11"/><text text-anchor="middle" y="4.5">1</text></g>`
    : "";
  return { name, viewBox: drawing.viewBox, base: `${drawing.svg}${pinMarkup}`, full: `<style>${css}</style>${drawing.svg}${pinMarkup}` };
});
// The page is served with the opening drawing only; the others and the highlight rules come with the script that
// plays them (the first client render matches the served one, then fills in).
const hydrated = ref(false);
const markupOf = (item: (typeof layers)[number]) =>
  hydrated.value ? item.full : item.name === "proposal" ? item.base : "";
const key = computed(() => drawings[view.value.drawing].key);
const steps = WALKS.proposal;
// The legend's group colours, in Archer's slot order (teal, violet, coral).
const SLOTS = ["var(--g1)", "var(--g3)", "var(--g4)"];

// The terminal's answer, as text in the page: readable, selectable and read out in order.
type Line = { kind: "meta" | "you" | "agent" | "head" | "body" | "gap"; text?: string };
const answer: Line[] = [
  { kind: "meta", text: "Your coding agent, in your terminal (scripted example)" },
  { kind: "gap" },
  {
    kind: "you",
    text: "Propose moving payment capture out of the Orders API into a worker. Show the new boundary and what crosses it.",
  },
  { kind: "gap" },
  { kind: "agent", text: "Proposal: move card capture behind a job queue." },
  { kind: "gap" },
  { kind: "head", text: "Current flow" },
  { kind: "body", text: "1. The web app posts the cart to the Orders API." },
  { kind: "body", text: "2. The Orders API validates the cart, reserves stock and writes the order as pending." },
  { kind: "body", text: "3. In the same request, it calls the payment provider to capture the card." },
  { kind: "body", text: "4. On success it marks the order paid; on failure it releases the stock." },
  { kind: "body", text: "5. The checkout request stays open for the whole provider round trip." },
  { kind: "gap" },
  { kind: "head", text: "Proposed flow" },
  { kind: "body", text: "1. The Orders API validates, reserves stock and writes the order as awaiting capture." },
  { kind: "body", text: "2. Instead of calling the provider, it puts a capture job on a new job queue." },
  { kind: "body", text: "3. It answers the web app straight away." },
  { kind: "body", text: "4. A new payment worker takes each job from the queue." },
  { kind: "body", text: "5. The worker charges the card through the payment provider." },
  { kind: "body", text: "6. On success it records the result in the orders database." },
  { kind: "body", text: "7. On failure it retries, then marks the order as capture failed." },
  { kind: "gap" },
  { kind: "head", text: "The new boundary" },
  { kind: "body", text: "- The job queue and the payment worker sit outside the Orders API." },
  { kind: "body", text: "- Only the order id, amount and currency cross it. No card data." },
  { kind: "body", text: "- The worker holds the provider credentials; the API no longer needs them." },
  { kind: "gap" },
  { kind: "head", text: "Still to decide" },
  { kind: "body", text: "- How many retries before giving up." },
  { kind: "body", text: "- Whether the web app polls for status or gets a callback." },
  { kind: "body", text: "- What happens to reserved stock while capture is pending." },
  { kind: "gap" },
  { kind: "head", text: "Files I would touch" },
  { kind: "body", text: "- services/orders/api/checkout.ts" },
  { kind: "body", text: "- services/payments/worker/index.ts (new)" },
  { kind: "body", text: "- services/payments/worker/capture.ts (new)" },
  { kind: "body", text: "- infra/queues.tf" },
  { kind: "gap" },
  { kind: "meta", text: "Wrote .archer/notes/proposals/payment-worker.md" },
  { kind: "meta", text: "Open in Archer: http://127.0.0.1:4317/projects/shop/notes/proposals/payment-worker.md#flow" },
];

const root = ref<HTMLElement>();
const browser = ref<HTMLElement>();
const log = ref<HTMLElement>();
const body = ref<HTMLElement>();
const svgs = ref<SVGSVGElement[]>([]);
const cams = ref<SVGGElement[]>([]);
const cursor = ref<{ x: number; y: number } | null>(null);
const cameras = ref<Record<FilmDrawing, string>>({ proposal: "", revised: "", sequence: "" });
let player: ReturnType<typeof createFilmPlayer> | undefined;

const layer = (name: FilmDrawing) => ORDER.indexOf(name);
const svgOf = (name: FilmDrawing) => svgs.value[layer(name)];
const camOf = (name: FilmDrawing) => cams.value[layer(name)];
const elementOf = (name: FilmDrawing, id: string, channel?: "node" | "edge") =>
  svgOf(name)?.querySelector<SVGGElement>(
    `[data-element-id="${CSS.escape(id)}"]${channel ? `[data-element-channel="${channel}"]` : ""}`,
  ) ?? null;

/** What the painter adds to an element for the shown highlight, put on (and the last one's taken off) by id. */
let applied: { element: Element; names: string[] }[] = [];
function applyHighlight() {
  for (const { element, names } of applied) for (const name of names) element.removeAttribute(name);
  applied = [];
  const { drawing, highlight, selection } = view.value;
  const state = highlight ? drawings[drawing].states[highlight] : undefined;
  for (const [address, attributes] of Object.entries(state?.attributes ?? {})) {
    const [channel, id] = address.split(/:(.*)/s) as ["node" | "edge", string];
    const element = elementOf(drawing, id, channel);
    if (!element) continue;
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    applied.push({ element, names: Object.keys(attributes) });
  }
  if (selection) {
    const element = elementOf(drawing, selection, "edge");
    if (element) {
      element.setAttribute("data-film-selected", "true");
      applied.push({ element, names: ["data-film-selected"] });
    }
  }
}

/**
 * An element's box in the drawing's own units. A node's group is translated into place, and getBBox answers in the
 * group's own units, so the box is carried through the group's transform relative to the camera's.
 */
function drawingBox(name: FilmDrawing, element: SVGGraphicsElement): DOMRect | null {
  const cam = camOf(name)?.getCTM();
  const own = element.getCTM();
  if (!cam || !own) return null;
  const into = cam.inverse().multiply(own);
  const b = element.getBBox();
  const corners = [
    new DOMPoint(b.x, b.y),
    new DOMPoint(b.x + b.width, b.y + b.height),
  ].map((point) => point.matrixTransform(into));
  const [a, z] = corners as [DOMPoint, DOMPoint];
  return new DOMRect(Math.min(a.x, z.x), Math.min(a.y, z.y), Math.abs(z.x - a.x), Math.abs(z.y - a.y));
}

/** The step's parts in the drawing's own units: what the follow camera frames. */
function boundsOf(name: FilmDrawing, ids: readonly string[]): DOMRect | null {
  let box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  for (const id of ids) {
    const element = elementOf(name, id);
    const b = element ? drawingBox(name, element) : null;
    if (!b) continue;
    box = box
      ? { x0: Math.min(box.x0, b.x), y0: Math.min(box.y0, b.y), x1: Math.max(box.x1, b.x + b.width), y1: Math.max(box.y1, b.y + b.height) }
      : { x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height };
  }
  return box ? new DOMRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0) : null;
}

/**
 * The walkthrough's follow camera, and the reader's zoom: the parts fill the canvas, never past the app's own size
 * (1:1). Elsewhere the whole drawing fits, as the app opens it.
 */
function camera(name: FilmDrawing): { s: number; tx: number; ty: number } {
  const svg = svgOf(name);
  const { step, drawing, zoom } = view.value;
  const identity = { s: 1, tx: 0, ty: 0 };
  if (!svg || drawing !== name) return identity;
  const current = step > 0 ? WALKS.proposal[step - 1] : undefined;
  const ids = zoom ?? (current ? [...current.nodes, ...current.edges.map((edge) => edge.id)] : null);
  if (ids === null) return identity;
  const box = boundsOf(name, ids);
  if (!box) return identity;
  const [vx, vy, vw, vh] = drawings[name].viewBox.split(" ").map(Number) as [number, number, number, number];
  const { width, height } = svg.getBoundingClientRect();
  if (width === 0 || height === 0) return identity;
  const fit = Math.min(width / vw, height / vh);
  const pad = 28;
  const wanted = Math.min(1, (width - pad * 2) / box.width, (height - pad * 2) / box.height);
  const s = Math.max(1, wanted / fit);
  const centre = { x: vx + vw / 2, y: vy + vh / 2 };
  return { s, tx: centre.x - s * (box.x + box.width / 2), ty: centre.y - s * (box.y + box.height / 2) };
}

/** Where a target is, in the body's pixels, after the camera has moved (computed, not read mid-move). */
function locate(target: FilmTarget): { x: number; y: number } | null {
  const frameBox = body.value?.getBoundingClientRect();
  if (!frameBox) return null;
  const centreOf = (element: Element | null | undefined) => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { x: r.left + r.width / 2 - frameBox.left, y: r.top + r.height / 2 - frameBox.top };
  };
  if ("element" in target) {
    const name = view.value.drawing;
    const svg = svgOf(name);
    const element = elementOf(name, target.element, "edge") ?? elementOf(name, target.element);
    const words = element?.querySelector<SVGGraphicsElement>("g[font-style]") ?? element;
    const matrix = svg?.getScreenCTM();
    const b = words ? drawingBox(name, words) : null;
    if (!svg || !b || !matrix) return null;
    const cam = camera(name);
    const point = new DOMPoint(cam.s * (b.x + b.width / 2) + cam.tx, cam.s * (b.y + b.height / 2) + cam.ty).matrixTransform(matrix);
    return { x: point.x - frameBox.left, y: point.y - frameBox.top };
  }
  const control = root.value?.querySelector(`[data-film-target="${target.control}"]`);
  return centreOf(control) ?? centreOf(root.value?.querySelector('[data-film-target="canvas"]'));
}

function place() {
  for (const name of ORDER) {
    const { s, tx, ty } = camera(name);
    cameras.value[name] = `translate(${tx}px, ${ty}px) scale(${s})`;
  }
  cursor.value = locate(view.value.cursor);
}

// The terminal scrolls on its own like a long answer does: slowly, unless motion is reduced. It holds still while the
// film is paused, and while the reader is in it (focus or pointer); their own scrolling stops it at once.
let scrolling = 0;
const readerFocus = ref(false);
const readerPointer = ref(false);
function stopScrolling() {
  cancelAnimationFrame(scrolling);
  scrolling = 0;
}
/** The reader in the terminal: in it, the answer stays where they put it. */
const readerIn = {
  focusin: () => {
    readerFocus.value = true;
    stopScrolling();
  },
  focusout: () => (readerFocus.value = false),
  pointerenter: () => {
    readerPointer.value = true;
    stopScrolling();
  },
  pointerleave: () => (readerPointer.value = false),
  wheel: stopScrolling,
  touchstart: stopScrolling,
  keydown: stopScrolling,
};
function scrollTerminal() {
  const element = log.value;
  if (!element) return;
  stopScrolling();
  // Not running (paused, off screen, a hidden tab), or the reader is in it: it holds still.
  if (!running.value || readerFocus.value || readerPointer.value) return;
  const target = view.value.terminalAtEnd ? element.scrollHeight - element.clientHeight : 0;
  const from = element.scrollTop;
  if (reduced.value || Math.abs(target - from) < 1) {
    element.scrollTop = target;
    return;
  }
  const start = performance.now();
  const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  const tick = (now: number) => {
    const t = Math.min(1, (now - start) / 3400);
    element.scrollTop = from + (target - from) * ease(t);
    if (t < 1) scrolling = requestAnimationFrame(tick);
  };
  scrolling = requestAnimationFrame(tick);
}

let resize: ResizeObserver | undefined;
let motion: MediaQueryList | undefined;
const onMotion = () => (reduced.value = Boolean(motion?.matches));
onMounted(async () => {
  motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  reduced.value = motion.matches;
  motion.addEventListener("change", onMotion);
  player = createFilmPlayer({
    win: window,
    // The window Archer plays in: on a phone the terminal stacked above it can be on screen while it is not.
    root: browser.value!,
    durations: FILM_FRAMES.map((entry) => entry.ms),
    reducedMotion: reduced.value,
    onFrame: (index) => (frame.value = index),
    onState: (state) => {
      paused.value = state.paused;
      running.value = state.running;
    },
  });
  paused.value = player.state().paused;
  running.value = player.state().running;
  hydrated.value = true;
  await nextTick();
  applyHighlight();
  place();
  resize = new ResizeObserver(() => place());
  resize.observe(body.value!);
});
onUnmounted(() => {
  player?.dispose();
  resize?.disconnect();
  motion?.removeEventListener("change", onMotion);
  stopScrolling();
});
watch(running, (now) => {
  if (now) scrollTerminal();
  else stopScrolling();
});
watch(frame, async () => {
  await nextTick();
  applyHighlight();
  place();
  scrollTerminal();
});

function toggle() {
  player?.toggle();
}
const captions = [...new Map(FILM_FRAMES.map((entry) => [`${entry.lead} ${entry.cap}`, entry])).values()];
const progress = computed(() => `${Math.round(((frame.value + 1) / FILM_FRAMES.length) * 100)}%`);
const commentOn = "Charge (Payment Worker to Payment Provider)";
</script>

<template>
  <div ref="root" class="film" :class="{ 'film--still': reduced, 'film--paused': paused }" :data-film-running="running">
    <div class="film-pair">
      <div class="film-col">
        <div class="film-head">
          <h2>Chat alone</h2>
          <span>Scroll, re-read, ask again.</span>
        </div>
        <div class="film-term">
          <div class="film-term-bar" aria-hidden="true">
            <span class="film-lights"><i /><i /><i /></span>
            <span class="film-term-title">Terminal · ~/shop · coding agent</span>
          </div>
          <!-- biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region the keyboard must be able to scroll. -->
          <div ref="log" class="film-log" role="log" tabindex="0" aria-label="A long text answer from the coding agent" v-on="readerIn">
            <template v-for="(line, index) in answer" :key="index">
              <div v-if="line.kind === 'gap'" class="film-gap" />
              <div v-else-if="line.kind === 'you'" class="film-you"><span aria-hidden="true">you ›</span><span>{{ line.text }}</span></div>
              <div v-else-if="line.kind === 'agent'" class="film-agent"><span aria-hidden="true">●</span><span>{{ line.text }}</span></div>
              <div v-else :class="`film-line-${line.kind}`">{{ line.text }}</div>
            </template>
          </div>
          <div class="film-ask" aria-hidden="true">
            <span class="film-ask-mark">›</span>
            <span v-if="view.followUp" class="film-ask-q">wait, which part talks to the payment provider again?</span>
            <span v-else class="film-ask-hint">Ask a follow-up</span>
            <!-- A new caret at the new line's end, not the old one moved there: the swap shifts no layout (O286). -->
            <span :key="view.followUp ? 'question' : 'hint'" class="film-caret" />
          </div>
        </div>
      </div>

      <div class="film-col">
        <div class="film-head">
          <h2>With Archer</h2>
          <span>Walk it, point at it, comment.</span>
          <span class="film-badge">Scripted example</span>
        </div>
        <div ref="browser" class="film-browser film-app" role="img" :aria-label="`Archer in the browser, scripted: ${view.lead} ${view.cap}`">
          <div class="film-browser-bar">
            <span class="film-lights"><i /><i /><i /></span>
            <span class="film-address">{{ view.address }}</span>
          </div>
          <div class="film-docbar">
            <span class="film-crumbs">shop / notes / proposals</span>
            <span class="film-title">{{ view.title }}</span>
          </div>
          <div ref="body" class="film-body">
            <div class="film-rail">
              <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20 12 4l8 16" /><path d="M7.5 13h9" /></svg>
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h6l2 2h10v10H3z" /></svg>
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>
            </div>
            <div class="film-canvas" data-film-target="canvas">
              <svg aria-hidden="true"
                v-for="item in layers"
                :key="item.name"
                ref="svgs"
                class="film-drawing"
                :class="{ 'is-shown': view.drawing === item.name }"
                :data-film-state="view.drawing === item.name ? (view.highlight ?? 'none') : 'none'"
                :data-film-pin="view.drawing === item.name && view.pin ? 'shown' : 'hidden'"
                :viewBox="item.viewBox"
                preserveAspectRatio="xMidYMid meet"
                xmlns="http://www.w3.org/2000/svg"
              >
                <g ref="cams" class="film-cam" :style="{ transform: cameras[item.name] }" v-html="markupOf(item)" />
              </svg>
            </div>
            <div class="film-panel">
              <template v-if="view.panel === 'highlights'">
                <section class="film-highlights">
                  <span class="film-panel-label">Highlights</span>
                  <span class="film-panel-title">{{ SEQUENCE_HIGHLIGHT.title }}</span>
                  <ol>
                    <li
                      v-for="(group, index) in SEQUENCE_HIGHLIGHT.groups"
                      :key="group.id"
                      :data-film-target="index === SEQUENCE_HIGHLIGHT.groups.length - 1 ? 'legend' : undefined"
                    >
                      <span class="film-swatch" :style="{ background: SLOTS[index] }" />
                      <span class="film-highlight-text">
                        <strong><span class="film-highlight-num">{{ index + 1 }}</span>{{ group.label }}</strong>
                        <span>{{ group.description }}</span>
                      </span>
                    </li>
                  </ol>
                </section>
              </template>
              <template v-else>
                <span class="film-panel-label">Walkthrough</span>
                <span class="film-panel-title">{{ WALK_TITLE }}</span>
                <span v-if="view.step === 0" class="film-play-walk" data-film-target="play">
                  <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><path d="M6 4l14 8-14 8V4z" /></svg>
                  Play walkthrough
                </span>
                <span v-else class="film-play-walk is-playing" data-film-target="play">
                  <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M8 5v14" /><path d="M16 5v14" /></svg>
                  Step {{ view.step }} of {{ steps.length }}
                </span>
                <ol class="film-steps">
                  <li
                    v-for="(step, index) in steps"
                    :key="step.title"
                    :class="{ 'is-current': view.step === index + 1 }"
                    :data-film-target="view.step === index + 1 ? 'step' : undefined"
                  >
                    <span>{{ index + 1 }}</span>{{ step.title }}
                  </li>
                </ol>
              </template>
              <div v-if="key" class="film-key">
                <span class="film-panel-label">Diagram Key</span>
                <svg :viewBox="`0 0 ${key.width} ${key.height}`" :width="key.width" :height="key.height" v-html="key.svg" />
              </div>
              <div class="film-comments" :class="{ 'is-open': view.panel === 'comments' }">
                <span class="film-panel-label">Comments · {{ commentOn }}</span>
                <div v-if="view.comment === 'none' || view.comment === 'draft'" class="film-draft" :class="{ 'is-empty': view.comment === 'none' }">
                  <span>If the worker crashes after the charge, is the card charged twice?<i class="film-caret film-caret--thin" /></span>
                  <span class="film-draft-send" data-film-target="comment">Comment</span>
                </div>
                <template v-else>
                  <div class="film-posted" data-film-target="thread">
                    <span class="film-who">You · just now</span>
                    <span>If the worker crashes after the charge, is the card charged twice?</span>
                  </div>
                  <div v-if="view.comment === 'waiting'" class="film-waiting">
                    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
                    <span>Waiting for the agent's next turn</span>
                  </div>
                  <div v-else class="film-reply">
                    <span class="film-who">Agent · reply</span>
                    <span>Not with an idempotency key. I added one, and a dead-letter queue after 3 failed tries.</span>
                  </div>
                </template>
              </div>
            </div>
            <div class="film-toast" :class="{ 'is-shown': view.toast }">
              <div class="film-toast-bar"><span class="film-lights film-lights--small"><i /><i /><i /></span>Meanwhile, in your terminal</div>
              <div class="film-toast-body">
                <div><span class="film-you-mark">you › </span>I left a comment in Archer on the charge.</div>
                <div><span class="film-agent-mark">● </span>Read 1 comment: Charge (Payment Worker to Payment Provider).</div>
                <div><span class="film-agent-mark">● </span>Revising payment-worker.md…</div>
              </div>
            </div>
            <div class="film-cursor" :class="{ 'is-placed': cursor }" :style="cursor ? { transform: `translate(${cursor.x}px, ${cursor.y}px)` } : undefined">
              <span v-if="view.click" :key="frame" class="film-ripple" />
              <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24"><path d="M5 3l14 7.2-6.3 1.7L9.7 18z" /></svg>
            </div>
          </div>
        </div>
        <div class="film-progress" aria-hidden="true"><div :style="{ width: progress }" /></div>
        <div class="film-caption-row">
          <!-- Every caption laid in one cell, the unshown ones invisible: the row is as tall as the longest at any
               width, so a caption never moves the page. Keyed by frame, so its words are new, not shifted. -->
          <div class="film-captions">
            <p v-for="caption in captions" :key="`${caption.lead} ${caption.cap}`" class="film-caption film-caption--ghost" aria-hidden="true"><strong>{{ caption.lead }}</strong> {{ caption.cap }}</p>
            <p :key="frame" class="film-caption" :aria-live="paused ? 'polite' : 'off'"><strong>{{ view.lead }}</strong> {{ view.cap }}</p>
          </div>
          <button type="button" class="film-toggle" :class="{ 'is-paused': paused }" @click="toggle">
            <svg v-if="paused" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l14 8-14 8V4z" /></svg>
            <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M8 5v14" /><path d="M16 5v14" /></svg>
            {{ paused ? "Play" : "Pause" }}
          </button>
        </div>
      </div>
    </div>
    <div class="film-actions">
      <a class="film-cta" href="#install">Install Archer</a>
      <a class="film-cta film-cta--quiet" :href="playground">
        Try the playground
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7" /><path d="M8 7h9v9" /></svg>
      </a>
    </div>
  </div>
</template>
