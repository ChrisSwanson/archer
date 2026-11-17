import { expect, test } from "vitest";
import { liveClientAllowed } from "../vite.config";

// 192.0.2.x is a documentation range (RFC 5737): stand-ins for two other machines on the network.
test.each([
  ["127.0.0.1", ["127.0.0.1"], true],
  ["::ffff:127.0.0.1", ["127.0.0.1"], true],
  ["::1", ["::1"], true],
  ["192.0.2.121", ["192.0.2.121"], true],
  ["192.0.2.122", ["192.0.2.121"], false],
  ["192.0.2.122", ["*"], true],
  ["fd00::12", ["*"], true],
  [undefined, ["*"], false],
  ["", ["*"], false],
] as const)("helper access for %s with %j is %s", (address, entries, accepted) => {
  expect(liveClientAllowed(address, new Set<string>(entries))).toBe(accepted);
});
