import { randomUUID } from "node:crypto";
import { EXPLORATIONS_CAPABILITY } from "../../../shared/explorations.mts";

/** Browser HTTP/SSE compatibility is independent of application and MCP versions. */
export const BROWSER_PROTOCOL_MAJOR = 1;

export interface BrowserConnection {
  readonly browserProtocolMajor: typeof BROWSER_PROTOCOL_MAJOR;
  readonly supportedBrowserProtocolMajors: readonly number[];
  readonly serverEpoch: string;
  readonly capabilities: readonly string[];
  readonly applicationVersion: string;
  readonly semanticSchemaVersion: 2;
  readonly heartbeatIntervalMs: number;
  /** Present while Archer is open to the network: the address and since when (the page's quiet notice). */
  readonly networkAccess?: { readonly address: string; readonly since: string };
}

/**
 * Fresh per startService lifetime, including restarts inside one process. This is
 * server-generated metadata, not a new untrusted-input parser or stored identity.
 * No revision, token, persistence format, or existing response is changed.
 */
export function browserConnection(
  applicationVersion: string,
  heartbeatIntervalMs: number,
  networkAccess?: BrowserConnection["networkAccess"],
): BrowserConnection {
  return {
    browserProtocolMajor: BROWSER_PROTOCOL_MAJOR,
    supportedBrowserProtocolMajors: [BROWSER_PROTOCOL_MAJOR],
    serverEpoch: randomUUID(),
    capabilities: ["heartbeat", "instance-settings", EXPLORATIONS_CAPABILITY],
    applicationVersion,
    semanticSchemaVersion: 2,
    heartbeatIntervalMs,
    ...(networkAccess === undefined ? {} : { networkAccess }),
  };
}
