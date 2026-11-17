/**
 * Source frames' messages between the page and its layout worker, tagged `frames` so the worker's entry
 * (`nest-worker.ts`) and the page's transport (`elk-worker-transport.ts`) tell them from ELK's and the
 * nested view's. The engine (`frame-engine.ts`) lives in the worker and keeps the layouts it made; the page
 * gets copies. Each request carries its base (the canvas as drawn) and the whole frame list, so there is
 * no session to lose: the worker reuses what it has under the base's key.
 */
import type { LayoutResult } from "../layout/elk-layout";
import type { FrameBase, FrameEngine, FramesAnswer, FrameStep } from "./frame-engine";
import type { Frame } from "./frame-view";

/** How long one request may take in the worker before the page stops waiting (and shows the base view). */
export const FRAMES_TIMEOUT_MS = 8_000;

export type FramesRequest = {
  readonly op: "layout";
  readonly id: number;
  readonly base: FrameBase;
  readonly frames: readonly Frame[];
};
export type FramesReply =
  | {
      readonly id: number;
      readonly kind: "complete";
      readonly layout: LayoutResult;
      readonly steps: readonly FrameStep[];
    }
  | { readonly id: number; readonly kind: "error"; readonly message: string };

export function isFramesMessage(data: unknown): data is { readonly frames: unknown } {
  return typeof data === "object" && data !== null && "frames" in data;
}

/** The worker side: each request handed to `engine`, in arrival order, each answer posted back. */
export function serveFrames(
  engine: FrameEngine,
  post: (message: { frames: FramesReply }) => void,
): (request: FramesRequest) => void {
  let queue: Promise<unknown> = Promise.resolve();
  return (request) => {
    queue = queue
      .then(() => engine.layout(request.base, request.frames))
      .then(
        (answer: FramesAnswer) =>
          post({ frames: { id: request.id, kind: "complete", layout: answer.layout, steps: answer.steps } }),
        (error: unknown) =>
          post({
            frames: {
              id: request.id,
              kind: "error",
              message: error instanceof Error ? error.message.slice(0, 1000) : "the frames could not be laid out",
            },
          }),
      );
  };
}

type Pending = {
  resolve(answer: FramesAnswer): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

/** The page side, one per worker. A request past `timeoutMs` is refused; the worker carries on. */
export class FramesClient {
  readonly #post: (message: { frames: FramesRequest }) => void;
  readonly #timeoutMs: number;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed: Error | undefined;

  constructor(post: (message: { frames: FramesRequest }) => void, options: { timeoutMs?: number } = {}) {
    this.#post = post;
    this.#timeoutMs = options.timeoutMs ?? FRAMES_TIMEOUT_MS;
  }

  layout(base: FrameBase, frames: readonly Frame[]): Promise<FramesAnswer> {
    return new Promise((resolve, reject) => {
      if (this.#closed !== undefined) return reject(this.#closed);
      const id = this.#nextId++;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("Placing the frame took too long."));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#post({ frames: { op: "layout", id, base, frames } });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error("The frames could not be sent to the layout worker."));
      }
    });
  }

  receive(reply: FramesReply): void {
    const pending = this.#pending.get(reply.id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pending.delete(reply.id);
    if (reply.kind === "complete") pending.resolve({ layout: reply.layout, steps: reply.steps });
    else pending.reject(new Error(`The frame could not be placed: ${reply.message}`));
  }

  close(reason: Error = new Error("Background layout worker was stopped.")): void {
    if (this.#closed !== undefined) return;
    this.#closed = reason;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(reason);
    }
  }
}
