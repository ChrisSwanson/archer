import { join } from "node:path";
import { serviceDirs, ensurePrivateDir } from "../service/paths.ts";
import { setupLocalTls } from "../service/tls-setup.ts";
import { UsageError, type Io } from "./main.ts";

export async function runTls(args: readonly string[], io: Io): Promise<number> {
  if (args[0] !== "setup")
    throw new UsageError("tls accepts setup --host <hostname-or-IP> [--directory <new-absolute-path>]");
  let host: string | undefined, directory: string | undefined;
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index],
      value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`tls setup ${flag} needs a value`);
    if (flag === "--host" && host === undefined) host = value;
    else if (flag === "--directory" && directory === undefined) directory = value;
    else throw new UsageError("tls setup accepts --host and --directory once each");
  }
  if (host === undefined) throw new UsageError("tls setup requires the concrete --host your browser will use");
  if (directory === undefined) {
    const stateDir = serviceDirs(io.env).stateDir;
    ensurePrivateDir(stateDir);
    directory = join(stateDir, "tls");
  }
  const result = await setupLocalTls({ directory, host });
  io.stdout(
    `Local Archer certificates created. No trust stores or configuration were changed.\n\nPut these lines in ~/.config/archer/archer.toml (merge them into an existing [service] table):\n\n${result.configuration}\nPublic CA certificate: ${result.caCert}\nCA SHA-256 fingerprint: ${result.caFingerprint256}\nServer certificate expires: ${result.expiresAt}\n\nCopy only the public CA certificate to the browser computer. Follow docs/tls.md to trust it, then open an issued HTTPS access link.\n`,
  );
  return 0;
}
