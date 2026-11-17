import { expect, test, vi } from "vitest";
import { connectionSupportsInstanceSettings, discoverServiceSettings } from "../src/app/service-settings";

const connection = (capabilities: readonly string[] = ["heartbeat", "instance-settings"]): Record<string, unknown> => ({
  browserProtocolMajor: 1,
  supportedBrowserProtocolMajors: [1],
  serverEpoch: "12345678-1234-4234-9234-123456789abc",
  capabilities,
  applicationVersion: "0.3.0",
  semanticSchemaVersion: 2,
  heartbeatIntervalMs: 15000,
});

const reply = (body: unknown, status = 200): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

test("discovers advertised service settings without requiring a project", async () => {
  const fetcher = vi.fn().mockResolvedValue(reply(connection()));
  await expect(discoverServiceSettings(fetcher)).resolves.toEqual({ kind: "supported" });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledWith("api/connection", expect.objectContaining({ cache: "no-store" }));
});

test("metadata that advertises no instance settings is unavailable, with no probe of the settings route", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply(connection(["heartbeat"])));
  await expect(discoverServiceSettings(fetcher)).resolves.toEqual({ kind: "unavailable" });
  expect(fetcher).toHaveBeenCalledOnce();
});

test.each([
  [
    "incompatible metadata",
    [reply({ ...connection(), browserProtocolMajor: 2, supportedBrowserProtocolMajors: [2] })],
    { kind: "incompatible" },
  ],
  ["a hidden connection route", [reply("", 404)], { kind: "unavailable" }],
  ["explicitly refused access", [reply("", 403)], { kind: "access-required" }],
] as const)("reports %s honestly", async (_label, replies, expected) => {
  const fetcher = vi.fn();
  for (const response of replies) fetcher.mockResolvedValueOnce(response);
  await expect(discoverServiceSettings(fetcher)).resolves.toEqual(expected);
});

test("keeps transient failures retryable", async () => {
  const fetcher = vi.fn().mockRejectedValue(new TypeError("offline"));
  await expect(discoverServiceSettings(fetcher)).resolves.toEqual({ kind: "unavailable" });
});

test("capability inspection inherits the bounded connection parser", () => {
  expect(connectionSupportsInstanceSettings(connection())).toBe(true);
  expect(connectionSupportsInstanceSettings(connection(["heartbeat"]))).toBe(false);
  expect(connectionSupportsInstanceSettings({ ...connection(), capabilities: new Array(65).fill("x") })).toBe(false);
  expect(connectionSupportsInstanceSettings(null)).toBe(false);
});

test("the service-wide read tells the page whether Archer is open to the network (finding 6: /projects/ has no project connection)", async () => {
  const { observeNetworkAccess, subscribeNetworkAccess } = await import("../src/app/network-access");
  observeNetworkAccess(undefined);
  const seen: unknown[] = [];
  const stop = subscribeNetworkAccess((access) => seen.push(access));
  try {
    await discoverServiceSettings(
      vi.fn().mockResolvedValue(
        reply({
          ...connection(),
          networkAccess: { address: "https://192.168.1.42:40399/", since: "2026-10-22T10:00:00Z" },
        }),
      ),
    );
    expect(seen.at(-1)).toEqual({ address: "https://192.168.1.42:40399/", since: "2026-10-22T10:00:00Z" });
    await discoverServiceSettings(vi.fn().mockResolvedValue(reply(connection())));
    expect(seen.at(-1)).toBeNull();
  } finally {
    stop();
    observeNetworkAccess(undefined);
  }
});
