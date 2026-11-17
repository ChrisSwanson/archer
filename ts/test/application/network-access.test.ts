// setup_network_access: the agent opens Archer to the person's devices after their yes, without
// handing them a file to edit. The merge keeps every other setting and comment; refusals say what to do.
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
  chmodSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  detectLanHost,
  mergeServiceSettings,
  setupNetworkAccess,
  type NetworkAccess,
} from "../../src/application/network-access.ts";
import type { OperationError } from "../../src/application/errors.ts";
import { ServiceUnavailableError, type ServiceClient } from "../../src/service/service-client.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const VALUES = {
  host: "0.0.0.0",
  forceHttp: false as const,
  tlsCert: "/s/tls/server/server-cert.pem",
  tlsKey: "/s/tls/server/server-key.pem",
};

test("a missing file becomes a minimal settings file", () => {
  expect(mergeServiceSettings("", VALUES)).toBe(
    `version = 1\n\n[service]\nhost = "0.0.0.0"\nforce_http = false\ntls_cert = "${VALUES.tlsCert}"\ntls_key = "${VALUES.tlsKey}"\n`,
  );
});

test("an existing [service] table keeps its other keys, comments and the tables after it", () => {
  const text = `# my settings\nversion = 1\n\n[service]\n# the port I like\nport = 40399\nforce_http = true # for now\nopen_browser = "never"\n\n[[projects]]\npath = "/home/me/code/**"\nadmit = true\n`;
  const merged = mergeServiceSettings(text, VALUES);
  expect(merged).toBe(
    `# my settings\nversion = 1\n\n[service]\n# the port I like\nport = 40399\nforce_http = false\nopen_browser = "never"\nhost = "0.0.0.0"\ntls_cert = "${VALUES.tlsCert}"\ntls_key = "${VALUES.tlsKey}"\n\n[[projects]]\npath = "/home/me/code/**"\nadmit = true\n`,
  );
});

test("turning it off sets the loopback host and removes the certificate keys, keeping the rest", () => {
  const text = `version = 1\n[service]\nport = 40399 # mine\nhost = "192.168.1.42"\nforce_http = false\ntls_cert = "/a"\ntls_key = "/b"\nopen_browser = "never"\n`;
  expect(mergeServiceSettings(text, { host: "127.0.0.1", forceHttp: null, tlsCert: null, tlsKey: null })).toBe(
    `version = 1\n[service]\nport = 40399 # mine\nhost = "127.0.0.1"\nopen_browser = "never"\n`,
  );
});

test("a file without a [service] table gets one at the end", () => {
  const merged = mergeServiceSettings(`version = 1\n[[services]]\nname = "work"\nport = 41000\n`, VALUES);
  expect(merged).toMatch(
    /^version = 1\n\[\[services\]\]\nname = "work"\nport = 41000\n\n\[service\]\nhost = "0\.0\.0\.0"\n/,
  );
});

test.each([
  ["a dotted service key", `version = 1\nservice.port = 40399\n`],
  ["a multi-line value in the table", `version = 1\n[service]\npublic_url = """\nhttps://x.example\n"""\n`],
  ["a file that does not parse", `version = 1\n[service\n`],
])("%s is refused rather than merged unsafely", (_, text) => {
  expect(() => mergeServiceSettings(text, VALUES)).toThrow();
});

test("the LAN address is a private IPv4 on a real interface, not a container bridge or loopback", () => {
  const entry = (address: string, internal = false) => ({
    address,
    family: "IPv4" as const,
    internal,
    netmask: "255.255.255.0",
    mac: "00:00:00:00:00:00",
    cidr: null,
  });
  expect(
    detectLanHost({ lo: [entry("127.0.0.1", true)], docker0: [entry("172.17.0.1")], wlan0: [entry("192.168.1.42")] }),
  ).toBe("192.168.1.42");
  expect(detectLanHost({ lo: [entry("127.0.0.1", true)], eth0: [entry("169.254.3.4")] })).toBeUndefined();
});

