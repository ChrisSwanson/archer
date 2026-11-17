import { expect, test } from "vitest";
import { parseGlobalConfig } from "../../src/config/index.ts";
import { resolveServiceConfiguration } from "../../src/config/resolve.ts";
import { optionsFromEnv } from "../../src/service/foreground.ts";
test("global TLS fields resolve through file, env and flag precedence", () => {
  const user = parseGlobalConfig('version=1\n[service]\ntls_cert="/cert.pem"\ntls_key="/key.pem"\nforce_http=false\n');
  expect(user.service).toMatchObject({ tlsCert: "/cert.pem", tlsKey: "/key.pem", forceHttp: false });
  const r = resolveServiceConfiguration({
    projectRoot: "/project",
    user,
    env: { ARCHER_TLS_CERT: "/env.pem" },
    flags: { tlsKey: "/flag.pem" },
  });
  expect(r.settings).toMatchObject({ tlsCert: "/env.pem", tlsKey: "/flag.pem", forceHttp: false });
  expect(r.settingSources).toMatchObject({ tlsCert: "env", tlsKey: "flag", forceHttp: "user" });
});
test.each(['tls_cert="relative"', 'tls_key="relative"', 'force_http="true"'])(
  "refuses invalid global transport: %s",
  (value) => expect(() => parseGlobalConfig(`version=1\n[service]\n${value}`)).toThrow(),
);
test("HTTP override is explicit and strict in environment", () => {
  expect(optionsFromEnv({})).not.toHaveProperty("forceHttp");
  expect(optionsFromEnv({ ARCHER_FORCE_HTTP: "true" })).toMatchObject({ forceHttp: true });
  expect(() => optionsFromEnv({ ARCHER_FORCE_HTTP: "1" })).toThrow();
});
