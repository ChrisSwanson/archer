/**
 * Who receives the chat's messages (ADR 0035 §7–8): the service's listener listing for the checkout on screen,
 * read from `api/listeners`, kept current by the `listeners` stream event (`listener-event.ts`), and the person's
 * two actions on it: pinning a listener and pressing Launch. Only with the service's `listeners` capability;
 * without it the chat keeps 0.6.4's pull line.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LISTENER_ROUTES,
  type AgentHost,
  type AgentInfo,
  type ListenerListing,
  type ListenerState,
  type ListenerStatus,
  type PendingDelivery,
} from "../../../ts/src/agents/contract";
import { browserFetch } from "../app/browser-resource";
import { LISTENERS_DOM_EVENT, LISTENERS_LOST } from "./listener-event";

/**
 * The listing as the page reads it. `launcher`: the person configured a launch command (ADR 0035 §8), so the
 * chat may offer Launch while nobody listens; the service sends it only to the person. `personal: true`: this
 * viewer is the person themself (the owner's own sign-in on this computer, not an access link or a paired
 * device), who alone may pin and launch (review decisions 1 and 23). The service enforces it (403 `person_only`);
 * the page only hides what it would refuse, and without the flag offers neither.
 */
export type Listing = ListenerListing & { readonly launcher?: boolean; readonly personal?: boolean };
export type { AgentInfo, ListenerState };

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Rec) : undefined;
const STATES: readonly ListenerState[] = ["listening", "next-turn", "none"];
const HOSTS: readonly AgentHost[] = ["claude-code", "codex", "other"];
/** The service's label bound (`MAX_LABEL` in ts/src/agents/pins.ts): 80 code points, never half a surrogate pair. */
const LABEL_CODE_POINTS = 80;

function agent(value: unknown): AgentInfo | undefined {
  const r = rec(value);
  if (r === undefined || typeof r.agentId !== "string" || r.agentId === "" || typeof r.label !== "string")
    return undefined;
  return {
    agentId: r.agentId,
    root: typeof r.root === "string" ? r.root : "",
    cwd: typeof r.cwd === "string" ? r.cwd : "",
    host: HOSTS.includes(r.host as AgentHost) ? (r.host as AgentHost) : "other",
    label: Array.from(r.label).slice(0, LABEL_CODE_POINTS).join(""),
    lastActive: typeof r.lastActive === "string" ? r.lastActive : "",
  };
}
const agents = (value: unknown): AgentInfo[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const read = value.map(agent);
  return read.every((a): a is AgentInfo => a !== undefined) ? read : undefined;
};

/** One checkout's status, or undefined: a state the page does not know is never shown as one it does. */
export function parseStatus(value: unknown): ListenerStatus | undefined {
  const r = rec(value);
  if (
    r === undefined ||
    typeof r.root !== "string" ||
    !STATES.includes(r.state as ListenerState) ||
    typeof r.pinnedByPerson !== "boolean"
  )
    return undefined;
  const listener = r.listener === null ? null : agent(r.listener);
  if (listener === undefined) return undefined;
  // "Listening" needs a listener to name; without one it is not claimed.
  const state = r.state === "listening" && listener === null ? "none" : (r.state as ListenerState);
  return {
    root: r.root,
    state,
    listener,
    pinnedByPerson: r.pinnedByPerson,
    ...(r.away === true && listener !== null && state !== "none" ? { away: true } : {}),
  };
}

/** One step of the delivery order, or undefined: a step the page does not know is never shown (ADR 0035, amended 2026-10-31). */
function pendingStep(value: unknown): PendingDelivery | undefined {
  const r = rec(value);
  if (r === undefined || typeof r.threadId !== "string" || r.threadId === "" || typeof r.until !== "string")
    return undefined;
  if (r.step === "launching") return { threadId: r.threadId, step: "launching", until: r.until };
  if (r.step !== "next-turn" || typeof r.waitMs !== "number" || !Number.isFinite(r.waitMs) || r.waitMs < 0)
    return undefined;
  return {
    threadId: r.threadId,
    step: "next-turn",
    host: HOSTS.includes(r.host as AgentHost) ? (r.host as AgentHost) : "other",
    waitMs: r.waitMs,
    until: r.until,
  };
}