const LAN = {
  wlan0: [
    {
      address: "192.168.1.42",
      family: "IPv4" as const,
      internal: false,
      netmask: "255.255.255.0",
      mac: "00:00:00:00:00:00",
      cidr: null,
    },
  ],
};
/** A service that says it was started from the settings file as it is now (or as `answers.started` overrides). */
function startedFrom(env: Record<string, string>) {
  const config =
    env["ARCHER_CONFIG"] ||
    (env["XDG_CONFIG_HOME"] === undefined ? undefined : join(env["XDG_CONFIG_HOME"], "archer", "archer.toml"));
  const text = config !== undefined && existsSync(config) ? readFileSync(config, "utf8") : "";
  const value = (key: string) => new RegExp(`^${key} = "([^"]*)"`, "m").exec(text)?.[1];
  const cert = value("tls_cert"),
    key = value("tls_key");
  const port = /^port = (\d+)/m.exec(text)?.[1];
  return {
    stateDir: env["ARCHER_STATE_DIR"],
    host: value("host") ?? "127.0.0.1",
    restoreState: true,
    ...(port === undefined ? {} : { port: Number(port) }),
    transport:
      cert !== undefined && key !== undefined
        ? { scheme: "https", tlsCert: cert, tlsKey: key }
        : { scheme: "http", forceHttp: false },
  };
}
function harness(
  env: Record<string, string>,
  over: Partial<NetworkAccess> = {},
  answers: { home?: string; started?: object; stop?: "drops" | "drops-unread" } = {},
) {
  const calls: string[] = [];
  let stopped = false;
  const client = {
    call: async (method: string) => {
      calls.push(method);
      // PD-3: the stopping service can reset the connection before its answer is read ("drops"), or before it
      // read the stop at all ("drops-unread": it keeps running).
      if (method === "stop" && answers.stop === "drops-unread")
        throw new ServiceUnavailableError("lost the Archer service: write EPIPE");
      if (method === "stop") stopped = true;
      if (method === "stop" && answers.stop === "drops")
        throw new ServiceUnavailableError("lost the Archer service: read ECONNRESET");
      if (method === "issuePairingCode")
        return {
          code: "ABCD-EFGH",
          url: "https://192.168.1.42:40399/",
          minutes: 5,
          expiresAt: "x",
          plainHttpOnNetwork: false,
          localOnly: false,
        };
      if (method === "hello") return { homeUrl: answers.home ?? "https://192.168.1.42:40399/tok/" };
      if (method === "restartConfiguration") return { ...startedFrom(env), ...(stopped ? answers.started : {}) };
      return {};
    },
    close: () => undefined,
  } as unknown as ServiceClient;
  const access: NetworkAccess = {
    env,
    acquire: async () => client,
    disconnect: () => calls.push("disconnect"),
    openssl: () => true,
    interfaces: () => LAN,
    resolveName: async () => ["192.168.1.42"],
    serviceGone: async () => {
      calls.push("gone?");
      return answers.stop !== "drops-unread";
    },
    ...over,
  };
  return { access, calls };
}
const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as OperationError;
  }
  throw new Error("expected a refusal");
};

test("where the client can ask the person, their answer decides, whatever the agent passed", async () => {
  const asked: string[] = [];
  const { access, calls } = harness(
    {},
    {
      askPerson: async (question) => {
        asked.push(question);
        return "no";
      },
    },
  );
  const error = await refusal(setupNetworkAccess({ personConfirmed: true, host: "192.168.1.42" }, access));
  expect(error.data["code"]).toBe("person_declined");
  expect(asked).toEqual([
    expect.stringContaining("Open Archer to other devices on your network at https://192.168.1.42"),
  ]);
  expect(calls).toEqual([]);
});

