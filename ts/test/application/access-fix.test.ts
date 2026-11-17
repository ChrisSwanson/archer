// Access and TLS refusals carry a stable code and a fix the agent can act on (never "edit your config").
import { expect, test } from "vitest";
import { accessStartFailure } from "../../src/application/errors.ts";
import { ACCESS_FIXES, accessRefusalText } from "../../src/service/access-fix.ts";
import { ServiceStartError } from "../../src/service/service-client.ts";

test.each(["tls_required", "tls_invalid"] as const)(
  "a service that would not start for %s is refused with that code and its fix",
  (code) => {
    const log = `the Archer service exited (1) before answering:\narcher: ${accessRefusalText(code, "Why it stopped.")}\n(full log: /x/service.log)`;
    const error = accessStartFailure("present_diagram", new ServiceStartError(log));
    expect(error?.data).toMatchObject({
      code,
      fix: { tool: "setup_network_access", arguments: { personConfirmed: true }, needsPersonYes: true },
    });
    expect(error?.message).toBe(
      `present_diagram could not start Archer: ${accessRefusalText(code, "Why it stopped.")}`,
    );
  },
);

test("no fix tells the person to edit configuration by hand", () => {
  for (const fix of Object.values(ACCESS_FIXES)) expect(fix.text).not.toMatch(/edit|archer\.toml|force_http/i);
  expect(
    accessStartFailure(
      "present_diagram",
      new ServiceStartError("the Archer service exited (1) before answering:\narcher: something else"),
    ),
  ).toBeNull();
});