export function parseListing(value: unknown): Listing | undefined {
  const r = rec(value);
  const current = parseStatus(r?.current);
  const currentAgents = agents(rec(r?.current)?.agents);
  if (r === undefined || current === undefined || currentAgents === undefined || !Array.isArray(r.otherCheckouts))
    return undefined;
  const others: Listing["otherCheckouts"][number][] = [];
  for (const raw of r.otherCheckouts) {
    const status = parseStatus(raw);
    const list = agents(rec(raw)?.agents);
    const name = rec(raw)?.name;
    if (status === undefined || list === undefined || typeof name !== "string") return undefined;
    others.push({ ...status, name, agents: list });
  }
  const pending = Array.isArray(r.pending)
    ? r.pending.map(pendingStep).filter((step): step is PendingDelivery => step !== undefined)
    : [];
  return {
    current: { ...current, agents: currentAgents },
    otherCheckouts: others,
    ...(pending.length === 0 ? {} : { pending }),
    ...(r.launcher === true ? { launcher: true } : {}),
    ...(typeof r.personal === "boolean" ? { personal: r.personal } : {}),
  };
}

/** Whether this viewer may pin a listener and press Launch: only when the service says so (`Listing.personal`). */
export function mayChoose(listing: Listing | null): boolean {
  return listing?.personal === true;
}

/** A listener's state as it bears on Launch: two listings with the same key say the same about who listens. */
export function listenerKey(listing: Listing | null): string | null {
  if (listing === null) return null;
  const { state, listener, away, pinnedByPerson } = listing.current;
  return JSON.stringify([state, listener?.agentId ?? null, away === true, pinnedByPerson]);
}

