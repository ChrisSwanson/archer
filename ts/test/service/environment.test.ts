import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { cleanUp, isolatedProcessEnv, service, tempDir, write } from "./support.ts";

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanUp();
});

test.each(["HOME", "XDG_CONFIG_HOME", "ARCHER_CONFIG"])(
  "temporary service fixtures ignore unrelated owner TLS configuration selected by %s",
  async (selector) => {
    const owner = tempDir("archer-unrelated-config-");
    const config = write(
      owner,
      ".config/archer/archer.toml",
      'version = 1\n[service]\ntls_cert = "/unrelated/server-cert.pem"\ntls_key = "/unrelated/server-key.pem"\n',
    );
    vi.stubEnv("ARCHER_CONFIG", "");
    vi.stubEnv("XDG_CONFIG_HOME", "");
    vi.stubEnv(
      selector,
      selector === "ARCHER_CONFIG" ? config : selector === "XDG_CONFIG_HOME" ? join(owner, ".config") : owner,
    );
    const state = tempDir("archer-isolated-env-");
    const { svc } = await service({ stateDir: state, env: isolatedProcessEnv(state) });
    expect(svc.homeUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
  },
);
