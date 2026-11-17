import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectService } from "../../src/service/service-client.ts";
import { isolatedProcessEnv, project, cleanUp, apiBase, openPage, stopServicesUnder } from "./support.ts";
import { startService } from "../../src/service/service.ts";
const dirs: string[] = [];
afterEach(cleanUp);
afterEach(async () => {
  const left = dirs.splice(0);
  await Promise.all(left.map(stopServicesUnder));
  for (const d of left) rmSync(d, { recursive: true, force: true });
});
// Zero-config local default (ADR 0017, amended 2026-10-22): a loopback bind with no TLS serves plain
// HTTP, since its token link never leaves the machine. A bind other devices can reach still needs
// HTTPS or an explicit force_http, and refuses with a code and a fix the agent can act on.
test("a loopback bind without certificates serves plain HTTP with no setting", async () => {
  const state = mkdtempSync(join(tmpdir(), "archer-tls-"));
  dirs.push(state);
  const svc = await startService({
    stateDir: state,
    env: { HOME: state, ARCHER_OPEN_BROWSER: "never" },
    log: () => {},
  });
  try {
    expect(svc.homeUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
  } finally {
    await svc.close();
  }
});
test.each(["0.0.0.0", "::"])(
  "a network bind (%s) without certificates refuses with tls_required and its fix, before writing identity",
  async (host) => {
    const state = mkdtempSync(join(tmpdir(), "archer-tls-"));
    dirs.push(state);
    let running: Awaited<ReturnType<typeof startService>> | undefined;
    try {
      await expect(
        startService({ host, stateDir: state, env: { HOME: state, ARCHER_OPEN_BROWSER: "never" }, log: () => {} }).then(
          (s) => {
            running = s;
            return s;
          },
        ),
      ).rejects.toMatchObject({
        code: "tls_required",
        message: expect.stringMatching(/\[tls_required\] Fix: .*setup_network_access with personConfirmed: true/),
      });
    } finally {
      await running?.close();
    }
    expect(existsSync(join(state, "service.json"))).toBe(false);
  },
);
test("only names no other device can use count as loopback", () => {
  for (const host of ["127.0.0.1", "127.8.9.10", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "localhost"])
    expect(prepareTransport({}, host)).toEqual({ scheme: "http", automatic: true });
  for (const host of [
    "0.0.0.0",
    "::",
    "192.168.1.20",
    "10.0.0.1",
    "::ffff:192.168.1.20",
    "fe80::1",
    "myhost",
    "myhost.local",
    "foo.localhost",
    "localhost.",
    "127.0.0.1.nip.io",
  ])
    expect(() => prepareTransport({}, host)).toThrow(expect.objectContaining({ code: "tls_required" }));
});

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { prepareTransport, MAX_TLS_PEM_BYTES } from "../../src/service/transport.ts";
import { optionsFromEnv } from "../../src/service/foreground.ts";
import { PersistenceError } from "../../src/state/account.ts";
function directory() {
  const d = mkdtempSync(join(tmpdir(), "archer-tls-"));
  dirs.push(d);
  return d;
}
function certificate() {
  const d = directory(),
    tlsCert = join(d, "cert.pem"),
    tlsKey = join(d, "key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      tlsKey,
      "-out",
      tlsCert,
      "-days",
      "2",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore", timeout: 10000 },
  );
  return { tlsCert, tlsKey };
}
test("native HTTPS serves the authenticated page with certificate and hostname verification", async () => {
  const material = certificate();
  const state = directory();
  const svc = await startService({
    ...material,
    stateDir: state,
    env: { HOME: state, ARCHER_OPEN_BROWSER: "never" },
    log: () => {},
  });
  try {
    expect(svc.homeUrl).toMatch(/^https:/);
    // The home link signs this browser in over the verified connection: a secure, host-only session cookie.
    const reply = await new Promise<{ status: number; location?: string; cookie?: string }>((resolve, reject) => {
      const req = httpsRequest(svc.homeUrl, { ca: readFileSync(material.tlsCert) }, (res) => {
        res.resume();
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            ...(res.headers.location === undefined ? {} : { location: res.headers.location }),
            ...(res.headers["set-cookie"]?.[0] === undefined ? {} : { cookie: res.headers["set-cookie"][0] }),
          }),
        );
      });
      req.on("error", reject);
      req.end();
    });
    expect([reply.status, reply.location]).toEqual([303, "/projects/"]);
    expect(reply.cookie).toMatch(/^__Host-archer-\d+=[0-9a-f]+;.*\bSecure\b/);
    const cookie = reply.cookie!.split(";")[0]!;
    const client = await connectService(svc.socketPath);
    let page: string;
    try {
      page = (await client.call("attach", { root: project() })).url;
    } finally {
      client.close();
    }
    const metadata = await new Promise<string>((resolve, reject) => {
      const req = httpsRequest(
        `${apiBase(page)}api/connection`,
        { ca: readFileSync(material.tlsCert), headers: { cookie } },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (s) => (body += s));
          res.on("end", () => (res.statusCode === 200 ? resolve(body) : reject(Error(String(res.statusCode)))));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(JSON.parse(metadata)).toMatchObject({ browserProtocolMajor: 1 });
    const firstFrame = await new Promise<string>((resolve, reject) => {
      const req = httpsRequest(
        `${apiBase(page)}api/events`,
        { ca: readFileSync(material.tlsCert), headers: { cookie } },
        (res) => {
          res.setEncoding("utf8");
          res.once("data", (s) => {
            resolve(String(s));
            req.destroy();
          });
        },
      );
      req.setTimeout(2000, () => req.destroy(Error("no SSE frame")));
      req.on("error", reject);
      req.end();
    });
    expect(firstFrame).toContain(": open");
    await expect(
      new Promise((resolve, reject) => {
        const req = httpsRequest(svc.homeUrl, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        req.on("error", reject);
        req.end();
      }),
    ).rejects.toThrow();
  } finally {
    await svc.close();
  }
});
test("explicit HTTP override serves the home link over plain HTTP", async () => {
  const state = directory();
  const svc = await startService({
    forceHttp: true,
    stateDir: state,
    env: { HOME: state, ARCHER_OPEN_BROWSER: "never" },
    log: () => {},
  });
  try {
    expect(svc.homeUrl).toMatch(/^http:/);
    // Signed in by the link, the browser is served Projects.
    const projects = await openPage(svc.homeUrl);
    expect([projects.status, projects.body]).toEqual([200, expect.stringContaining("<html")]);
  } finally {
    await svc.close();
  }
});
test("TLS certificate must cover the configured name and match its key", () => {
  const a = certificate(),
    b = certificate();
  expect(() => prepareTransport(a, "wrong.example")).toThrow(/cover/);
  expect(() => prepareTransport({ ...a, tlsKey: b.tlsKey }, "localhost")).toThrow(/match/);
  expect(() => prepareTransport({ ...a, forceHttp: true }, "localhost")).toThrow(/combined/);
});
test("PEM parser bounds files and refuses directories or malformed certificates", () => {
  const d = directory(),
    p = join(d, "pem");
  writeFileSync(p, Buffer.alloc(MAX_TLS_PEM_BYTES + 1));
  expect(() => prepareTransport({ tlsCert: p, tlsKey: p }, "localhost")).toThrow(/regular file/);
  expect(() => prepareTransport({ tlsCert: d, tlsKey: d }, "localhost")).toThrow(/regular file/);
  writeFileSync(p, "not PEM");
  expect(() => prepareTransport({ tlsCert: p, tlsKey: p }, "localhost")).toThrow(/TLS context/);
});
test("bounded transport vocabulary mutations are either refused by name or valid", () => {
  const vocabulary: unknown[] = [
    undefined,
    null,
    true,
    false,
    0,
    1,
    "",
    "https",
    "http",
    "../key",
    "/missing/key",
    "\0",
    [],
    {},
    "a".repeat(4097),
  ];
  for (const forceHttp of vocabulary)
    for (const path of vocabulary) {
      for (const host of ["localhost", "192.168.1.20"]) {
        // HTTP only when asked for, or with no TLS setting at all on loopback (the zero-config default).
        try {
          const result = prepareTransport(
            { forceHttp, tlsCert: path, tlsKey: path } as Parameters<typeof prepareTransport>[0],
            host,
          );
          expect(result.scheme).toBe("http");
          expect(path).toBeUndefined();
          expect(forceHttp === true || (host === "localhost" && (forceHttp === false || forceHttp === undefined))).toBe(
            true,
          );
        } catch (error) {
          expect(error).toBeInstanceOf(PersistenceError);
          expect((error as Error).message.length).toBeLessThan(800);
        }
      }
    }
  // Environment ambiguity cannot accidentally authorize insecure transport.
  for (const v of ["1", "yes", "TRUE", "false\0"]) expect(() => optionsFromEnv({ ARCHER_FORCE_HTTP: v })).toThrow();
});

import { build } from "esbuild";
import { spawnSync } from "node:child_process";
test("transport trust boundary refuses arbitrary and mutated vocabulary on a small stack against a clock", async () => {
  const d = directory(),
    out = join(d, "probe.cjs");
  await build({
    stdin: {
      contents: `
 import {prepareTransport} from ${JSON.stringify(new URL("../../src/service/transport.ts", import.meta.url).pathname)};
 import {PersistenceError} from ${JSON.stringify(new URL("../../src/state/account.ts", import.meta.url).pathname)};
 let seed=761;const rand=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
 const words=[null,undefined,true,false,0,1,'','http','https','tlsCert','tlsKey','forceHttp','../key','/does-not-exist','\\0',[],{}];
 const check=(v)=>{for(const host of ['localhost','192.168.1.20']){try{const r=prepareTransport(v,host);const unset=v.tlsCert===undefined&&v.tlsKey===undefined&&(v.forceHttp===undefined||v.forceHttp===false);if(r.scheme!=='http'||!(v.forceHttp===true||(host==='localhost'&&unset)))throw Error('invalid acceptance');}catch(e){if(!(e instanceof PersistenceError))throw e;}}};
 for(let i=0;i<1000;i++){
 const a=words[rand()%words.length],b=words[rand()%words.length];
 check({forceHttp:a,tlsCert:b,tlsKey:a});
 check({forceHttp:true,...{[String(a)]:b}});
 check({tlsCert:Array.from({length:rand()%100},()=>String.fromCharCode(rand()%65536)).join(''),tlsKey:a});
 }
 check({forceHttp:true});console.log('PASS 3001');
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
  expect(child.stdout).toContain("PASS 3001");
});

import { main } from "../../src/bin/main.ts";
import { connectIfRunning } from "../../src/service/client.ts";
test("native HTTPS restart preserves its URL and trust while refreshing the service epoch", {
  timeout: 30000,
}, async () => {
  const material = certificate(),
    state = directory();
  const env = isolatedProcessEnv(state, { ARCHER_STATE_DIR: state, ARCHER_OPEN_BROWSER: "never" });
  const svc = await startService({ ...material, stateDir: state, env, log: () => {} });
  const client = await connectService(svc.socketPath);
  let page: string;
  try {
    page = (await client.call("attach", { root: project() })).url;
  } finally {
    client.close();
  }
  // The owner's browser signs in once (the link's token exchanged for its session cookie); a restart keeps it.
  const cookie = await new Promise<string>((resolve, reject) => {
    const req = httpsRequest(page, { ca: readFileSync(material.tlsCert) }, (res) => {
      res.resume();
      const set = res.headers["set-cookie"]?.[0];
      if (res.statusCode === 303 && set !== undefined) resolve(set.split(";")[0]!);
      else reject(Error(`sign-in: ${res.statusCode}`));
    });
    req.on("error", reject);
    req.end();
  });
  const metadata = () =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const req = httpsRequest(
        `${apiBase(page)}api/connection`,
        { ca: readFileSync(material.tlsCert), headers: { cookie } },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (s) => (body += s));
          res.on("end", () => {
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  const before = await metadata();
  const errors: string[] = [];
  try {
    expect(
      await main(["restart"], {
        env,
        cwd: state,
        stdout: () => {},
        stderr: (t) => errors.push(t),
        isTTY: false,
        columns: undefined,
      }),
      errors.join(""),
    ).toBe(0);
    const replacement = await connectService(svc.socketPath);
    try {
      expect((await replacement.call("hello", { protocolVersion: 1 })).homeUrl).toBe(svc.homeUrl);
      expect((await replacement.call("listProjects", {})).projects).toHaveLength(1);
    } finally {
      replacement.close();
    }
    expect((await metadata()).serverEpoch).not.toBe(before.serverEpoch);
  } finally {
    const replacement = await connectIfRunning({ env });
    if (replacement !== null) {
      await replacement.call("stop", {});
      replacement.close();
    }
    await expect.poll(() => existsSync(join(state, "archer.lock"))).toBe(false);
  }
});
test("bad replacement certificate refuses before stopping the existing HTTPS server", async () => {
  const material = certificate(),
    state = directory(),
    env = isolatedProcessEnv(state, { ARCHER_STATE_DIR: state, ARCHER_OPEN_BROWSER: "never" });
  const svc = await startService({ ...material, stateDir: state, env, log: () => {} });
  try {
    writeFileSync(material.tlsCert, "invalid replacement certificate");
    const errors: string[] = [];
    expect(
      await main(["restart"], {
        env,
        stdout: () => {},
        stderr: (t) => errors.push(t),
        isTTY: false,
        columns: undefined,
      }),
    ).not.toBe(0);
    expect(errors.join("")).toContain("TLS");
    const client = await connectService(svc.socketPath);
    try {
      expect((await client.call("hello", { protocolVersion: 1 })).homeUrl).toBe(svc.homeUrl);
    } finally {
      client.close();
    }
  } finally {
    await svc.close();
  }
});

test.each(["http", "https"] as const)("foreground CLI explicitly configures %s transport", async (scheme) => {
  const state = directory(),
    env = { HOME: state, ARCHER_STATE_DIR: state, ARCHER_OPEN_BROWSER: "never" };
  const material = scheme === "https" ? certificate() : undefined;
  const args =
    material === undefined ? ["--force-http"] : ["--tls-cert", material.tlsCert, "--tls-key", material.tlsKey];
  const errors: string[] = [];
  const running = main(["serve", "--foreground", ...args], {
    env,
    stdout: () => {},
    stderr: (t) => errors.push(t),
    isTTY: false,
    columns: undefined,
  });
  try {
    await expect
      .poll(async () => {
        const client = await connectIfRunning({ env });
        if (client === null) return null;
        try {
          return new URL((await client.call("hello", { protocolVersion: 1 })).homeUrl).protocol;
        } finally {
          client.close();
        }
      })
      .toBe(`${scheme}:`);
  } finally {
    const client = await connectIfRunning({ env });
    if (client !== null) {
      await client.call("stop", {});
      client.close();
    }
    expect(await running, errors.join("")).toBe(0);
  }
});

test("expired certificate is refused by name", () => {
  const material = certificate();
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 4 * 24 * 60 * 60 * 1000);
  try {
    expect(() => prepareTransport(material, "localhost")).toThrow(/expired/);
  } finally {
    clock.mockRestore();
  }
});