/** A refusal from the listener routes, with the service's code (`person_only`, `listener_live`, `launch_busy`, …). */
export class ListenerRouteError extends Error {
  override readonly name = "ListenerRouteError";
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The pin and Launch routes are the person's alone: an access link or a paired device is refused with this code. */
export const PERSON_ONLY = "person_only";

/** The service's words for a refusal, or the status. */
async function refusal(response: Response, what: string): Promise<Error> {
  let code: string | undefined;
  try {
    const error = rec(rec(await response.json())?.error);
    code = typeof error?.code === "string" ? error.code : undefined;
    if (typeof error?.message === "string" && error.message !== "")
      return new ListenerRouteError(error.message, code, response.status);
  } catch {
    /* no JSON body */
  }
  return new ListenerRouteError(`${what} failed with HTTP ${response.status}`, code, response.status);
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The listener routes, relative to the project page like every other route it reads. */
export interface ListenerTransport {
  list(): Promise<Listing>;
  /** The person's pick; `null` gives the role back to whichever agent claims it. */
  pin(agentId: string | null): Promise<ListenerStatus>;
  /** Runs the person's configured launcher for this thread's waiting message. */
  launch(threadId: string): Promise<void>;
}

export function httpListenerTransport(fetchImpl: FetchLike = browserFetch): ListenerTransport {
  const post = async (what: string, url: string, body: unknown): Promise<unknown> => {
    // JSON, as every write from a cookie-admitted page is (ADR 0017).
    const response = await fetchImpl(url, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await refusal(response, what);
    return response.json() as Promise<unknown>;
  };
  return {
    async list() {
      const response = await fetchImpl(LISTENER_ROUTES.list, { cache: "no-store" });
      if (!response.ok) throw await refusal(response, "reading who is listening");
      const listing = parseListing(await response.json());
      if (listing === undefined) throw new Error("could not read who is listening");
      return listing;
    },
    async pin(agentId) {
      const status = parseStatus(await post("choosing the agent", LISTENER_ROUTES.pin, { agentId }));
      if (status === undefined) throw new Error("could not read the chosen agent");
      return status;
    },
    async launch(threadId) {
      await post("launching an agent", LISTENER_ROUTES.launch, { threadId });
    },
  };
}

/** What a pick came to: taken, or, its answer lost, read back as taken, as not taken, or not readable (O125). */
export type PinOutcome = "chosen" | "not-chosen" | "unknown";

/** Whether a listing shows the pick: the agent pinned by the person, or (`null`) the role given back. */
export function pinHolds(current: ListenerStatus, agentId: string | null): boolean {
  return agentId === null ? !current.pinnedByPerson : current.pinnedByPerson && current.listener?.agentId === agentId;
}

/** Waits between the retries of a failed listing read; after the last the chat says it cannot tell (decision 25). */
export const LISTING_RETRY_MS: readonly number[] = [1_000, 2_000, 4_000];
/** How long the listing may stay unknown (a dropped stream not back yet) before the chat says it cannot tell. */
export const UNKNOWN_AFTER_MS = 10_000;
/** A read older than this is made again when the chat opens, so `launcher` follows the config (decision 32). */
export const LISTING_FRESH_MS = 30_000;
/** How long Launch waits for the launched agent to claim before it is offered again (decision 33). */
export const LAUNCH_WAIT_MS = 60_000;

/** What only the read (the GET, to the person) says; the `listeners` event never carries it. */
type Owner = Pick<Listing, "personal" | "launcher">;
const ownerOf = (l: Listing): Owner => ({
  ...(l.launcher === true ? { launcher: true } : {}),
  ...(l.personal !== undefined ? { personal: l.personal } : {}),
});
const withoutOwner = (l: Listing): Listing => {
  const { personal: _p, launcher: _l, ...rest } = l;
  return rest;
};

/**
 * The listing while `enabled`, in two parts (decision 31). Who listens comes from the newest of a read or a
 * `listeners` event; `personal` and `launcher` come only from the last read that answered, which no event replaces
 * or discards. The chat reads when it opens unless both are held: who listens fresh since the stream last opened,
 * and a read answered within LISTING_FRESH_MS. A read an event overtook still gives its `personal`/`launcher`; only
 * its listeners are older. `null` while who listens is not known: before the first read, from the moment the
 * stream drops until a fresh listing arrives, and after a failed read; an old listing is never kept as if it were
 * live (C12). A failed read is tried again after each of LISTING_RETRY_MS; `unreachable` says the reads gave up, or
 * the listing stayed unknown for UNKNOWN_AFTER_MS, so the chat never says "checking" for ever; the retries run while
 * the chat is closed too, so a read always settles (decision 39). `refresh` reads again (a refused Launch: the page's
 * view was old); asked while a read is in flight, exactly one more read follows it, and its answer is the one kept.
 */
export function useListeners(
  transport: ListenerTransport,
  enabled: boolean,
  open: boolean,
): {
  readonly listing: Listing | null;
  readonly unreachable: boolean;
  readonly pin: (agentId: string | null) => Promise<PinOutcome>;
  readonly refresh: () => void;
} {
  const [base, setBase] = useState<Listing | null>(null);
  const [owner, setOwner] = useState<Owner>({});
  const [unreachable, setUnreachable] = useState(false);
  // Who listens was read, or replaced by an event, since the stream last opened.
  const fresh = useRef(false);
  // When the last read answered (`personal`/`launcher` held from it), or null: read on the next open.
  const answeredAt = useRef<number | null>(null);
  // Bumped by anything newer than a read in flight (an event, a drop, a pin): that read's listeners are then old.
  const gen = useRef(0);
  // Bumped to drop whatever read or retry is outstanding (disabled, unmounted).
  const reads = useRef(0);
  // The generation the read in flight started at, or null: none in flight.
  const inFlight = useRef<number | null>(null);
  // One more read is wanted once the one in flight settles (a refresh, or listeners made old meanwhile); its answer wins.
  const queued = useRef(false);
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const source = useRef(transport);
  const [reopened, setReopened] = useState(0);
  // A refresh asked for, with no read in flight, since the open effect last ran: it reads even if the last answer is
  // held, and a read started meanwhile (a retry) is followed by one more.
  const forced = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    const onEvent = (event: Event): void => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (detail === null || detail === LISTENERS_LOST) {
        // Dropped: unknown from now. (Re)opened: it replays nothing, so read again, now if the chat is open.
        gen.current += 1;
        fresh.current = false;
        setBase(null);
        setUnreachable(false);
        if (detail === null) {
          answeredAt.current = null;
          setReopened((n) => n + 1);
        }
        return;
      }
      const next = parseListing(detail);
      if (next === undefined) return;
      gen.current += 1;
      fresh.current = true;
      setBase(withoutOwner(next));
      setUnreachable(false);
    };
    window.addEventListener(LISTENERS_DOM_EVENT, onEvent);
    return () => window.removeEventListener(LISTENERS_DOM_EVENT, onEvent);
  }, [enabled]);
  useEffect(() => {
    source.current = transport;
  }, [transport]);
  // The reads and their retries belong to the hook while enabled, never to one open of the chat (decision 39): a read
  // that fails after the chat closed, or closed and opened again, is still tried again.
  const read = useCallback((tries: number): void => {
    if (retry.current !== undefined) {
      clearTimeout(retry.current);
      retry.current = undefined;
    }
    if (tries === 0) setUnreachable(false);
    const mine = ++reads.current;
    const at = gen.current;
    inFlight.current = at;
    const again = (): boolean => {
      inFlight.current = null;
      if (!queued.current) return false;
      queued.current = false;
      read(0);
      return true;
    };
    source.current.list().then(
      (next) => {
        if (reads.current !== mine || again()) return;
        answeredAt.current = Date.now();
        setOwner(ownerOf(next));
        if (gen.current === at) {
          fresh.current = true;
          setBase(withoutOwner(next));
        }
        setUnreachable(false);
      },
      () => {
        if (reads.current !== mine) return;
        if (gen.current === at) {
          fresh.current = false;
          setBase(null);
        }
        if (again()) return;
        const wait = LISTING_RETRY_MS[tries];
        if (wait === undefined) setUnreachable(true);
        else
          retry.current = setTimeout(() => {
            retry.current = undefined;
            read(tries + 1);
          }, wait);
      },
    );
  }, []);
  useEffect(() => {
    if (!enabled) return;
    return () => {
      reads.current += 1;
      inFlight.current = null;
      queued.current = false;
      if (retry.current !== undefined) {
        clearTimeout(retry.current);
        retry.current = undefined;
      }
    };
  }, [enabled]);
  useEffect(() => {
    const force = forced.current;
    forced.current = false;
    if (!enabled || !open) return;
    const held = answeredAt.current !== null && Date.now() - answeredAt.current < LISTING_FRESH_MS;
    if (!force && fresh.current && held) return;
    if (inFlight.current !== null) {
      // The read in flight answers both, unless a refresh wants a newer one, or something newer has made its
      // listeners old and they are not fresh: then exactly one more read follows it.
      if (force || (inFlight.current !== gen.current && !fresh.current)) queued.current = true;
      return;
    }
    read(0);
  }, [enabled, open, transport, reopened, read]);
  // Unknown for too long (a dropped stream that has not come back): say so rather than "checking".
  const waiting = enabled && open && base === null && !unreachable;
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setUnreachable(true), UNKNOWN_AFTER_MS);
    return () => clearTimeout(timer);
  }, [waiting, reopened]);
  // A read in flight queues the one more read now, not in the effect: its answer can land before the render does, and
  // would then make the listing look fresh and held (O28).
  const refresh = useCallback((): void => {
    answeredAt.current = null;
    if (inFlight.current !== null) {
      queued.current = true;
      return;
    }
    forced.current = true;
    setReopened((n) => n + 1);
  }, []);
  // A pick whose answer was lost (the network dropped it, or it could not be read) may have landed (O125): Archer is
  // read back and the listing it gives is kept; it says whether the pick holds. Unreadable, the outcome is not known
  // and the listing is read again. A pin sets a value, so choosing again is never a second effect. A refusal throws.
  const pin = useCallback(
    async (agentId: string | null): Promise<PinOutcome> => {
      let status: ListenerStatus;
      try {
        status = await transport.pin(agentId);
      } catch (failure) {
        if (!(failure instanceof TypeError || failure instanceof SyntaxError)) throw failure;
        gen.current += 1;
        let now: Listing;
        try {
          now = await transport.list();
        } catch {
          refresh();
          return "unknown";
        }
        answeredAt.current = Date.now();
        fresh.current = true;
        setOwner(ownerOf(now));
        setBase(withoutOwner(now));
        setUnreachable(false);
        return pinHolds(now.current, agentId) ? "chosen" : "not-chosen";
      }
      gen.current += 1;
      setBase((held) => (held === null ? held : { ...held, current: { ...held.current, ...status } }));
      return "chosen";
    },
    [transport, refresh],
  );
  const listing = useMemo(() => (base === null ? null : { ...base, ...owner }), [base, owner]);
  return { listing: enabled ? listing : null, unreachable: enabled && unreachable && base === null, pin, refresh };
}