test("without the person's yes nothing is done, and the refusal says to ask once", async () => {
  const { access, calls } = harness({});
  const error = await refusal(setupNetworkAccess({ host: "192.168.1.42" }, access));
  expect(error.data).toMatchObject({
    code: "person_confirmation_needed",
    fix: { needsPersonYes: true, tool: "setup_network_access" },
  });
  expect(error.message).toMatch(/Ask the person once, in one sentence/);
  expect(calls).toEqual([]);
});

test("missing openssl is refused with how to install it", async () => {
  const { access } = harness({}, { openssl: () => false, platform: "linux" });
  const error = await refusal(setupNetworkAccess({ personConfirmed: true, host: "192.168.1.42" }, access));
  expect(error.data["code"]).toBe("openssl_missing");
  expect(error.message).toMatch(/sudo apt install openssl/);
});

test("an environment override is refused, since the settings file would not take effect", async () => {
  const { access } = harness({ ARCHER_FORCE_HTTP: "true" });
  const error = await refusal(setupNetworkAccess({ personConfirmed: true, host: "192.168.1.42" }, access));
  expect(error.data).toMatchObject({ code: "network_setup_blocked", variables: ["ARCHER_FORCE_HTTP"] });
});

test.each(["127.0.0.1", "localhost", "0.0.0.0", "::1"])(
  "host %s is not an address another device uses",
  async (host) => {
    const { access } = harness({});
    expect((await refusal(setupNetworkAccess({ personConfirmed: true, host }, access))).data["code"]).toBe(
      "invalid_arguments",
    );
  },
);

test("with the yes: a certificate, the merged settings, a restart and a pairing code", async () => {
  const home = mkdtempSync(join(tmpdir(), "aev-net-"));
  dirs.push(home);
  chmodSync(home, 0o700);
  const config = join(home, "archer.toml");
  writeFileSync(config, "version = 1\n[service]\nport = 41234 # mine\n", { mode: 0o600 });
  const { access, calls } = harness(
    { HOME: home, ARCHER_CONFIG: config, ARCHER_STATE_DIR: join(home, "state") },
    { askPerson: async () => "yes" },
  );
  const result = await setupNetworkAccess({ host: "mybox.lan" }, access);
  const merged = readFileSync(config, "utf8");
  // Bound to the one address the name resolves to, never every interface.
  expect(merged).toMatch(
    /^version = 1\n\[service\]\nport = 41234 # mine\nhost = "192\.168\.1\.42"\nforce_http = false\ntls_cert = ".*server-cert\.pem"\ntls_key = ".*server-key\.pem"\n$/,
  );
  expect(readdirSync(home).some((name) => name.startsWith("archer.toml.before-network-"))).toBe(true);
  expect(calls).toEqual([
    "restartConfiguration",
    "stop",
    "disconnect",
    "gone?",
    "restartConfiguration",
    "issuePairingCode",
  ]);
  const backup = readdirSync(home).find((name) => name.startsWith("archer.toml.before-network-"))!;
  expect(statSync(join(home, backup)).mode & 0o777).toBe(0o600);
  expect(result.structured).toMatchObject({
    host: "mybox.lan",
    bind: "192.168.1.42",
    code: "ABCD-EFGH",
    url: "https://192.168.1.42:40399/",
    certificateReused: false,
  });
  expect(existsSync(String(result.structured["caCert"]))).toBe(true);
  expect(result.text).toContain("ABCD-EFGH");
  expect(result.text).toMatch(/one step only the person can do/);
  expect(result.text).not.toMatch(/edit/i);
  const { X509Certificate } = await import("node:crypto");
  expect(
    new X509Certificate(
      readFileSync(String(result.structured["caCert"]).replace("ca/ca-cert.pem", "server/server-cert.pem")),
    ).subjectAltName,
  ).toContain("IP Address:192.168.1.42");

  // Off: loopback again, the certificate kept; on again: the same certificate, so no new trust step.
  const off = await setupNetworkAccess(
    { enabled: false },
    harness(
      { HOME: home, ARCHER_CONFIG: config, ARCHER_STATE_DIR: join(home, "state") },
      {},
      { home: "http://127.0.0.1:40399/tok/" },
    ).access,
  );
  expect(off.structured).toMatchObject({ enabled: false });
  expect(readFileSync(config, "utf8")).toBe('version = 1\n[service]\nport = 41234 # mine\nhost = "127.0.0.1"\n');
  const again = await setupNetworkAccess(
    { host: "mybox.lan" },
    harness(
      { HOME: home, ARCHER_CONFIG: config, ARCHER_STATE_DIR: join(home, "state") },
      { askPerson: async () => "yes", openssl: () => false },
    ).access,
  );
  expect(again.structured).toMatchObject({ certificateReused: true, caCert: result.structured["caCert"] });
  // Codex re-review: a reused certificate must not carry the old record's enabled: false along.
  expect(JSON.parse(readFileSync(join(home, "state", "network-access.json"), "utf8"))).toMatchObject({
    enabled: true,
    bind: "192.168.1.42",
  });
}, 60_000);

