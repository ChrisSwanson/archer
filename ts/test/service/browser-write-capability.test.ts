// ADR 0028: browser credentials never write configuration. Account settings and the project's
// archer.toml are read-only from every browser credential, including authoring links, and a
// refusal leaves the file bytes untouched.
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:http";
import { afterEach, expect, test } from "vitest";
import { connectService } from "../../src/service/service-client.ts";
import { InstanceSettingsStore } from "../../src/config/instance-settings.ts";
import { cleanUp, http, project, service, slugOf, tempDir, write } from "./support.ts";

afterEach(cleanUp);

const MANIFEST =
  'version = 1\nname = "Demo"\n\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "Flow"\nsource = ".archer/flow.mmd"\n';

async function setup() {
  const config = write(tempDir(), "archer.toml", 'version = 1\n# mine\n[service]\ncomment_submission = "queued"\n');
  const { svc } = await service({ env: { ARCHER_CONFIG: config } });
  const client = await connectService(svc.socketPath);
  const root = realpathSync(project());
  write(root, "archer.toml", MANIFEST);
  const attached = await client.call("attach", { root });
  const origin = new URL(svc.homeUrl).origin,
    slug = slugOf(attached.url);
  const cookieOf = async (url: string): Promise<string> =>
    ((await http(url)).headers["set-cookie"] as string[])[0]!.split(";")[0]!;
  const reader = await client.call("issueAccess", { label: "reader" });
  // The owner's browser: the agent link (the service token) exchanged for its session cookie.
  const ownerCookie = await cookieOf(attached.url);
  const author = await client.call("issueAuthoringAccess", { label: "author", projectRoots: [root] });
  const credentials: Record<string, { base: string; headers: Record<string, string> }> = {
    "read/comment cookie": { base: origin, headers: { cookie: await cookieOf(reader.url) } },
    "authoring cookie": { base: origin, headers: { cookie: await cookieOf(author.url) } },
    "owner cookie": { base: origin, headers: { cookie: ownerCookie } },
    bearer: { base: origin, headers: { authorization: `Bearer ${author.token}` } },
  };
  return { svc, client, root, config, origin, slug, credentials, ownerCookie };
}

test("no browser credential can write account settings or the project manifest", async () => {
  const { client, root, config, origin, slug, credentials } = await setup();
  try {
    const manifest = readFileSync(join(root, "archer.toml"));
    const account = readFileSync(config);
    for (const [name, { base, headers }] of Object.entries(credentials)) {
      const send = (path: string, method: string, body: unknown) =>
        http(`${base}${path}`, {
          method,
          headers: { ...headers, origin, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const settingsSnapshot = JSON.parse((await http(`${base}/api/settings`, { headers })).body) as {
        configRevision: string;
      };
      const put = await send("/api/settings", "PUT", {
        commentSubmission: "immediate",
        expectedRevision: settingsSnapshot.configRevision,
      });
      expect([name, put.status, JSON.parse(put.body).error?.code]).toEqual([name, 403, "settings_read_only"]);
      const scoped = await send(`/p/${slug}/api/settings`, "PUT", {
        commentSubmission: "immediate",
        expectedRevision: settingsSnapshot.configRevision,
      });
      expect([name, scoped.status]).toEqual([name, 403]);
      const snapshot = JSON.parse((await http(`${base}/p/${slug}/api/project-settings`, { headers })).body) as {
        revision: string;
      };
      const patch = await send(`/p/${slug}/api/project-settings`, "PATCH", {
        revision: snapshot.revision,
        changes: { name: "Renamed" },
      });
      expect([name, patch.status, JSON.parse(patch.body).error?.code]).toEqual([name, 403, "settings_read_only"]);
    }
    expect(readFileSync(join(root, "archer.toml"))).toEqual(manifest);
    expect(readFileSync(config)).toEqual(account);
  } finally {
    client.close();
  }
}, 20_000);

test("account settings read back every service setting with its value, default and source, and no secrets", () => {
  const config = write(
    tempDir(),
    "archer.toml",
    'version = 1\n[service]\ncomment_submission = "immediate"\ntls_key = "/secret/key.pem"\ntls_cert = "/secret/cert.pem"\n',
  );
  const read = new InstanceSettingsStore(
    "default",
    { ARCHER_CONFIG: config },
    join(tempDir(), "absent-system.toml"),
  ).read();
  const text = JSON.stringify(read);
  expect(read.writable).toBe(false);
  expect(read.commentSubmission).toBe("immediate");
  expect(read.settings.map((s) => s.key)).toEqual([
    "edit",
    "host",
    "port",
    "publicUrl",
    "admission",
    "openBrowser",
    "autoStart",
    "restore",
    "commentSubmission",
    "pairingCodeMinutes",
    "tlsCert",
    "tlsKey",
    "forceHttp",
  ]);
  expect(read.settings.find((s) => s.key === "commentSubmission")).toEqual({
    key: "commentSubmission",
    value: "immediate",
    default: "immediate",
    source: "user",
  });
  expect(read.settings.find((s) => s.key === "pairingCodeMinutes")).toEqual({
    key: "pairingCodeMinutes",
    value: 5,
    default: 5,
    source: "builtin",
  });
  // Editing in the page: on unless an archer.toml says edit = false; shown, never changed, by the page.
  expect(read.settings.find((s) => s.key === "edit")).toEqual({
    key: "edit",
    value: true,
    default: true,
    source: "builtin",
  });
  expect(read.settings.find((s) => s.key === "host")).toEqual({
    key: "host",
    value: "127.0.0.1",
    default: "127.0.0.1",
    source: "builtin",
  });
  expect(read.settings.find((s) => s.key === "port")).toEqual({
    key: "port",
    value: null,
    default: null,
    source: "builtin",
  });
  expect(read.settings.find((s) => s.key === "tlsKey")).toEqual({
    key: "tlsKey",
    value: "set",
    default: null,
    source: "user",
  });
  expect(text).not.toContain("/secret/key.pem");
});

test("account settings report the running service's startup overrides, not only the files", async () => {
  const { svc } = await service({ host: "127.0.0.1" });
  const signIn = await http(svc.homeUrl);
  const cookie = (signIn.headers["set-cookie"] as string[])[0]!.split(";")[0]!;
  const body = JSON.parse(
    (await http(`${new URL(svc.homeUrl).origin}/api/settings`, { headers: { cookie } })).body,
  ) as {
    settings: { key: string; value: unknown; source: string }[];
  };
  expect(body.settings.find((s) => s.key === "forceHttp")).toMatchObject({ value: true, source: "flag" });
  expect(body.settings.find((s) => s.key === "host")).toMatchObject({ value: "127.0.0.1", source: "flag" });
});

test("the refusal answers before the request body arrives and reads no configuration", async () => {
  const { client, origin, slug, ownerCookie } = await setup();
  try {
    for (const [method, path] of [
      ["PUT", "/api/settings"],
      ["PATCH", `/p/${slug}/api/project-settings`],
    ] as const) {
      const status = await new Promise<number>((resolveStatus, reject) => {
        const req = request(
          `${origin}${path}`,
          {
            method,
            headers: { cookie: ownerCookie, origin, "content-type": "application/json", "content-length": "1000" },
          },
          (res) => {
            res.resume();
            resolveStatus(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.write("{"); // never finished: a handler that awaited the body would hang here
      });
      expect([method, status]).toEqual([method, 403]);
    }
  } finally {
    client.close();
  }
});
