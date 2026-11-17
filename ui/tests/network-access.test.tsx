// @vitest-environment jsdom
// Whether Archer is open to the network (setup_network_access) is read from the connection answer. Where it is
// shown (Archer's settings panel, not the header) is tested in archer-settings.test.tsx and web-shell-bindings.test.tsx.
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { observeNetworkAccess, parseNetworkAccess } from "../src/app/network-access";
import { parseBrowserConnection } from "../src/app/http-connection";

afterEach(() => {
  cleanup();
  observeNetworkAccess(undefined);
});
const CONNECTION = {
  browserProtocolMajor: 1,
  supportedBrowserProtocolMajors: [1],
  serverEpoch: "123e4567-e89b-12d3-a456-426614174000",
  capabilities: [],
  applicationVersion: "0.4.0",
  semanticSchemaVersion: 2,
  heartbeatIntervalMs: 15000,
};

describe("network access", () => {
  it("is read from the connection answer, and a malformed one is ignored without refusing the connection", () => {
    expect(
      parseBrowserConnection({
        ...CONNECTION,
        networkAccess: { address: "https://192.168.1.42:40399/", since: "2026-10-22T10:00:00Z" },
      })?.networkAccess,
    ).toEqual({ address: "https://192.168.1.42:40399/", since: "2026-10-22T10:00:00Z" });
    for (const bad of [
      { address: "javascript:alert(1)", since: "2026-10-22T10:00:00Z" },
      { address: "https://x/", since: "never" },
      "x",
      null,
    ])
      expect(parseBrowserConnection({ ...CONNECTION, networkAccess: bad })).toMatchObject({
        applicationVersion: "0.4.0",
      });
    expect(parseNetworkAccess({ address: "https://x/<b>/", since: "2026-10-22T10:00:00Z" })).toBeUndefined();
  });
});
