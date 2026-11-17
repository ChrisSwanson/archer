import { parseBrowserConnection } from "./http-connection";
import { browserFetch } from "./browser-resource";
import { readBoundedJson, JSON_SNAPSHOT_MAX_BYTES } from "./bounded-json";
import { observeNetworkAccess } from "./network-access";

export type ServiceSettingsDiscovery =
  | { readonly kind: "supported" }
  | { readonly kind: "incompatible" }
  | { readonly kind: "access-required" }
  | { readonly kind: "unavailable" };

export type ServiceSettingsFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Inspect only metadata already accepted by the browser-protocol parser. */
export function connectionSupportsInstanceSettings(body: unknown): boolean {
  if (parseBrowserConnection(body) === undefined) return false;
  return (body as { readonly capabilities: readonly string[] }).capabilities.includes("instance-settings");
}

/**
 * Discover the service-wide Settings from the connection metadata, without choosing an arbitrary project. Every
 * 0.15 service advertises `instance-settings`; metadata that does not is no service that has them (unavailable), and
 * a hidden 404 (revoked or missing access) is unavailable too.
 */
export async function discoverServiceSettings(
  fetcher: ServiceSettingsFetch = browserFetch,
  signal?: AbortSignal,
): Promise<ServiceSettingsDiscovery> {
  const budget = { remaining: JSON_SNAPSHOT_MAX_BYTES };
  let response: Response;
  try {
    response = await fetcher("api/connection", { cache: "no-store", ...(signal === undefined ? {} : { signal }) });
  } catch {
    return { kind: "unavailable" };
  }
  if (response.status === 401 || response.status === 403) return { kind: "access-required" };
  if (!response.ok) return { kind: "unavailable" };

  let body: unknown;
  try {
    body = await readBoundedJson(response, budget, signal);
  } catch {
    return { kind: "incompatible" };
  }
  const info = parseBrowserConnection(body);
  if (info === undefined) return { kind: "incompatible" };
  // The service-wide page has no project connection: this answer is how it knows about the network.
  observeNetworkAccess(info.networkAccess ?? null);
  return connectionSupportsInstanceSettings(body) ? { kind: "supported" } : { kind: "unavailable" };
}
