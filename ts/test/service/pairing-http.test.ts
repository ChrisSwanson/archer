import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { connectService } from "../../src/service/service-client.ts";
import { cleanUp, http, project, service, tempDir } from "./support.ts";

afterEach(cleanUp);

const json = (origin: string) => ({ origin, "content-type": "application/json" });
const pair = (origin: string, code: string, headers: Record<string, string> = json(origin)) =>
  http(`${origin}/-/pair`, { method: "POST", headers, body: JSON.stringify({ code }) });
const errorCode = (body: string): unknown => (JSON.parse(body) as { error: { code: string } }).error.code;

test("the base page offers the code form, and a code exchanged at /-/pair is a revocable grant's cookie", async () => {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  try {
    await client.call("attach", { root: project() });
    const origin = new URL(svc.homeUrl).origin;
    const base = await http(`${origin}/`);
    expect(base.status).toBe(200);
    expect(base.headers["cache-control"]).toBe("no-store");
    expect(base.body).toContain('autocomplete="one-time-code"');
    expect(base.body).toContain("archer pair");
    expect(base.body).not.toContain(svc.token);

    const issued = await client.call("issuePairingCode", {});
    expect(issued.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(issued.url).toBe(`${origin}/`);
    expect(issued.minutes).toBe(5);
    expect(issued).toMatchObject({ localOnly: true, plainHttpOnNetwork: false });
    expect(Date.parse(issued.expiresAt) - Date.now()).toBeGreaterThan(4 * 60_000);

    const paired = await pair(origin, issued.code.toLowerCase().replace("-", " "));
    // One 303 to a clean Location (D5), like a link's exchange.
    expect(paired.status, paired.body).toBe(303);
    expect(paired.headers.location).toBe("/projects/");
    expect(paired.body).toBe("");
    const setCookie = (paired.headers["set-cookie"] as string[])[0]!;
    expect(setCookie).toMatch(/HttpOnly; SameSite=Strict; Path=\//);
    expect(setCookie).not.toContain(svc.token);
    const cookie = setCookie.split(";")[0]!;
    expect((await http(`${origin}/api/projects`, { headers: { cookie } })).status).toBe(200);

    const { grants } = await client.call("listAccess", {});
    const grant = grants.find((entry) => entry.label.startsWith("Paired "));
    expect(grant).toMatchObject({ revokedAt: null });
    expect(JSON.stringify(grants)).not.toContain(issued.code);

    const replay = await pair(origin, issued.code);
    expect(replay.status).toBe(400);
    expect(errorCode(replay.body)).toBe("code_used");

    expect(await client.call("revokeAccess", { grantId: grant!.id })).toEqual({ revoked: true });
    expect((await http(`${origin}/api/projects`, { headers: { cookie } })).status).toBe(404);
  } finally {
    client.close();
  }
}, 20_000);

test("/-/pair takes only a same-origin form or JSON POST with no query, and a refused request spends nothing", async () => {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  try {
    const origin = new URL(svc.homeUrl).origin;
    const { code } = await client.call("issuePairingCode", {});
    const body = JSON.stringify({ code });
    const refusals: [string, Parameters<typeof http>[1], number][] = [
      ["no Origin", { method: "POST", headers: { "content-type": "application/json" }, body }, 403],
      ["a foreign Origin", { method: "POST", headers: json("http://evil.invalid"), body }, 403],
      ["another scheme", { method: "POST", headers: json(origin.replace("http:", "https:")), body }, 403],
      [
        "a form with no Origin",
        { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `code=${code}` },
        403,
      ],
      [
        "a form from another site",
        {
          method: "POST",
          headers: { origin: "http://evil.invalid", "content-type": "application/x-www-form-urlencoded" },
          body: `code=${code}`,
        },
        403,
      ],
      [
        "a form with Origin: null",
        {
          method: "POST",
          headers: { origin: "null", "content-type": "application/x-www-form-urlencoded" },
          body: `code=${code}`,
        },
        403,
      ],
      ["text/plain", { method: "POST", headers: { origin, "content-type": "text/plain" }, body }, 403],
      ["a foreign Host", { method: "POST", headers: { ...json(origin), host: "evil.invalid" }, body }, 404],
      ["GET", { method: "GET" }, 404],
    ];
    for (const [why, options, status] of refusals)
      expect((await http(`${origin}/-/pair`, options)).status, why).toBe(status);
    expect((await http(`${origin}/-/pair?code=${code}`, { method: "POST", headers: json(origin), body })).status).toBe(
      404,
    );
    for (const bad of ["{}", "[]", '{"code":1}', `{"code":"${code}","x":1}`, "not json"]) {
      const reply = await http(`${origin}/-/pair`, { method: "POST", headers: json(origin), body: bad });
      expect(reply.status, bad).toBe(400);
      expect(errorCode(reply.body)).toBe("code_invalid");
    }
    expect(
      (
        await http(`${origin}/-/pair`, {
          method: "POST",
          headers: json(origin),
          body: JSON.stringify({ code: "x".repeat(5000) }),
        })
      ).status,
    ).toBe(413);
    expect((await pair(origin, code)).status).toBe(303);
  } finally {
    client.close();
  }
}, 20_000);

test("the page's form: a refusal answers the form again with its reason, and a correct code one 303 with the cookie", async () => {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  try {
    const origin = new URL(svc.homeUrl).origin;
    const base = await http(`${origin}/`);
    expect(base.body).toContain('<form id="pair" method="post" action="/-/pair"');
    expect(base.body).toContain('name="code"');
    // A form navigation under no-referrer would send `Origin: null`; the form's address holds no secret.
    expect(base.headers["referrer-policy"]).toBe("same-origin");
    const { code } = await client.call("issuePairingCode", {});
    const submit = (body: string) =>
      http(`${origin}/-/pair`, {
        method: "POST",
        headers: { origin, "content-type": "application/x-www-form-urlencoded" },
        body,
      });
    const wrong = `${code.slice(0, -1)}${code.endsWith("Z") ? "Y" : "Z"}`;
    for (const [body, reason] of [
      [`code=${encodeURIComponent(wrong)}`, "Check it and try again"],
      ["code=ABC", "8 letters and digits"],
      [`code=${code}&code=${code}`, "8 letters and digits"],
      [`code=${code}&x=1`, "8 letters and digits"],
      ["", "8 letters and digits"],
    ] as const) {
      const refused = await submit(body);
      expect(refused.status, body).toBe(400);
      expect(refused.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(refused.headers["set-cookie"]).toBeUndefined();
      expect(refused.headers.location).toBeUndefined();
      expect(refused.body).toContain(reason);
      expect(refused.body).toContain('aria-invalid="true"');
      // Nothing the browser sent is echoed.
      expect(refused.body).not.toContain(wrong.slice(0, 4) + "-");
      expect(String(refused.headers["content-security-policy"])).toMatch(/script-src 'sha256-/);
    }
    const paired = await submit(`code=${encodeURIComponent(code.toLowerCase())}`);
    expect(paired.status).toBe(303);
    expect(paired.headers.location).toBe("/projects/");
    const cookie = (paired.headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    expect((await http(`${origin}/api/projects`, { headers: { cookie } })).status).toBe(200);
    const used = await submit(`code=${code}`);
    expect(used.status).toBe(400);
    expect(used.body).toContain("already used");
  } finally {
    client.close();
  }
}, 20_000);

test("wrong codes are throttled globally, then every live code is void", async () => {
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  try {
    const origin = new URL(svc.homeUrl).origin;
    const { code } = await client.call("issuePairingCode", {});
    const wrong = `${code.slice(0, -1)}${code.endsWith("Z") ? "Y" : "Z"}`;
    for (let i = 0; i < 5; i++) {
      const reply = await pair(origin, wrong);
      expect(reply.status).toBe(400);
      expect(errorCode(reply.body)).toBe("code_wrong");
    }
    const throttled = await pair(origin, code);
    expect(throttled.status).toBe(429);
    expect(errorCode(throttled.body)).toBe("too_many_tries_wait");
    expect(Number(throttled.headers["retry-after"])).toBeGreaterThan(0);
  } finally {
    client.close();
  }
}, 20_000);

test("the configured pairing_code_minutes sets the code's lifetime", async () => {
  const home = tempDir("archer-pair-home-");
  mkdirSync(join(home, ".config", "archer"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".config", "archer", "archer.toml"), "version = 1\n[service]\npairing_code_minutes = 12\n", {
    mode: 0o600,
  });
  const { svc } = await service({ env: { XDG_CONFIG_HOME: join(home, ".config") } });
  const client = await connectService(svc.socketPath);
  try {
    const issued = await client.call("issuePairingCode", {});
    expect(issued.minutes).toBe(12);
    expect(Date.parse(issued.expiresAt) - Date.now()).toBeGreaterThan(11 * 60_000);
  } finally {
    client.close();
  }
}, 20_000);
