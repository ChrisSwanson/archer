/**
 * The nested view's messages between the page and its layout worker. A message is tagged `nest`
 * so the worker's entry (`nest-worker.ts`) and the page's transport (`elk-worker-transport.ts`)
 * can tell it from ELK's own. The engine (`nest-engine.ts`) lives in the worker and keeps the
 * layouts it made there; the page gets copies.
 *
 * Sessions: the first request for a session key on a worker carries the diagram (`spec`);
 * afterwards only the key. A worker that no longer has it answers `unknown-session` and the
 * client sends the request again with the diagram.
 */
import type { LayoutResult } from "../layout/elk-layout";
import type { Laid } from "./grow-in-place-v2";
import type { NestEngine, NestHow, NestStepSpec } from "./nest-engine";
import { nestSessionKey, type NestSessionSpec } from "./nest-key";

/** How long one press may take in the worker before it is stopped and the press refused (the caller lays out the fallback). */
export const NEST_STEP_TIMEOUT_MS = 8_000;

export type NestSessionRef = { readonly key: string; readonly spec?: NestSessionSpec };

/** A request that answers: it names its session and has an id. */
type Asked = Extract<NestRequest, { readonly id: number }>;

export type NestRequest =
  | {
      readonly op: "layout";
      readonly id: number;
      readonly session: NestSessionRef;
      readonly open: readonly string[];
      readonly step?: NestStepSpec;
    }
  | {
      readonly op: "fallback";
      readonly id: number;
      readonly session: NestSessionRef;
      readonly open: readonly string[];
      readonly seed?: Laid;
    }
  | {
      readonly op: "prefetch";
      readonly id: number;
      readonly session: NestSessionRef;
      readonly from: readonly string[];
      readonly candidates: readonly string[];
    }
  | { readonly op: "cancel" }
  | { readonly op: "drop" };

export type NestReply =
  | { readonly id: number; readonly kind: "first"; readonly layout: LayoutResult }
  | { readonly id: number; readonly kind: "complete"; readonly layout: LayoutResult; readonly how: NestHow }
  | { readonly id: number; readonly kind: "error"; readonly message: string }
  | { readonly id: number; readonly kind: "unknown-session" }
  /** A prefetch list taken (prefetch has no other answer). */
  | { readonly id: number; readonly kind: "accepted" };

export function isNestMessage(data: unknown): data is { readonly nest: unknown } {
  return typeof data === "object" && data !== null && "nest" in data;
}

/** The worker side: each request handed to `engine`, each answer posted back. */
export function serveNest(
  engine: NestEngine,
  post: (message: { nest: NestReply }) => void,
): (request: NestRequest) => void {
  const reply = (message: NestReply) => post({ nest: message });
  const known = (session: NestSessionRef): string | undefined => {
    if (session.spec !== undefined) return engine.open(session.spec);
    return engine.has(session.key) ? session.key : undefined;
  };
  return (request) => {
    if (request.op === "cancel") return engine.cancelPrefetch();
    if (request.op === "drop") return engine.dropPrefetched();
    const key = known(request.session);
    if (key === undefined) return reply({ id: request.id, kind: "unknown-session" });
    if (request.op === "prefetch") {
      void engine.prefetch(key, request.from, request.candidates);
      return reply({ id: request.id, kind: "accepted" });
    }
    const work =
      request.op === "layout"
        ? engine.layout(key, request.open, request.step)
        : engine.fallback(key, request.open, request.seed);
    // Only a grow has a first picture of its own; anything else sends one message, not two.
    if (work.first !== work.complete)
      void work.first.then(
        (layout) => reply({ id: request.id, kind: "first", layout }),
        () => undefined,
      );
    Promise.all([work.complete, work.how]).then(
      ([layout, how]) => reply({ id: request.id, kind: "complete", layout, how }),
      (error: unknown) =>
        reply({
          id: request.id,
          kind: "error",
          message: error instanceof Error ? error.message.slice(0, 1000) : "the nested view could not be laid out",
        }),
    );
  };
}

/** What a nest request answers: the staged first picture, the complete one, and how it was reached. */
export type NestClientAnswer = {
  readonly first: Promise<LayoutResult>;
  readonly complete: Promise<LayoutResult>;
  readonly how: Promise<NestHow>;
};

type Pending = {
  request: Asked;
  spec: NestSessionSpec;
  resent: boolean;
  timer?: ReturnType<typeof setTimeout>;
  showFirst(layout: LayoutResult): void;
  resolve(done: { layout: LayoutResult; how: NestHow }): void;
  reject(error: Error): void;
};

const keys = new WeakMap<object, Map<string, string>>();
/** `nestSessionKey`, remembered per full view: it serialises the whole view. */
export function sessionKeyOf(spec: NestSessionSpec): string {
  let byFace = keys.get(spec.full);
  if (byFace === undefined) keys.set(spec.full, (byFace = new Map()));
  const sub = `${spec.typeface}\0${spec.revision}`;
  let key = byFace.get(sub);
  if (key === undefined) byFace.set(sub, (key = nestSessionKey(spec)));
  return key;
}

