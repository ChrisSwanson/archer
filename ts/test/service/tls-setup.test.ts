import { afterEach, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:https";
import { setupLocalTls } from "../../src/service/tls-setup.ts";
import { startService } from "../../src/service/service.ts";
const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
function directory() {
  const d = mkdtempSync(join(tmpdir(), "archer-tls-setup-"));
  made.push(d);
  return d;
}
test("explicit provisioning creates a private CA that verifies native HTTPS", { timeout: 30000 }, async () => {
  const parent = directory(),
    destination = join(parent, "tls");
  const setup = await setupLocalTls({ directory: destination, host: "127.0.0.1" });
  expect(statSync(destination).mode & 0o777).toBe(0o700);
  expect(statSync(setup.tlsKey).mode & 0o777).toBe(0o600);
  expect(statSync(join(destination, "ca", "ca-key.pem")).mode & 0o777).toBe(0o600);
  expect(setup.caFingerprint256).toMatch(/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  expect(setup.configuration).toContain(`tls_cert = ${JSON.stringify(setup.tlsCert)}`);
  const svc = await startService({
    tlsCert: setup.tlsCert,
    tlsKey: setup.tlsKey,
    stateDir: join(parent, "state"),
    env: { HOME: parent, ARCHER_OPEN_BROWSER: "never" },
    log: () => {},
  });
  try {
    const status = await new Promise((resolve, reject) => {
      const req = request(svc.homeUrl, { ca: readFileSync(setup.caCert) }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.end();
    });
    // The home link answers over the verified connection: it signs the browser in (303 to /projects/).
    expect(status).toBe(303);
  } finally {
    await svc.close();
  }
});

test("provisioning refuses existing destinations without overwriting a CA", { timeout: 30000 }, async () => {
  const parent = directory(),
    destination = join(parent, "tls");
  const setup = await setupLocalTls({ directory: destination, host: "archer.example.test" });
  const original = readFileSync(setup.caCert);
  await expect(setupLocalTls({ directory: destination, host: "archer.example.test" })).rejects.toThrow(
    /must not exist/,
  );
  expect(readFileSync(setup.caCert)).toEqual(original);
  const { X509Certificate } = await import("node:crypto");
  const leaf = new X509Certificate(readFileSync(setup.tlsCert));
  expect(leaf.checkHost("archer.example.test")).toBe("archer.example.test");
  expect(leaf.checkHost("localhost")).toBe("localhost");
  expect(leaf.checkIP("127.0.0.1")).toBe("127.0.0.1");
  expect(leaf.checkIP("::1")).toBe("::1");
});
test.each(["0.0.0.0", "::", "bad,IP:1.2.3.4", "host\nsubjectAltName=DNS:evil", "*.example", "../outside", ""])(
  "invalid advertised host %j refuses before filesystem changes",
  async (host) => {
    const parent = directory(),
      destination = join(parent, "tls");
    await expect(setupLocalTls({ directory: destination, host })).rejects.toThrow(/concrete/);
    const { existsSync } = await import("node:fs");
    expect(existsSync(destination)).toBe(false);
  },
);
test("untrusted writable parent refuses without filesystem changes", async () => {
  const parent = directory(),
    destination = join(parent, "tls");
  const { chmodSync, existsSync } = await import("node:fs");
  chmodSync(parent, 0o777);
  try {
    await expect(setupLocalTls({ directory: destination, host: "localhost" })).rejects.toThrow(/current-user-owned/);
    expect(existsSync(destination)).toBe(false);
  } finally {
    chmodSync(parent, 0o700);
  }
});

test("setup boundary refuses arbitrary and edited inputs on a small stack against a clock", async () => {
  const parent = directory(),
    out = join(parent, "probe.cjs");
  const { build } = await import("esbuild"),
    { spawnSync } = await import("node:child_process");
  await build({
    stdin: {
      contents: `
 import {setupLocalTls} from ${JSON.stringify(new URL("../../src/service/tls-setup.ts", import.meta.url).pathname)};
 import {PersistenceError} from ${JSON.stringify(new URL("../../src/state/account.ts", import.meta.url).pathname)};
 const parent=${JSON.stringify(parent)};
 let seed=389;const rand=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
 const vocabulary=[undefined,null,true,false,0,1,'','tls','host','localhost','127.0.0.1','::1','0.0.0.0','::','bad,IP:evil','\\0',{},[]];
 const check=async value=>{try{await setupLocalTls(value);throw Error('unexpectedly provisioned invalid or existing destination');}catch(e){if(!(e instanceof PersistenceError))throw e;}};
 (async()=>{for(let i=0;i<300;i++){
 await check({directory:vocabulary[rand()%vocabulary.length],host:vocabulary[rand()%vocabulary.length]});
 await check({directory:parent,host:vocabulary[rand()%vocabulary.length]});
 const at=rand()%9;await check({directory:parent+'/new',host:'localhost'.slice(0,at)+'\\n'+'localhost'.slice(at)});
 }console.log('PASS 900');})();
 `,
      resolveDir: process.cwd(),
    },
    outfile: out,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  });
  const child = spawnSync(process.execPath, ["--stack_size=128", out], { encoding: "utf8", timeout: 10000 });
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toContain("PASS 900");
});

// The LAN recipe: `tls setup --host X` prints the whole block, and a wildcard bind advertises the certificate's host.
test.each(["archer.example.test", "192.0.2.10"])(
  "a wildcard bind advertises the host the certificate was made for (%s)",
  { timeout: 30000 },
  async (host) => {
    const parent = directory(),
      setup = await setupLocalTls({ directory: join(parent, "tls"), host });
    expect(setup.configuration).toMatch(/^version = 1\n\n\[service\]\nhost = "0\.0\.0\.0"\nforce_http = false\n/);
    const svc = await startService({
      host: "0.0.0.0",
      tlsCert: setup.tlsCert,
      tlsKey: setup.tlsKey,
      stateDir: join(parent, "state"),
      env: { HOME: parent, ARCHER_OPEN_BROWSER: "never" },
      log: () => {},
    });
    try {
      expect(new URL(svc.homeUrl).hostname).toBe(host);
    } finally {
      await svc.close();
    }
  },
);
test("a loopback certificate keeps the loopback bind in its printed block", { timeout: 30000 }, async () => {
  const parent = directory(),
    setup = await setupLocalTls({ directory: join(parent, "tls"), host: "localhost" });
  expect(setup.configuration).not.toContain("host =");
  expect(setup.configuration.startsWith("version = 1\n")).toBe(true);
});

// Codex review of the fix: every 127.0.0.0/8 name is loopback, never the advertised host.
test("a wildcard bind skips every loopback name the certificate lists", { timeout: 30000 }, async () => {
  const parent = directory(),
    { execFileSync } = await import("node:child_process"),
    { writeFileSync } = await import("node:fs");
  const key = join(parent, "key.pem"),
    cert = join(parent, "cert.pem"),
    ext = join(parent, "ext.cnf");
  writeFileSync(
    ext,
    "[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=archer\n[v3]\nsubjectAltName=DNS:localhost,IP:127.0.0.2,DNS:sub.localhost,DNS:archer.example.test\n",
  );
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-keyout", key, "-out", cert, "-config", ext],
    { stdio: "ignore" },
  );
  const { prepareTransport } = await import("../../src/service/transport.ts");
  const prepared = prepareTransport({ tlsCert: cert, tlsKey: key }, "0.0.0.0");
  expect(prepared.scheme === "https" && prepared.certificateHost).toBe("archer.example.test");
});
