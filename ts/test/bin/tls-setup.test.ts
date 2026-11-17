import { afterEach, expect, test } from "vitest";
import { join } from "node:path";
import { main, type Io } from "../../src/bin/main.ts";
import { cleanUp, tempDir } from "../service/support.ts";
afterEach(cleanUp);
test("explicit CLI TLS setup prints paths and trust information without starting a service", async () => {
  const state = tempDir(),
    destination = join(state, "tls");
  let out = "",
    err = "";
  const io: Io = {
    cwd: state,
    env: { ARCHER_STATE_DIR: state },
    stdout: (value) => (out += value),
    stderr: (value) => (err += value),
    isTTY: false,
    columns: undefined,
  };
  const code = await main(["tls", "setup", "--host", "localhost", "--directory", destination], io);
  expect(code, err).toBe(0);
  expect(out).toContain("tls_cert = ");
  expect(out).toContain("SHA-256");
  expect(out).toContain("ca-cert.pem");
  expect(out).not.toContain("PRIVATE KEY");
}, 30_000);
