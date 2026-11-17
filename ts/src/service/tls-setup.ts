// Explicit local-CA provisioning. This never changes trust stores or settings.
import { execFile } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, dirname, join, normalize } from "node:path";
import { isIP } from "node:net";
import { randomBytes, X509Certificate } from "node:crypto";
import { prepareTransport } from "./transport.ts";
import { PersistenceError } from "../state/account.ts";

export interface LocalTlsOptions {
  readonly directory: string;
  readonly host: string;
  /** More IP addresses the certificate covers: the address a host name was bound to (setup_network_access). */
  readonly addresses?: readonly string[];
}
export interface LocalTlsSetup {
  readonly directory: string;
  readonly host: string;
  readonly tlsCert: string;
  readonly tlsKey: string;
  readonly caCert: string;
  readonly caFingerprint256: string;
  readonly expiresAt: string;
  readonly configuration: string;
}
function invalid(message: string): never {
  throw new PersistenceError("invalid_configuration", message);
}

/** Provision only a fresh destination; a failure leaves private artifacts for inspection. */
export async function setupLocalTls(options: LocalTlsOptions): Promise<LocalTlsSetup> {
  const directory = options.directory;
  if (
    typeof directory !== "string" ||
    directory.length === 0 ||
    directory.length > 4096 ||
    directory.includes("\0") ||
    !isAbsolute(directory) ||
    normalize(directory) !== directory
  )
    return invalid("TLS setup requires a new canonical absolute destination directory");
  const host = options.host;
  if (!validHost(host)) return invalid("TLS setup host must be a concrete DNS hostname or IP address");
  try {
    const parent = lstatSync(dirname(directory));
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      (parent.mode & 0o022) !== 0 ||
      parent.uid !== process.getuid?.()
    )
      return invalid("TLS setup parent must be a current-user-owned directory without group/other write access");
    // Atomic creation is the no-overwrite guard, including existing symlinks.
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    return invalid("TLS setup destination must not exist, and its trusted parent must exist");
  }
  const caDirectory = join(directory, "ca"),
    serverDirectory = join(directory, "server");
  mkdirSync(caDirectory, { mode: 0o700 });
  mkdirSync(serverDirectory, { mode: 0o700 });
  const caCert = join(caDirectory, "ca-cert.pem"),
    caKey = join(caDirectory, "ca-key.pem");
  const tlsCert = join(serverDirectory, "server-cert.pem"),
    tlsKey = join(serverDirectory, "server-key.pem");
  const request = join(serverDirectory, "server.csr"),
    caConfig = join(caDirectory, "ca.cnf"),
    extensions = join(serverDirectory, "server.ext");
  writeFileSync(
    caConfig,
    "[req]\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n",
    { mode: 0o600, flag: "wx" },
  );
  const extra = (options.addresses ?? []).filter((address) => isIP(address) !== 0).map((address) => `IP:${address}`);
  const sans = ["DNS:localhost", "IP:127.0.0.1", "IP:::1", `${isIP(host) === 0 ? "DNS" : "IP"}:${host}`, ...extra];
  writeFileSync(
    extensions,
    `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${[...new Set(sans)].join(",")}\nauthorityKeyIdentifier=keyid,issuer\n`,
    { mode: 0o600, flag: "wx" },
  );
  try {
    await openssl([
      "req",
      "-x509",
      "-newkey",
      "rsa:3072",
      "-nodes",
      "-sha256",
      "-days",
      "3650",
      "-subj",
      "/CN=Archer local certificate authority",
      "-config",
      caConfig,
      "-keyout",
      caKey,
      "-out",
      caCert,
    ]);
    chmodSync(caKey, 0o600);
    await openssl([
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-subj",
      `/CN=${host}`,
      "-keyout",
      tlsKey,
      "-out",
      request,
    ]);
    chmodSync(tlsKey, 0o600);
    await openssl([
      "x509",
      "-req",
      "-in",
      request,
      "-CA",
      caCert,
      "-CAkey",
      caKey,
      "-set_serial",
      `0x${randomBytes(16).toString("hex")}`,
      "-days",
      "365",
      "-sha256",
      "-extfile",
      extensions,
      "-out",
      tlsCert,
    ]);
    chmodSync(caCert, 0o600);
    chmodSync(tlsCert, 0o600);
    prepareTransport({ tlsCert, tlsKey }, host);
    const ca = new X509Certificate(readFileSync(caCert)),
      leaf = new X509Certificate(readFileSync(tlsCert));
    if (!leaf.verify(ca.publicKey))
      return invalid("TLS setup generated a certificate that does not verify against its CA");
    return {
      directory,
      host,
      tlsCert,
      tlsKey,
      caCert,
      caFingerprint256: ca.fingerprint256,
      expiresAt: new Date(leaf.validTo).toISOString(),
      // The complete global block. A certificate for another device's use binds every interface; the
      // service then advertises the certificate's host, so the printed lines work as they are.
      configuration: `version = 1\n\n[service]\n${loopback(host) ? "" : 'host = "0.0.0.0"\n'}force_http = false\ntls_cert = ${JSON.stringify(tlsCert)}\ntls_key = ${JSON.stringify(tlsKey)}\n`,
    };
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    return invalid(
      `TLS setup failed; private partial files remain in ${directory}. Check OpenSSL availability and use a new destination when retrying`,
    );
  }
}
function loopback(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}
function validHost(host: unknown): host is string {
  if (
    typeof host !== "string" ||
    host.length === 0 ||
    host.length > 253 ||
    host.includes("\0") ||
    host === "0.0.0.0" ||
    host === "::"
  )
    return false;
  if (isIP(host) !== 0) return true;
  return host
    .split(".")
    .every(
      (label) => label.length > 0 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
    );
}
function openssl(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("openssl", [...args], { timeout: 20_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 }, (error) =>
      error === null ? resolve() : reject(error),
    );
  });
}
