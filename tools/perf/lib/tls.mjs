// Scoped TLS trust for the lab, the harness and the release check (performance rubric G5, §8): Chromium trusts
// exactly one certificate — the sandbox's leaf, by its SPKI hash — instead of `ignoreHTTPSErrors`, which stops
// Chromium caching (baseline B: warm loads re-downloaded the document and the worker). No trust store is changed.
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect } from "node:tls";

/** base64 SHA-256 of a certificate's SubjectPublicKeyInfo (DER): what `--ignore-certificate-errors-spki-list` takes. */
export const spkiOf = (cert) =>
  createHash("sha256")
    .update(cert.publicKey.export({ type: "spki", format: "der" }))
    .digest("base64");

/**
 * The SPKI hash of the leaf certificate `origin` serves, after verifying that leaf against the CA in `caPath` (so
 * only a certificate that CA issued is pinned). Rejects when the chain does not verify.
 */
export function leafSpki(origin, caPath) {
  const { hostname, port } = new URL(origin);
  const ca = readFileSync(caPath, "utf8");
  return new Promise((resolvePin, reject) => {
    const socket = connect(
      {
        host: hostname,
        port: Number(port) || 443,
        ca,
        servername: /^[\d.]+$|:/.test(hostname) ? undefined : hostname,
        ALPNProtocols: ["http/1.1"],
      },
      () => {
        try {
          if (!socket.authorized)
            throw new Error(`certificate of ${origin} does not verify against ${caPath}: ${socket.authorizationError}`);
          const pin = spkiOf(new X509Certificate(socket.getPeerCertificate(false).raw));
          socket.end();
          resolvePin(pin);
        } catch (error) {
          socket.destroy();
          reject(error);
        }
      },
    );
    socket.once("error", reject);
  });
}

/**
 * How a lab browser treats TLS, from the run's options: {mode, launchArgs, ignoreHTTPSErrors}. `mode` goes into
 * every report's test target: "http" (no TLS), "spki-scoped" (one pinned leaf; caching behaves as for a person) or
 * "ignore-https-errors" (legacy; distorts caching, so G5 is NOT EVALUATED under it).
 */
export async function tlsSetup({ base, tlsCa, tlsSpki }) {
  if (!/^https:/.test(base)) return { mode: "http", launchArgs: [], ignoreHTTPSErrors: false, spki: null };
  const spki = tlsSpki ?? (tlsCa ? await leafSpki(base, tlsCa) : null);
  if (spki)
    return {
      mode: "spki-scoped",
      launchArgs: [`--ignore-certificate-errors-spki-list=${spki}`],
      ignoreHTTPSErrors: false,
      spki,
    };
  return { mode: "ignore-https-errors", launchArgs: [], ignoreHTTPSErrors: true, spki: null };
}
