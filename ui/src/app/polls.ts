/**
 * Every read the page repeats on a timer, by name, with its interval: the one home of these numbers.
 * A debug build hands each tick its own tag, `<name>#<tick>`, which the tick passes down its own fetch path as
 * `x-archer-poll` (`withPollTag`). The release check's request classifier (tools/perf/lib/requests.mjs
 * SCHEDULED_POLLS, same names) then counts one copy of each request per tick as the tick, not as a duplicate.
 * Nothing is inferred from timing or from what else is in flight. A production build sends no tag.
 */
export const POLL_INTERVAL_MS = {
  // SearchPage and WorkspaceNavigation: the project catalog.
  "project-catalog": 15_000,
  // workspace-notifications.tsx: the bell.
  notifications: 60_000,
} as const;

export type PollName = keyof typeof POLL_INTERVAL_MS;

/**
 * One tick's tag: the header it adds, `{"x-archer-poll": "<name>#<tick>"}`. Made only in a debug build, so the
 * production page carries no trace of it (`scripts/check-prod-strip.mjs`); `undefined` for reads no tick made.
 */
export type PollTag = Readonly<Record<string, string>>;

export const POLL_HEADER = "x-archer-poll";

let ticks = 0;
/** A new tick of `name`: its tag, unique in this page. */
export function pollTag(name: PollName): PollTag {
  ticks += 1;
  return { [POLL_HEADER]: `${name}#${ticks}` };
}

/**
 * Calls `tick` every interval of `name`, with this tick's tag in a debug build; returns the function that stops it.
 * The tick passes the tag to the requests it makes (`withPollTag`), and to nothing else.
 */
export function schedulePoll(name: PollName, tick: (poll: PollTag | undefined) => unknown): () => void {
  const timer = setInterval(() => {
    tick(__ARCHER_DEBUG__ ? pollTag(name) : undefined);
  }, POLL_INTERVAL_MS[name]);
  return () => clearInterval(timer);
}

/** `init` with a tick's tag added to its headers (a copy); `init` itself when there is no tag. */
export const withPollTag = (init: RequestInit, poll: PollTag | undefined): RequestInit =>
  poll ? { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), ...poll } } : init;