// Codex review (2026-10-22), findings 4 and 7: a change made meanwhile wins, and a [[services]] entry named
// "default" that would override the written settings is refused rather than reported as done.
test.each([
  [
    "a [[services]] entry named default overrides [service]",
    `version = 1\n[[services]]\nname = "default"\nhost = "127.0.0.1"\n`,
    undefined,
  ],
  ["the file changes while the certificate is made", "version = 1\n", "version = 1\n# the person's edit\n"],
])(
  "%s: refused, the file as it is",
  async (_, text, meanwhile) => {
    const home = mkdtempSync(join(tmpdir(), "aev-net-"));
    dirs.push(home);
    chmodSync(home, 0o700);
    const config = join(home, "archer.toml");
    writeFileSync(config, text, { mode: 0o600 });
    const { access, calls } = harness(
      { HOME: home, ARCHER_CONFIG: config, ARCHER_STATE_DIR: join(home, "state") },
      {
        askPerson: async () => "yes",
        acquire: async () => {
          if (meanwhile !== undefined) writeFileSync(config, meanwhile, { mode: 0o600 });
          return null;
        },
      },
    );
    const error = await refusal(setupNetworkAccess({ host: "192.168.1.42" }, access));
    expect(error.data["code"]).toBe("network_setup_blocked");
    expect(readFileSync(config, "utf8")).toBe(meanwhile ?? text);
    expect(calls).not.toContain("stop");
  },
  60_000,
);

// Codex re-review (2026-10-22): the bind must be one of this machine's own addresses (never a wildcard a
// name resolves to), and the service that answers after the restart must be the one the settings made.
test.each([["0.0.0.0"], ["0:0:0:0:0:0:0:0"], ["10.9.9.9"]])(
  "a name resolving to %s is refused before anything changes",
  async (address) => {
    const { access, calls } = harness({}, { askPerson: async () => "yes", resolveName: async () => [address] });
    expect((await refusal(setupNetworkAccess({ host: "evil.example" }, access))).data["code"]).toBe(
      "network_host_unknown",
    );
    expect(calls).toEqual([]);
  },
);

test("another copy answering after the restart is a failure, and the old settings come back", async () => {
  const home = mkdtempSync(join(tmpdir(), "aev-net-"));
  dirs.push(home);
  chmodSync(home, 0o700);
  const config = join(home, "archer.toml");
  writeFileSync(config, "version = 1\n", { mode: 0o600 });
  const { access } = harness(
    { HOME: home, ARCHER_CONFIG: config, ARCHER_STATE_DIR: join(home, "state") },
    { askPerson: async () => "yes" },
    { started: { stateDir: "/elsewhere/state" } },
  );
  const error = await refusal(setupNetworkAccess({ host: "192.168.1.42" }, access));
  expect(error.message).toMatch(/the Archer that answered keeps its state in \/elsewhere\/state/);
  expect(readFileSync(config, "utf8")).toBe("version = 1\n");
  expect(existsSync(join(home, "state", "network-access.lock"))).toBe(false);
  // O37: the certificate it made for the failed try is gone (no record names it, so nothing would reuse it).
  expect(readdirSync(join(home, "state")).filter((name) => name.startsWith("tls-"))).toEqual([]);
}, 60_000);

