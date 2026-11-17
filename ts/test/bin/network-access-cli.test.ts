// `archer network-access` is the person's command: only a person at a terminal can say yes to it, so an
// agent's shell (no terminal) cannot open Archer to the network, by any CLI route.
import { networkInterfaces } from "node:os";
import { expect, test } from "vitest";
import { main, type Io } from "../../src/bin/main.ts";
import { NO_TERMINAL_FOR_NETWORK, networkSummary } from "../../src/bin/operations.ts";

async function run(args: string[], io: Partial<Io> = {}) {
  let out = "",
    err = "";
  const code = await main(args, {
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    isTTY: false,
    columns: undefined,
    env: {},
    ...io,
  });
  return { code, out, err };
}

test("without a terminal it refuses and changes nothing", async () => {
  const { code, out, err } = await run(["network-access"]);
  expect(code).toBe(1);
  expect(out).toBe("");
  expect(err).toBe(`archer: ${NO_TERMINAL_FOR_NETWORK}\n`);
});

test("archer call cannot pass personConfirmed instead", async () => {
  const { code, err } = await run(["call", "setup_network_access", "--stdin", "--json"], {
    stdin: async () => JSON.stringify({ personConfirmed: true }),
  });
  expect(code).toBe(1);
  expect(JSON.parse(err)).toMatchObject({
    code: "person_confirmation_needed",
    details: { fix: { command: "archer network-access", needsPersonYes: true } },
  });
});

test("--yes is gone", async () => {
  const { code, err } = await run(["network-access", "--yes"]);
  expect(code).toBe(2);
  expect(err).toMatch(/no --yes/);
});

const lan = Object.values(networkInterfaces())
  .flat()
  .find((entry) => entry !== undefined && !entry.internal && entry.family === "IPv4");

test.skipIf(lan === undefined)("at a terminal the person's answer decides, whatever personConfirmed says", async () => {
  const asked: string[] = [];
  const { code, out, err } = await run(["call", "setup_network_access", "--stdin"], {
    stdin: async () => JSON.stringify({ personConfirmed: true, host: lan!.address }),
    askAtTerminal: async (question) => {
      asked.push(question);
      return "no";
    },
  });
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatch(/Open Archer to other devices/);
  expect(code).toBe(1);
  expect(out).toBe("");
  expect(err).toBe("Not changed: Archer still serves only this computer.\n");
});

test("the terminal gets four lines, not the agent's text", () => {
  const fresh = networkSummary({
    url: "https://192.168.1.20:40399/-/pair",
    code: "7KQ2-M9XD",
    minutes: 5,
    caCert: "/s/tls/ca-cert.pem",
    caFingerprint256: "AB:CD",
    certificateReused: false,
  });
  expect(fresh.split("\n")).toEqual([
    "Archer is open to your network: https://192.168.1.20:40399/-/pair",
    "Pairing code: 7KQ2-M9XD (single use, 5 minutes)",
    expect.stringMatching(
      /^On each device, trust this certificate once: \/s\/tls\/ca-cert\.pem \(SHA-256 AB:CD\); steps for iPhone, Android and others: .*tls\.md$/,
    ),
    "Turn off with: archer network-access off",
  ]);
  expect(networkSummary({ url: "u", code: "c", minutes: 5, certificateReused: true }).split("\n")[2]).toMatch(
    /still do/,
  );
});
