/**
 * Whether Archer is open to the person's network (setup_network_access). The service says so in its
 * `api/connection` answer; every read of it reports here (a project's HTTP connection, and the
 * service-wide settings discovery on `/projects/`, which has no project connection), and Archer's
 * settings panel shows it.
 *
 * Three states: `undefined` while no answer has arrived (nothing is claimed), `null` when the service
 * answered that it is not open, and the address and time when it is.
 */
export type NetworkAccess = { readonly address: string; readonly since: string };
export type NetworkAccessState = NetworkAccess | null | undefined;

let current: NetworkAccessState;
const listeners = new Set<(access: NetworkAccessState) => void>();

/** The answer's `networkAccess`, when it is one: an http(s) address and a time, both short. */
export function parseNetworkAccess(value: unknown): NetworkAccess | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { address, since } = value as Record<string, unknown>;
  if (typeof address !== "string" || address.length > 300 || !/^https?:\/\/[^\s/]+\/$/.test(address)) return undefined;
  if (typeof since !== "string" || since.length > 64 || Number.isNaN(Date.parse(since))) return undefined;
  return { address, since };
}

/** What an answer said (`null`: not open), or `undefined` to forget it (no answer yet). */
export function observeNetworkAccess(access: NetworkAccessState): void {
  if (access === current) return;
  if (access != null && current != null && access.address === current.address && access.since === current.since) return;
  current = access;
  for (const listener of listeners) listener(current);
}

/** What is known now, for a first render that must not claim something it would correct a moment later. */
export function currentNetworkAccess(): NetworkAccessState {
  return current;
}

export function subscribeNetworkAccess(listener: (access: NetworkAccessState) => void): () => void {
  listeners.add(listener);
  listener(current);
  return () => {
    listeners.delete(listener);
  };
}
