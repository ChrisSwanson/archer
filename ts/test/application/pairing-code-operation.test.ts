// issue_pairing_code through the application layer: it starts the service when none is running
// (a code is for opening Archer, so there must be one to open), and its text says when the address
// cannot be reached from another device.
import { expect, test } from "vitest";
import { runEnvironmentOperation } from "../../src/application/environment.ts";
import type { ServiceClient } from "../../src/service/service-client.ts";

const issued = (overrides: Record<string, unknown> = {}) => ({
  code: "7KQ4-M2XD",
  url: "http://127.0.0.1:41234/",
  minutes: 5,
  expiresAt: "2026-10-22T10:05:00.000Z",
  plainHttpOnNetwork: false,
  localOnly: true,
  ...overrides,
});
function client(result: Record<string, unknown>): ServiceClient {
  return {
    call: (async (method: string) => {
      expect(method).toBe("issuePairingCode");
      return result;
    }) as ServiceClient["call"],
    close: () => {},
  };
}

test("issue_pairing_code starts the service when it is not running", async () => {
  const starts: boolean[] = [];
  const answer = await runEnvironmentOperation(
    "issue_pairing_code",
    {},
    {
      cwd: "/",
      acquire: async (start) => {
        starts.push(start);
        return client(issued());
      },
      disconnect: () => {},
    },
  );
  expect(starts).toEqual([true]);
  expect(answer.text.split("\n")).toEqual(expect.arrayContaining(["http://127.0.0.1:41234/", "7KQ4-M2XD"]));
});

test("the text says when only this computer can open the address, and when plain HTTP crosses the network", async () => {
  const run = (result: Record<string, unknown>) =>
    runEnvironmentOperation(
      "issue_pairing_code",
      {},
      { cwd: "/", acquire: async () => client(result), disconnect: () => {} },
    );
  expect((await run(issued())).text).toMatch(/only on this computer.*setup_network_access with personConfirmed: true/s);
  const lan = (await run(issued({ url: "http://192.168.1.20:41234/", localOnly: false, plainHttpOnNetwork: true })))
    .text;
  expect(lan).not.toMatch(/only on this computer/);
  expect(lan).toMatch(/unencrypted/);
  expect((await run(issued({ url: "https://192.168.1.20:41234/", localOnly: false }))).text).not.toMatch(
    /only on this computer|unencrypted/,
  );
});