/**
 * The page side of the channel, one per worker: it knows which sessions that worker has been
 * sent. A press past `timeoutMs` calls `onTimeout` (the transport closes the worker, which closes
 * this client and refuses everything pending).
 */
export class NestClient {
  readonly #post: (message: { nest: NestRequest }) => void;
  readonly #timeoutMs: number;
  readonly #onTimeout: (error: Error) => void;
  readonly #sent = new Set<string>();
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed: Error | undefined;

  constructor(
    post: (message: { nest: NestRequest }) => void,
    options: { timeoutMs?: number; onTimeout?: (error: Error) => void } = {},
  ) {
    this.#post = post;
    this.#timeoutMs = options.timeoutMs ?? NEST_STEP_TIMEOUT_MS;
    this.#onTimeout = options.onTimeout ?? ((error) => this.close(error));
  }

  layout(spec: NestSessionSpec, open: readonly string[], step?: NestStepSpec): NestClientAnswer {
    return this.#ask(spec, (id, session) => ({
      op: "layout",
      id,
      session,
      open: [...open],
      ...(step === undefined ? {} : { step: { from: [...step.from], toggled: step.toggled } }),
    }));
  }

  fallback(spec: NestSessionSpec, open: readonly string[], seed?: Laid): NestClientAnswer {
    return this.#ask(spec, (id, session) => ({
      op: "fallback",
      id,
      session,
      open: [...open],
      ...(seed === undefined ? {} : { seed }),
    }));
  }

  prefetch(spec: NestSessionSpec, from: readonly string[], candidates: readonly string[]): void {
    if (this.#closed !== undefined) return;
    const id = this.#nextId++;
    const request = {
      op: "prefetch" as const,
      id,
      session: this.#ref(spec),
      from: [...from],
      candidates: [...candidates],
    };
    // Answered `accepted` or `unknown-session`; never timed.
    this.#pending.set(id, {
      request,
      spec,
      resent: false,
      showFirst: () => undefined,
      resolve: () => undefined,
      reject: () => undefined,
    });
    this.#send(request);
  }

  cancelPrefetch(): void {
    if (this.#closed === undefined) this.#send({ op: "cancel" });
  }

  dropPrefetched(): void {
    if (this.#closed === undefined) this.#send({ op: "drop" });
  }

  receive(reply: NestReply): void {
    const pending = this.#pending.get(reply.id);
    if (pending === undefined) return;
    if (reply.kind === "first") return pending.showFirst(reply.layout);
    if (reply.kind === "unknown-session" && !pending.resent) {
      pending.resent = true;
      this.#sent.delete(pending.request.session.key);
      const again: Asked = { ...pending.request, session: this.#ref(pending.spec) };
      pending.request = again;
      this.#send(again);
      return;
    }
    this.#finish(reply.id);
    if (pending.request.op === "prefetch") return;
    if (reply.kind === "complete") pending.resolve({ layout: reply.layout, how: reply.how });
    else
      pending.reject(
        new Error(
          reply.kind === "error"
            ? `The nested view could not be laid out: ${reply.message}`
            : "The layout worker lost the diagram.",
        ),
      );
  }

  /** Refuses everything pending; later requests are refused at once. */
  close(reason: Error = new Error("Background layout worker was stopped.")): void {
    if (this.#closed !== undefined) return;
    this.#closed = reason;
    for (const id of [...this.#pending.keys()]) {
      const pending = this.#pending.get(id)!;
      this.#finish(id);
      pending.reject(reason);
    }
  }

  #ref(spec: NestSessionSpec): { key: string; spec?: NestSessionSpec } {
    const key = sessionKeyOf(spec);
    if (this.#sent.has(key)) return { key };
    this.#sent.add(key);
    return { key, spec };
  }

  #finish(id: number): void {
    const pending = this.#pending.get(id);
    if (pending?.timer !== undefined) clearTimeout(pending.timer);
    this.#pending.delete(id);
  }

  #send(request: NestRequest): void {
    try {
      this.#post({ nest: request });
    } catch (error) {
      this.close(error instanceof Error ? error : new Error("Background layout could not be sent to its worker."));
    }
  }

  #ask(spec: NestSessionSpec, build: (id: number, session: NestSessionRef) => Asked): NestClientAnswer {
    let showFirst!: (layout: LayoutResult) => void;
    let refuseFirst!: (error: Error) => void;
    const first = new Promise<LayoutResult>((resolve, reject) => {
      showFirst = resolve;
      refuseFirst = reject;
    });
    const done = new Promise<{ layout: LayoutResult; how: NestHow }>((resolve, reject) => {
      if (this.#closed !== undefined) return reject(this.#closed);
      const id = this.#nextId++;
      const request = build(id, this.#ref(spec));
      const timer = setTimeout(
        () => this.#onTimeout(new Error("Background layout exceeded its time limit. Try opening the box again.")),
        this.#timeoutMs,
      );
      this.#pending.set(id, { request, spec, resent: false, timer, showFirst, resolve, reject });
      this.#send(request);
    });
    done.then((d) => showFirst(d.layout), refuseFirst);
    first.catch(() => undefined);
    const how = done.then((d) => d.how);
    how.catch(() => undefined);
    return { first, complete: done.then((d) => d.layout), how };
  }
}