test("a certificate replaced by a new one (another host) is removed; the new one stays", async () => {
  const home = mkdtempSync(join(tmpdir(), "aev-net-"));
  dirs.push(home);
  chmodSync(home, 0o700);
  const config = join(home, "archer.toml");
  writeFileSync(config, "version = 1\n", { mode: 0o600 });
  const env = { HOME: home, ARCHER_CONFIG: config, ARCHER_STATE_DIR: join(home, "state") };
  const first = await setupNetworkAccess({ host: "mybox.lan" }, harness(env, { askPerson: async () => "yes" }).access);
  const second = await setupNetworkAccess({ host: "other.lan" }, harness(env, { askPerson: async () => "yes" }).access);
  expect(second.structured["certificateReused"]).toBe(false);
  expect(existsSync(String(first.structured["tlsDirectory"]))).toBe(false);
  expect(
    readdirSync(join(home, "state"))
      .filter((name) => name.startsWith("tls-"))
      .map((name) => join(home, "state", name)),
  ).toEqual([second.structured["tlsDirectory"]]);
}, 60_000);

// Codex review 3: the replacement must serve this exact address over HTTPS with these certificates (a
// wildcard listener advertising the LAN IP, or plain HTTP there, is not it); a lock left by a dead
// process is taken over, one held by a live one is not; a failure releases the lock.
test.each([
  ["a wildcard listener", { host: "0.0.0.0" }, /listens on 0\.0\.0\.0, not 192\.168\.1\.42/],
  ["plain HTTP", { transport: { scheme: "http", forceHttp: true } }, /serves http/],
])(
  "%s answering after the restart is a failure",
  async (_, started, message) => {
    const home = mkdtempSync(join(tmpdir(), "aev-net-"));
    dirs.push(home);
    chmodSync(home, 0o700);
    const config = join(home, "archer.toml");
    writeFileSync(config, "version = 1\n", { mode: 0o600 });
    const { access } = harness(
      { HOME: home, ARCHER_CONFIG: config, ARCHER_STATE_DIR: join(home, "state") },
      { askPerson: async () => "yes" },
      { started },
    );
    expect((await refusal(setupNetworkAccess({ host: "192.168.1.42" }, access))).message).toMatch(message);
    expect(readFileSync(config, "utf8")).toBe("version = 1\n");
    expect(existsSync(`${config}.network-access.lock`)).toBe(false);
  },
  60_000,
);

test("a lock held by a live process refuses; one left by a dead process is taken over", async () => {
  const home = mkdtempSync(join(tmpdir(), "aev-net-"));
  dirs.push(home);
  chmodSync(home, 0o700);
  const config = join(home, "archer.toml");
  writeFileSync(config, "version = 1\n", { mode: 0o600 });
  const env = { HOME: home, ARCHER_CONFIG: config, ARCHER_STATE_DIR: join(home, "state") };
  writeFileSync(`${config}.network-access.lock`, `${process.pid} live\n`);
  expect(
    (await refusal(setupNetworkAccess({ host: "192.168.1.42" }, harness(env, { askPerson: async () => "yes" }).access)))
      .message,
  ).toMatch(/Another setup_network_access is running/);
  writeFileSync(`${config}.network-access.lock`, "999999999 dead\n");
  expect(
    (await setupNetworkAccess({ host: "192.168.1.42" }, harness(env, { askPerson: async () => "yes" }).access))
      .structured,
  ).toMatchObject({ enabled: true });
  expect(existsSync(`${config}.network-access.lock`)).toBe(false);
}, 60_000);

// A fresh install has no ~/.config/archer yet: setup makes it (private), the file and its lock in it.
test("a settings folder that does not exist yet is made", async () => {
  const home = mkdtempSync(join(tmpdir(), "aev-net-"));
  dirs.push(home);
  chmodSync(home, 0o700);
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), ARCHER_STATE_DIR: join(home, "state") };
  const result = await setupNetworkAccess(
    { host: "192.168.1.42" },
    harness({ ...env, ARCHER_CONFIG: "" }, { askPerson: async () => "yes" }).access,
  );
  expect(result.structured).toMatchObject({ enabled: true });
  expect(statSync(join(home, ".config", "archer")).mode & 0o777).toBe(0o700);
  expect(readFileSync(join(home, ".config", "archer", "archer.toml"), "utf8")).toMatch(
    /^version = 1\n\n\[service\]\nhost = "192\.168\.1\.42"/,
  );
}, 60_000);

// Codex review 4: publishing the settings and the record is inside what is rolled back.
test("a record that cannot be written rolls the settings back", async () => {
  const { mkdirSync } = await import("node:fs");
  const home = mkdtempSync(join(tmpdir(), "aev-net-"));
  dirs.push(home);
  chmodSync(home, 0o700);
  const config = join(home, "archer.toml");
  writeFileSync(config, "version = 1\n", { mode: 0o600 });
  mkdirSync(join(home, "state", "network-access.json"), { recursive: true });
  const { access, calls } = harness(
    { HOME: home, ARCHER_CONFIG: config, ARCHER_STATE_DIR: join(home, "state") },
    { askPerson: async () => "yes" },
  );
  await refusal(setupNetworkAccess({ host: "192.168.1.42" }, access));
  expect(readFileSync(config, "utf8")).toBe("version = 1\n");
  expect(calls).not.toContain("stop");
  expect(existsSync(`${config}.network-access.lock`)).toBe(false);
}, 60_000);

// PD-3 (security round 1): the stopping service may reset the connection the stop went on before its answer
// is read. That is a stop: setup goes on once the old service is gone, and checks the one that answers.
test("a stop whose connection drops as the service stops is a stop", async () => {
  const home = mkdtempSync(join(tmpdir(), "aev-net-"));
  dirs.push(home);
  chmodSync(home, 0o700);
  const config = join(home, "archer.toml");
  writeFileSync(config, "version = 1\n", { mode: 0o600 });
  const env = { HOME: home, ARCHER_CONFIG: config, ARCHER_STATE_DIR: join(home, "state") };
  const { access, calls } = harness(env, { askPerson: async () => "yes" }, { stop: "drops" });
  const result = await setupNetworkAccess({ host: "192.168.1.42" }, access);
  expect(result.structured).toMatchObject({ enabled: true, bind: "192.168.1.42" });
  expect(calls).toEqual([
    "restartConfiguration",
    "stop",
    "disconnect",
    "gone?",
    "restartConfiguration",
    "issuePairingCode",
  ]);
  const off = await setupNetworkAccess(
    { enabled: false },
    harness(env, {}, { home: "http://127.0.0.1:40399/tok/", stop: "drops" }).access,
  );
  expect(off.structured).toMatchObject({ enabled: false });
  expect(readFileSync(config, "utf8")).toMatch(/host = "127\.0\.0\.1"/);
}, 60_000);

test("a stop that drops while the old service keeps answering fails closed", async () => {
  const home = mkdtempSync(join(tmpdir(), "aev-net-"));
  dirs.push(home);
  chmodSync(home, 0o700);
  const config = join(home, "archer.toml");
  writeFileSync(config, "version = 1\n", { mode: 0o600 });
  const { access } = harness(
    { HOME: home, ARCHER_CONFIG: config, ARCHER_STATE_DIR: join(home, "state") },
    { askPerson: async () => "yes" },
    { stop: "drops-unread" },
  );
  const error = await refusal(setupNetworkAccess({ host: "192.168.1.42" }, access));
  expect(error.data["code"]).toBe("io_failure");
  expect(error.message).toMatch(/did not stop/);
  expect(readFileSync(config, "utf8")).toBe("version = 1\n");
  expect(existsSync(join(home, "state", "network-access.json"))).toBe(false);
}, 60_000);

// PD-2: a rollback leaves the service as the restored settings say. One of ours that answers with the new
// settings (it started, then a later check failed) is stopped and started again from the old ones.
test("a rollback restarts a service of ours that still runs the settings it put back", async () => {
  const home = mkdtempSync(join(tmpdir(), "aev-net-"));
  dirs.push(home);
  chmodSync(home, 0o700);
  const config = join(home, "archer.toml");
  writeFileSync(config, "version = 1\n", { mode: 0o600 });
  const env = { HOME: home, ARCHER_CONFIG: config, ARCHER_STATE_DIR: join(home, "state") };
  const calls: string[] = [];
  let generation = 0,
    running = startedFrom(env);
  const client = {
    call: async (method: string) => {
      calls.push(method);
      if (method === "stop") generation++;
      // The first replacement answers how it started with the network settings but the wrong port; the next is right.
      if (method === "restartConfiguration") return generation === 1 ? { ...running, port: 1 } : running;
      return {};
    },
  } as unknown as ServiceClient;
  const access: NetworkAccess = {
    env,
    acquire: async () => {
      running = startedFrom(env);
      return client;
    },
    disconnect: () => calls.push("disconnect"),
    openssl: () => true,
    interfaces: () => LAN,
    resolveName: async () => ["192.168.1.42"],
    serviceGone: async () => true,
    askPerson: async () => "yes",
  };
  writeFileSync(config, "version = 1\n[service]\nport = 41234\n", { mode: 0o600 });
  const error = await refusal(setupNetworkAccess({ host: "192.168.1.42" }, access));
  expect(error.message).toMatch(/uses port 1, not 41234/);
  expect(readFileSync(config, "utf8")).toBe("version = 1\n[service]\nport = 41234\n");
  // Stopped once for the change, once more by the rollback, and what answers last is the restored one.
  expect(calls.filter((call) => call === "stop")).toHaveLength(2);
  expect(error.message).not.toMatch(/could not be started again/);
}, 60_000);

// PD-2: over the default MCP door the session is a relay of the very service setup restarts, and it may end
// while the restart is under way. Setup's own connections carry it through: confirmed or rolled back, never
// cut short between writing the settings and checking the service they started.
test("a session that closes while setup restarts Archer does not cut it short", async () => {
  const { createApplication } = await import("../../src/application/index.ts");
  const home = mkdtempSync(join(tmpdir(), "aev-net-"));
  dirs.push(home);
  chmodSync(home, 0o700);
  const config = join(home, "archer.toml");
  // Open to the network now; the session turns it off (the same restart, without needing a LAN interface here).
  writeFileSync(
    config,
    `version = 1\n[service]\nhost = "192.168.1.42"\nforce_http = false\ntls_cert = "${home}/c.pem"\ntls_key = "${home}/k.pem"\n`,
    { mode: 0o600 },
  );
  const env = {
    HOME: home,
    ARCHER_CONFIG: config,
    ARCHER_STATE_DIR: join(home, "state"),
    ARCHER_SOCKET: join(home, "state", "archer.sock"),
  };
  const { access } = harness(env, {}, { home: "http://127.0.0.1:40399/tok/" });
  let app: ReturnType<typeof createApplication>;
  let started = false;
  const service = async () => (await access.acquire(true))!;
  app = createApplication({
    cwd: home,
    env,
    findService: async () => (started ? null : service()),
    // The relay's connection ends with the service it hosts: the session closes as the replacement starts.
    startService: async () => {
      started = true;
      app.close();
      return service();
    },
  });
  const result = await app.call("setup_network_access", { enabled: false });
  expect(result.structured).toMatchObject({ enabled: false });
  expect(readFileSync(config, "utf8")).toMatch(/host = "127\.0\.0\.1"/);
}, 60_000);
